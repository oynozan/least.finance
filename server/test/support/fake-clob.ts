import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type Json = Record<string, unknown>;

export type FakeBook = {
    /** Ascending, best last, as the CLOB sends them. */
    bids: { price: string; size: string }[];
    /** Descending, best last. */
    asks: { price: string; size: string }[];
    tickSize?: string;
    minOrderSize?: string;
    negRisk?: boolean;
    conditionId?: string;
};

export type NextPost = { json: Json } | { status: number; body: Json } | "hold";

export type FakeClob = {
    /** The CLOB root, which is also the relayer, data and RPC root (they live under their own paths). */
    url: string;
    /** Every request served, as "METHOD /path". */
    requests: string[];
    /** The JSON bodies of POST /order, in order. */
    posted: Json[];
    setBook(tokenId: string, book: FakeBook): void;
    setBalance(e6: bigint): void;
    /** Answers GET /data/order/:id; `null` answers 404. */
    setOrder(id: string, order: Json | null): void;
    /** Answers the next POST /order; "hold" never answers. */
    nextPost(response: NextPost): void;
    /** Drops every open connection, as a network failure mid-request. */
    dropConnections(): void;
    /** Resolves when the next POST /order arrives. */
    postArrived(): Promise<void>;
    stop(): Promise<void>;
};

const CONDITION = `0x${"c".repeat(64)}`;

const readBody = async (request: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
};

/** Stands in for Polymarket's CLOB and relayer, serving what the SDK calls for the pool's trader. */
export async function startFakeClob(): Promise<FakeClob> {
    const books = new Map<string, FakeBook>();
    const orders = new Map<string, Json | null>();
    const requests: string[] = [];
    const posted: Json[] = [];
    let balance = 0n;
    let next: NextPost | undefined;
    let arrived: (() => void) | undefined;

    const send = (response: ServerResponse, status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
    };

    const server = createServer(async (request, response) => {
        const url = new URL(request.url ?? "/", "http://fake");
        const path = url.pathname;
        requests.push(`${request.method} ${path}`);
        const body = request.method === "POST" ? await readBody(request) : "";

        if (path === "/auth/api-key" || path === "/auth/derive-api-key") {
            return send(response, 200, {
                apiKey: "11111111-2222-4333-8444-555555555555",
                secret: Buffer.from("fake-secret").toString("base64"),
                passphrase: "fake-passphrase",
            });
        }
        if (path === "/auth/api-keys") {
            return send(response, 200, { apiKeys: ["11111111-2222-4333-8444-555555555555"] });
        }
        if (path === "/deployed") return send(response, 200, { deployed: true });

        if (path === "/book") {
            const tokenId = url.searchParams.get("token_id") ?? "";
            const book = books.get(tokenId);
            if (!book) return send(response, 404, { error: "No orderbook exists for the requested token id" });
            return send(response, 200, {
                market: book.conditionId ?? CONDITION,
                asset_id: tokenId,
                timestamp: "1760000000000",
                bids: book.bids,
                asks: book.asks,
                min_order_size: book.minOrderSize ?? "5",
                tick_size: book.tickSize ?? "0.01",
                neg_risk: book.negRisk ?? false,
                last_trade_price: "0.50",
                hash: "a".repeat(40),
            });
        }
        if (path.startsWith("/markets-by-token/")) {
            const book = books.get(decodeURIComponent(path.slice("/markets-by-token/".length)));
            if (!book) return send(response, 404, { error: "market not found" });
            return send(response, 200, { condition_id: book.conditionId ?? CONDITION });
        }
        if (path.startsWith("/clob-markets/")) {
            const first = [...books.entries()][0];
            const book = first?.[1];
            return send(response, 200, {
                fd: { r: 0.05, e: 1, to: true },
                mts: Number(book?.tickSize ?? "0.01"),
                nr: book?.negRisk ?? false,
                t: [...books.keys()].map((token, index) => ({ t: token, o: index === 0 ? "Yes" : "No" })),
            });
        }
        if (path === "/balance-allowance" || path === "/balance-allowance/update") {
            return send(response, 200, { balance: balance.toString(), allowances: {} });
        }
        if (path === "/order" && request.method === "POST") {
            posted.push(JSON.parse(body) as Json);
            arrived?.();
            arrived = undefined;
            const answer = next;
            next = undefined;
            if (answer === "hold") return;
            if (answer && "status" in answer) return send(response, answer.status, answer.body);
            return send(
                response,
                200,
                answer?.json ?? {
                    success: true,
                    errorMsg: "",
                    orderID: `0x${"b".repeat(64)}`,
                    status: "matched",
                    makingAmount: "0",
                    takingAmount: "0",
                    transactionsHashes: [],
                    tradeIDs: [],
                },
            );
        }
        if (path.startsWith("/data/order/")) {
            const order = orders.get(decodeURIComponent(path.slice("/data/order/".length)));
            if (!order) return send(response, 404, { error: "Order not found" });
            return send(response, 200, order);
        }
        send(response, 404, { error: `fake CLOB has no ${request.method} ${path}` });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    return {
        url: `http://127.0.0.1:${port}`,
        requests,
        posted,
        setBook: (tokenId, book) => void books.set(tokenId, book),
        setBalance: (e6) => void (balance = e6),
        setOrder: (id, order) => void orders.set(id, order),
        nextPost: (response) => void (next = response),
        dropConnections: () => server.closeAllConnections(),
        postArrived: () => new Promise<void>((resolve) => (arrived = resolve)),
        stop: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}
