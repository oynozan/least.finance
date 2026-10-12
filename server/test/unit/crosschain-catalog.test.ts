import { expect, test } from "vitest";
import { COINS, EVM_COINS, SOLANA_COINS, coinByKey, formatCoinAmount, parseCoinAmount, toArcWei } from "../../src/crosschain/catalog.ts";

test("the catalog holds the spec's coins, and no USDT on Arc", () => {
    expect(COINS.map((c) => c.key)).toEqual([
        "ethereum:ETH",
        "ethereum:USDC",
        "ethereum:USDT",
        "bnb:BNB",
        "bnb:USDC",
        "bnb:USDT",
        "arc:USDC",
        "solana:SOL",
        "solana:USDC",
    ]);
    expect(coinByKey("bnb:USDT")).toMatchObject({
        chainId: 56,
        token: "0x55d398326f99059fF775485246999027B3197955",
        decimals: 18,
    });
    expect(() => coinByKey("arc:USDT")).toThrow(/coin/);
});

test("amounts parse with the coin's own decimals", () => {
    expect(parseCoinAmount(coinByKey("bnb:USDT"), "1.5")).toBe(1_500_000_000_000_000_000n);
    expect(parseCoinAmount(coinByKey("ethereum:USDC"), "1.5")).toBe(1_500_000n);
    expect(() => parseCoinAmount(coinByKey("ethereum:USDT"), "1.1234567")).toThrow(/amount/);
    expect(() => parseCoinAmount(coinByKey("ethereum:ETH"), "0")).toThrow(/amount/);
    expect(formatCoinAmount(coinByKey("ethereum:ETH"), 500_000_000_000_000_000n)).toBe("0.5");
});

test("6-decimal USDC becomes 18-decimal Arc wei", () => {
    expect(toArcWei(1_500_000n, 6)).toBe(1_500_000_000_000_000_000n);
    expect(toArcWei(7n, 18)).toBe(7n);
});

test("Solana's coins have no chain id or contract, and USDC has its mint", () => {
    expect(EVM_COINS).toHaveLength(7);
    expect(SOLANA_COINS.map((c) => c.key)).toEqual(["solana:SOL", "solana:USDC"]);
    expect(coinByKey("solana:SOL")).toMatchObject({ chainId: null, token: null, mint: null, decimals: 9 });
    expect(coinByKey("solana:USDC")).toMatchObject({
        chainId: null,
        token: null,
        mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        decimals: 6,
    });
    expect(parseCoinAmount(coinByKey("solana:SOL"), "1.5")).toBe(1_500_000_000n);
});
