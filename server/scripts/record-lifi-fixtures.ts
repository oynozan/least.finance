// Records LI.FI's token list for the swap networks, with look-alike tokens as decoys; --check-quotes also records which entries LI.FI quotes.
// Run from server/: node --env-file=.env scripts/record-lifi-fixtures.ts --check-quotes, then npx prettier --write server/test/fixtures from the root.
import { mkdirSync, writeFileSync } from "node:fs";
import { COINS, NETWORKS, type CoinEntry, type NetworkId, type SwapCoin } from "../src/swaps/coins.ts";

const LIFI_URL = "https://li.quest";
const QUOTE_PAUSE_MS = 700;
const DECOYS_PER_SYMBOL = 3;
const QUOTE_USD = 10;
// Throwaway senders; LI.FI answers 422 for Ethereum USDT from the first, so the second is the fallback
const EVM_WALLETS = ["0x0000000000000000000000000000000000000001", "0x00000000000000000000000000000000000a11ce"];
const SOLANA_WALLET = "11111111111111111111111111111112";

// The fields the script reads; the rest of LI.FI's token is recorded as it came
type RawToken = { address: string; symbol: string; priceUSD?: unknown } & Record<string, unknown>;

const checkQuotes = process.argv.includes("--check-quotes");
const apiKey = process.env.LIFI_API_KEY;
const headers: Record<string, string> = apiKey ? { "x-lifi-api-key": apiKey } : {};

const networkOf = (id: NetworkId) => NETWORKS.find((network) => network.id === id)!;
const sameAddress = (network: NetworkId, a: string, b: string) =>
    networkOf(network).kind === "evm" ? a.toLowerCase() === b.toLowerCase() : a === b;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function answer(response: Response): Promise<unknown> {
    if (!response.ok) throw new Error(`${response.url} answered ${response.status}: ${await response.text()}`);
    return response.json();
}

function save(file: string, body: unknown) {
    const directory = new URL("../test/fixtures/lifi/", import.meta.url);
    mkdirSync(directory, { recursive: true });
    writeFileSync(new URL(file, directory), `${JSON.stringify(body, null, 4)}\n`);
    console.log(`recorded lifi/${file}`);
}

const chainIds = NETWORKS.map((network) => network.chainId);
const list = (await answer(
    await fetch(`${LIFI_URL}/v1/tokens?${new URLSearchParams({ chains: chainIds.join(","), chainTypes: "EVM,SVM" })}`, {
        headers,
    }),
)) as { tokens: Record<string, RawToken[] | undefined> };
const listed = (network: NetworkId): RawToken[] => list.tokens[String(networkOf(network).chainId)] ?? [];
const tokenOf = (network: NetworkId, entry: CoinEntry) =>
    listed(network).find((token) => sameAddress(network, token.address, entry.address));

const missing: string[] = [];
const recorded: Record<string, RawToken[]> = {};
for (const network of NETWORKS) {
    const entries = COINS.flatMap((coin) =>
        coin.entries.filter((entry) => entry.network === network.id).map((entry) => ({ coin, entry })),
    );
    const kept: RawToken[] = [];
    const symbols = new Set<string>();
    for (const { coin, entry } of entries) {
        const token = tokenOf(network.id, entry);
        if (!token) {
            missing.push(`${network.id}:${coin.symbol}`);
            continue;
        }
        kept.push(token);
        symbols.add(coin.symbol.toLowerCase());
        symbols.add(String(token.symbol).toLowerCase());
    }
    const perSymbol = new Map<string, number>();
    for (const token of listed(network.id)) {
        const symbol = String(token.symbol).toLowerCase();
        const isEntry = entries.some(({ entry }) => sameAddress(network.id, token.address, entry.address));
        if (isEntry || !symbols.has(symbol) || (perSymbol.get(symbol) ?? 0) >= DECOYS_PER_SYMBOL) continue;
        perSymbol.set(symbol, (perSymbol.get(symbol) ?? 0) + 1);
        kept.push(token);
    }
    recorded[String(network.chainId)] = kept;
}
if (missing.length) throw new Error(`LI.FI's list lacks ${missing.join(", ")}`);
save("tokens.json", { recordedAt: new Date().toISOString(), tokens: recorded });

// A quote answers 200 with a transaction to sign, and waits out a rate limit rather than record a false negative
async function quoteWorks(query: URLSearchParams): Promise<{ status: number; ok: boolean }> {
    for (let attempt = 1; ; attempt++) {
        await pause(QUOTE_PAUSE_MS);
        const response = await fetch(`${LIFI_URL}/v1/quote?${query}`, { headers });
        if (response.status !== 429) {
            const body = (response.ok ? await response.json() : null) as { transactionRequest?: unknown } | null;
            return { status: response.status, ok: Boolean(body?.transactionRequest) };
        }
        if (attempt === 3) throw new Error("LI.FI keeps answering 429");
        await pause(5_000);
    }
}

if (checkQuotes) {
    const coinOf = (symbol: string): SwapCoin => COINS.find((coin) => coin.symbol === symbol)!;
    // USDC is quoted to USDT, or to WETH where there is no USDT (Arc)
    const target = (network: NetworkId, coin: SwapCoin) =>
        coinOf(coin.symbol === "USDC" ? "USDT" : "USDC").entries.find((entry) => entry.network === network) ??
        coinOf("ETH").entries.find((entry) => entry.network === network)!;
    const quotable: string[] = [];
    for (const coin of COINS) {
        for (const entry of coin.entries) {
            const network = networkOf(entry.network);
            const key = `${entry.network}:${coin.symbol}`;
            const price = Number(tokenOf(entry.network, entry)?.priceUSD);
            if (!(price > 0)) {
                console.log(`NO PRICE  ${key}`);
                continue;
            }
            // About $10 of the coin in its smallest units, worked out in integers to stay exact at 18 decimals
            const fromAmount =
                (BigInt(Math.round((QUOTE_USD / price) * 1e10)) * 10n ** BigInt(entry.decimals)) / 10n ** 10n;
            let result = { status: 0, ok: false };
            for (const wallet of network.kind === "solana" ? [SOLANA_WALLET] : EVM_WALLETS) {
                result = await quoteWorks(
                    new URLSearchParams({
                        fromChain: String(network.chainId),
                        toChain: String(network.chainId),
                        fromToken: entry.address,
                        toToken: target(entry.network, coin).address,
                        fromAmount: String(fromAmount),
                        fromAddress: wallet,
                        toAddress: wallet,
                        integrator: "least-finance",
                    }),
                );
                if (result.ok) break;
            }
            if (result.ok) quotable.push(key);
            console.log(`${result.ok ? "quotable" : `NOT ${result.status}`}  ${key}`);
        }
    }
    save("quotable.json", { recordedAt: new Date().toISOString(), quotable });
}
