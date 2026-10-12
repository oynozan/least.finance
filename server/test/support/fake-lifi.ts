import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { COINS, NETWORKS, type NetworkId } from "../../src/swaps/coins.ts";

type RawToken = Record<string, any>;

export type FakeLifi = {
    url: string;
    /** Every request served, as "METHOD /path?query". */
    requests: string[];
    /** The `x-lifi-api-key` each request carried, null when it had none. */
    keys: (string | null)[];
    /** Answers the next request to this path with a 500. */
    failNext(path: "/v1/tokens"): void;
    /** Prices every table entry of this symbol from now on; look-alike tokens keep their recorded price. */
    setPrice(symbol: string, price: number): void;
    stop(): Promise<void>;
};

const tokenList = (): Record<string, RawToken[]> =>
    JSON.parse(readFileSync(new URL("../fixtures/lifi/tokens.json", import.meta.url), "utf8")).tokens;

/** Stands in for LI.FI's API, serving the recorded token list. */
export async function startFakeLifi(options: { prices?: Record<string, number> } = {}): Promise<FakeLifi> {
    const recorded = tokenList();
    const prices = new Map(Object.entries(options.prices ?? {}));
    const failing = new Set<string>();

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
        send(404, { message: "Not found" });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const fake: FakeLifi = {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        requests: [],
        keys: [],
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
