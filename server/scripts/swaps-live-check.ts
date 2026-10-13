/**
 * Checks the swaps path against the real LI.FI. By default it is read-only: it quotes about $10 of every coin entry
 * to USDC on the same network (USDT for USDC entries, WETH on Arc) and holds each quote to checkQuote.
 * With --yes-spend-real-money it swaps $2 of USDC to USDT on Base from the wallet whose key is in SWAP_CHECK_KEY.
 *
 * Run it from server/ with `node --env-file=.env scripts/swaps-live-check.ts [--yes-spend-real-money]`.
 */
import { createPublicClient, createWalletClient, erc20Abi, getAddress, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { checkQuote } from "../src/swaps/check.ts";
import { COINS, NETWORKS, type CoinEntry, type NetworkId } from "../src/swaps/coins.ts";
import { createLifi, LifiError, type LifiQuote } from "../src/swaps/lifi.ts";
import { spendVerdict } from "./swaps-live-verdict.ts";

const QUOTE_USD = 10;
const SPEND_USD = 2;
const SLIPPAGE = 0.005;
const QUOTE_PAUSE_MS = 700;
const POLL_MS = 10_000;
const POLL_LIMIT = 90;
// Throwaway senders; LI.FI answers 422 for Ethereum USDT from the first, so the second is the fallback
const EVM_WALLETS = ["0x0000000000000000000000000000000000000001", "0x00000000000000000000000000000000000a11ce"];
const SOLANA_WALLET = "11111111111111111111111111111112";

const apiKey = process.env.LIFI_API_KEY?.trim() || undefined;
const integrator = process.env.LIFI_INTEGRATOR?.trim() || "least-finance";
const fee = Number(process.env.LIFI_FEE ?? 0) || 0;
const lifi = createLifi({ url: process.env.LIFI_URL?.trim() || "https://li.quest", apiKey });

const networkOf = (id: NetworkId) => NETWORKS.find((network) => network.id === id)!;
const coinOf = (symbol: string) => COINS.find((coin) => coin.symbol === symbol)!;
const entryOf = (symbol: string, network: NetworkId): CoinEntry | undefined =>
    coinOf(symbol).entries.find((entry) => entry.network === network);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// USDC is quoted to USDT, or to WETH where there is no USDT (Arc); everything else to USDC
const targetOf = (network: NetworkId, symbol: string): CoinEntry =>
    entryOf(symbol === "USDC" ? "USDT" : "USDC", network) ?? entryOf("ETH", network)!;

const quoteWith = async (req: Parameters<typeof lifi.quote>[0]): Promise<LifiQuote> => {
    for (let attempt = 1; ; attempt++) {
        try {
            return await lifi.quote(req);
        } catch (error) {
            if (!(error instanceof LifiError) || error.kind !== "rate_limited" || attempt === 3) throw error;
            await pause(5_000);
        }
    }
};

// About `usd` of the coin in its smallest units, worked out in integers to stay exact at 18 decimals
const unitsFor = (usd: number, price: number, decimals: number): bigint =>
    (BigInt(Math.round((usd / price) * 1e10)) * 10n ** BigInt(decimals)) / 10n ** 10n;

async function readOnly(): Promise<number> {
    const chains = await lifi.chains();
    const tokens = await lifi.tokens(NETWORKS.map((network) => network.chainId));
    let failed = 0;
    let passed = 0;
    for (const coin of COINS) {
        for (const entry of coin.entries) {
            const network = networkOf(entry.network);
            const key = `${entry.network}:${coin.symbol}`;
            const price = tokens.find(
                (token) =>
                    token.chainId === network.chainId &&
                    (network.kind === "evm"
                        ? token.address.toLowerCase() === entry.address.toLowerCase()
                        : token.address === entry.address),
            )?.priceUSD;
            if (!price) {
                console.log(`FAIL  ${key}: LI.FI lists no price`);
                failed++;
                continue;
            }
            const to = targetOf(entry.network, coin.symbol);
            const fromUnits = unitsFor(QUOTE_USD, price, entry.decimals);
            const diamond = chains.find((chain) => chain.id === network.chainId)?.diamondAddress ?? null;
            let verdict = "";
            for (const wallet of network.kind === "solana" ? [SOLANA_WALLET] : EVM_WALLETS) {
                await pause(QUOTE_PAUSE_MS);
                try {
                    const quote = await quoteWith({
                        fromChain: network.chainId,
                        toChain: network.chainId,
                        fromToken: entry.address,
                        toToken: to.address,
                        fromAddress: wallet,
                        toAddress: wallet,
                        fromAmount: fromUnits.toString(),
                        slippage: SLIPPAGE,
                        integrator,
                        ...(fee > 0 && { fee }),
                    });
                    checkQuote(quote, {
                        fromNetwork: entry.network,
                        from: entry,
                        toNetwork: entry.network,
                        to,
                        fromAddress: wallet,
                        toAddress: wallet,
                        fromUnits,
                        diamond,
                    });
                    verdict = "";
                    console.log(`PASS  ${key}: ${quote.toolName}, to ${quote.toAmountMin} min of ${to.address}`);
                    break;
                } catch (error) {
                    verdict = error instanceof Error ? error.message : String(error);
                }
            }
            if (verdict) {
                console.log(`FAIL  ${key}: ${verdict}`);
                failed++;
            } else passed++;
        }
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    return failed ? 1 : 0;
}

async function spend(): Promise<number> {
    const key = process.env.SWAP_CHECK_KEY?.trim();
    if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
        console.error("Set SWAP_CHECK_KEY to the test wallet's private key (0x and 64 hex characters).");
        return 1;
    }
    const account = privateKeyToAccount(key as Hex);
    const rpc = process.env.BASE_RPC_URLS?.split(",")[0]?.trim() || "https://mainnet.base.org";
    const publicClient = createPublicClient({ chain: base, transport: http(rpc) });
    const wallet = createWalletClient({ account, chain: base, transport: http(rpc) });
    const from = entryOf("USDC", "base")!;
    const to = entryOf("USDT", "base")!;
    const network = networkOf("base");
    const fromUnits = BigInt(SPEND_USD) * 10n ** BigInt(from.decimals);
    console.log(`Swapping $${SPEND_USD} of USDC to USDT on Base from ${account.address}`);

    const diamond = (await lifi.chains()).find((chain) => chain.id === network.chainId)?.diamondAddress ?? null;
    const quote = await quoteWith({
        fromChain: network.chainId,
        toChain: network.chainId,
        fromToken: from.address,
        toToken: to.address,
        fromAddress: account.address,
        toAddress: account.address,
        fromAmount: fromUnits.toString(),
        slippage: SLIPPAGE,
        integrator,
        ...(fee > 0 && { fee }),
    });
    checkQuote(quote, {
        fromNetwork: "base",
        from,
        toNetwork: "base",
        to,
        fromAddress: account.address,
        toAddress: account.address,
        fromUnits,
        diamond,
    });
    if (quote.tx.kind !== "evm") throw new Error("LI.FI built a non-EVM transaction for Base");

    if (!quote.skipApproval) {
        const spender = quote.approvalAddress;
        if (!spender || diamond === null || spender.toLowerCase() !== diamond.toLowerCase())
            throw new Error("LI.FI's approval address is not the diamond");
        const allowance = await publicClient.readContract({
            address: getAddress(from.address),
            abi: erc20Abi,
            functionName: "allowance",
            args: [account.address, getAddress(spender)],
        });
        if (allowance < fromUnits) {
            const approval = await wallet.writeContract({
                address: getAddress(from.address),
                abi: erc20Abi,
                functionName: "approve",
                args: [getAddress(spender), fromUnits],
            });
            await publicClient.waitForTransactionReceipt({ hash: approval });
            console.log(`approval ${approval}`);
        }
    }

    const hash = await wallet.sendTransaction({
        to: getAddress(quote.tx.to),
        data: quote.tx.data as Hex,
        value: BigInt(quote.tx.value),
    });
    console.log(`swap ${hash}`);

    for (let poll = 0; poll < POLL_LIMIT; poll++) {
        const status = await lifi.status({
            txHash: hash,
            fromChain: network.chainId,
            toChain: network.chainId,
            bridge: quote.tool,
        });
        if (status.status === "DONE") {
            console.log(
                `DONE ${status.substatus ?? ""} received ${status.receiving?.amount} ${status.receiving?.tokenSymbol}`,
            );
            const verdict = spendVerdict(status, to.address);
            if (!verdict.done) console.error(`NOT DONE ${verdict.reason}`);
            return verdict.done ? 0 : 1;
        }
        if (status.status === "FAILED" || status.status === "INVALID") {
            console.error(`FAILED ${status.status} ${status.substatus ?? ""}`);
            return 1;
        }
        await pause(POLL_MS);
    }
    console.error("The swap did not reach DONE in time");
    return 1;
}

process.exit(await (process.argv.includes("--yes-spend-real-money") ? spend() : readOnly()));
