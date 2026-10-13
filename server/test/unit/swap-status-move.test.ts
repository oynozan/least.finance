import { describe, expect, it } from "vitest";
import type { LifiStatus } from "../../src/swaps/lifi.ts";
import { moveFromStatus } from "../../src/swaps/tracker.ts";

const WALLET = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const expectation = { hash: "0xabc", wallet: WALLET, receiver: WALLET, token: TOKEN };
const status = (over: Partial<LifiStatus> = {}): LifiStatus => ({
    status: "DONE",
    substatus: "COMPLETED",
    sendingTxHash: "0xabc",
    fromAddress: WALLET,
    toAddress: WALLET,
    receiving: {
        txHash: "0xdef",
        amount: "1500000",
        tokenAddress: TOKEN,
        tokenSymbol: "USDC",
        decimals: 6,
        chainId: 8453,
    },
    ...over,
});

describe("moveFromStatus", () => {
    it("settles DONE only when the hash and both addresses are present and match", () => {
        expect(moveFromStatus(status(), expectation).move).toEqual({ state: "done", received: "1.5" });
        for (const over of [{ sendingTxHash: null }, { fromAddress: null }, { toAddress: null }]) {
            expect(moveFromStatus(status(over), expectation).move).toBeNull();
        }
    });
    it("settles FAILED and REFUNDED on the fields present, and rejects a mismatch among them", () => {
        const bare = { fromAddress: null, toAddress: null, receiving: null };
        expect(moveFromStatus(status({ status: "FAILED", ...bare }), expectation).move).toEqual({ state: "failed" });
        expect(moveFromStatus(status({ substatus: "REFUNDED", ...bare }), expectation).move).toEqual({
            state: "refunded",
        });
        expect(
            moveFromStatus(status({ status: "FAILED", ...bare, sendingTxHash: "0xother" }), expectation).move,
        ).toBeNull();
        expect(
            moveFromStatus(
                status({ status: "FAILED", fromAddress: "0x3333333333333333333333333333333333333333" }),
                expectation,
            ).move,
        ).toBeNull();
    });
    it("leaves pending statuses alone and reports another token as partial in its own decimals", () => {
        expect(moveFromStatus(status({ status: "PENDING" }), expectation)).toEqual({ move: null, note: null });
        const other = { ...status().receiving!, tokenAddress: WALLET, tokenSymbol: "", decimals: 18, amount: "10" };
        expect(moveFromStatus(status({ receiving: other }), expectation).move).toEqual({
            state: "partial",
            received: "0.00000000000000001",
            receivedSymbol: WALLET,
        });
    });
});
