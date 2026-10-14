import { randomUUID } from "node:crypto";
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

export type FakePosition = { tokenId: string; size: string; status: "OPEN" | "REDEEMABLE" | "CLOSED" };
export type RelayerState =
    "STATE_NEW" | "STATE_EXECUTED" | "STATE_MINED" | "STATE_CONFIRMED" | "STATE_INVALID" | "STATE_FAILED";

export type NextPost = { json: Json } | { status: number; body: Json } | "hold";

/** One call of a submitted deposit-wallet batch, as the relayer receives it. */
export type SubmittedCall = { target: string; data: string; value: string };

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
    /** Answers GET /data/trades?id=:id with this trade, and an unfiltered GET /data/trades with every trade set. */
    setTrade(id: string, trade: Json): void;
    /** Makes GET /data/trades fail with this status; null serves it again. */
    failTrades(status: number | null): void;
    /** The query strings of every GET /data/trades. */
    tradeQueries: string[];
    /** Answers the next POST /order; "hold" never answers. */
    nextPost(response: NextPost): void;
    /** Every relayer transaction the fake accepted, in order, with the calls of its deposit-wallet batch. */
    submitted: { id: string; body: Json; calls: SubmittedCall[] }[];
    /** Answers the next POST /submit with this status and body instead of accepting it, or never answers it ("hold"); such a submit is not in `submitted`. */
    nextSubmit(response: { status: number; body: Json } | "hold"): void;
    /** Resolves when the next POST /submit arrives. */
    submitArrived(): Promise<void>;
    setTransactionState(id: string, state: RelayerState): void;
    /** The rows GET /v2/positions serves, filtered by its status parameter. */
    setPositions(rows: FakePosition[]): void;
    setPositionsPageSize(size: number): void;
    /** Serves GET /data/trades this many trades per page; the default is one page of everything. */
    setTradesPageSize(size: number): void;
    /** Removes every trade set so far. */
    clearTrades(): void;
    /** Drops every open connection, as a network failure mid-request. */
    dropConnections(): void;
    /** Resolves when the next POST /order arrives. */
    postArrived(): Promise<void>;
    stop(): Promise<void>;
};

const CONDITION = `0x${"c".repeat(64)}`;

const WALLET = `0x${"1".repeat(40)}`;

const positionRow = (row: FakePosition) => ({
    proxy_wallet: WALLET,
    token_id: row.tokenId,
    condition_id: CONDITION,
    current_size: row.size,
    avg_price: "0.5",
    entry_cost_usdc: "1",
    entry_fees_usdc: "0",
    total_cost_usdc: "1",
    current_price: "0.5",
    current_value: "1",
    total_size: row.size,
    realized_pnl: "0",
    unrealized_pnl: "0",
    total_pnl: "0",
    percent_pnl: "0",
    percent_realized_pnl: "0",
    status: row.status,
    redeemable: row.status === "REDEEMABLE",
    mergeable: false,
    negative_risk: false,
    archived: false,
    verified: false,
});

const readBody = async (request: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
};

/** Stands in for Polymarket's CLOB and relayer, serving what the SDK calls for the pool's trader. */
export async function startFakeClob(): Promise<FakeClob> {
    const books = new Map<string, FakeBook>();
    const orders = new Map<string, Json | null>();
    const trades = new Map<string, Json>();
    const tradeQueries: string[] = [];
    let tradesStatus: number | null = null;
    const requests: string[] = [];
    const posted: Json[] = [];
    const submitted: { id: string; body: Json; calls: SubmittedCall[] }[] = [];
    const states = new Map<string, RelayerState>();
    let positions: FakePosition[] = [];
    let positionsPage = 100;
    let tradesPage = Infinity;
    let balance = 0n;
    let next: NextPost | undefined;
    let nextSubmitAnswer: { status: number; body: Json } | "hold" | undefined;
    let submitSeen: (() => void) | undefined;
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
        if (path === "/v1/account/transactions/params") {
            return send(response, 200, { address: url.searchParams.get("address"), nonce: "0" });
        }
        if (path === "/submit" && request.method === "POST") {
            const answer = nextSubmitAnswer;
            nextSubmitAnswer = undefined;
            submitSeen?.();
            submitSeen = undefined;
            if (answer === "hold") return;
            if (answer) return send(response, answer.status, answer.body);
            const id = randomUUID();
            const parsed = JSON.parse(body) as { depositWalletParams?: { calls?: SubmittedCall[] } };
            submitted.push({ id, body: parsed, calls: parsed.depositWalletParams?.calls ?? [] });
            states.set(id, "STATE_NEW");
            return send(response, 200, { transactionID: id, state: "STATE_NEW", transactionHash: null });
        }
        if (path.startsWith("/v1/account/transactions/")) {
            const id = decodeURIComponent(path.slice("/v1/account/transactions/".length));
            const state = states.get(id);
            if (!state) return send(response, 404, { error: "transaction not found" });
            return send(response, 200, {
                transaction_id: id,
                state,
                transaction_hash: state === "STATE_CONFIRMED" ? `0x${"e".repeat(64)}` : "",
                error_msg: state === "STATE_FAILED" ? "execution reverted" : null,
            });
        }
        if (path === "/markets/keyset") {
            // The redeem path only needs the market's condition, protocol and tokens
            const conditionId = url.searchParams.get("condition_ids") ?? CONDITION;
            return send(response, 200, {
                markets: [
                    {
                        id: "1",
                        version: "v1",
                        conditionId,
                        closed: true,
                        negRisk: false,
                        outcomes: JSON.stringify(["Yes", "No"]),
                        outcomePrices: JSON.stringify(["1", "0"]),
                        clobTokenIds: JSON.stringify(["1", "2"]),
                    },
                ],
            });
        }
        if (path === "/v2/positions") {
            const status = url.searchParams.get("status") ?? "OPEN";
            const rows = positions.filter((row) => row.status === status);
            const offset = Number(url.searchParams.get("cursor") ?? "0");
            const page = rows.slice(offset, offset + positionsPage);
            const more = offset + positionsPage < rows.length;
            return send(response, 200, {
                data: page.map((row) => positionRow(row)),
                pagination: {
                    limit: positionsPage,
                    offset,
                    has_more: more,
                    next_cursor: more ? String(offset + positionsPage) : null,
                },
            });
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
        if (path === "/data/trades") {
            tradeQueries.push(url.search);
            if (tradesStatus !== null) return send(response, tradesStatus, { error: "trades are down" });
            const id = url.searchParams.get("id");
            const asset = url.searchParams.get("asset_id");
            // Like the exchange, a trade at the `after` second itself is left out
            const after = Number(url.searchParams.get("after") ?? 0);
            const data = id
                ? [trades.get(id)].filter((trade) => trade !== undefined)
                : [...trades.values()].filter(
                      (trade) =>
                          (!asset || (trade as { asset_id?: string }).asset_id === asset) &&
                          Number((trade as { match_time?: string }).match_time ?? 0) > after,
                  );
            const cursor = url.searchParams.get("next_cursor");
            const offset = cursor && cursor !== "MA==" ? Number(Buffer.from(cursor, "base64").toString()) : 0;
            const page = data.slice(offset, offset + tradesPage);
            const end = offset + tradesPage;
            const next = end < data.length ? Buffer.from(String(end)).toString("base64") : "LTE=";
            return send(response, 200, { limit: 100, count: page.length, next_cursor: next, data: page });
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
        submitted,
        nextSubmit: (response) => void (nextSubmitAnswer = response),
        submitArrived: () => new Promise<void>((resolve) => (submitSeen = resolve)),
        setTransactionState: (id, state) => void states.set(id, state),
        setPositions: (rows) => void (positions = rows),
        setPositionsPageSize: (size) => void (positionsPage = size),
        setBook: (tokenId, book) => void books.set(tokenId, book),
        setBalance: (e6) => void (balance = e6),
        setOrder: (id, order) => void orders.set(id, order),
        clearTrades: () => trades.clear(),
        setTradesPageSize: (size) => void (tradesPage = size),
        setTrade: (id, trade) => void trades.set(id, trade),
        failTrades: (status) => void (tradesStatus = status),
        tradeQueries,
        nextPost: (response) => void (next = response),
        dropConnections: () => server.closeAllConnections(),
        postArrived: () => new Promise<void>((resolve) => (arrived = resolve)),
        stop: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}
