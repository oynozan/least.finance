import { describe, expect, it } from "vitest";
import type { LifiStatus } from "../../src/swaps/lifi.ts";
import { spendVerdict } from "../../scripts/swaps-live-verdict.ts";

const USDT = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";
const status = (over: Partial<LifiStatus> = {}, tokenAddress = USDT): LifiStatus => ({
    status: "DONE",
    substatus: "COMPLETED",
    sendingTxHash: "0xa",
    fromAddress: null,
    toAddress: null,
    receiving: { txHash: "0xb", amount: "1990000", tokenAddress, tokenSymbol: "USDT", decimals: 6, chainId: 8453 },
    ...over,
});

describe("spendVerdict", () => {
    it("accepts a completed swap that paid the ordered token", () => {
        expect(spendVerdict(status(), USDT)).toEqual({ done: true });
        expect(spendVerdict(status({}, USDT.toLowerCase()), USDT)).toEqual({ done: true });
    });
    it("rejects PARTIAL and REFUNDED", () => {
        expect(spendVerdict(status({ substatus: "PARTIAL" }), USDT)).toMatchObject({ done: false });
        expect(spendVerdict(status({ substatus: "REFUNDED" }), USDT)).toMatchObject({ done: false });
    });
    it("rejects a different received token or none", () => {
        expect(spendVerdict(status({}, "0x0000000000000000000000000000000000000002"), USDT)).toMatchObject({
            done: false,
        });
        expect(spendVerdict(status({ receiving: null }), USDT)).toMatchObject({ done: false });
    });
});
