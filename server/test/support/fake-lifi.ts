import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { base58, base64 } from "@scure/base";
import { COINS, NETWORKS, type NetworkId } from "../../src/swaps/coins.ts";
import type { LifiQuoteRequest } from "../../src/swaps/lifi.ts";
import { solanaFeePayer } from "../../src/swaps/solana-tx.ts";

type RawToken = Record<string, any>;

export type FakeLifi = {
    url: string;
    /** Every request served, as "METHOD /path?query". */
    requests: string[];
    /** The `x-lifi-api-key` each request carried, null when it had none. */
    keys: (string | null)[];
    /** Answers the next request to this path with a 500. */
    failNext(path: "/v1/tokens" | "/v1/chains" | "/v1/quote" | "/v1/status"): void;
    /** Every quote request served, as the client sent it; a request that named no slippage has none here, and its quote carries 0.6%. */
    quotes: LifiQuoteRequest[];
    /** Merges this into the next raw quote, nested objects included; with `fromAddress`, into the next one that wallet asks for. */
    nextQuote(patch: Record<string, any>, fromAddress?: string): void;
    /** Answers the next quote request, or the next one `fromAddress` makes, with LI.FI's no-route error. */
    noRoute(fromAddress?: string): void;
    /** Serves this raw status for a sending hash; other hashes are unknown. */
    setStatus(txHash: string, raw: Record<string, any>): void;
    /** Prices every table entry of this symbol from now on; look-alike tokens keep their recorded price. */
    setPrice(symbol: string, price: number): void;
    stop(): Promise<void>;
};

const tokenList = (): Record<string, RawToken[]> =>
    JSON.parse(readFileSync(new URL("../fixtures/lifi/tokens.json", import.meta.url), "utf8")).tokens;

const fixture = (file: string) =>
    JSON.parse(readFileSync(new URL(`../fixtures/lifi/${file}`, import.meta.url), "utf8"));

const isObject = (value: unknown): value is Record<string, any> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

function merge(target: Record<string, any>, patch: Record<string, any>): Record<string, any> {
    const out = { ...target };
    for (const [key, value] of Object.entries(patch)) {
        out[key] = isObject(value) && isObject(out[key]) ? merge(out[key], value) : value;
    }
    return out;
}

// The recorded Solana transaction with its fee payer swapped for the wallet
function solanaTxFor(wallet: string): string {
    const bytes = base64.decode(
        readFileSync(new URL("../fixtures/lifi/solana-tx.txt", import.meta.url), "utf8").trim(),
    );
    const recorded = base58.decode(solanaFeePayer(base64.encode(bytes)));
    const at = Buffer.from(bytes).indexOf(recorded);
    bytes.set(base58.decode(wallet), at);
    return base64.encode(bytes);
}

// The fee LI.FI keeps from a swap, in basis points
const FEE_BPS = 25n;
// What Smart Slippage picks for a request that names no slippage; LI.FI's own pick is 0.5% to 1% on the routes we use
const SMART_SLIPPAGE = 0.006;
const MICRO = 1_000_000;

/** Stands in for LI.FI's API, serving the recorded token list. */
export async function startFakeLifi(options: { prices?: Record<string, number> } = {}): Promise<FakeLifi> {
    const recorded = tokenList();
    const prices = new Map(Object.entries(options.prices ?? {}));
    const failing = new Set<string>();
    const chains: { id: number; key: string; diamondAddress: string | null }[] = fixture("chains.json").chains;
    const statuses = new Map<string, Record<string, any>>();
    const patches: { patch: Record<string, any>; fromAddress?: string }[] = [];
    const noRoutes: { fromAddress?: string }[] = [];
    // The first queued entry that is for anyone or for this wallet
    const takeFor = <T extends { fromAddress?: string }>(queue: T[], wallet: string): T | undefined => {
        const at = queue.findIndex(
            (entry) => !entry.fromAddress || entry.fromAddress.toLowerCase() === wallet.toLowerCase(),
        );
        return at < 0 ? undefined : queue.splice(at, 1)[0];
    };
    let quoteCount = 0;

    const priceOf = (chainId: number, address: string): { symbol: string; decimals: number; price: number } => {
        const network = NETWORKS.find((candidate) => candidate.chainId === chainId)!;
        const symbol = coinAt.get(`${chainId}:${keyOf(network.id, address)}`);
        const decimals = COINS.find((coin) => coin.symbol === symbol)?.entries.find(
            (entry) => entry.network === network.id && keyOf(network.id, entry.address) === keyOf(network.id, address),
        )?.decimals;
        const listed = (recorded[String(chainId)] ?? []).find(
            (token) => keyOf(network.id, token.address) === keyOf(network.id, address),
        );
        const price = symbol === undefined ? 0 : (prices.get(symbol) ?? Number(listed?.priceUSD));
        if (symbol === undefined || decimals === undefined || !(price > 0)) {
            throw new Error(`The fake LI.FI has no price for ${address} on ${chainId}`);
        }
        return { symbol, decimals, price };
    };

    // The raw LI.FI quote for a request, priced from the table less the fee
    const rawQuote = (ask: LifiQuoteRequest): Record<string, any> => {
        const from = priceOf(ask.fromChain, ask.fromToken);
        const to = priceOf(ask.toChain, ask.toToken);
        const units = BigInt(ask.fromAmount);
        const fromMicro = BigInt(Math.round(from.price * MICRO));
        const toMicro = BigInt(Math.round(to.price * MICRO));
        const toAmount =
            (units * fromMicro * (10_000n - FEE_BPS) * 10n ** BigInt(to.decimals)) /
            (toMicro * 10_000n * 10n ** BigInt(from.decimals));
        const slippage = ask.slippage ?? SMART_SLIPPAGE;
        const kept = 10_000n - BigInt(Math.round(slippage * 10_000));
        const feeUsd = (Number(units) / 10 ** from.decimals) * from.price * (Number(FEE_BPS) / 10_000);
        const network = NETWORKS.find((candidate) => candidate.chainId === ask.fromChain)!;
        const entry = COINS.flatMap((coin) => coin.entries).find(
            (candidate) =>
                candidate.network === network.id &&
                keyOf(network.id, candidate.address) === keyOf(network.id, ask.fromToken),
        )!;
        const native = entry.reserve !== undefined;
        const diamond = chains.find((chain) => chain.id === ask.fromChain)?.diamondAddress ?? undefined;
        const value = native && network.kind === "evm" ? units * 10n ** BigInt(18 - entry.decimals) : 0n;
        return {
            id: `fake-${++quoteCount}`,
            tool: "fakebridge",
            toolDetails: { key: "fakebridge", name: "Fake Bridge" },
            action: {
                fromChainId: ask.fromChain,
                toChainId: ask.toChain,
                fromToken: { address: ask.fromToken },
                toToken: { address: ask.toToken },
                fromAddress: ask.fromAddress,
                toAddress: ask.toAddress,
                fromAmount: ask.fromAmount,
                slippage,
            },
            estimate: {
                toAmount: String(toAmount),
                toAmountMin: String((toAmount * kept) / 10_000n),
                approvalAddress: diamond,
                skipApproval: native,
                executionDuration: 30,
                feeCosts: [{ name: "LIFI Fixed Fee", amountUSD: String(feeUsd), included: true }],
                gasCosts: [{ amountUSD: "0.05" }],
            },
            transactionRequest:
                network.kind === "solana"
                    ? { data: solanaTxFor(ask.fromAddress) }
                    : {
                          from: ask.fromAddress,
                          to: diamond,
                          chainId: ask.fromChain,
                          data: "0xdeadbeef",
                          value: `0x${value.toString(16)}`,
                      },
        };
    };

    // EVM addresses compare without case, Solana's are case-sensitive
    const keyOf = (network: NetworkId, address: string) =>
        NETWORKS.find((candidate) => candidate.id === network)!.kind === "evm" ? address.toLowerCase() : address;
    const coinAt = new Map<string, string>();
    for (const coin of COINS) {
        for (const entry of coin.entries) {
            const chainId = NETWORKS.find((network) => network.id === entry.network)!.chainId;
            coinAt.set(`${chainId}:${keyOf(entry.network, entry.address)}`, coin.symbol);
        }
    }

    const served = (chainId: string): RawToken[] =>
        (recorded[chainId] ?? []).map((token) => {
            const network = NETWORKS.find((candidate) => String(candidate.chainId) === chainId)!;
            const symbol = coinAt.get(`${chainId}:${keyOf(network.id, token.address)}`);
            const price = symbol === undefined ? undefined : prices.get(symbol);
            return price === undefined ? token : { ...token, priceUSD: String(price) };
        });

    const server = createServer((req, res) => {
        const send = (status: number, body: unknown) =>
            res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
        const url = new URL(req.url ?? "/", "http://localhost");
        fake.requests.push(`${req.method} ${req.url}`);
        fake.keys.push(req.headers["x-lifi-api-key"]?.toString() ?? null);

        if (failing.delete(url.pathname)) return send(500, { message: "Unavailable" });

        if (req.method === "GET" && url.pathname === "/v1/tokens") {
            const asked = url.searchParams.get("chains");
            const chainIds = asked === null ? Object.keys(recorded) : asked.split(",").filter((id) => id in recorded);
            return send(200, { tokens: Object.fromEntries(chainIds.map((id) => [id, served(id)])) });
        }
        if (req.method === "GET" && url.pathname === "/v1/chains") {
            return send(200, {
                chains: chains.map(({ diamondAddress, ...chain }) =>
                    diamondAddress ? { ...chain, diamondAddress } : chain,
                ),
            });
        }
        if (req.method === "GET" && url.pathname === "/v1/quote") {
            const q = url.searchParams;
            const ask: LifiQuoteRequest = {
                fromChain: Number(q.get("fromChain")),
                toChain: Number(q.get("toChain")),
                fromToken: q.get("fromToken") ?? "",
                toToken: q.get("toToken") ?? "",
                fromAddress: q.get("fromAddress") ?? "",
                toAddress: q.get("toAddress") ?? "",
                fromAmount: q.get("fromAmount") ?? "",
                ...(q.has("slippage") ? { slippage: Number(q.get("slippage")) } : {}),
                integrator: q.get("integrator") ?? "",
            };
            fake.quotes.push(ask);
            if (takeFor(noRoutes, ask.fromAddress)) {
                return send(404, { message: "No available quotes for the requested transfer" });
            }
            let raw = rawQuote(ask);
            const queued = takeFor(patches, ask.fromAddress);
            if (queued) raw = merge(raw, queued.patch);
            return send(200, raw);
        }
        if (req.method === "GET" && url.pathname === "/v1/status") {
            const raw = statuses.get(url.searchParams.get("txHash") ?? "");
            return raw ? send(200, raw) : send(404, { message: "Not found" });
        }
        send(404, { message: "Not found" });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const fake: FakeLifi = {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        requests: [],
        keys: [],
        quotes: [],
        nextQuote: (patch, fromAddress) => void patches.push({ patch, fromAddress }),
        noRoute: (fromAddress) => void noRoutes.push({ fromAddress }),
        setStatus: (txHash, raw) => void statuses.set(txHash, raw),
        failNext: (path) => failing.add(path),
        setPrice: (symbol, price) => prices.set(symbol, price),
        stop: () =>
            new Promise((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
    return fake;
}
