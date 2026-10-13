import { afterAll, beforeAll, expect, test } from "vitest";
import { SOLANA_COINS } from "../../src/crosschain/catalog.ts";
import { fixedPrices } from "../../src/crosschain/prices.ts";
import { createSolanaRpc, readSolanaBalances } from "../../src/crosschain/solana.ts";
import { startFakeSolanaRpc } from "../support/fake-solana-rpc.ts";

const USDC_MINT = SOLANA_COINS.find((c) => c.symbol === "USDC")!.mint!;
const OWNER = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const prices = fixedPrices({ SOL: 100, USDC: 1 });

let fake: Awaited<ReturnType<typeof startFakeSolanaRpc>>;
let second: Awaited<ReturnType<typeof startFakeSolanaRpc>>;
beforeAll(async () => {
    fake = await startFakeSolanaRpc();
    second = await startFakeSolanaRpc();
});
afterAll(async () => {
    await fake.stop();
    await second.stop();
});

test("SOL and USDC are read with their own decimals, and the owner's case is kept", async () => {
    fake.setBalance(OWNER, 2_500_000_000n);
    fake.setTokenBalance(OWNER, USDC_MINT, 40_000_000n);

    const rows = await readSolanaBalances({ solana: createSolanaRpc([fake.url]), prices }, OWNER);

    expect(rows.map((r) => [r.coin, r.amount, r.usd])).toEqual([
        ["solana:SOL", "2.5", 250],
        ["solana:USDC", "40", 40],
    ]);
    expect(rows.every((r) => r.wallet === OWNER && r.chainId === null)).toBe(true);
});

test("a wallet with nothing still lists both coins at 0", async () => {
    const rows = await readSolanaBalances({ solana: createSolanaRpc([fake.url]), prices }, "EmptyWa11et");
    expect(rows.map((r) => [r.coin, r.amount, r.spendable])).toEqual([
        ["solana:SOL", "0", "0"],
        ["solana:USDC", "0", "0"],
    ]);
});

test("a 429 from the first URL falls back to the second", async () => {
    fake.failNext(10, 429);
    second.setBalance(OWNER, 1_000_000_000n);

    expect(await createSolanaRpc([fake.url, second.url]).getBalance(OWNER)).toBe(1_000_000_000n);
    fake.failNext(0);
});

test("both URLs failing gives null amounts, not an error", async () => {
    fake.failNext(10, 429);
    second.failNext(10, 500);

    const rows = await readSolanaBalances({ solana: createSolanaRpc([fake.url, second.url]), prices }, OWNER);

    expect(rows.map((r) => [r.coin, r.amount, r.spendable, r.usd])).toEqual([
        ["solana:SOL", null, null, null],
        ["solana:USDC", null, null, null],
    ]);
    fake.failNext(0);
    second.failNext(0);
});

test("getLatestBlockhash returns blockhash and lastValidBlockHeight", async () => {
    fake.setBlockhash("Hash1111", 900);
    expect(await createSolanaRpc([fake.url]).getLatestBlockhash()).toEqual({
        blockhash: "Hash1111",
        lastValidBlockHeight: 900,
    });
});

test("getSignatureStatuses returns null for an unknown signature", async () => {
    fake.setSignatureStatus("sigKnown", { confirmationStatus: "finalized", err: null });
    expect(await createSolanaRpc([fake.url]).getSignatureStatuses(["sigKnown", "sigUnknown"])).toEqual([
        { confirmationStatus: "finalized", err: null },
        null,
    ]);
});

test("getAddressLookupTables decodes the address list after the 56-byte header", async () => {
    const a = "11111111111111111111111111111111";
    const b = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    fake.setLookupTable("Table1", [a, b]);
    expect(await createSolanaRpc([fake.url]).getAddressLookupTables(["Table1"])).toEqual([
        { address: "Table1", addresses: [a, b] },
    ]);
});

test("getAccountInfo returns null for a missing account and the owner for an existing one", async () => {
    const rpc = createSolanaRpc([fake.url]);
    fake.setAccount("Funded", { owner: "11111111111111111111111111111111", lamports: 5n });
    expect(await rpc.getAccountInfo("Missing")).toBeNull();
    expect(await rpc.getAccountInfo("Funded")).toEqual({ owner: "11111111111111111111111111111111", lamports: 5n });
});

test("a second URL is tried when the first fails", async () => {
    fake.failNext(10, 500);
    second.setBlockhash("FromSecond", 7);
    expect(await createSolanaRpc([fake.url, second.url]).getLatestBlockhash()).toEqual({
        blockhash: "FromSecond",
        lastValidBlockHeight: 7,
    });
    fake.failNext(0);
});
