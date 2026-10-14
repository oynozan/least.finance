import { encodeAbiParameters, encodeEventTopics, pad, type Address, type Hex } from "viem";
import { expect, test } from "vitest";
import { createPolygonReader, type PolygonClient } from "../../src/predictions/polygon-reader.ts";
import { DEPOSIT_FOR_BURN_EVENT, POLYGON } from "../../src/predictions/pool-moves.ts";
import { FORWARD_HOOK_DATA } from "../../src/withdrawals/cctp-burn.ts";

const WALLET: Address = "0x00000000000000000000000000000000000a11ce";
const OTHER: Address = "0x000000000000000000000000000000000000dead";
const TREASURY: Address = "0x000000000000000000000000000000000000b0b0";
const HASH = `0x${"a".repeat(64)}` as Hex;
const HASH2 = `0x${"b".repeat(64)}` as Hex;
const HEAD = 1_000_000n;

type Log = { address: Address; topics: Hex[]; data: Hex; transactionHash: Hex; blockNumber: bigint };

function burnLog(o: { depositor: Address; amountE6: bigint; hash?: Hex; block?: bigint; address?: Address }): Log {
    const topics = encodeEventTopics({
        abi: [DEPOSIT_FOR_BURN_EVENT],
        eventName: "DepositForBurn",
        args: { burnToken: POLYGON.usdc, depositor: o.depositor, minFinalityThreshold: 2000 },
    }) as Hex[];
    const data = encodeAbiParameters(
        [
            { type: "uint256" },
            { type: "bytes32" },
            { type: "uint32" },
            { type: "bytes32" },
            { type: "bytes32" },
            { type: "uint256" },
            { type: "bytes" },
        ],
        [
            o.amountE6,
            pad(TREASURY, { size: 32 }),
            26,
            pad(POLYGON.tokenMessenger, { size: 32 }),
            pad("0x", { size: 32 }),
            213_201n,
            FORWARD_HOOK_DATA,
        ],
    );
    return {
        address: o.address ?? POLYGON.tokenMessenger,
        topics,
        data,
        transactionHash: o.hash ?? HASH,
        blockNumber: o.block ?? HEAD - 10n,
    };
}

type LogsCall = { address: Address; event: unknown; args: { depositor: Address }; fromBlock: bigint; toBlock: bigint };

/** A hand-written client: it records getLogs asks and serves the logs inside each asked range. */
function stub(o: { logs?: Log[]; head?: bigint; code?: Hex; receipt?: { logs: Log[] }; balance?: bigint } = {}) {
    const calls = {
        read: [] as unknown[],
        logs: [] as LogsCall[],
        receipts: [] as unknown[],
        code: [] as unknown[],
    };
    const client = {
        getBlockNumber: async () => o.head ?? HEAD,
        readContract: async (request: unknown) => {
            calls.read.push(request);
            return o.balance ?? 0n;
        },
        getLogs: async (request: LogsCall) => {
            calls.logs.push(request);
            return (o.logs ?? []).filter(
                (log) => log.blockNumber >= request.fromBlock && log.blockNumber <= request.toBlock,
            );
        },
        getTransactionReceipt: async (request: unknown) => {
            calls.receipts.push(request);
            if (!o.receipt) throw new Error("receipt not found");
            return o.receipt;
        },
        getCode: async (request: unknown) => {
            calls.code.push(request);
            return o.code;
        },
    } as unknown as PolygonClient;
    return { client, calls };
}

const now = new Date("2026-10-14T12:00:00Z");
const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);

test("usdcBalanceE6 reads balanceOf on native USDC", async () => {
    const { client, calls } = stub({ balance: 4_930_000n });
    const reader = createPolygonReader(client);
    expect(await reader.usdcBalanceE6(WALLET)).toBe(4_930_000n);
    expect(calls.read).toHaveLength(1);
    expect(calls.read[0]).toMatchObject({ address: POLYGON.usdc, functionName: "balanceOf", args: [WALLET] });
});

test("hasCode is false for 0x", async () => {
    for (const [code, expected] of [
        ["0x", false],
        [undefined, false],
        ["0x363d3d373d3d3d363d73", true],
    ] as const) {
        const { client, calls } = stub({ code });
        expect(await createPolygonReader(client).hasCode(WALLET)).toBe(expected);
        expect(calls.code).toEqual([{ address: WALLET }]);
    }
});

test("burnEvents asks only for the wallet as depositor from a block range that covers the window, and drops a log whose amount or depositor doesn't decode", async () => {
    const good = burnLog({ depositor: WALLET, amountE6: 12_000_000n, hash: HASH });
    const second = burnLog({ depositor: WALLET, amountE6: 5_000_000n, hash: HASH2 });
    const otherDepositor = burnLog({ depositor: OTHER, amountE6: 9_000_000n, hash: HASH2 });
    const brokenData: Log = { ...burnLog({ depositor: WALLET, amountE6: 1n }), data: "0x1234" };
    const brokenTopics: Log = { ...burnLog({ depositor: WALLET, amountE6: 1n }), topics: [] };
    const { client, calls } = stub({ logs: [good, otherDepositor, brokenData, brokenTopics, second] });

    const found = await createPolygonReader(client).burnEvents({ wallet: WALLET, since: ago(300), now });

    expect(found).toEqual([
        { txHash: HASH, amountE6: 12_000_000n },
        { txHash: HASH2, amountE6: 5_000_000n },
    ]);
    // 300 seconds of blocks (at least one second apart) plus the 200-block margin, up to the head
    expect(calls.logs).toHaveLength(1);
    const ask = calls.logs[0]!;
    expect(ask.address).toBe(POLYGON.tokenMessenger);
    expect(ask.event).toBe(DEPOSIT_FOR_BURN_EVENT);
    expect(ask.args).toEqual({ depositor: WALLET });
    expect(ask.fromBlock).toBe(HEAD - 300n - 200n);
    expect(ask.toBlock).toBe(HEAD);
});

test("burnEvents rounds the elapsed seconds up and never starts below block zero", async () => {
    const rounded = stub();
    await createPolygonReader(rounded.client).burnEvents({ wallet: WALLET, since: ago(300.4), now });
    expect(rounded.calls.logs[0]!.fromBlock).toBe(HEAD - 301n - 200n);

    const future = stub();
    await createPolygonReader(future.client).burnEvents({ wallet: WALLET, since: ago(-60), now });
    expect(future.calls.logs[0]!.fromBlock).toBe(HEAD - 200n);

    const young = stub({ head: 150n });
    await createPolygonReader(young.client).burnEvents({ wallet: WALLET, since: ago(300), now });
    expect(young.calls.logs[0]!.fromBlock).toBe(0n);
});

test("a window of 5_000 blocks is read in ranges of at most 2_000", async () => {
    const early = burnLog({ depositor: WALLET, amountE6: 7_000_000n, hash: HASH, block: HEAD - 4_900n });
    const late = burnLog({ depositor: WALLET, amountE6: 8_000_000n, hash: HASH2, block: HEAD - 3n });
    const { client, calls } = stub({ logs: [early, late] });

    const found = await createPolygonReader(client).burnEvents({ wallet: WALLET, since: ago(4_800), now });

    expect(found).toEqual([
        { txHash: HASH, amountE6: 7_000_000n },
        { txHash: HASH2, amountE6: 8_000_000n },
    ]);
    expect(calls.logs).toHaveLength(3);
    for (const ask of calls.logs) expect(ask.toBlock - ask.fromBlock + 1n).toBeLessThanOrEqual(2_000n);
    // The ranges follow each other with no gap and no overlap, from the start to the head
    expect(calls.logs[0]!.fromBlock).toBe(HEAD - 5_000n);
    for (let index = 1; index < calls.logs.length; index++) {
        expect(calls.logs[index]!.fromBlock).toBe(calls.logs[index - 1]!.toBlock + 1n);
    }
    expect(calls.logs.at(-1)!.toBlock).toBe(HEAD);
});

test("a range that fails fails the whole scan instead of answering from part of the window", async () => {
    const { client } = stub();
    let asks = 0;
    (client as unknown as { getLogs: () => Promise<unknown[]> }).getLogs = async () => {
        if (++asks === 2) throw new Error("range too large");
        return [];
    };
    await expect(createPolygonReader(client).burnEvents({ wallet: WALLET, since: ago(4_800), now })).rejects.toThrow(
        "range too large",
    );
});

test("burnLog finds the wallet's DepositForBurn in a receipt and returns null for another depositor", async () => {
    const mine = burnLog({ depositor: WALLET, amountE6: 12_000_000n });
    const { client, calls } = stub({ receipt: { logs: [mine] } });
    expect(await createPolygonReader(client).burnLog({ wallet: WALLET, hash: HASH })).toEqual({
        amountE6: 12_000_000n,
    });
    expect(calls.receipts).toEqual([{ hash: HASH }]);

    const others = stub({ receipt: { logs: [burnLog({ depositor: OTHER, amountE6: 12_000_000n })] } });
    expect(await createPolygonReader(others.client).burnLog({ wallet: WALLET, hash: HASH })).toBeNull();

    const empty = stub({ receipt: { logs: [] } });
    expect(await createPolygonReader(empty.client).burnLog({ wallet: WALLET, hash: HASH })).toBeNull();
});

test("burnLog skips the wallet's burn event when another contract emitted it, and the other logs of the batch", async () => {
    const spoofed = burnLog({ depositor: WALLET, amountE6: 99_000_000n, address: OTHER });
    const approval: Log = {
        ...burnLog({ depositor: WALLET, amountE6: 1n }),
        address: POLYGON.usdc,
        topics: [HASH],
        data: "0x",
    };
    const real = burnLog({ depositor: WALLET, amountE6: 12_000_000n });
    const { client } = stub({ receipt: { logs: [approval, spoofed, real] } });
    expect(await createPolygonReader(client).burnLog({ wallet: WALLET, hash: HASH })).toEqual({
        amountE6: 12_000_000n,
    });
});

test("burnLog throws when the node has no receipt, because null would read as a batch with no burn", async () => {
    const { client } = stub();
    await expect(createPolygonReader(client).burnLog({ wallet: WALLET, hash: HASH })).rejects.toThrow(
        "receipt not found",
    );
});
