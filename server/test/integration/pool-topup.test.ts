import { parseUnits } from "viem";
import { afterEach, describe, expect, test, vi } from "vitest";
import { fromDecimal, toDecimal } from "../../src/db/money.ts";
import type { PoolRebalanceDoc } from "../../src/db/mongo.ts";
import { POOL_ERRORS } from "../../src/predictions/rebalance-log.ts";
import { poolHarness, type PoolHarness } from "../support/pool-harness.ts";

const e6 = (usdc: string) => parseUnits(usdc, 6);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const POOL_WALLET = "0x1111111111111111111111111111111111111111";
const FORWARD = "0x00000000000000000000000000000000000000000000000000000000000000f0";
const BURN = "0x00000000000000000000000000000000000000000000000000000000000000b0";
/** max(3 * 71_067, 71_067 + 100_000), the maxFee the fake Iris's high fee gives a top-up. */
const MAX_FEE = 213_201n;
/** What a $50 top-up must find in the wallet before it wraps. */
const THRESHOLD = e6("50") - MAX_FEE;
const IDLE_WARNING = "Native USDC is idle in the pool wallet";

const opened: PoolHarness[] = [];
async function open(options: Parameters<typeof poolHarness>[0] = {}) {
    const harness = await poolHarness(options);
    opened.push(harness);
    return harness;
}
afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(opened.splice(0).map((harness) => harness.stop()));
});

/** Moves the clock on and runs one rebalancer pass. */
async function step(h: PoolHarness, ms = 30_000) {
    h.advance(ms);
    await h.rebalancer.tick();
}

/** Runs passes `ms` apart until the fake relayer holds `count` batches, and returns how long that took. */
async function untilBatches(h: PoolHarness, count: number, ms: number, limit = 3 * HOUR) {
    let waited = 0;
    while (h.trader.batches.length < count && waited < limit) {
        await step(h, ms);
        waited += ms;
    }
    return waited;
}

/** A top-up whose burn Circle has forwarded and whose USDC is on its way into the wallet: wrapping, or stuck. */
function seedWrapping(
    h: PoolHarness,
    o: { usdc?: string; state?: "wrapping" | "stuck"; at?: Date; patch?: Partial<PoolRebalanceDoc> } = {},
) {
    return h.seed({
        direction: "arc_to_polygon",
        usdc: o.usdc ?? "50",
        state: o.state ?? "wrapping",
        ...(o.at && { at: o.at }),
        patch: {
            maxFeeE6: toDecimal(MAX_FEE),
            mintRecipient: POOL_WALLET,
            arc: {
                approveNonce: 0,
                approveRawTx: "0x01",
                approveTxHash: "0x02",
                burnNonce: 1,
                burnRawTx: "0x03",
                burnTxHash: BURN,
            },
            iris: { checkedAt: null, forwardTxHash: FORWARD, feeExecutedE6: toDecimal(71_067n), delayReason: null },
            ...o.patch,
        },
    });
}

/** Queues a $50 top-up and runs it until its burn is mined: the row is `forwarding` with the burn hash stored. */
async function seedBurned(h: PoolHarness) {
    const row = await h.queue({ direction: "arc_to_polygon", usdc: "50" });
    await h.pass();
    const burned = await h.rowOf(row._id);
    expect(burned.state).toBe("forwarding");
    return burned;
}

const floatOf = async (h: PoolHarness) => (await h.database.collections.poolFloat.findOne({ _id: "polygon" }))!;

describe("the top-up from the burn to a wrapped pUSD", () => {
    test("end to end: queued, sending, both Arc transactions mined, forwarding, Iris pending then complete, wrapping, wrap confirmed, forced read, done", async () => {
        const h = await open({ poolUsdc: "100" });
        h.trader.lagBalance(true);
        const states: string[] = [];
        h.bus.on("pool-rebalance:updated", ({ rebalance }) => states.push(rebalance.state));
        const row = await h.queue({ direction: "arc_to_polygon", usdc: "50" });

        await h.pass();
        const burned = await h.rowOf(row._id);
        expect(burned.state).toBe("forwarding");
        const burn = burned.arc.burnTxHash!;
        expect(await h.messenger.calls()).toHaveLength(1);

        h.iris.setPending(burn);
        await step(h);
        expect(await h.rowOf(row._id)).toMatchObject({ state: "forwarding", iris: { forwardTxHash: null } });
        expect((await h.rowOf(row._id)).iris.checkedAt?.getTime()).toBe(h.clock.t);

        h.iris.setForwarded(burn, FORWARD, { domain: 26, feeExecuted: 71_067 });
        h.trader.setUsdc(e6("50") - 71_067n);
        await step(h);
        const forwarded = await h.rowOf(row._id);
        expect(forwarded).toMatchObject({ state: "wrapping", iris: { forwardTxHash: FORWARD } });
        expect(fromDecimal(forwarded.iris.feeExecutedE6!)).toBe(71_067n);
        expect(h.iris.requests().filter((url) => url.startsWith("/v2/messages/"))).toContain(
            `/v2/messages/26?transactionHash=${burn}`,
        );

        await step(h, 2_000);
        const wrapping = await h.rowOf(row._id);
        const batch = h.trader.batches[0]!;
        expect(h.trader.batches).toHaveLength(1);
        expect(batch).toMatchObject({ kind: "wrap", amountE6: e6("50") - 71_067n });
        expect(wrapping.polygon.wrapTransactionId).toBe(batch.id);
        expect(wrapping.polygon.wrapAttemptedAt?.getTime()).toBeLessThanOrEqual(h.clock.t);
        expect(wrapping.polygon.wrapSubmittedAt).not.toBeNull();
        expect(fromDecimal(wrapping.polygon.balanceBeforeE6!)).toBe(e6("100"));
        expect(fromDecimal(wrapping.polygon.mintedE6!)).toBe(batch.amountE6);

        // The wallet is wrapped, but the CLOB still shows the old balance, so free float has not moved
        h.trader.confirmBatch(batch.id);
        await h.service.refreshFloat();
        expect(fromDecimal((await floatOf(h)).balanceE6)).toBe(e6("100"));
        expect(await h.rowOf(row._id)).toMatchObject({ state: "wrapping", polygon: { wrapFinalAt: null } });

        await step(h);
        const done = await h.rowOf(row._id);
        expect(done.state).toBe("done");
        expect(done.active).toBeUndefined();
        expect(done.doneAt).not.toBeNull();
        expect(done.polygon.wrapFinalAt).not.toBeNull();
        expect(fromDecimal((await floatOf(h)).balanceE6)).toBe(e6("100") + batch.amountE6);
        expect(states).toEqual(["sending", "forwarding", "wrapping", "done"]);
        expect(await h.messenger.calls()).toHaveLength(1);
        expect(h.trader.batches).toHaveLength(1);
    });

    test("a delayReason logs 'Pool rebalance burn delayed' and neither fails nor re-burns", async () => {
        const h = await open();
        const row = await seedBurned(h);
        h.iris.setDelayed(row.arc.burnTxHash!, "insufficient_fee", 26);

        for (let i = 0; i < 4; i++) await step(h);

        const after = await h.rowOf(row._id);
        expect(after.state).toBe("forwarding");
        expect(after.iris.delayReason).toBe("insufficient_fee");
        expect(await h.messenger.calls()).toHaveLength(1);
        expect(h.logged(POOL_ERRORS.burnDelayed)).toMatchObject([
            {
                level: 50,
                rebalance: row._id.toString(),
                delayReason: "insufficient_fee",
                message: { status: "pending_confirmations", delayReason: "insufficient_fee" },
            },
        ]);
    });

    test("a stalled Iris after the burn never fails, becomes stuck after 2 hours with the hourly error, and a late complete moves it on", async () => {
        const h = await open();
        const row = await seedBurned(h);
        const burn = row.arc.burnTxHash!;
        h.iris.setPending(burn);

        h.advance(2 * HOUR);
        await h.rebalancer.tick();
        // Exactly 2 hours is not older than 2 hours
        expect((await h.rowOf(row._id)).state).toBe("forwarding");
        expect(h.logged(POOL_ERRORS.stuck)).toHaveLength(0);

        await step(h);
        const stuck = await h.rowOf(row._id);
        expect(stuck.state).toBe("stuck");
        expect(stuck.active).toBeUndefined();
        expect(h.logged(POOL_ERRORS.stuck)).toMatchObject([
            {
                level: 50,
                rebalance: row._id.toString(),
                burnTxHash: burn,
                iris: { status: "pending_confirmations" },
            },
        ]);

        // The stuck row is still followed, and the error comes once an hour
        const polls = () => h.iris.requests().filter((url) => url.startsWith("/v2/messages/")).length;
        const before = polls();
        await step(h);
        expect(polls()).toBe(before + 1);
        await step(h, 30 * MINUTE);
        expect(h.logged(POOL_ERRORS.stuck)).toHaveLength(1);
        await step(h, 31 * MINUTE);
        expect(h.logged(POOL_ERRORS.stuck)).toHaveLength(2);
        expect(await h.messenger.calls()).toHaveLength(1);

        // The late complete moves the row on without making it active again
        h.iris.setForwarded(burn, FORWARD, { domain: 26, feeExecuted: 71_067 });
        h.trader.setUsdc(e6("50") - 71_067n);
        await step(h);
        const wrapping = await h.rowOf(row._id);
        expect(wrapping.state).toBe("wrapping");
        expect(wrapping.active).toBeUndefined();
        expect(wrapping.iris.forwardTxHash).toBe(FORWARD);

        await step(h, 2_000);
        h.trader.confirmBatch(h.trader.batches[0]!.id);
        await step(h);
        const done = await h.rowOf(row._id);
        expect(done.state).toBe("done");
        expect(done.active).toBeUndefined();
        expect(await h.messenger.calls()).toHaveLength(1);
    });

    test("Circle reporting the forward failed leaves the row forwarding and burns nothing again", async () => {
        const h = await open();
        const row = await seedBurned(h);
        h.iris.setForwardFailed(row.arc.burnTxHash!);

        for (let i = 0; i < 3; i++) await step(h);

        expect((await h.rowOf(row._id)).state).toBe("forwarding");
        expect(await h.messenger.calls()).toHaveLength(1);
        expect(h.trader.batches).toHaveLength(0);
    });

    test("a new worker on the same rows resumes forwarding from the stored burn hash and signs and burns nothing", async () => {
        const h = await open();
        const row = await seedBurned(h);
        const burn = row.arc.burnTxHash!;
        const nonce = await h.chain.getTransactionCount({ address: h.signer.address });
        expect(nonce).toBe(2);

        h.restart();
        h.iris.setForwarded(burn, FORWARD, { domain: 26, feeExecuted: 71_067 });
        await step(h);

        expect(await h.rowOf(row._id)).toMatchObject({ state: "wrapping", iris: { forwardTxHash: FORWARD } });
        await h.payouts.tick();
        expect(await h.messenger.calls()).toHaveLength(1);
        expect(await h.chain.getTransactionCount({ address: h.signer.address })).toBe(nonce);
        expect(h.iris.requests().at(-1)).toBe(`/v2/messages/26?transactionHash=${burn}`);
    });

    test("Iris answering 429 or unreachable while forwarding leaves the state unchanged and backs the shared limiter off", async () => {
        const h = await open();
        const row = await seedBurned(h);
        h.iris.setForwarded(row.arc.burnTxHash!, FORWARD, { domain: 26 });

        h.iris.failWith(500);
        await step(h);
        expect((await h.rowOf(row._id)).state).toBe("forwarding");
        expect(h.limiter.blockedUntil()).toBe(0);
        expect(h.logged("Iris couldn't be asked about a pool move")).toHaveLength(1);

        h.iris.failWith(429);
        await step(h);
        expect((await h.rowOf(row._id)).state).toBe("forwarding");
        expect(h.limiter.blockedUntil()).toBe(h.clock.t + 5 * MINUTE);

        // The backoff holds the poll back until it is over, then the answer is taken
        h.iris.failWith(null);
        const asked = h.iris.requests().length;
        await step(h);
        expect(h.iris.requests()).toHaveLength(asked);
        expect((await h.rowOf(row._id)).state).toBe("forwarding");
        await step(h, 5 * MINUTE);
        expect((await h.rowOf(row._id)).state).toBe("wrapping");
        expect(await h.messenger.calls()).toHaveLength(1);
    });

    test("Payouts and the rebalancer share one Iris budget", async () => {
        const h = await open();
        const row = await seedBurned(h);
        h.iris.setForwarded(row.arc.burnTxHash!, FORWARD, { domain: 26 });
        const asked = () => h.iris.requests().filter((url) => url.startsWith("/v2/messages/")).length;

        // A 429 the rebalancer sees blocks the limiter Payouts takes from
        h.iris.failWith(429);
        await step(h);
        expect(h.limiter.take(h.clock.t)).toBe(false);

        // A 429 Payouts saw (it calls backoff) holds the rebalancer's poll back
        h.iris.failWith(null);
        h.advance(6 * MINUTE);
        h.limiter.backoff(h.clock.t);
        const before = asked();
        await step(h);
        expect(asked()).toBe(before);
        expect((await h.rowOf(row._id)).state).toBe("forwarding");

        await step(h, 5 * MINUTE);
        expect((await h.rowOf(row._id)).state).toBe("wrapping");
    });
});

describe("the wrap", () => {
    test("the wrap waits until the wallet holds at least amount minus maxFee, and wraps at exactly that", async () => {
        const h = await open();
        const row = await seedWrapping(h);

        h.trader.setUsdc(THRESHOLD - 1n);
        await step(h);
        await step(h);
        expect(h.trader.batches).toHaveLength(0);
        expect(await h.rowOf(row._id)).toMatchObject({
            state: "wrapping",
            polygon: { wrapAttemptedAt: null, wrapTransactionId: null },
        });

        h.trader.setUsdc(THRESHOLD);
        await step(h);
        expect(h.trader.batches).toHaveLength(1);
        expect(h.trader.batches[0]).toMatchObject({ kind: "wrap", amountE6: THRESHOLD });
    });

    test("the wrap wraps the whole balance, not the amount", async () => {
        const h = await open({ poolUsdc: "100" });
        const row = await seedWrapping(h);
        h.trader.setUsdc(e6("60"));
        // What the row holds at the moment the batch is sent
        const atSend: PoolRebalanceDoc[] = [];
        const send = h.trader.wrapUsdc.bind(h.trader);
        vi.spyOn(h.trader, "wrapUsdc").mockImplementation(async (amountE6) => {
            atSend.push(await h.rowOf(row._id));
            return send(amountE6);
        });

        await step(h);

        expect(atSend).toHaveLength(1);
        expect(atSend[0]!.polygon.wrapAttemptedAt).not.toBeNull();
        expect(atSend[0]!.polygon.wrapTransactionId).toBeNull();
        expect(fromDecimal(atSend[0]!.polygon.mintedE6!)).toBe(e6("60"));
        expect(fromDecimal(atSend[0]!.polygon.balanceBeforeE6!)).toBe(e6("100"));

        expect(h.trader.batches).toHaveLength(1);
        expect(h.trader.batches[0]).toMatchObject({ amountE6: e6("60") });
        const sent = await h.rowOf(row._id);
        expect(fromDecimal(sent.polygon.mintedE6!)).toBe(e6("60"));
        expect(fromDecimal(sent.polygon.balanceBeforeE6!)).toBe(e6("100"));
        expect(sent.polygon.wrapTransactionId).toBe("batch-1");
    });

    test("a failed wrap batch retries after 1, 5, 15 minutes then hourly, wrapping whatever the balance is", async () => {
        const h = await open();
        const row = await seedWrapping(h);
        const delays = [1, 5, 15, 60, 60];
        h.trader.setUsdc(e6("49.9"));
        await step(h);

        for (const [n, minutes] of delays.entries()) {
            expect(h.trader.batches).toHaveLength(n + 1);
            h.trader.failBatch(h.trader.batches[n]!.id);

            // The failing tick clears the attempt; the retry is due the delay after it
            await step(h);
            const cleared = await h.rowOf(row._id);
            expect(cleared.polygon).toMatchObject({ wrapTransactionId: null, wrapAttemptedAt: null });
            expect(cleared.attempts).toBe(n + 1);
            expect(cleared.nextAt?.getTime()).toBe(h.clock.t + minutes * MINUTE);
            expect(cleared.lastError).toBe("the relayer failed the batch");

            const balance = e6("49.9") + BigInt(n + 1);
            h.trader.setUsdc(balance);
            const waited = await untilBatches(h, n + 2, minutes >= 60 ? 5 * MINUTE : 30_000);
            expect(waited).toBe(minutes * MINUTE);
            expect(h.trader.batches[n + 1]).toMatchObject({ amountE6: balance });
        }
    });

    test("a second attempt after a success does nothing", async () => {
        const h = await open();
        const row = await seedWrapping(h);
        h.trader.setUsdc(e6("49.9"));
        await step(h);
        h.trader.confirmBatch("batch-1");
        await step(h);
        expect((await h.rowOf(row._id)).state).toBe("done");

        h.trader.setUsdc(e6("49.9"));
        for (let i = 0; i < 3; i++) await step(h, 10 * MINUTE);

        expect(h.trader.batches).toHaveLength(1);
        expect((await h.rowOf(row._id)).state).toBe("done");
    });

    test("a stored batch id is polled and never submitted twice", async () => {
        const h = await open();
        const row = await seedWrapping(h);
        h.trader.setUsdc(e6("49.9"));
        await step(h);

        // The USDC still shows in the wallet while the batch is pending, and the row waits for the batch
        for (let i = 0; i < 5; i++) await step(h, 2 * MINUTE);

        expect(h.trader.batches).toHaveLength(1);
        expect((await h.rowOf(row._id)).polygon.wrapTransactionId).toBe("batch-1");
    });

    test("a wrap unconfirmed for 30 minutes is retried", async () => {
        const h = await open();
        const row = await seedWrapping(h);
        h.trader.setUsdc(e6("49.9"));
        await step(h);
        const submittedAt = (await h.rowOf(row._id)).polygon.wrapSubmittedAt!.getTime();

        h.advance(29 * MINUTE);
        await h.rebalancer.tick();
        expect((await h.rowOf(row._id)).polygon.wrapTransactionId).toBe("batch-1");

        h.advance(submittedAt + 30 * MINUTE - h.clock.t);
        await h.rebalancer.tick();
        const cleared = await h.rowOf(row._id);
        expect(cleared.polygon).toMatchObject({ wrapTransactionId: null, wrapAttemptedAt: null });
        expect(cleared.attempts).toBe(1);
        expect(cleared.nextAt?.getTime()).toBe(h.clock.t + MINUTE);

        await step(h);
        await step(h);
        expect(h.trader.batches).toHaveLength(2);
        expect((await h.rowOf(row._id)).polygon.wrapTransactionId).toBe("batch-2");
    });

    test("a lookup that throws changes nothing, however long it lasts", async () => {
        const h = await open();
        const row = await seedWrapping(h);
        h.trader.setUsdc(e6("49.9"));
        await step(h);
        const stored = await h.rowOf(row._id);
        h.trader.failTransactionCheck(true);

        for (let i = 0; i < 4; i++) await step(h, 20 * MINUTE);

        const after = await h.rowOf(row._id);
        expect(after.polygon).toEqual(stored.polygon);
        expect(after.attempts).toBe(0);
        expect(h.trader.batches).toHaveLength(1);
    });

    test("the retry continues while the row is stuck", async () => {
        const h = await open();
        const row = await seedWrapping(h);
        h.trader.setUsdc(e6("49.9"));
        await step(h);
        h.trader.failBatch("batch-1");
        h.advance(2 * HOUR);
        await h.rebalancer.tick();
        // The first tick past 2 hours makes the row stuck, before anything else
        expect((await h.rowOf(row._id)).state).toBe("stuck");
        expect(h.logged(POOL_ERRORS.stuck)).toHaveLength(1);

        await step(h);
        expect((await h.rowOf(row._id)).attempts).toBe(1);
        await step(h, 2 * MINUTE);
        expect(h.trader.batches).toHaveLength(2);
        expect((await h.rowOf(row._id)).state).toBe("stuck");

        h.trader.confirmBatch("batch-2");
        await step(h);
        const done = await h.rowOf(row._id);
        expect(done.state).toBe("done");
        expect(done.active).toBeUndefined();
        expect(h.trader.batches).toHaveLength(2);
    });

    test("after 10 tries 'A pool rebalance wrap keeps failing' is logged hourly", async () => {
        const h = await open();
        const row = await seedWrapping(h, { patch: { attempts: 8, nextAt: null } });
        h.trader.setUsdc(e6("49.9"));
        const failing = () => h.logged(POOL_ERRORS.wrapFailing);
        const failLatest = async () => {
            h.trader.failBatch(h.trader.batches.at(-1)!.id);
            await step(h);
        };

        // The ninth failure is not yet an error; the tenth is
        await step(h);
        await failLatest();
        expect((await h.rowOf(row._id)).attempts).toBe(9);
        expect(failing()).toHaveLength(0);
        await untilBatches(h, 2, 5 * MINUTE);
        await failLatest();
        expect((await h.rowOf(row._id)).attempts).toBe(10);
        expect(failing()).toMatchObject([{ level: 50, rebalance: row._id.toString(), attempts: 10 }]);

        // An hour later the next failure logs again, and not before
        await step(h, 30 * MINUTE);
        expect(failing()).toHaveLength(1);
        await untilBatches(h, 3, 5 * MINUTE);
        await failLatest();
        expect((await h.rowOf(row._id)).attempts).toBe(11);
        expect(failing()).toHaveLength(2);
    });

    test("a refused or failed wrap clears the attempt, so the gate does not hold the retry", async () => {
        const h = await open();
        const row = await seedWrapping(h);
        h.trader.setUsdc(e6("49.9"));

        h.trader.onNextBatch("refuse");
        await step(h);
        const refused = await h.rowOf(row._id);
        expect(refused.polygon).toMatchObject({ wrapAttemptedAt: null, wrapTransactionId: null });
        expect(refused.attempts).toBe(1);
        expect(refused.nextAt?.getTime()).toBe(h.clock.t + MINUTE);
        expect(h.trader.batches).toHaveLength(0);

        await step(h);
        await step(h);
        expect(h.trader.batches).toHaveLength(1);
        h.trader.failBatch("batch-1");
        await step(h);
        const failed = await h.rowOf(row._id);
        expect(failed.polygon).toMatchObject({ wrapAttemptedAt: null, wrapTransactionId: null });
        // The retry goes out at the second delay (5 minutes), not after the 11 minutes of the gate
        expect(failed.nextAt?.getTime()).toBe(h.clock.t + 5 * MINUTE);
        let waited = 0;
        while (h.trader.batches.length === 1) {
            await step(h);
            waited += 30_000;
            if (waited > 11 * MINUTE) break;
        }
        expect(waited).toBe(5 * MINUTE);
        expect(h.trader.batches).toHaveLength(2);
    });

    test("a gate that is shut writes nothing, and the wrap goes out once it opens", async () => {
        const h = await open();
        const row = await seedWrapping(h);
        h.trader.setUsdc(e6("49.9"));
        h.gate.shut();

        await step(h);
        const held = await h.rowOf(row._id);
        expect(held.polygon).toMatchObject({ wrapAttemptedAt: null, balanceBeforeE6: null, mintedE6: null });
        expect(h.trader.batches).toHaveLength(0);
        expect(held.attempts).toBe(0);

        await step(h, 11 * MINUTE);
        expect(h.trader.batches).toHaveLength(1);
    });

    test("an unknown wrap that ran ends done through the float check without a second batch", async () => {
        const h = await open({ poolUsdc: "100" });
        h.trader.lagBalance(true);
        const row = await seedWrapping(h);
        h.trader.setUsdc(e6("49.9"));
        h.trader.onNextBatch("unknown-executed");

        await step(h);
        const attempt = await h.rowOf(row._id);
        expect(attempt.polygon.wrapAttemptedAt).not.toBeNull();
        expect(attempt.polygon.wrapTransactionId).toBeNull();
        const attemptedAt = attempt.polygon.wrapAttemptedAt!.getTime();
        // The relayer ran it after all: the wallet's USDC is wrapped
        h.trader.confirmBatch("batch-1");

        h.advance(attemptedAt + 10 * MINUTE - h.clock.t);
        await h.rebalancer.tick();
        expect((await h.rowOf(row._id)).state).toBe("wrapping");
        expect(h.trader.batches).toHaveLength(1);

        // The window ended 40 seconds before this pass
        h.advance(MINUTE + 40_000);
        await h.rebalancer.tick();
        const done = await h.rowOf(row._id);
        expect(done.state).toBe("done");
        expect(done.polygon.wrapFinalAt?.getTime()).toBe(attemptedAt + 11 * MINUTE);
        expect(h.trader.batches).toHaveLength(1);
        expect(fromDecimal((await floatOf(h)).balanceE6)).toBe(e6("100") + e6("49.9"));
    });

    test("an unknown wrap that never ran is wrapped again after 11 minutes", async () => {
        const h = await open();
        const row = await seedWrapping(h);
        h.trader.setUsdc(e6("49.9"));
        h.trader.onNextBatch("unknown-lost");

        await step(h);
        const attempt = await h.rowOf(row._id);
        const attemptedAt = attempt.polygon.wrapAttemptedAt!.getTime();
        expect(attempt.polygon.wrapTransactionId).toBeNull();

        // A new worker finds the attempt and, for the whole window, neither submits nor lets another batch out
        h.restart();
        h.advance(5 * MINUTE);
        await h.rebalancer.tick();
        expect(h.trader.batches).toHaveLength(0);
        await expect(h.gate.run(async () => 1, { from: "redeemer" })).resolves.toEqual({
            ran: false,
            reason: "shut",
        });

        h.advance(attemptedAt + 10 * MINUTE - h.clock.t);
        await h.rebalancer.tick();
        expect(h.trader.batches).toHaveLength(0);
        expect((await h.rowOf(row._id)).polygon.wrapAttemptedAt?.getTime()).toBe(attemptedAt);

        h.advance(MINUTE);
        await h.rebalancer.tick();
        expect(h.trader.batches).toHaveLength(1);
        const again = await h.rowOf(row._id);
        expect(again.polygon.wrapTransactionId).toBe("batch-1");
        expect(again.polygon.wrapAttemptedAt?.getTime()).toBe(attemptedAt + 11 * MINUTE);
        expect(again.state).toBe("wrapping");
    });

    test("a wrap call that throws is an unknown outcome: the attempt stays and the gate shuts", async () => {
        const h = await open();
        const row = await seedWrapping(h);
        h.trader.setUsdc(e6("49.9"));
        vi.spyOn(h.trader, "wrapUsdc").mockRejectedValueOnce(new Error("the relayer connection broke"));

        await step(h);
        const attempt = await h.rowOf(row._id);
        expect(attempt.polygon.wrapAttemptedAt).not.toBeNull();
        expect(attempt.polygon.wrapTransactionId).toBeNull();

        await step(h, 5 * MINUTE);
        expect(h.trader.batches).toHaveLength(0);
        await expect(h.gate.run(async () => 1, { from: "redeemer" })).resolves.toEqual({
            ran: false,
            reason: "shut",
        });
        await step(h, 6 * MINUTE);
        expect(h.trader.batches).toHaveLength(1);
    });

    test("a Polygon RPC failure reading the wallet leaves the row wrapping and fails nothing", async () => {
        const h = await open();
        const row = await seedWrapping(h);
        h.trader.setUsdc(e6("49.9"));
        const read = vi.spyOn(h.trader, "usdcBalanceE6").mockRejectedValue(new Error("rpc down"));

        for (let i = 0; i < 3; i++) await step(h);

        const same = await h.rowOf(row._id);
        expect(same.state).toBe("wrapping");
        expect(same.attempts).toBe(0);
        expect(same.lastError).toBeNull();
        expect(same.polygon.wrapAttemptedAt).toBeNull();
        expect(h.trader.batches).toHaveLength(0);
        expect(h.logged("Couldn't read the pool wallet's USDC, so a pool move waits")).toHaveLength(1);

        read.mockRestore();
        await step(h);
        expect(h.trader.batches).toHaveLength(1);
    });

    test("a new worker resumes polling a stored wrap batch id and submits nothing", async () => {
        const h = await open();
        const row = await seedWrapping(h);
        h.trader.setUsdc(e6("49.9"));
        await step(h);
        expect((await h.rowOf(row._id)).polygon.wrapTransactionId).toBe("batch-1");

        h.restart();
        await step(h);
        expect(h.trader.batches).toHaveLength(1);

        h.trader.confirmBatch("batch-1");
        await step(h);
        expect((await h.rowOf(row._id)).state).toBe("done");
        expect(h.trader.batches).toHaveLength(1);
    });

    test("a forced read that never shows the rise ends done after 10 minutes with a warn", async () => {
        const h = await open({ poolUsdc: "100" });
        const row = await seedWrapping(h);
        h.trader.setUsdc(e6("49.9"));
        await step(h);
        // The CLOB keeps showing the old balance whatever is forced
        vi.spyOn(h.trader, "balanceE6").mockResolvedValue(e6("100"));
        h.trader.confirmBatch("batch-1");

        await step(h);
        const confirmed = await h.rowOf(row._id);
        expect(confirmed.state).toBe("wrapping");
        const finalAt = confirmed.polygon.wrapFinalAt!.getTime();

        h.advance(finalAt + 9 * MINUTE - h.clock.t);
        await h.rebalancer.tick();
        expect((await h.rowOf(row._id)).state).toBe("wrapping");
        expect(h.logged("The pool's balance didn't show the wrapped USDC in time")).toHaveLength(0);

        h.advance(MINUTE);
        await h.rebalancer.tick();
        const done = await h.rowOf(row._id);
        expect(done.state).toBe("done");
        expect(h.logged("The pool's balance didn't show the wrapped USDC in time")).toMatchObject([
            { level: 40, rebalance: row._id.toString() },
        ]);
        expect(h.trader.batches).toHaveLength(1);
    });

    test("a forced read that throws is retried at the next tick", async () => {
        const h = await open({ poolUsdc: "100" });
        h.trader.lagBalance(true);
        const row = await seedWrapping(h);
        h.trader.setUsdc(e6("49.9"));
        await step(h);
        h.trader.confirmBatch("batch-1");
        const sync = vi.spyOn(h.trader, "syncBalance").mockRejectedValueOnce(new Error("the CLOB is down"));

        await step(h);
        expect(sync).toHaveBeenCalledTimes(1);
        const waiting = await h.rowOf(row._id);
        expect(waiting.state).toBe("wrapping");
        expect(waiting.polygon.wrapFinalAt).not.toBeNull();
        expect(h.logged("Couldn't re-read the pool's balance after a wrap")).toHaveLength(1);

        await step(h);
        expect((await h.rowOf(row._id)).state).toBe("done");
        expect(h.trader.batches).toHaveLength(1);
    });

    test("a float read taken before the wrap was confirmed does not end done, even when it already shows enough", async () => {
        const h = await open({ poolUsdc: "100" });
        const row = await seedWrapping(h);
        h.trader.setUsdc(e6("49.9"));
        await step(h);
        h.trader.confirmBatch("batch-1");
        // The read after the wrap never lands: the document stays as an earlier read left it, already high
        vi.spyOn(h.service, "refreshFloat").mockResolvedValue(undefined);
        await h.database.collections.poolFloat.updateOne(
            { _id: "polygon" },
            { $set: { balanceE6: toDecimal(e6("500")), balanceAt: new Date(h.clock.t - HOUR) } },
        );

        await step(h);
        const confirmed = await h.rowOf(row._id);
        expect(confirmed.state).toBe("wrapping");
        const finalAt = confirmed.polygon.wrapFinalAt!.getTime();
        h.advance(finalAt + 9 * MINUTE - h.clock.t);
        await h.rebalancer.tick();
        expect((await h.rowOf(row._id)).state).toBe("wrapping");

        h.advance(MINUTE);
        await h.rebalancer.tick();
        expect((await h.rowOf(row._id)).state).toBe("done");
        expect(h.logged("The pool's balance didn't show the wrapped USDC in time")).toHaveLength(1);
    });

    test("a stuck wrapped row finishes done through the same float check", async () => {
        const h = await open({ poolUsdc: "100" });
        h.trader.lagBalance(true);
        const row = await seedWrapping(h, { state: "stuck" });
        h.trader.setUsdc(e6("49.9"));
        await step(h);
        h.trader.confirmBatch("batch-1");

        await step(h);

        const done = await h.rowOf(row._id);
        expect(done.state).toBe("done");
        expect(done.active).toBeUndefined();
        expect(fromDecimal((await floatOf(h)).balanceE6)).toBe(e6("100") + e6("49.9"));
    });
});

describe("wrap_idle", () => {
    test("wrap_idle wraps idle USDC and ends done, and with nothing idle ends done without a batch", async () => {
        const h = await open({ poolUsdc: "100" });
        h.trader.lagBalance(true);
        h.trader.setUsdc(e6("3.5"));
        const row = await h.queue({ kind: "wrap_idle" });

        await h.rebalancer.tick();
        expect(await h.rowOf(row._id)).toMatchObject({ state: "wrapping", active: true });
        expect(h.trader.batches).toHaveLength(1);
        expect(h.trader.batches[0]).toMatchObject({ kind: "wrap", amountE6: e6("3.5") });
        const sent = await h.rowOf(row._id);
        expect(fromDecimal(sent.polygon.mintedE6!)).toBe(e6("3.5"));
        expect(fromDecimal(sent.polygon.balanceBeforeE6!)).toBe(e6("100"));

        h.trader.confirmBatch("batch-1");
        await step(h);
        const done = await h.rowOf(row._id);
        expect(done.state).toBe("done");
        expect(done.active).toBeUndefined();
        expect(fromDecimal((await floatOf(h)).balanceE6)).toBe(e6("103.5"));

        const none = await h.queue({ kind: "wrap_idle" });
        await h.rebalancer.tick();
        expect((await h.rowOf(none._id)).state).toBe("done");
        expect(h.trader.batches).toHaveLength(1);
    });

    test("any balance above zero is wrapped for wrap_idle", async () => {
        const h = await open();
        const row = await h.queue({ kind: "wrap_idle" });
        h.trader.setUsdc(1n);

        await h.rebalancer.tick();

        expect(h.trader.batches).toHaveLength(1);
        expect(h.trader.batches[0]).toMatchObject({ amountE6: 1n });
        expect((await h.rowOf(row._id)).state).toBe("wrapping");
    });

    test("a wrap_idle row that keeps failing becomes stuck and is still retried", async () => {
        const h = await open();
        const row = await h.queue({ kind: "wrap_idle" });
        h.trader.setUsdc(e6("2"));
        await h.rebalancer.tick();
        h.trader.failBatch("batch-1");

        h.advance(2 * HOUR + 30_000);
        await h.rebalancer.tick();
        expect((await h.rowOf(row._id)).state).toBe("stuck");
        expect(h.logged(POOL_ERRORS.stuck)).toHaveLength(1);

        await step(h);
        await step(h, 2 * MINUTE);
        expect(h.trader.batches).toHaveLength(2);
        h.trader.confirmBatch("batch-2");
        await step(h);
        expect((await h.rowOf(row._id)).state).toBe("done");
    });
});

describe("idle native USDC", () => {
    test("idle USDC over $1 warns hourly and under $1 does not", async () => {
        const h = await open();
        h.trader.setUsdc(e6("1.5"));

        await h.rebalancer.tick();
        expect(h.logged(IDLE_WARNING)).toMatchObject([{ level: 40, usdcUSD: "1.5" }]);

        // Read every 10 minutes, warned once an hour
        await step(h, 10 * MINUTE);
        await step(h, 10 * MINUTE);
        expect(h.logged(IDLE_WARNING)).toHaveLength(1);
        await step(h, 41 * MINUTE);
        expect(h.logged(IDLE_WARNING)).toHaveLength(2);

        const quiet = await open();
        quiet.trader.setUsdc(e6("1"));
        await quiet.rebalancer.tick();
        quiet.trader.setUsdc(e6("0.99"));
        await step(quiet, 11 * MINUTE);
        expect(quiet.logged(IDLE_WARNING)).toHaveLength(0);
    });

    test("it is read every 10 minutes only, while the trader is connected", async () => {
        const h = await open();
        const read = vi.spyOn(h.trader, "usdcBalanceE6");

        await h.rebalancer.tick();
        await step(h, 5 * MINUTE);
        expect(read).toHaveBeenCalledTimes(1);
        await step(h, 5 * MINUTE);
        expect(read).toHaveBeenCalledTimes(2);

        h.connect(false);
        await step(h, 20 * MINUTE);
        expect(read).toHaveBeenCalledTimes(2);
    });

    test("a row wrapping holds the warning back", async () => {
        const h = await open();
        h.trader.setUsdc(e6("5"));
        await seedWrapping(h, { patch: { nextAt: new Date(h.clock.t + 3 * HOUR) } });

        await h.rebalancer.tick();

        expect(h.logged(IDLE_WARNING)).toHaveLength(0);
    });

    test("a read that fails is retried at the next ten minutes and fails nothing", async () => {
        const h = await open();
        const read = vi.spyOn(h.trader, "usdcBalanceE6").mockRejectedValueOnce(new Error("rpc down"));

        await expect(h.rebalancer.tick()).resolves.toBeUndefined();
        expect(read).toHaveBeenCalledTimes(1);
        expect(h.logged("Couldn't read the idle USDC in the pool wallet")).toHaveLength(1);

        h.trader.setUsdc(e6("2"));
        await step(h, 10 * MINUTE);
        expect(h.logged(IDLE_WARNING)).toHaveLength(1);
    });
});
