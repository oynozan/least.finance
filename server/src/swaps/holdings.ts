import type { ObjectId } from "mongodb";
import type { Logger } from "pino";
import { erc20Abi, formatUnits, multicall3Abi, type Address, type PublicClient } from "viem";
import type { Identity, IdentityProvider } from "../auth/identity.ts";
import type { SolanaRpc } from "../crosschain/solana.ts";
import type { AccountDoc } from "../db/mongo.ts";
import type { Bus } from "../events.ts";
import type { SwapHoldingRow, SwapHoldingsView } from "../protocol.ts";
import type { SwapCatalog } from "./catalog.ts";
import type { EvmNetworkId } from "./clients.ts";
import { COINS, NATIVE_EVM, NATIVE_SOLANA, NETWORKS, type CoinEntry, type NetworkId } from "./coins.ts";

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

/** An account's holdings are read at most this often, unless a swap just settled. */
const REFRESH_INTERVAL_MS = 15_000;
/** Inside that window a click asks Privy for new wallets at most this often. */
const LINK_CHECK_MS = 5_000;

/** The units held, in the order of `entries`: a null is a call that failed, and a failed request throws. */
export type EvmReader = (
    network: EvmNetworkId,
    owner: Address,
    entries: readonly CoinEntry[],
) => Promise<(bigint | null)[]>;
export type SolanaReader = (owner: string, entries: readonly CoinEntry[]) => Promise<(bigint | null)[]>;

/** One multicall per network reads the native coin and every listed token. */
export function multicallReader(clients: Record<EvmNetworkId, PublicClient>): EvmReader {
    return async (network, owner, entries) => {
        const contracts = entries.map((entry) =>
            entry.address === NATIVE_EVM
                ? ({ address: MULTICALL3, abi: multicall3Abi, functionName: "getEthBalance", args: [owner] } as const)
                : ({
                      address: entry.address as Address,
                      abi: erc20Abi,
                      functionName: "balanceOf",
                      args: [owner],
                  } as const),
        );
        const results = await clients[network].multicall({
            multicallAddress: MULTICALL3,
            allowFailure: true,
            contracts,
        });
        // Viem reports a failed request as a failure of every call, so a read where nothing answered is the failure
        if (results.every((result) => result.status === "failure")) {
            throw results[0]?.error ?? new Error("The multicall had nothing to read");
        }
        return results.map((result) => (result.status === "success" ? (result.result as bigint) : null));
    };
}

/** SOL through `getBalance` and each token through its token accounts. */
export function solanaReader(rpc: SolanaRpc): SolanaReader {
    return async (owner, entries) => {
        const settled = await Promise.allSettled(
            entries.map((entry) =>
                entry.address === NATIVE_SOLANA ? rpc.getBalance(owner) : rpc.getTokenBalance(owner, entry.address),
            ),
        );
        const first = settled.find((result) => result.status === "rejected");
        if (first && settled.every((result) => result.status === "rejected")) throw first.reason;
        return settled.map((result) => (result.status === "fulfilled" ? result.value : null));
    };
}

type Deps = {
    identity: IdentityProvider;
    bus: Bus;
    logger: Logger;
    catalog: Pick<SwapCatalog, "priceOf">;
    readEvm: EvmReader;
    readSolana: SolanaReader;
    now?: () => number;
};

type Linked = { evm: Address[]; solana: string[] };

type ReadPair = SwapHoldingsView["read"][number];

type State = {
    /** When the last full run started, whether or not it read anything. */
    attemptedAt: number;
    /** When linked wallets were last fetched fresh from Privy. */
    checkedAt: number;
    /** The non-zero rows by wallet, network and symbol; a failed read leaves its entries as they were. */
    held: Map<string, SwapHoldingRow>;
    /** The wallet and network pairs that answered at least once, which a later failure leaves in. */
    read: Map<string, ReadPair>;
    linked: Linked;
    view: SwapHoldingsView;
};

const EVM_NETWORKS = NETWORKS.filter((network) => network.kind === "evm").map((network) => network.id as EvmNetworkId);

/** The coins listed on each network, in the picker's order. */
const LISTED = new Map<NetworkId, { symbol: string; entry: CoinEntry }[]>(
    NETWORKS.map(({ id }) => [
        id,
        COINS.flatMap((coin) =>
            coin.entries.filter((entry) => entry.network === id).map((entry) => ({ symbol: coin.symbol, entry })),
        ),
    ]),
);

const pairKey = (wallet: string, network: NetworkId) => `${wallet}|${network}`;

const rowKey = (wallet: string, network: NetworkId, symbol: string) => `${pairKey(wallet, network)}|${symbol}`;

/** Each account's coins on the nine swap networks, read when the socket binds and again on request, at most once per 15 s, except for a wallet with nothing read yet. */
export class SwapHoldings {
    readonly #deps: Deps;
    readonly #now: () => number;
    readonly #states = new Map<string, State>();
    readonly #running = new Map<string, Promise<{ read: boolean }>>();

    constructor(deps: Deps) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
    }

    /** Reads past REFRESH_INTERVAL_MS, at once on a settle, or on a click for a wallet with nothing read yet; a bind that reads nothing is pushed the last view. */
    async refresh(
        account: AccountDoc,
        identity: Identity,
        reason: "bind" | "click" | "settled",
        push?: (view: SwapHoldingsView) => void,
    ): Promise<{ read: boolean }> {
        const key = account._id.toHexString();
        let work = this.#running.get(key);
        if (!work) {
            work = this.#run(account, identity, reason).finally(() => this.#running.delete(key));
            this.#running.set(key, work);
        }
        const result = await work;
        if (reason === "bind" && !result.read) {
            const held = this.last(account._id);
            if (held) push?.(held);
        }
        return result;
    }

    last(accountId: ObjectId): SwapHoldingsView | null {
        return this.#states.get(accountId.toHexString())?.view ?? null;
    }

    async #run(account: AccountDoc, identity: Identity, reason: "bind" | "click" | "settled") {
        const key = account._id.toHexString();
        const state = this.#states.get(key);
        const now = this.#now();
        const due = !state || reason === "settled" || now - state.attemptedAt >= REFRESH_INTERVAL_MS;
        // Inside the window only a click looks further, for a wallet that has nothing read yet
        if (!due && reason !== "click") return { read: false };

        let linked: Linked;
        let checkedAt = state?.checkedAt ?? 0;
        if (state && !due && now - state.checkedAt < LINK_CHECK_MS) {
            linked = state.linked;
        } else {
            try {
                linked = await this.#deps.identity.linkedWallets(identity, { fresh: reason !== "bind" });
                if (reason !== "bind") checkedAt = now;
            } catch (error) {
                if (!state) throw error;
                this.#deps.logger.warn({ err: error }, "Couldn't check linked wallets for the swap holdings");
                linked = state.linked;
            }
        }

        const pairs = [
            ...linked.evm.flatMap((wallet) => EVM_NETWORKS.map((network) => ({ wallet: wallet as string, network }))),
            ...linked.solana.map((wallet) => ({ wallet, network: "solana" as NetworkId })),
        ];
        const readWallets = new Set([...(state?.read.values() ?? [])].map((pair) => pair.wallet));
        const toRead = due ? pairs : pairs.filter(({ wallet }) => !readWallets.has(wallet));
        const held = new Map(state?.held);
        const readPairs = new Map(state?.read);
        let read = 0;
        await Promise.all(
            toRead.map(async ({ wallet, network }) => {
                const listed = LISTED.get(network)!;
                const entries = listed.map(({ entry }) => entry);
                try {
                    const units =
                        network === "solana"
                            ? await this.#deps.readSolana(wallet, entries)
                            : await this.#deps.readEvm(network as EvmNetworkId, wallet as Address, entries);
                    read += 1;
                    readPairs.set(pairKey(wallet, network), { wallet, network });
                    for (const [i, { symbol, entry }] of listed.entries()) {
                        const amount = units[i];
                        // A call that failed leaves the last row as it was
                        if (amount === null || amount === undefined) continue;
                        if (amount === 0n) held.delete(rowKey(wallet, network, symbol));
                        else
                            held.set(
                                rowKey(wallet, network, symbol),
                                this.#row(wallet, network, symbol, entry, amount),
                            );
                    }
                } catch (error) {
                    this.#deps.logger.warn({ err: error, wallet, network }, "Couldn't read a wallet's swap holdings");
                }
            }),
        );

        if (read === 0) {
            if (state) Object.assign(state, { attemptedAt: due ? now : state.attemptedAt, checkedAt, linked });
            return { read: false };
        }

        const wallets = [...linked.evm, ...linked.solana];
        for (const [rowId, row] of held) if (!wallets.includes(row.wallet as Address)) held.delete(rowId);
        for (const [pairId, pair] of readPairs) if (!wallets.includes(pair.wallet as Address)) readPairs.delete(pairId);
        // Rows follow the wallets' order, then the networks', then the picker's
        const rows = wallets.flatMap((wallet) =>
            NETWORKS.flatMap(({ id }) =>
                (LISTED.get(id) ?? []).flatMap(({ symbol }) => held.get(rowKey(wallet, id, symbol)) ?? []),
            ),
        );
        const readList = wallets.flatMap((wallet) =>
            NETWORKS.flatMap(({ id }) => readPairs.get(pairKey(wallet, id)) ?? []),
        );
        const view = { readAt: new Date(now).toISOString(), rows, read: readList };
        this.#states.set(key, {
            attemptedAt: state && !due ? state.attemptedAt : now,
            checkedAt,
            held,
            read: readPairs,
            linked,
            view,
        });
        this.#deps.bus.emit("swap:holdings", { accountId: account._id, privyUserId: account.privyUserId, view });
        return { read: true };
    }

    #row(wallet: string, network: NetworkId, symbol: string, entry: CoinEntry, units: bigint): SwapHoldingRow {
        const amount = formatUnits(units, entry.decimals);
        const price = this.#deps.catalog.priceOf(symbol);
        return {
            wallet,
            network,
            symbol,
            amount,
            usd: price === null ? null : Math.round(Number(amount) * price * 100) / 100,
        };
    }
}
