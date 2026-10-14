import type { Address } from "viem";
import { expect, test } from "vitest";
import { FakeTrader } from "../support/fake-trader.ts";

const RECIPIENT: Address = "0x000000000000000000000000000000000000b0b0";

const newTrader = () =>
    new FakeTrader({
        bookOf: () => {
            throw new Error("no books here");
        },
    });

async function submitted(batch: ReturnType<FakeTrader["wrapUsdc"]>): Promise<string> {
    const result = await batch;
    if (result.kind !== "submitted") throw new Error(`expected a submitted batch, got ${result.kind}`);
    return result.transactionId;
}

test("a confirmed wrap moves native USDC into pUSD", async () => {
    const trader = newTrader();
    trader.setBalance(20_000_000n);
    trader.setUsdc(5_000_000n);
    const id = await submitted(trader.wrapUsdc(5_000_000n));
    expect(trader.batches).toMatchObject([{ id, kind: "wrap", amountE6: 5_000_000n }]);
    expect(await trader.transaction(id)).toEqual({ state: "pending", hash: null, errorMsg: null });
    expect(await trader.usdcBalanceE6()).toBe(5_000_000n);
    expect(await trader.balanceE6()).toBe(20_000_000n);

    trader.confirmBatch(id);
    expect(await trader.usdcBalanceE6()).toBe(0n);
    expect(await trader.balanceE6()).toBe(25_000_000n);
    const record = await trader.transaction(id);
    expect(record).toMatchObject({ state: "confirmed", errorMsg: null });
    expect(record.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(trader.burns).toEqual([]);
});

test("a confirmed unwrapAndBurn lowers pUSD and records a burn", async () => {
    const trader = newTrader();
    trader.setBalance(50_000_000n);
    const id = await submitted(
        trader.unwrapAndBurn({ amountE6: 12_000_000n, maxFeeE6: 100_000n, recipient: RECIPIENT }),
    );
    expect(trader.batches).toMatchObject([
        { id, kind: "unwrap-and-burn", amountE6: 12_000_000n, maxFeeE6: 100_000n, recipient: RECIPIENT },
    ]);
    expect(await trader.balanceE6()).toBe(50_000_000n);
    expect(trader.burns).toEqual([]);

    trader.confirmBatch(id);
    expect(await trader.balanceE6()).toBe(38_000_000n);
    expect(await trader.usdcBalanceE6()).toBe(0n);
    const { hash } = await trader.transaction(id);
    expect(hash).not.toBeNull();
    expect(trader.burns).toEqual([{ txHash: hash, amountE6: 12_000_000n }]);
    expect(await trader.burnLog(hash as `0x${string}`)).toEqual({ amountE6: 12_000_000n });
    expect(await trader.burnEvents({ since: new Date(0) })).toEqual(trader.burns);
    expect(await trader.burnLog(`0x${"ab".repeat(32)}`)).toBeNull();
});

test("partial unwraps without a burn", async () => {
    const trader = newTrader();
    trader.setBalance(50_000_000n);
    trader.onNextBatch("partial");
    const id = await submitted(
        trader.unwrapAndBurn({ amountE6: 12_000_000n, maxFeeE6: 100_000n, recipient: RECIPIENT }),
    );
    trader.confirmBatch(id);
    expect(await trader.balanceE6()).toBe(38_000_000n);
    expect(await trader.usdcBalanceE6()).toBe(12_000_000n);
    expect(trader.burns).toEqual([]);
    const { hash } = await trader.transaction(id);
    expect(await trader.burnLog(hash as `0x${string}`)).toBeNull();
    // The mode lasts one batch
    const next = await submitted(
        trader.unwrapAndBurn({ amountE6: 1_000_000n, maxFeeE6: 100_000n, recipient: RECIPIENT }),
    );
    trader.confirmBatch(next);
    expect(trader.burns).toHaveLength(1);
});

test("a partial batch that the relayer fails still ran its unwrap", async () => {
    const trader = newTrader();
    trader.setBalance(50_000_000n);
    trader.onNextBatch("partial");
    const id = await submitted(
        trader.unwrapAndBurn({ amountE6: 12_000_000n, maxFeeE6: 100_000n, recipient: RECIPIENT }),
    );
    trader.failBatch(id);
    expect(await trader.usdcBalanceE6()).toBe(12_000_000n);
    expect(await trader.balanceE6()).toBe(38_000_000n);
    expect(trader.burns).toEqual([]);
    expect(await trader.transaction(id)).toMatchObject({ state: "failed" });
});

test("lagBalance holds balanceE6 until syncBalance", async () => {
    const trader = newTrader();
    trader.setBalance(20_000_000n);
    trader.setUsdc(5_000_000n);
    trader.lagBalance(true);
    const id = await submitted(trader.wrapUsdc(5_000_000n));
    trader.confirmBatch(id);
    expect(await trader.balanceE6()).toBe(20_000_000n);
    expect(await trader.usdcBalanceE6()).toBe(0n);
    await trader.syncBalance();
    expect(await trader.balanceE6()).toBe(25_000_000n);

    trader.lagBalance(false);
    trader.setBalance(1n);
    expect(await trader.balanceE6()).toBe(1n);
});

test("refuse answers refused and records nothing", async () => {
    const trader = newTrader();
    trader.setUsdc(5_000_000n);
    trader.onNextBatch("refuse");
    const refused = await trader.wrapUsdc(5_000_000n);
    expect(refused).toMatchObject({ kind: "refused" });
    expect(refused.kind === "refused" && refused.message).toBeTruthy();
    expect(trader.batches).toEqual([]);

    trader.onNextBatch("refuse");
    expect(await trader.unwrapAndBurn({ amountE6: 1_000_000n, maxFeeE6: 10_000n, recipient: RECIPIENT })).toMatchObject(
        {
            kind: "refused",
        },
    );
    expect(trader.batches).toEqual([]);
    // The refusal lasted one call
    expect((await trader.wrapUsdc(5_000_000n)).kind).toBe("submitted");
});

test("unknown-lost answers unknown and nothing ever ran", async () => {
    const trader = newTrader();
    trader.setUsdc(5_000_000n);
    trader.onNextBatch("unknown-lost");
    expect(await trader.wrapUsdc(5_000_000n)).toEqual({ kind: "unknown" });
    expect(trader.batches).toEqual([]);
    expect(await trader.usdcBalanceE6()).toBe(5_000_000n);
});

test("unknown-executed answers unknown, keeps the batch and applies it on confirm", async () => {
    const trader = newTrader();
    trader.setBalance(0n);
    trader.setUsdc(5_000_000n);
    trader.onNextBatch("unknown-executed");
    expect(await trader.wrapUsdc(5_000_000n)).toEqual({ kind: "unknown" });
    expect(trader.batches).toHaveLength(1);
    expect(await trader.usdcBalanceE6()).toBe(5_000_000n);

    trader.confirmBatch(trader.batches[0]!.id);
    expect(await trader.usdcBalanceE6()).toBe(0n);
    expect(await trader.balanceE6()).toBe(5_000_000n);
});

test("a failed batch applies nothing", async () => {
    const trader = newTrader();
    trader.setBalance(20_000_000n);
    trader.setUsdc(5_000_000n);
    const id = await submitted(trader.wrapUsdc(5_000_000n));
    trader.failBatch(id);
    expect(await trader.usdcBalanceE6()).toBe(5_000_000n);
    expect(await trader.balanceE6()).toBe(20_000_000n);
    expect(await trader.transaction(id)).toMatchObject({ state: "failed", hash: null });
    expect((await trader.transaction(id)).errorMsg).toBeTruthy();
});

test("a batch confirmed without the funds it moves is a mistake in the test", async () => {
    const trader = newTrader();
    trader.setBalance(1_000_000n);
    const unwrap = await submitted(
        trader.unwrapAndBurn({ amountE6: 2_000_000n, maxFeeE6: 10_000n, recipient: RECIPIENT }),
    );
    expect(() => trader.confirmBatch(unwrap)).toThrow(/pUSD/);
    const wrap = await submitted(trader.wrapUsdc(1n));
    expect(() => trader.confirmBatch(wrap)).toThrow(/native USDC/);
});

test("derivedWallet defaults to a matching wallet with code and setDerived changes it", async () => {
    const trader = newTrader();
    const first = await trader.derivedWallet();
    expect(first.configured).toBe(first.derived);
    expect(first.hasCode).toBe(true);

    const other: Address = "0x000000000000000000000000000000000000dEaD";
    trader.setDerived({ derived: other });
    expect(await trader.derivedWallet()).toEqual({ configured: first.configured, derived: other, hasCode: true });
    trader.setDerived({ hasCode: false });
    expect((await trader.derivedWallet()).hasCode).toBe(false);
});

test("transaction answers the relayer record of a redemption too", async () => {
    const trader = newTrader();
    const { transactionId } = await trader.redeem("0xc");
    expect(await trader.transaction(transactionId)).toEqual({ state: "pending", hash: null, errorMsg: null });
    trader.confirm(transactionId);
    expect(await trader.transaction(transactionId)).toMatchObject({ state: "confirmed", errorMsg: null });
    const failed = (await trader.redeem("0xd")).transactionId;
    trader.failTransaction(failed);
    expect(await trader.transaction(failed)).toMatchObject({ state: "failed" });
});
