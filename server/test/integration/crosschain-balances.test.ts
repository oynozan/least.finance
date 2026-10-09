import type { Address } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { beforeAll, expect, inject, test } from "vitest";
import { createArcClient } from "../../src/chain/arc.ts";
import { readBalances } from "../../src/crosschain/balances.ts";
import { COINS, coinByKey } from "../../src/crosschain/catalog.ts";
import { createSourceClients } from "../../src/crosschain/chains.ts";
import { fixedPrices, type PriceFeed } from "../../src/crosschain/prices.ts";
import { sourceChain } from "../support/source-chains.ts";
import { chainHelpers } from "../support/stack.ts";

const ethereum = sourceChain(inject("ethereumUrl"), 1);
const bnb = sourceChain(inject("bnbUrl"), 56);
const arcChain = chainHelpers(inject("anvilUrl"));

const sources = createSourceClients({ ethereum: [inject("ethereumUrl")], bnb: [inject("bnbUrl")] });
const arc = createArcClient([inject("anvilUrl")]);
const prices = fixedPrices({ ETH: 3000, BNB: 600, USDC: 1, USDT: 1 });

// The anvils are fresh, not forks: `balanceOf` on an address with no code makes viem throw, and readBalances
// calls it on every catalog token. Other files install some of these tokens, so each run installs them all.
beforeAll(async () => {
    for (const { chain, token } of COINS) {
        if (token) await (chain === "bnb" ? bnb : ethereum).installToken(token);
    }
});

/** A wallet holding 0.5 ETH on Ethereum, 250 USDT on BNB Chain and 12.5 USDC on Arc. */
async function holder() {
    const owner = privateKeyToAddress(generatePrivateKey());
    await ethereum.fund(owner, "0.5");
    await arcChain.fund(owner, "12.5");
    await bnb.setTokenBalance(coinByKey("bnb:USDT").token as Address, owner, 250n * 10n ** 18n);
    return owner;
}

test("a wallet's coins on every chain come back with their dollar value, the richest first", async () => {
    const owner = await holder();

    const rows = await readBalances({ sources, arc, prices }, owner);

    expect(rows).toHaveLength(COINS.length);
    expect(rows.slice(0, 3)).toEqual([
        {
            coin: "ethereum:ETH",
            symbol: "ETH",
            chainName: "Ethereum",
            chainId: 1,
            decimals: 18,
            amount: "0.5",
            spendable: "0.498",
            usd: 1500,
        },
        {
            coin: "bnb:USDT",
            symbol: "USDT",
            chainName: "BNB Chain",
            chainId: 56,
            decimals: 18,
            amount: "250",
            spendable: "250",
            usd: 250,
        },
        {
            coin: "arc:USDC",
            symbol: "USDC",
            chainName: "Arc",
            chainId: 5042,
            decimals: 18,
            amount: "12.5",
            spendable: "12.49",
            usd: 12.5,
        },
    ]);
    expect(rows.slice(3).map((row) => [row.coin, row.amount, row.spendable, row.usd])).toEqual([
        ["ethereum:USDC", "0", "0", 0],
        ["ethereum:USDT", "0", "0", 0],
        ["bnb:BNB", "0", "0", 0],
        ["bnb:USDC", "0", "0", 0],
    ]);
});

test("an amount below the gas reserve leaves nothing spendable", async () => {
    const owner = privateKeyToAddress(generatePrivateKey());
    await ethereum.fund(owner, "0.001");
    await arcChain.fund(owner, "0");
    const rows = await readBalances({ sources, arc, prices }, owner);

    expect(rows.find((row) => row.coin === "ethereum:ETH")).toMatchObject({ amount: "0.001", spendable: "0" });
});

test("a coin with no price has no dollar value and sorts last, in catalog order", async () => {
    const owner = await holder();
    const noBnbPrices: PriceFeed = {
        async usd(coins) {
            const known = await prices.usd(coins);
            for (const coin of coins) if (coin.symbol === "BNB" || coin.symbol === "ETH") known.delete(coin.key);
            return known;
        },
    };

    const rows = await readBalances({ sources, arc, prices: noBnbPrices }, owner);

    expect(rows.map((row) => [row.coin, row.usd])).toEqual([
        ["bnb:USDT", 250],
        ["arc:USDC", 12.5],
        ["ethereum:USDC", 0],
        ["ethereum:USDT", 0],
        ["bnb:USDC", 0],
        ["ethereum:ETH", null],
        ["bnb:BNB", null],
    ]);
    expect(rows.find((row) => row.coin === "ethereum:ETH")?.amount).toBe("0.5");
});
