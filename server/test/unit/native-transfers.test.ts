import { encodeAbiParameters, encodeEventTopics, getAddress, pad, type Address, type Hash, type Log } from "viem";
import type { TransactionReceipt } from "viem";
import { describe, expect, it, vi } from "vitest";
import { NATIVE_TRANSFER_EMITTER, transferEvent, type ArcClient } from "../../src/chain/arc.ts";
import { findTransfersTo, transfersInReceipt } from "../../src/chain/native-transfers.ts";

const USDC_ERC20 = "0x3600000000000000000000000000000000000000";
const BLOCK_HASH = `0x${"b1".repeat(32)}` as Hash;

function transferLog(opts: {
    emitter: string;
    logIndex: number;
    from: string;
    to: string;
    value: bigint;
    txHash: Hash;
    blockNumber?: bigint;
}): Log {
    return {
        address: opts.emitter as Address,
        topics: encodeEventTopics({
            abi: [transferEvent],
            eventName: "Transfer",
            args: { from: opts.from.toLowerCase() as Address, to: opts.to.toLowerCase() as Address },
        }),
        data: encodeAbiParameters([{ type: "uint256" }], [opts.value]),
        blockHash: BLOCK_HASH,
        blockNumber: opts.blockNumber ?? 100n,
        logIndex: opts.logIndex,
        transactionHash: opts.txHash,
        transactionIndex: 0,
        removed: false,
    } as Log;
}

const receipt = (txHash: Hash, logs: Log[]) =>
    ({
        transactionHash: txHash,
        blockHash: BLOCK_HASH,
        blockNumber: 100n,
        status: "success",
        logs,
    }) as TransactionReceipt;

describe("transfersInReceipt", () => {
    it("reads a plain native transfer", () => {
        const txHash = "0xD346D5673985926CF8FDEEB40763244430943F795E84E048A20EF9797AF95DEB" as Hash;
        const from = "0xF56ED4FB3308D58346A07692320C851936480D33";
        const to = "0x84AB385972B366ABCD7DFB6792F4624D92A224A4";
        const transfers = transfersInReceipt(
            receipt(txHash, [
                transferLog({
                    emitter: NATIVE_TRANSFER_EMITTER,
                    logIndex: 0,
                    from,
                    to,
                    value: 0xb1c43459b2800n,
                    txHash,
                }),
            ]),
        );
        expect(transfers).toEqual([
            {
                txHash: txHash.toLowerCase(),
                logIndex: 0,
                blockNumber: 100,
                blockHash: BLOCK_HASH,
                from: from.toLowerCase(),
                to: to.toLowerCase(),
                value: 0xb1c43459b2800n,
            },
        ]);
    });

    it("counts an ERC-20 transfer through the USDC contract once", () => {
        const txHash = `0x${"11".repeat(32)}` as Hash;
        const from = "0xf56ed4fb3308d58346a07692320c851936480d33";
        const to = "0x84ab385972b366abcd7dfb6792f4624d92a224a4";
        const transfers = transfersInReceipt(
            receipt(txHash, [
                transferLog({ emitter: NATIVE_TRANSFER_EMITTER, logIndex: 0, from, to, value: 10n ** 15n, txHash }),
                transferLog({ emitter: USDC_ERC20, logIndex: 1, from, to, value: 1000n, txHash }),
            ]),
        );
        expect(transfers).toHaveLength(1);
        expect(transfers[0]).toMatchObject({ logIndex: 0, value: 10n ** 15n });
    });

    it("returns every hop of forwarded value in log order", () => {
        const txHash = `0x${"22".repeat(32)}` as Hash;
        const a = "0x00000000000000000000000000000000000000a1";
        const b = "0x00000000000000000000000000000000000000b2";
        const c = "0x00000000000000000000000000000000000000c3";
        const d = "0x00000000000000000000000000000000000000d4";
        const logs = [
            transferLog({ emitter: NATIVE_TRANSFER_EMITTER, logIndex: 2, from: c, to: d, value: 3n, txHash }),
            transferLog({ emitter: NATIVE_TRANSFER_EMITTER, logIndex: 0, from: a, to: b, value: 1n, txHash }),
            transferLog({ emitter: NATIVE_TRANSFER_EMITTER, logIndex: 1, from: b, to: c, value: 2n, txHash }),
        ];
        const transfers = transfersInReceipt(receipt(txHash, logs));
        expect(transfers.map((t) => [t.logIndex, t.from, t.to, t.value])).toEqual([
            [0, a, b, 1n],
            [1, b, c, 2n],
            [2, c, d, 3n],
        ]);
    });

    it("matches the emitter regardless of address case", () => {
        const txHash = `0x${"33".repeat(32)}` as Hash;
        const log = transferLog({
            emitter: getAddress(NATIVE_TRANSFER_EMITTER),
            logIndex: 0,
            from: "0x00000000000000000000000000000000000000a1",
            to: "0x00000000000000000000000000000000000000b2",
            value: 5n,
            txHash,
        });
        expect(transfersInReceipt(receipt(txHash, [log]))).toHaveLength(1);
    });

    it("ignores Transfer logs from other contracts", () => {
        const txHash = `0x${"44".repeat(32)}` as Hash;
        const other = "0x1111111111111111111111111111111111111111";
        const logs = [
            transferLog({
                emitter: other,
                logIndex: 0,
                from: "0x00000000000000000000000000000000000000a1",
                to: "0x00000000000000000000000000000000000000b2",
                value: 7n,
                txHash,
            }),
        ];
        expect(transfersInReceipt(receipt(txHash, logs))).toEqual([]);
    });

    it("ignores logs from the emitter that are not Transfers", () => {
        const txHash = `0x${"55".repeat(32)}` as Hash;
        const log = {
            ...transferLog({
                emitter: NATIVE_TRANSFER_EMITTER,
                logIndex: 0,
                from: "0x00000000000000000000000000000000000000a1",
                to: "0x00000000000000000000000000000000000000b2",
                value: 7n,
                txHash,
            }),
            topics: [pad("0x01", { size: 32 })],
        } as Log;
        expect(transfersInReceipt(receipt(txHash, [log]))).toEqual([]);
    });
});

type Call = { args?: { to?: Address[] }; fromBlock: bigint; toBlock: bigint; address: string };
type FakeLog = ReturnType<typeof fakeLog>;

function fakeLog(opts: { to: string; block: number; logIndex: number; txHash?: string; value?: bigint }) {
    return {
        transactionHash: (opts.txHash ?? `0x${opts.block.toString(16).padStart(64, "0")}`) as Hash,
        logIndex: opts.logIndex,
        blockNumber: BigInt(opts.block),
        blockHash: BLOCK_HASH,
        args: {
            from: "0x00000000000000000000000000000000000000AA" as Address,
            to: opts.to as Address,
            value: opts.value ?? 1n,
        },
    };
}

function fakeClient(handler: (call: Call) => FakeLog[] | Error) {
    const calls: Call[] = [];
    const client = {
        getLogs: async (params: Call) => {
            calls.push(params);
            const result = handler(params);
            if (result instanceof Error) throw result;
            return result;
        },
    } as unknown as ArcClient;
    return { client, calls };
}

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

describe("findTransfersTo", () => {
    it("does nothing without recipients", async () => {
        const { client, calls } = fakeClient(() => []);
        expect(await findTransfersTo(client, [], 1, 10)).toEqual([]);
        expect(calls).toHaveLength(0);
    });

    it("queries the system emitter filtered by recipient", async () => {
        const { client, calls } = fakeClient(() => []);
        await findTransfersTo(client, [addr(1)], 5, 9);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.address).toBe(NATIVE_TRANSFER_EMITTER);
        expect(calls[0]?.args?.to).toEqual([getAddress(addr(1))]);
        expect([calls[0]?.fromBlock, calls[0]?.toBlock]).toEqual([5n, 9n]);
    });

    it("splits up to 400 recipients into queries of at most 100", async () => {
        const recipients = Array.from({ length: 250 }, (_, i) => addr(i + 1));
        const { client, calls } = fakeClient(() => []);
        await findTransfersTo(client, recipients, 1, 10);
        expect(calls.map((c) => c.args?.to?.length)).toEqual([100, 100, 50]);
        expect(calls.flatMap((c) => c.args?.to ?? [])).toHaveLength(250);
    });

    it("uses 4 filtered queries for exactly 400 recipients", async () => {
        const recipients = Array.from({ length: 400 }, (_, i) => addr(i + 1));
        const { client, calls } = fakeClient(() => []);
        await findTransfersTo(client, recipients, 1, 10);
        expect(calls).toHaveLength(4);
    });

    it("queries unfiltered and filters locally past 400 recipients", async () => {
        const recipients = Array.from({ length: 401 }, (_, i) => addr(i + 1));
        const { client, calls } = fakeClient(() => [
            fakeLog({ to: addr(5), block: 3, logIndex: 0 }),
            fakeLog({ to: addr(9999), block: 4, logIndex: 0 }),
        ]);
        const found = await findTransfersTo(client, recipients, 1, 10);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.args).toBeUndefined();
        expect(found.map((t) => t.to)).toEqual([addr(5)]);
    });

    it("drops logs for addresses nobody asked for even when the query was filtered", async () => {
        const { client } = fakeClient(() => [fakeLog({ to: addr(2), block: 1, logIndex: 0 })]);
        expect(await findTransfersTo(client, [addr(1)], 1, 1)).toEqual([]);
    });

    it("dedupes by tx hash and log index and sorts by block then log index", async () => {
        const dup = fakeLog({ to: addr(1), block: 7, logIndex: 3, txHash: `0x${"aa".repeat(32)}` });
        const logs = [
            dup,
            fakeLog({ to: addr(1), block: 9, logIndex: 0 }),
            fakeLog({ to: addr(1), block: 7, logIndex: 1 }),
            dup,
        ];
        // two chunks return overlapping results, as a transfer to two recipients matched by both would not, but a replayed range might
        const recipients = Array.from({ length: 150 }, (_, i) => addr(i + 1));
        const { client } = fakeClient(() => logs);
        const found = await findTransfersTo(client, recipients, 1, 10);
        expect(found.map((t) => [t.blockNumber, t.logIndex])).toEqual([
            [7, 1],
            [7, 3],
            [9, 0],
        ]);
    });

    it("lowercases what it returns", async () => {
        const { client } = fakeClient(() => [
            {
                ...fakeLog({ to: getAddress(addr(0xabc)), block: 1, logIndex: 0 }),
                transactionHash: `0x${"AB".repeat(32)}` as Hash,
            },
        ]);
        const [transfer] = await findTransfersTo(client, [getAddress(addr(0xabc))], 1, 1);
        expect(transfer?.to).toBe(addr(0xabc));
        expect(transfer?.txHash).toBe(`0x${"ab".repeat(32)}`);
    });

    it("halves a range the RPC says has too many results, down to single blocks", async () => {
        const { client, calls } = fakeClient((call) =>
            call.toBlock > call.fromBlock
                ? new Error("query exceeds max results 2000, retry with the range 1-5")
                : [fakeLog({ to: addr(1), block: Number(call.fromBlock), logIndex: 0 })],
        );
        const found = await findTransfersTo(client, [addr(1)], 1, 8);
        expect(found.map((t) => t.blockNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(calls[1]).toMatchObject({ fromBlock: 1n, toBlock: 4n });
        expect(calls[2]).toMatchObject({ fromBlock: 1n, toBlock: 2n });
    });

    it("splits on a 'requested range too large' error, only as far as needed", async () => {
        const { client, calls } = fakeClient((call) =>
            call.toBlock - call.fromBlock + 1n > 4n ? new Error("requested range too large") : [],
        );
        await findTransfersTo(client, [addr(1)], 1, 16);
        expect(calls.filter((c) => c.toBlock - c.fromBlock + 1n <= 4n)).toHaveLength(4);
        expect(calls).toHaveLength(1 + 2 + 4);
    });

    it("reads the error's details as well as its message", async () => {
        const error = Object.assign(new Error("RPC Request failed."), { details: "range too large" });
        const { client, calls } = fakeClient((call) => (call.toBlock > call.fromBlock ? error : []));
        await findTransfersTo(client, [addr(1)], 1, 2);
        expect(calls).toHaveLength(3);
    });

    it("says when it halves a range and why, and wraps a throttle so the scan's log says so", async () => {
        const log = { warn: vi.fn(), info: vi.fn() };
        const { client } = fakeClient((call) =>
            call.toBlock > call.fromBlock ? new Error("query exceeds max results 2000") : [],
        );
        await findTransfersTo(client, [addr(1)], 1, 2, log);
        expect(log.info).toHaveBeenCalledWith(
            { op: "getLogs.split", fromBlock: 1, toBlock: 2, reason: "query exceeds max results 2000" },
            expect.stringContaining("halves"),
        );

        const throttled = fakeClient(() => new Error("HTTP request failed. Status: 429"));
        const error = await findTransfersTo(throttled.client, [addr(1)], 1, 100, log).catch((e: unknown) => e);
        expect((error as Error).message).toMatch(/^Arc's RPC rate limited getLogs for blocks 1-100: /);
        expect((error as Error).cause).toBeInstanceOf(Error);
    });

    it("skips a log missing a field and says which", async () => {
        const log = { warn: vi.fn(), info: vi.fn() };
        const bad = { ...fakeLog({ to: addr(1), block: 3, logIndex: 4 }), blockHash: null };
        const good = fakeLog({ to: addr(1), block: 5, logIndex: 0 });
        const { client } = fakeClient(() => [bad, good] as unknown as FakeLog[]);
        const found = await findTransfersTo(client, [addr(1)], 1, 9, log);
        expect(found.map((t) => t.blockNumber)).toEqual([5]);
        expect(log.warn).toHaveBeenCalledWith(
            expect.objectContaining({ logIndex: 4, blockNumber: 3, missing: ["blockHash"] }),
            "Skipped a transfer log with missing fields",
        );
    });

    it("rethrows when a single block still fails", async () => {
        const { client, calls } = fakeClient(() => new Error("query exceeds max results 2000"));
        await expect(findTransfersTo(client, [addr(1)], 4, 4)).rejects.toThrow(/max results/);
        expect(calls).toHaveLength(1);
    });

    it("narrows a block too busy for one query by recipient, filtered or not", async () => {
        // The RPC answers a single block only for 25 recipients or fewer at a time.
        const recipients = Array.from({ length: 500 }, (_, i) => addr(i + 1));
        const { client, calls } = fakeClient((call) => {
            const to = call.args?.to;
            if (!to || to.length > 25) return new Error("query exceeds max results 2000");
            return to.includes(getAddress(addr(321))) ? [fakeLog({ to: addr(321), block: 7, logIndex: 4 })] : [];
        });
        const found = await findTransfersTo(client, recipients, 7, 7);
        expect(found.map((t) => [t.to, t.logIndex])).toEqual([[addr(321), 4]]);
        // Unfiltered, then 5 chunks of 100, each halved to 50 and then 25.
        expect(calls.filter((c) => c.args?.to?.length === 25)).toHaveLength(20);
    });

    it("gives up on a busy block only once it's down to one recipient", async () => {
        const { client, calls } = fakeClient(() => new Error("query exceeds max results 2000"));
        await expect(findTransfersTo(client, [addr(1), addr(2)], 4, 4)).rejects.toThrow(/max results/);
        expect(calls.map((c) => c.args?.to?.length)).toEqual([2, 1]);
    });

    it("rethrows after splitting down to a failing block", async () => {
        const { client } = fakeClient(() => new Error("query exceeds max results 2000"));
        await expect(findTransfersTo(client, [addr(1)], 1, 4)).rejects.toThrow(/max results/);
    });

    it.each([
        "HTTP request failed. Status: 429",
        "rate limit exceeded",
        "Too Many Requests",
        "request exceeded rate limit on range query",
    ])("does not split on the throttling error '%s'", async (message) => {
        const { client, calls } = fakeClient(() => new Error(message));
        await expect(findTransfersTo(client, [addr(1)], 1, 100)).rejects.toThrow(message);
        expect(calls).toHaveLength(1);
    });

    it("rethrows unrelated errors without splitting", async () => {
        const { client, calls } = fakeClient(() => new Error("connection refused"));
        await expect(findTransfersTo(client, [addr(1)], 1, 100)).rejects.toThrow("connection refused");
        expect(calls).toHaveLength(1);
    });

    it("returns nothing for an empty range", async () => {
        const { client, calls } = fakeClient(() => []);
        expect(await findTransfersTo(client, [addr(1)], 10, 9)).toEqual([]);
        expect(calls).toHaveLength(0);
    });
});
