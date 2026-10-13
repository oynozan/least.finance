import { afterAll, beforeAll, expect, test } from "vitest";
import { createIris, IrisError } from "../../src/crosschain/iris.ts";
import { startFakeIris, type FakeIris } from "../support/fake-iris.ts";

let fake: FakeIris;
beforeAll(async () => {
    fake = await startFakeIris();
});
afterAll(() => fake.stop());

const BURN = `0x${"ab".repeat(32)}` as const;

test("forwardFee reads med and high for 26 to 5 with forward=true", async () => {
    const iris = createIris({ baseUrl: fake.url });
    expect(await iris.forwardFee({ from: 26, to: 5, setup: false })).toEqual({
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
