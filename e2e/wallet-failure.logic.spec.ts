import { expect, test } from "@playwright/test";
import { oneLine, shortHash, walletFailure } from "@/lib/wallet/failure";

test.beforeEach(() => {
    // The full error goes to the console for a report to quote; a test needn't print it
    console.warn = () => undefined;
});

test("a turned-down request is cancelled, by code or by wording", () => {
    expect(walletFailure({ code: 4001, message: "User rejected the request." })).toEqual({ kind: "cancelled" });
    expect(walletFailure(new Error("Transaction declined by user"))).toEqual({ kind: "cancelled" });
    expect(walletFailure({ message: "User denied transaction signature" })).toEqual({ kind: "cancelled" });
});

test("each known wallet fault has its plain sentence", () => {
    const say = (error: unknown, options?: Parameters<typeof walletFailure>[1]) => walletFailure(error, options);
    expect(say({ code: -32002 })).toEqual({
        kind: "failed",
        message: "Your wallet already has a request open. Finish or close it, then try again.",
    });
    expect(say({ code: 4100 })).toEqual({
        kind: "failed",
        message: "Your wallet hasn't given this site access to that account. Connect it in the wallet and try again.",
    });
    expect(say({ code: 4900 })).toEqual({
        kind: "failed",
        message: "Your wallet lost its connection to the network. Reconnect it and try again.",
    });
    expect(say({ message: "insufficient funds for gas * price + value" }, { symbol: "ETH" })).toEqual({
        kind: "failed",
        message: "Your wallet doesn't have enough ETH for the deposit plus network fees.",
    });
    expect(
        say(
            { message: "Attempt to debit an account but found no record of a prior credit (insufficient lamports)" },
            { solana: true },
        ),
    ).toEqual({
        kind: "failed",
        message: "Your wallet doesn't have enough SOL for the deposit plus network fees.",
    });
    expect(say({ message: "Blockhash not found" }, { solana: true })).toEqual({
        kind: "failed",
        message: "The transaction expired before your wallet signed it. Try again.",
    });
});

test("any other fault shows the wallet's own words, trimmed and quoted", () => {
    expect(walletFailure({ code: -32603, message: "Internal JSON-RPC error.\n  Try later" })).toEqual({
        kind: "failed",
        message: 'Your wallet refused the deposit: "Internal JSON-RPC error. Try later".',
    });
    expect(walletFailure({ message: "boom" }, { solana: true })).toEqual({
        kind: "failed",
        message: 'Your Solana wallet refused the deposit: "boom".',
    });
    expect(walletFailure({ code: 4200 })).toEqual({
        kind: "failed",
        message: "Your wallet couldn't send the deposit (error 4200).",
    });
    expect(walletFailure(undefined)).toEqual({ kind: "failed", message: "Your wallet couldn't send the deposit." });
});

test("the full error goes to the console", () => {
    const seen: unknown[][] = [];
    console.warn = (...args: unknown[]) => void seen.push(args);
    const error = { code: -32603, message: "x" };
    walletFailure(error);
    expect(seen).toEqual([["Your wallet failed the deposit", error]]);
});

test("words and hashes are shortened for a sentence", () => {
    expect(oneLine("  a\n  b  ")).toBe("a b");
    expect(oneLine("x".repeat(300), 20)).toHaveLength(20);
    expect(shortHash(`0x${"ab".repeat(32)}`)).toBe("0xabab…abab");
    expect(shortHash("short")).toBe("short");
});
