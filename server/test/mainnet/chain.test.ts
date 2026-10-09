import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import type { Address, Hash } from "viem";
import { describe, expect, test } from "vitest";
import { ARC_CHAIN_ID, ARC_RPC_URLS, assertArc, createArcClient } from "../../src/chain/arc.ts";
import { findTransfersTo, transfersInReceipt } from "../../src/chain/native-transfers.ts";

// Real Arc mainnet transactions.
export const PLAIN = {
    hash: "0xd346d5673985926cf8fdeeb40763244430943f795e84e048a20ef9797af95deb",
    block: 24998035,
    from: "0xf56ed4fb3308d58346a07692320c851936480d33",
    to: "0x84ab385972b366abcd7dfb6792f4624d92a224a4",
    value: 3_127_300_000_000_000n,
} as const;
const ERC20 = {
    hash: "0xe733e1a07d27ae01fd8af9afa7b25271de64813712032a9888c2c9ca454c4c9f",
    block: 24997957,
    from: "0x6ea99501b46040e9c99c6ffccd7d64ea8f726476",
    to: "0xfd4960f33670f3477ebe817b184dd59fc4961437",
    value: 1_000_000_000_000_000n,
} as const;
const FORWARD = "0x7f17b18f32b0ff075f623b0f546d5b1c8feed285707250fb60d4f8ef3cd180c2" as Hash;
const TRANSFER_FROM = "0xef755354153cae8c37fd17648d99bb8998d45e9f2774b8c15789083c53354b63" as Hash;

const client = createArcClient(ARC_RPC_URLS);
const decoys = (count: number) =>
    Array.from({ length: count }, () => privateKeyToAddress(generatePrivateKey()).toLowerCase() as Address);

describe("the chain", () => {
    test.each(ARC_RPC_URLS)("%s reports chain 5042", async (url) => {
        const single = createArcClient([url]);
        expect(await single.getChainId()).toBe(ARC_CHAIN_ID);
        await expect(assertArc(single)).resolves.toBeUndefined();
    });

    test("a client falls back when the first rpc is unreachable", async () => {
        const fallbackClient = createArcClient(["http://127.0.0.1:9", ...ARC_RPC_URLS]);
        await expect(assertArc(fallbackClient)).resolves.toBeUndefined();
        expect(Number(await fallbackClient.getBlockNumber())).toBeGreaterThan(PLAIN.block);
    });

    test("assertArc rejects an rpc that is not arc", async () => {
        const other = createArcClient(["http://127.0.0.1:9"]);
        await expect(assertArc(other)).rejects.toThrow();
    });
});

describe("transfers in a receipt", () => {
    test("a plain native send is one transfer", async () => {
        const receipt = await client.getTransactionReceipt({ hash: PLAIN.hash });
        const transfers = transfersInReceipt(receipt);
        expect(transfers).toHaveLength(1);
        expect(transfers[0]).toMatchObject({
            txHash: PLAIN.hash,
            logIndex: 0,
            blockNumber: PLAIN.block,
            from: PLAIN.from,
            to: PLAIN.to,
            value: PLAIN.value,
        });
    });

    test("an erc-20 transfer through 0x3600 is counted once", async () => {
        const receipt = await client.getTransactionReceipt({ hash: ERC20.hash });
        expect(receipt.logs).toHaveLength(2);
        const transfers = transfersInReceipt(receipt);
        expect(transfers).toHaveLength(1);
        expect(transfers[0]).toMatchObject({
            logIndex: 0,
            blockNumber: ERC20.block,
            from: ERC20.from,
            to: ERC20.to,
            value: ERC20.value,
        });
    });

    test("value a contract forwards is a transfer per hop", async () => {
        const receipt = await client.getTransactionReceipt({ hash: FORWARD });
        const transfers = transfersInReceipt(receipt);
        expect(transfers).toHaveLength(3);
        expect(transfers.map((transfer) => transfer.value)).toEqual([
            70_785n * 10n ** 15n,
            70_785n * 10n ** 15n,
            70_785n * 10n ** 15n,
        ]);
        expect(transfers.map((transfer) => transfer.logIndex)).toEqual([0, 1, 3]);
        // The hops chain: each one's recipient is the next one's sender, except the last, which comes from the router.
        expect(transfers[0]!.to).toBe(transfers[1]!.from);
    });

    test("transferFrom on 0x3600 is counted once", async () => {
        const receipt = await client.getTransactionReceipt({ hash: TRANSFER_FROM });
        expect(receipt.logs).toHaveLength(2);
        const transfers = transfersInReceipt(receipt);
        expect(transfers).toHaveLength(1);
        expect(transfers[0]).toMatchObject({
            logIndex: 1,
            blockNumber: 24998689,
            from: "0xf70da97812cb96acdf810712aa562db8dfa3dbef",
            to: "0xe00cf2faae27eea6f794b5fe29f8fbea14f93f05",
            value: 2_895_493_000_000_000_000n,
        });
    });
});

describe("finding transfers to addresses", () => {
    const real = PLAIN.to as Address;

    test("a narrow range finds exactly the transfer", async () => {
        const found = await findTransfersTo(client, [real], PLAIN.block - 5, PLAIN.block + 5);
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ txHash: PLAIN.hash, to: PLAIN.to, from: PLAIN.from, value: PLAIN.value });
    });

    test("an empty range around it finds nothing", async () => {
        expect(await findTransfersTo(client, [real], PLAIN.block + 1, PLAIN.block + 5)).toEqual([]);
    });

    test("150 recipients are queried in two chunks and still find it", async () => {
        const found = await findTransfersTo(client, [...decoys(150), real], PLAIN.block - 5, PLAIN.block + 5);
        expect(found.map((transfer) => transfer.txHash)).toEqual([PLAIN.hash]);
    });

    test("a recipient found only in the second chunk is not lost", async () => {
        const found = await findTransfersTo(client, [real, ...decoys(150)], PLAIN.block - 5, PLAIN.block + 5);
        expect(found.map((transfer) => transfer.txHash)).toEqual([PLAIN.hash]);
    });

    test("a 3000 block range is split as needed and still finds it", async () => {
        const found = await findTransfersTo(client, [real], PLAIN.block - 1500, PLAIN.block + 1500);
        expect(found.length).toBeGreaterThanOrEqual(1);
        expect(found.every((transfer) => transfer.to === PLAIN.to)).toBe(true);
        expect(found.filter((transfer) => transfer.txHash === PLAIN.hash)).toHaveLength(1);
        const blocks = found.map((transfer) => transfer.blockNumber);
        expect(blocks).toEqual([...blocks].sort((a, b) => a - b));
    });

    test("an unfiltered scan of many recipients matches locally", async () => {
        // Past 400 recipients the query drops the address filter and matches in memory.
        const found = await findTransfersTo(client, [...decoys(450), real], PLAIN.block - 5, PLAIN.block + 5);
        expect(found.map((transfer) => transfer.txHash)).toEqual([PLAIN.hash]);
    });
});
