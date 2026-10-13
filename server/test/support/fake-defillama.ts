import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { LLAMA_IDS, MAX_POINTS } from "../../src/prices/defillama.ts";

export type FakeDefiLlama = {
    url: string;
    /** Every chart asked for, refused ones included. */
    charts: { ids: string[]; end: number; span: number; period: string }[];
    /** The price served for a coin at a unix second. */
    priceAt(symbol: string, time: number): number;
    /** Answers the next chart with this status, and a Retry-After in seconds when given. */
    failNext(status?: number, retryAfterSeconds?: number): void;
    /** Leaves the coin out of every answer, as DefiLlama does with an id it doesn't price. */
    forget(symbol: string): void;
    stop(): Promise<void>;
};

const PERIOD = /^(\d+)([mhdw])$/i;
const UNIT_SECONDS: Record<string, number> = { m: 60, h: 3_600, d: 86_400, w: 604_800 };

/**
 * Stands in for DefiLlama's /chart: each coin at its price from `prices`,
 * swaying 2% over a day, with the real API's cap of 500 points a request.
 */
export async function startFakeDefiLlama(options: { prices: Record<string, number> }): Promise<FakeDefiLlama> {
    const symbolOf = new Map(Object.entries(LLAMA_IDS).map(([symbol, id]) => [id, symbol]));
    const forgotten = new Set<string>();
    const failures: { status: number; retryAfter?: number }[] = [];
    const priceAt = (symbol: string, time: number) =>
        options.prices[symbol]! * (1 + 0.02 * Math.sin((time / 86_400) * 2 * Math.PI));

    const server = createServer((req, res) => {
        const send = (status: number, body: unknown, headers: Record<string, string> = {}) =>
            res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
        const url = new URL(req.url ?? "/", "http://localhost");
        const match = /^\/chart\/([^/]+)$/.exec(url.pathname);
        if (req.method !== "GET" || !match) return send(404, { message: "Not found" });

        const ids = decodeURIComponent(match[1]!).split(",");
        const span = Number(url.searchParams.get("span"));
        const period = url.searchParams.get("period") ?? "";
        const end = Number(url.searchParams.get("end"));
        const unit = PERIOD.exec(period);
        if (!unit || !Number.isInteger(span) || span < 1 || !Number.isInteger(end))
            return send(400, { message: "Invalid chart request" });
        fake.charts.push({ ids, end, span, period });

        const failure = failures.shift();
        if (failure)
            return send(
                failure.status,
                { message: "Failing on purpose" },
                failure.retryAfter === undefined ? {} : { "retry-after": String(failure.retryAfter) },
            );
        if (ids.length * span > MAX_POINTS)
            return send(400, {
                message: `Requested ${ids.length * span} data points exceeds the maximum of ${MAX_POINTS}.`,
            });

        const step = Number(unit[1]) * UNIT_SECONDS[unit[2]!.toLowerCase()]!;
        const coins: Record<string, unknown> = {};
        for (const id of ids) {
            const symbol = symbolOf.get(id);
            if (!symbol || forgotten.has(symbol) || options.prices[symbol] === undefined) continue;
            coins[id] = {
                symbol,
                confidence: 0.99,
                prices: Array.from({ length: span }, (_, i) => {
                    const timestamp = end - (span - 1 - i) * step;
                    return { timestamp, price: priceAt(symbol, timestamp) };
                }),
            };
        }
        send(200, { coins });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const fake: FakeDefiLlama = {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        charts: [],
        priceAt,
        failNext: (status = 500, retryAfterSeconds) => void failures.push({ status, retryAfter: retryAfterSeconds }),
        forget: (symbol) => void forgotten.add(symbol),
        stop: () =>
            new Promise((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
    return fake;
}
