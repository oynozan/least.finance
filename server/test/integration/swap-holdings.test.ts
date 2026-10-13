import { ObjectId } from "mongodb";
import { pino } from "pino";
import { getAddress, type Address } from "viem";
import { afterAll, beforeAll, describe, expect, inject, test, vi } from "vitest";
import type { Identity, IdentityProvider } from "../../src/auth/identity.ts";
import type { AccountDoc } from "../../src/db/mongo.ts";
import { Bus } from "../../src/events.ts";
import type { SwapHoldingsView } from "../../src/protocol.ts";
import { COINS, type CoinEntry, type NetworkId } from "../../src/swaps/coins.ts";
import { SwapHoldings, type EvmReader, type SolanaReader } from "../../src/swaps/holdings.ts";
import { startStack, type AppSocket, type Stack, type User } from "../support/stack.ts";
import { sourceChain } from "../support/source-chains.ts";

const SOLANA = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

const entryOf = (symbol: string, network: NetworkId): CoinEntry =>
    COINS.find((coin) => coin.symbol === symbol)!.entries.find((entry) => entry.network === network)!;

let clock = 1_000_000;
let stack: Stack;
beforeAll(async () => {
    stack = await startStack({ mongoUri: inject("mongoUri"), anvilUrl: inject("anvilUrl"), now: () => clock });
});
afterAll(() => stack?.stop());

/** Collects every `swap:holdings` push of a socket. */
function listen(socket: AppSocket) {
    const pushes: SwapHoldingsView[] = [];
    socket.on("swap:holdings", (view) => pushes.push(view));
    return pushes;
}

async function bind(user: User) {
    const socket = await stack.socket(user);
    const pushes = listen(socket);
    const opened = await socket.timeout(5000).emitWithAck("account:open", {});
    expect(opened.ok).toBe(true);
    await expect.poll(() => pushes.length).toBe(1);
    return { socket, pushes };
}

const click = async (socket: AppSocket) => {
    const result = await socket.timeout(5000).emitWithAck("swap:holdings:refresh", {});
    if (!result.ok) throw new Error(result.error.code);
    return result.data;
};

/** Gives a wallet 1.5 ETH and 25 USDC on Ethereum. */
async function holdOnEthereum(wallet: Address) {
    const ethereum = sourceChain(inject("ethereumUrl"), 1);
    const usdc = entryOf("USDC", "ethereum").address as Address;
    await ethereum.fund(wallet, "1.5");
    await ethereum.installToken(usdc);
    await ethereum.setTokenBalance(usdc, wallet, 25_000_000n);
}

async function holder() {
    const user = await stack.user();
    await holdOnEthereum(user.wallet);
    return user;
}

describe("over the socket", () => {
    test("sign-in pushes the wallet's holdings with dollar values", async () => {
        const user = await holder();
        const { pushes } = await bind(user);

        const wallet = getAddress(user.wallet);
        expect(pushes[0]!.readAt).toBe(new Date(clock).toISOString());
        expect(pushes[0]!.rows).toEqual([
            { wallet, network: "ethereum", symbol: "ETH", amount: "1.5", usd: 4815.6 },
            { wallet, network: "ethereum", symbol: "USDC", amount: "25", usd: 25 },
        ]);
    });

    test("a refresh inside 15 s doesn't read again", async () => {
        const { socket, pushes } = await bind(await holder());

        clock += 10_000;
        expect(await click(socket)).toEqual({ read: false });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(pushes).toHaveLength(1);

        clock += 5_000;
        expect(await click(socket)).toEqual({ read: true });
        await expect.poll(() => pushes.length).toBe(2);
        expect(pushes[1]!.rows).toEqual(pushes[0]!.rows);
    });

    test("a network that can't be read doesn't hide the others", async () => {
        // Arbitrum's RPC refuses connections in the stack
        const user = await holder();
        const { pushes } = await bind(user);

        const networks = new Set(pushes[0]!.rows.map((row) => row.network));
        expect([...networks]).toEqual(["ethereum"]);
        expect(pushes[0]!.rows).toHaveLength(2);
    });

    test("a network that couldn't be read is left out of the pairs read", async () => {
        const user = await holder();
        const { pushes } = await bind(user);

        const wallet = getAddress(user.wallet);
        const read = pushes[0]!.read;
        expect(read).toContainEqual({ wallet, network: "ethereum" });
        expect(read).toContainEqual({ wallet, network: "bnb" });
        expect(read.some((pair) => pair.network === "arbitrum")).toBe(false);
        expect(read.every((pair) => pair.wallet === wallet)).toBe(true);
    });

    test("a linked Solana wallet's SOL is read", async () => {
        const user = await holder();
        stack.privy.setUser(user.userId, [user.wallet, { address: SOLANA, chain: "solana" }]);
        stack.solanaRpc.setBalance(SOLANA, 2_000_000_000n);
        const { pushes } = await bind(user);

        expect(pushes[0]!.rows).toContainEqual({
            wallet: SOLANA,
            network: "solana",
            symbol: "SOL",
            amount: "2",
            usd: 294.4,
        });
        expect(pushes[0]!.rows.filter((row) => row.network === "ethereum")).toHaveLength(2);
    });

    test("holdings go only to the account's owner", async () => {
        const user = await holder();
        const first = await bind(user);
        const second = await bind(user);
        const other = await bind(await holder());
        const before = [first.pushes.length, second.pushes.length, other.pushes.length];

        clock += 16_000;
        await click(first.socket);

        await expect.poll(() => first.pushes.length).toBe(before[0]! + 1);
        await expect.poll(() => second.pushes.length).toBe(before[1]! + 1);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(other.pushes).toHaveLength(before[2]!);
        expect(second.pushes.at(-1)!.rows.every((row) => row.wallet === getAddress(user.wallet))).toBe(true);
    });

    test("two binds inside 15 s read once, and both sockets end up holding the view", async () => {
        const user = await holder();
        const first = await bind(user);

        clock += 5_000;
        const second = await bind(user);

        expect(second.pushes[0]).toEqual(first.pushes[0]);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(first.pushes).toHaveLength(1);
    });
});

describe("the reader behind it", () => {
    const A = getAddress("0x00000000000000000000000000000000000000a1");
    const B = getAddress("0x00000000000000000000000000000000000000b2");
    const account = { _id: new ObjectId(), privyUserId: "did:privy:holder" } as AccountDoc;
    const identity = { userId: account.privyUserId } as Identity;

    const symbolOf = (entry: CoinEntry) => COINS.find((coin) => coin.entries.includes(entry))!.symbol;
    const wei = (eth: number) => BigInt(Math.round(eth * 1e18));
    /** Every wallet holds `eth` ETH wherever ETH is listed, and nothing else. */
    const ethOnly =
        (eth: number): EvmReader =>
        async (_network, _owner, entries) =>
            entries.map((entry) => (symbolOf(entry) === "ETH" ? wei(eth) : 0n));

    function setup(options: { evm?: EvmReader; solana?: SolanaReader; prices?: Record<string, number> } = {}) {
        let now = 1_000_000;
        const linked = { evm: [A, B] as Address[], solana: [] as string[] };
        const lookups: unknown[] = [];
        const bus = new Bus();
        const pushed: SwapHoldingsView[] = [];
        bus.on("swap:holdings", ({ view }) => pushed.push(view));
        const readEvm = vi.fn<EvmReader>(options.evm ?? (async (_network, _owner, entries) => entries.map(() => 0n)));
        const readSolana = vi.fn<SolanaReader>(options.solana ?? (async (_owner, entries) => entries.map(() => 0n)));
        const holdings = new SwapHoldings({
            identity: {
                linkedWallets: async (_identity: Identity, lookup?: { fresh?: boolean }) => {
                    lookups.push(lookup);
                    return linked;
                },
            } as unknown as IdentityProvider,
            bus,
            logger: pino({ level: "silent" }),
            catalog: { priceOf: (symbol) => options.prices?.[symbol] ?? null },
            readEvm,
            readSolana,
            now: () => now,
        });
        return { holdings, linked, lookups, pushed, readEvm, readSolana, advance: (ms: number) => void (now += ms) };
    }

    const describeRows = (view: SwapHoldingsView | null) =>
        view?.rows.map((row) => `${row.wallet === A ? "A" : "B"}:${row.network}:${row.symbol}=${row.amount}`);

    test("every linked wallet is read on every network, and only non-zero rows are kept", async () => {
        const t = setup({
            evm: async (network, owner, entries) =>
                entries.map((entry) => (owner === A && network === "base" && symbolOf(entry) === "ETH" ? wei(2) : 0n)),
            prices: { ETH: 2000 },
        });

        expect(await t.holdings.refresh(account, identity, "bind")).toEqual({ read: true });

        expect(t.readEvm).toHaveBeenCalledTimes(16);
        expect(t.readSolana).not.toHaveBeenCalled();
        expect(t.pushed).toHaveLength(1);
        expect(t.pushed[0]!.rows).toEqual([{ wallet: A, network: "base", symbol: "ETH", amount: "2", usd: 4000 }]);
        expect(t.holdings.last(account._id)).toEqual(t.pushed[0]);
    });

    test("a coin without a price has no dollar value", async () => {
        const t = setup({
            evm: async (_network, _owner, entries) => entries.map(() => 10n ** 18n),
            prices: { ETH: 1 },
        });
        await t.holdings.refresh(account, identity, "bind");

        const row = (symbol: string) => t.pushed[0]!.rows.find((candidate) => candidate.symbol === symbol)!;
        expect(row("ETH").usd).toBe(1);
        expect(row("LINK").usd).toBeNull();
    });

    test("a failed read keeps that wallet and network's last rows, and the rest update", async () => {
        let ethereumDown = false;
        let eth = 1;
        const t = setup({
            evm: async (network, owner, entries) => {
                if (network === "ethereum" && ethereumDown) throw new Error("RPC down");
                return ethOnly(eth)(network, owner, entries);
            },
        });
        await t.holdings.refresh(account, identity, "bind");
        expect(describeRows(t.holdings.last(account._id))).toContain("A:ethereum:ETH=1");

        ethereumDown = true;
        eth = 3;
        t.advance(15_000);
        expect(await t.holdings.refresh(account, identity, "click")).toEqual({ read: true });

        const after = describeRows(t.holdings.last(account._id))!;
        expect(after).toContain("A:ethereum:ETH=1");
        expect(after).toContain("B:ethereum:ETH=1");
        expect(after).toContain("A:base:ETH=3");
        expect(after).toContain("B:base:ETH=3");
        expect(t.pushed).toHaveLength(2);
    });

    test("a balance that reads as zero drops its row, and one that can't be read keeps it", async () => {
        let held: Record<string, bigint | null | undefined> = { ETH: wei(1), USDC: 5_000_000n };
        const t = setup({
            evm: async (network, owner, entries) =>
                entries.map((entry) => (owner === A && network === "ethereum" ? held[symbolOf(entry)] : 0n) ?? null),
        });
        await t.holdings.refresh(account, identity, "bind");
        expect(describeRows(t.holdings.last(account._id))).toEqual(["A:ethereum:ETH=1", "A:ethereum:USDC=5"]);

        held = { ETH: 0n, USDC: null };
        t.advance(15_000);
        await t.holdings.refresh(account, identity, "click");

        expect(describeRows(t.holdings.last(account._id))).toEqual(["A:ethereum:USDC=5"]);
    });

    test("when nothing could be read and nothing is known, nothing is pushed and the next call reads again", async () => {
        let down = true;
        const t = setup({
            evm: async (network, owner, entries) => {
                if (down) throw new Error("RPC down");
                return ethOnly(1)(network, owner, entries);
            },
        });
        const bound: SwapHoldingsView[] = [];

        expect(await t.holdings.refresh(account, identity, "bind", (view) => bound.push(view))).toEqual({
            read: false,
        });
        expect(t.pushed).toEqual([]);
        expect(bound).toEqual([]);
        expect(t.holdings.last(account._id)).toBeNull();

        down = false;
        expect(await t.holdings.refresh(account, identity, "click")).toEqual({ read: true });
        expect(t.pushed).toHaveLength(1);
    });

    test("when everything fails after a good read, the last view stays and isn't pushed again", async () => {
        let down = false;
        const t = setup({
            evm: async (network, owner, entries) => {
                if (down) throw new Error("RPC down");
                return ethOnly(1)(network, owner, entries);
            },
        });
        await t.holdings.refresh(account, identity, "bind");
        const good = t.holdings.last(account._id);

        down = true;
        t.advance(15_000);
        expect(await t.holdings.refresh(account, identity, "click")).toEqual({ read: false });

        expect(t.holdings.last(account._id)).toEqual(good);
        expect(t.pushed).toHaveLength(1);
    });

    test("a read inside 15 s is skipped unless a swap settled, and a bind then pushes the last view", async () => {
        const t = setup({ evm: ethOnly(1) });
        await t.holdings.refresh(account, identity, "bind");
        const reads = t.readEvm.mock.calls.length;

        t.advance(14_999);
        const bound: SwapHoldingsView[] = [];
        expect(await t.holdings.refresh(account, identity, "bind", (view) => bound.push(view))).toEqual({
            read: false,
        });
        expect(await t.holdings.refresh(account, identity, "click", (view) => bound.push(view))).toEqual({
            read: false,
        });
        expect(t.readEvm).toHaveBeenCalledTimes(reads);
        expect(bound).toEqual([t.pushed[0]]);

        expect(await t.holdings.refresh(account, identity, "settled")).toEqual({ read: true });
        expect(t.readEvm).toHaveBeenCalledTimes(reads * 2);
        expect(t.pushed).toHaveLength(2);
    });

    test("concurrent calls share one run", async () => {
        const t = setup({ evm: ethOnly(1) });

        const results = await Promise.all([
            t.holdings.refresh(account, identity, "bind"),
            t.holdings.refresh(account, identity, "click"),
            t.holdings.refresh(account, identity, "settled"),
        ]);

        expect(results).toEqual([{ read: true }, { read: true }, { read: true }]);
        expect(t.readEvm).toHaveBeenCalledTimes(16);
        expect(t.pushed).toHaveLength(1);
    });

    test("Solana wallets are read through the Solana reader, and an unlinked wallet's rows drop out", async () => {
        const t = setup({
            evm: ethOnly(1),
            solana: async (_owner, entries) =>
                entries.map((entry) => (symbolOf(entry) === "SOL" ? 2_000_000_000n : 0n)),
            prices: { SOL: 100 },
        });
        t.linked.solana = [SOLANA];
        await t.holdings.refresh(account, identity, "bind");

        expect(t.readSolana).toHaveBeenCalledTimes(1);
        expect(t.holdings.last(account._id)!.rows).toContainEqual({
            wallet: SOLANA,
            network: "solana",
            symbol: "SOL",
            amount: "2",
            usd: 200,
        });
        expect(describeRows(t.holdings.last(account._id))).toContain("B:ethereum:ETH=1");

        t.linked.evm = [A];
        t.linked.solana = [];
        t.advance(15_000);
        await t.holdings.refresh(account, identity, "click");

        expect(t.holdings.last(account._id)!.rows.every((row) => row.wallet === A)).toBe(true);
    });

    test("the pairs read follow the wallets' order, and a pair that fails later stays read", async () => {
        let down: string | null = null;
        const t = setup({
            evm: async (network, owner, entries) => {
                if (network === down || (network === "arbitrum" && owner === B)) throw new Error("RPC down");
                return ethOnly(1)(network, owner, entries);
            },
        });
        t.linked.solana = [SOLANA];
        await t.holdings.refresh(account, identity, "bind");

        const pairs = (view: SwapHoldingsView | null) =>
            view?.read.map((pair) => `${pair.wallet === A ? "A" : pair.wallet === B ? "B" : "S"}:${pair.network}`);
        expect(pairs(t.holdings.last(account._id))).toEqual([
            ...["ethereum", "arbitrum", "base", "optimism", "polygon", "bnb", "avalanche", "arc"].map(
                (id) => `A:${id}`,
            ),
            ...["ethereum", "base", "optimism", "polygon", "bnb", "avalanche", "arc"].map((id) => `B:${id}`),
            "S:solana",
        ]);

        down = "ethereum";
        t.advance(15_000);
        await t.holdings.refresh(account, identity, "click");
        expect(pairs(t.holdings.last(account._id))).toContain("A:ethereum");

        t.linked.evm = [A];
        t.linked.solana = [];
        t.advance(15_000);
        await t.holdings.refresh(account, identity, "click");
        expect(pairs(t.holdings.last(account._id))!.every((pair) => pair.startsWith("A:"))).toBe(true);
    });

    test("a click inside the window reads a wallet linked since, and only that one", async () => {
        const C = getAddress("0x00000000000000000000000000000000000000c3");
        const t = setup({ evm: ethOnly(1) });
        await t.holdings.refresh(account, identity, "bind");
        expect(t.readEvm).toHaveBeenCalledTimes(16);

        t.linked.evm = [A, B, C];
        t.advance(1_000);
        expect(await t.holdings.refresh(account, identity, "click")).toEqual({ read: true });
        expect(t.readEvm).toHaveBeenCalledTimes(24);
        expect(t.readEvm.mock.calls.slice(16).every(([, owner]) => owner === C)).toBe(true);
        expect(t.pushed).toHaveLength(2);
        const rows = t.holdings.last(account._id)!.rows;
        expect(rows.filter((row) => row.wallet === C)).toHaveLength(rows.filter((row) => row.wallet === A).length);
        expect(rows.some((row) => row.wallet === C)).toBe(true);
        expect(t.holdings.last(account._id)!.read.filter((pair) => pair.wallet === C)).toHaveLength(8);

        // The window didn't move, so the next full read is due 15 s after the first
        t.advance(1_000);
        expect(await t.holdings.refresh(account, identity, "click")).toEqual({ read: false });
        t.advance(13_000);
        expect(await t.holdings.refresh(account, identity, "click")).toEqual({ read: true });
        expect(t.readEvm).toHaveBeenCalledTimes(48);
    });

    test("a wallet whose first read failed is read again by the next click inside the window", async () => {
        const C = getAddress("0x00000000000000000000000000000000000000c3");
        let down = true;
        const t = setup({
            evm: async (network, owner, entries) => {
                if (owner === C && down) throw new Error("RPC down");
                return ethOnly(1)(network, owner, entries);
            },
        });
        await t.holdings.refresh(account, identity, "bind");

        t.linked.evm = [A, B, C];
        t.advance(1_000);
        expect(await t.holdings.refresh(account, identity, "click")).toEqual({ read: false });
        expect(t.pushed).toHaveLength(1);
        t.advance(1_000);
        down = false;
        expect(await t.holdings.refresh(account, identity, "click")).toEqual({ read: true });
        expect(t.holdings.last(account._id)!.read.filter((pair) => pair.wallet === C)).toHaveLength(8);
    });

    test("inside the window a click asks Privy afresh at most every 5 s", async () => {
        const t = setup({ evm: ethOnly(1) });
        await t.holdings.refresh(account, identity, "bind");

        t.advance(1_000);
        await t.holdings.refresh(account, identity, "click");
        t.advance(2_000);
        await t.holdings.refresh(account, identity, "click");
        t.advance(3_000);
        await t.holdings.refresh(account, identity, "click");

        expect(t.lookups).toEqual([{ fresh: false }, { fresh: true }, { fresh: true }]);
    });

    test("a click or a settle asks Privy afresh, a bind doesn't", async () => {
        const t = setup();
        await t.holdings.refresh(account, identity, "bind");
        t.advance(15_000);
        await t.holdings.refresh(account, identity, "click");
        await t.holdings.refresh(account, identity, "settled");

        expect(t.lookups).toEqual([{ fresh: false }, { fresh: true }, { fresh: true }]);
    });
});
