import { pino } from "pino";
import { io as connectSocket } from "socket.io-client";
import { afterAll, beforeAll, expect, inject, test } from "vitest";
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
const aboutRequests = () => lines.filter((line) => line.req);

test("a refused request is logged once with the reason the person was given", async () => {
    lines.length = 0;
    const response = await fetch(`${stack.url}/v1/account`, { headers: { "x-request-id": "req-401" } });
    expect(response.status).toBe(401);
    await expect.poll(() => aboutRequests().length).toBe(1);
    expect(aboutRequests()[0]).toMatchObject({
        level: WARN,
        code: "unauthorized",
        detail: "no_token",
        reason: "Your session expired. Sign in again.",
        req: { id: "req-401", path: "/v1/account" },
        res: { statusCode: 401 },
    });
});

test("an unknown route names itself, without its query", async () => {
    const response = await fetch(`${stack.url}/nowhere?x=1`);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe("No such endpoint: GET /nowhere.");
});

test("a body that isn't JSON says so and is logged with its kind", async () => {
    lines.length = 0;
    const response = await fetch(`${stack.url}/v1/account`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer nope" },
        body: "{not json",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe("The request wasn't valid JSON.");
    await expect.poll(() => aboutRequests().length).toBe(1);
    expect(aboutRequests()[0]).toMatchObject({ event: "http.bad_body", type: "entity.parse.failed", level: WARN });
});

test("a socket connection without a token is logged as refused", async () => {
    lines.length = 0;
    const socket = connectSocket(stack.url, { auth: { token: "" }, transports: ["websocket"], reconnection: false });
    const message = await new Promise<string>((resolve) =>
        socket.once("connect_error", (error) => resolve(error.message)),
    );
    socket.disconnect();
    expect(message).toBe("Your session expired. Sign in again.");
    await expect.poll(() => lines.filter((line) => line.event === "socket.handshake_refused").length).toBe(1);
    expect(lines.find((line) => line.event === "socket.handshake_refused")).toMatchObject({
        level: WARN,
        code: "unauthorized",
        detail: "no_token",
    });
});
