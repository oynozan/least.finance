import { afterAll, beforeAll, expect, test } from "vitest";
import { createIris, feeUnits, IrisError } from "../../src/crosschain/iris.ts";
import { startFakeIris, type FakeIris } from "../support/fake-iris.ts";

let fake: FakeIris;
beforeAll(async () => {
    fake = await startFakeIris();
});
afterAll(() => fake.stop());

const BURN = `0x${"ab".repeat(32)}` as const;

test("forwardFee reads med and high for 26 to 5 with forward=true", async () => {
    const iris = createIris({ baseUrl: fake.url });
    expect(await iris.forwardFee({ from: 26, to: 5, setup: false })).toMatchObject({
        med: 127_000n * 10n ** 12n,
        high: 150_000n * 10n ** 12n,
    });
    expect(fake.requests().at(-1)).toBe("/v2/burn/USDC/fees/26/5?forward=true");
});

test("includeRecipientSetup=true is added only when setup", async () => {
    const iris = createIris({ baseUrl: fake.url });
    const fee = await iris.forwardFee({ from: 26, to: 5, setup: true });
    expect(fake.requests().at(-1)).toBe("/v2/burn/USDC/fees/26/5?forward=true&includeRecipientSetup=true");
    expect(fee.med).toBe(286_000n * 10n ** 12n);
});

test("a 429 is rate_limited", async () => {
    const iris = createIris({ baseUrl: fake.url });
    fake.failWith(429);
    await expect(iris.forwardFee({ from: 26, to: 5, setup: false })).rejects.toMatchObject({ kind: "rate_limited" });
    fake.failWith(500);
    const error = await iris.message({ domain: 26, burnTxHash: BURN }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IrisError);
    expect(error).toMatchObject({ kind: "unavailable" });
    fake.failWith(null);
});

test("a request that outlives the timeout is a timeout", async () => {
    const hanging = createIris({
        baseUrl: fake.url,
        timeoutMs: 20,
        fetch: (_url, init) =>
            new Promise<Response>((_resolve, reject) =>
                init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
            ),
    });
    const error = await hanging.message({ domain: 26, burnTxHash: BURN }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IrisError);
    expect(error).toMatchObject({ kind: "timeout" });
});

test("a connection that fails outright is unavailable, not a timeout", async () => {
    const refused = createIris({
        baseUrl: fake.url,
        fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    await expect(refused.message({ domain: 26, burnTxHash: BURN })).rejects.toMatchObject({ kind: "unavailable" });
});

test("message maps a missing message to null and complete with forwardTxHash", async () => {
    const iris = createIris({ baseUrl: fake.url });
    expect(await iris.message({ domain: 26, burnTxHash: BURN })).toBeNull();
    fake.setMessage(BURN, { status: "pending_confirmations" });
    expect(await iris.message({ domain: 26, burnTxHash: BURN })).toMatchObject({
        status: "pending",
        forwardTxHash: null,
    });
    fake.setMessage(BURN, { status: "complete", forwardState: "CONFIRMED", forwardTxHash: "5sig" });
    expect(await iris.message({ domain: 26, burnTxHash: BURN })).toMatchObject({
        status: "complete",
        forwardTxHash: "5sig",
    });
    fake.setMessage(BURN, { status: "complete", forwardState: "FAILED" });
    expect(await iris.message({ domain: 26, burnTxHash: BURN })).toMatchObject({ status: "failed" });
});

test("forwardFee works for 26 to 7 and 7 to 26 and returns minimumFeeBps", async () => {
    const iris = createIris({ baseUrl: fake.url });
    expect(await iris.forwardFee({ from: 26, to: 7 })).toEqual({
        med: 70_969n * 10n ** 12n,
        high: 71_067n * 10n ** 12n,
        minimumFeeBps: 0,
    });
    expect(fake.requests().at(-1)).toBe("/v2/burn/USDC/fees/26/7?forward=true");
    expect(await iris.forwardFee({ from: 7, to: 26 })).toEqual({
        med: 15_638n * 10n ** 12n,
        high: 16_288n * 10n ** 12n,
        minimumFeeBps: 0,
    });
    expect(fake.requests().at(-1)).toBe("/v2/burn/USDC/fees/7/26?forward=true");
    fake.setPoolFees("arc_to_polygon", { med: 70_000, high: 72_000, bps: 1.3 });
    expect(await iris.forwardFee({ from: 26, to: 7 })).toEqual({
        med: 70_000n * 10n ** 12n,
        high: 72_000n * 10n ** 12n,
        minimumFeeBps: 1.3,
    });
    fake.setPoolFees("arc_to_polygon", { med: 70_969, high: 71_067 });
});

test("a whole number is units and a fraction is dollars", async () => {
    const answering = (forwardFee: Record<string, number | string>) =>
        createIris({
            baseUrl: "http://iris.test",
            fetch: async () => Response.json([{ finalityThreshold: 2000, minimumFee: 0, forwardFee }]),
        });
    const expected = { med: 70_969n * 10n ** 12n, high: 71_067n * 10n ** 12n };
    for (const forwardFee of [
        { med: 70_969, high: 71_067 },
        { med: 0.070969, high: 0.071067 },
        { med: "70969", high: "0.071067" },
    ]) {
        expect(await answering(forwardFee).forwardFee({ from: 26, to: 7 })).toMatchObject(expected);
    }
    await expect(answering({ med: 70_969 }).forwardFee({ from: 26, to: 7 })).rejects.toMatchObject({
        kind: "unavailable",
    });
    await expect(answering({ med: -1, high: 1 }).forwardFee({ from: 26, to: 7 })).rejects.toBeInstanceOf(IrisError);
});

test("feeUnits reads whole numbers as units and fractions as dollars, rounded up", () => {
    expect(feeUnits(70_969)).toBe(70_969n);
    expect(feeUnits("70969")).toBe(70_969n);
    expect(feeUnits(0.070969)).toBe(70_969n);
    expect(feeUnits("0.070969")).toBe(70_969n);
    expect(feeUnits(0.015626)).toBe(15_626n);
    expect(feeUnits(0.0709691)).toBe(70_970n);
    expect(feeUnits(1.5)).toBe(1_500_000n);
    expect(feeUnits(0)).toBe(0n);
    for (const bad of [-1, "-1", "abc", "", NaN, Infinity, 1e-7, "1e3"]) expect(() => feeUnits(bad)).toThrow();
});

test("message carries feeExecutedE6 and delayReason", async () => {
    const iris = createIris({ baseUrl: fake.url });
    const done = `0x${"cd".repeat(32)}`;
    const delayed = `0x${"ef".repeat(32)}`;
    fake.setForwarded(done, "0xforward", { domain: 26, feeExecuted: "70969" });
    expect(await iris.message({ domain: 26, burnTxHash: done })).toMatchObject({
        status: "complete",
        forwardTxHash: "0xforward",
        feeExecutedE6: 70_969n,
        delayReason: null,
    });
    expect(await iris.message({ domain: 7, burnTxHash: done })).toBeNull();
    fake.setDelayed(delayed, "insufficient_fee", 26);
    expect(await iris.message({ domain: 26, burnTxHash: delayed })).toMatchObject({
        status: "pending",
        forwardTxHash: null,
        feeExecutedE6: null,
        delayReason: "insufficient_fee",
    });
    fake.setForwarded(done, "0xany");
    expect(await iris.message({ domain: 7, burnTxHash: done })).toMatchObject({
        forwardTxHash: "0xany",
        feeExecutedE6: null,
    });
});
