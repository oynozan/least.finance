import { describe, expect, it } from "vitest";
import type { LifiQuote, LifiStatus } from "../../src/swaps/lifi.ts";
import { NATIVE_EVM } from "../../src/swaps/coins.ts";
import { approvalVerdict, spendVerdict } from "../../scripts/swaps-live-verdict.ts";

const USDT = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";
const WALLET = "0x2222222222222222222222222222222222222222";
const HASH = "0xabc";
const expectation = { hash: HASH, wallet: WALLET, receiver: WALLET, token: USDT };
const status = (over: Partial<LifiStatus> = {}, tokenAddress = USDT): LifiStatus => ({
    status: "DONE",
    substatus: "COMPLETED",
    sendingTxHash: HASH,
    fromAddress: WALLET,
    toAddress: WALLET,
    receiving: { txHash: "0xb", amount: "1990000", tokenAddress, tokenSymbol: "USDT", decimals: 6, chainId: 8453 },
    ...over,
});

describe("spendVerdict", () => {
    it("accepts a completed swap that paid the ordered token", () => {
        expect(spendVerdict(status(), expectation)).toEqual({ done: true });
        expect(spendVerdict(status({}, USDT.toLowerCase()), expectation)).toEqual({ done: true });
    });
    it("rejects PARTIAL and REFUNDED", () => {
        expect(spendVerdict(status({ substatus: "PARTIAL" }), expectation)).toMatchObject({ done: false });
        expect(spendVerdict(status({ substatus: "REFUNDED" }), expectation)).toMatchObject({ done: false });
    });
    it("rejects a different received token or none", () => {
        const other = "0x0000000000000000000000000000000000000002";
        expect(spendVerdict(status({}, other), expectation)).toMatchObject({ done: false });
        expect(spendVerdict(status({ receiving: null }), expectation)).toMatchObject({ done: false });
    });
    it("rejects a status the tracker would not settle on: missing or other hash and addresses", () => {
        for (const over of [
            { sendingTxHash: null },
            { fromAddress: null },
            { toAddress: null },
            { sendingTxHash: "0xother" },
            { fromAddress: "0x3333333333333333333333333333333333333333" },
            { toAddress: "0x3333333333333333333333333333333333333333" },
        ]) {
            const verdict = spendVerdict(status(over), expectation);
            expect(verdict).toMatchObject({ done: false });
        }
    });
});

describe("approvalVerdict", () => {
    const DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
    const quote = (over: Partial<LifiQuote>) =>
        ({ approvalAddress: DIAMOND, skipApproval: false, ...over }) as LifiQuote;
    const token = { network: "base", address: USDT, decimals: 6 } as const;

    it("holds a token input's approval address to the diamond", () => {
        expect(approvalVerdict(quote({}), token, DIAMOND)).toBeNull();
        expect(approvalVerdict(quote({ approvalAddress: DIAMOND.toLowerCase() }), token, DIAMOND)).toBeNull();
        expect(approvalVerdict(quote({ approvalAddress: WALLET }), token, DIAMOND)).toMatch(/approval/);
        expect(approvalVerdict(quote({ approvalAddress: null }), token, DIAMOND)).toMatch(/approval/);
        expect(approvalVerdict(quote({}), token, null)).toMatch(/approval/);
    });
    it("asks nothing of a native input, a skipped approval or a Solana input", () => {
        const native = { network: "base", address: NATIVE_EVM, decimals: 18 } as const;
        expect(approvalVerdict(quote({ approvalAddress: WALLET }), native, DIAMOND)).toBeNull();
        expect(approvalVerdict(quote({ approvalAddress: WALLET, skipApproval: true }), token, DIAMOND)).toBeNull();
        const solana = {
            network: "solana",
            address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            decimals: 6,
        } as const;
        expect(approvalVerdict(quote({ approvalAddress: null }), solana, null)).toBeNull();
    });
});
