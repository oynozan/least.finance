import { afterAll, beforeAll, expect, inject, test, vi } from "vitest";
import { pino } from "pino";
import { AppError } from "../../src/errors.ts";
import type { Ack, WalletSession } from "../../src/protocol.ts";
import { TradeError } from "../../src/trading/trades.ts";
import { startStack, type Stack } from "../support/stack.ts";

type Line = Record<string, any> & { level: number; msg: string };

const lines: Line[] = [];
let stack: Stack;
beforeAll(async () => {
    const logger = pino({ level: "info" }, { write: (chunk: string) => void lines.push(JSON.parse(chunk)) });
    stack = await startStack({ mongoUri: inject("mongoUri"), anvilUrl: inject("anvilUrl"), logger });
});
afterAll(() => stack?.stop());

const WARN = 40;
const ERROR = 50;
const aboutRequests = () => lines.filter((line) => line.req);

test("a successful request and /health write no log line", async () => {
    lines.length = 0;
    expect((await fetch(`${stack.url}/health`)).status).toBe(200);
    expect((await fetch(`${stack.url}/markets/trending`)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(aboutRequests()).toEqual([]);
});

test("a 404 writes one warn line with the method, path, status and request id, and no headers or query", async () => {
    lines.length = 0;
    const response = await fetch(`${stack.url}/nowhere?token=secret-value`, {
        headers: { authorization: "Bearer secret-token", cookie: "session=abc", "x-request-id": "req-404" },
    });
    expect(response.status).toBe(404);
    await expect.poll(() => aboutRequests().length).toBe(1);
    const [line] = aboutRequests();
    expect(line).toMatchObject({
        level: WARN,
        req: { id: "req-404", method: "GET", path: "/nowhere" },
        res: { statusCode: 404 },
    });
    expect(typeof line!.responseTime).toBe("number");
    const text = JSON.stringify(line);
    expect(text).not.toContain("secret");
    expect(text).not.toContain("headers");
});

test("an unexpected error in a request is logged once at error and the client gets its ref", async () => {
    lines.length = 0;
    vi.spyOn(stack.server.services.markets, "trending").mockImplementationOnce(() => {
        throw new Error("boom");
    });
    const response = await fetch(`${stack.url}/markets/trending`, { headers: { "x-request-id": "abcdef12-3456" } });
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Something went wrong on our side (ref abcdef12).");
    await expect.poll(() => aboutRequests().length).toBe(1);
    expect(aboutRequests()[0]).toMatchObject({
        level: ERROR,
        ref: "abcdef12",
        err: { message: "boom" },
        req: { id: "abcdef12-3456", path: "/markets/trending" },
    });
});

test("an unexpected error in a socket request is logged with the event and account, and the client gets the ref", async () => {
    const user = await stack.user();
    const socket = await stack.socket(user);
    const opened = (await socket.timeout(5000).emitWithAck("account:open", {})) as Ack<WalletSession>;
    expect(opened.ok).toBe(true);
    lines.length = 0;
    vi.spyOn(stack.server.services.pnl, "series").mockRejectedValueOnce(new Error("boom"));
    const answer = (await socket.timeout(5000).emitWithAck("pnl:series", { tz: "UTC" })) as Ack<unknown>;
    expect(answer.ok).toBe(false);
    const ref = /\(ref ([0-9a-f]{6})\)/.exec((answer as { error: { message: string } }).error.message)?.[1];
    expect(ref).toBeDefined();
    const logged = lines.filter((line) => line.event === "pnl:series");
    expect(logged).toHaveLength(1);
    const account = await stack.server.services.database.collections.accounts.findOne({ privyUserId: user.userId });
    expect(logged[0]).toMatchObject({
        level: ERROR,
        event: "pnl:series",
        account: account!._id.toHexString(),
        ref,
        err: { message: "boom" },
    });
});

test("an expected refusal in a socket request is logged once at warn with the event, account and code, and no stack", async () => {
    const user = await stack.user();
    const socket = await stack.socket(user);
    expect(((await socket.timeout(5000).emitWithAck("account:open", {})) as Ack<WalletSession>).ok).toBe(true);
    lines.length = 0;
    vi.spyOn(stack.server.services.pnl, "series").mockRejectedValueOnce(
        new AppError("insufficient_funds", "You need $5 more."),
    );
    const answer = (await socket.timeout(5000).emitWithAck("pnl:series", { tz: "UTC" })) as Ack<unknown>;
    expect(answer.ok).toBe(false);
    const logged = lines.filter((line) => line.event === "pnl:series");
    expect(logged).toHaveLength(1);
    const account = await stack.server.services.database.collections.accounts.findOne({ privyUserId: user.userId });
    expect(logged[0]).toMatchObject({
        level: WARN,
        event: "pnl:series",
        account: account!._id.toHexString(),
        code: "insufficient_funds",
    });
    expect(logged[0]!.msg).toContain("You need $5 more.");
    expect(logged[0]!.err).toBeUndefined();
});

test("an expected refusal in a trading request is logged once at warn", async () => {
    const user = await stack.user();
    const socket = await stack.socket(user);
    expect(((await socket.timeout(5000).emitWithAck("account:open", {})) as Ack<WalletSession>).ok).toBe(true);
    lines.length = 0;
    vi.spyOn(stack.server.services.trades, "order").mockRejectedValueOnce(
        new TradeError("insufficient_balance", "Not enough USDC."),
    );
    const answer = (await socket.timeout(5000).emitWithAck("trade:order", {
        requestId: "11111111-1111-4111-8111-111111111111",
        verb: "buy",
        symbol: "BTC",
        amountUSD: "5",
        quotedPriceUSD: "1",
    })) as { ok: boolean };
    const logged = lines.filter((line) => line.event === "trade:order" && line.level === WARN);
    expect(answer.ok).toBe(false);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ code: "insufficient_balance" });
    expect(logged[0]!.err).toBeUndefined();
});
