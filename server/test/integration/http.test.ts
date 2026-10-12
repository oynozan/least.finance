import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import { getAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { createKeyring } from "../../src/accounts/keyring.ts";
import { startStack, WEB_ORIGIN, type Stack, type User } from "../support/stack.ts";

let stack: Stack;
beforeAll(async () => {
    stack = await startStack({ mongoUri: inject("mongoUri"), anvilUrl: inject("anvilUrl") });
});
afterAll(() => stack?.stop());

type Options = { token?: string | null; body?: unknown; raw?: string; headers?: Record<string, string> };

async function call(method: string, path: string, { token, body, raw, headers = {} }: Options = {}, base = stack) {
    const response = await fetch(`${base.url}${path}`, {
        method,
        headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(body !== undefined || raw !== undefined ? { "content-type": "application/json" } : {}),
            ...headers,
        },
        body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const text = await response.text();
    let json: any;
    try {
        json = JSON.parse(text);
    } catch {
        json = undefined;
    }
    return { status: response.status, headers: response.headers, json };
}

const connect = (user: User, base = stack) => call("POST", "/v1/account", { token: user.token }, base);

async function connected() {
    const user = await stack.user();
    const { json } = await connect(user);
    return { user, depositAddress: json.account.depositAddress as Address };
}

describe("health", () => {
    test("health reports ok", async () => {
        const res = await call("GET", "/health");
        expect(res.status).toBe(200);
        expect(res.json).toEqual({ status: "ok" });
    });

    test("ready reports the database and a fresh deposit scan", async () => {
        await expect.poll(async () => (await call("GET", "/ready")).status, { timeout: 10_000 }).toBe(200);
        const res = await call("GET", "/ready");
        expect(res.json).toMatchObject({ status: "ready", database: true });
        expect(res.json.depositScan).toBeDefined();
    });
});

describe("security headers", () => {
    test("responses carry the hardened headers", async () => {
        const res = await call("GET", "/health");
        expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(res.headers.get("x-powered-by")).toBeNull();
        expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
        expect(res.headers.get("strict-transport-security")).toBeTruthy();
    });

    test("a valid request id is echoed back", async () => {
        const res = await call("GET", "/health", { headers: { "x-request-id": "abc-123.x:y" } });
        expect(res.headers.get("x-request-id")).toBe("abc-123.x:y");
    });

    test("a missing request id is generated as a uuid", async () => {
        const res = await call("GET", "/health");
        expect(res.headers.get("x-request-id")).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
    });

    test("an invalid request id is replaced", async () => {
        for (const bad of ["has spaces here", "a".repeat(65)]) {
            const res = await call("GET", "/health", { headers: { "x-request-id": bad } });
            const id = res.headers.get("x-request-id");
            expect(id).not.toBe(bad);
            expect(id).toMatch(/^[0-9a-f-]{36}$/);
        }
    });
});

describe("cors", () => {
    test("the web origin is allowed", async () => {
        const res = await call("GET", "/health", { headers: { origin: WEB_ORIGIN } });
        expect(res.headers.get("access-control-allow-origin")).toBe(WEB_ORIGIN);
    });

    test("other origins get no cors headers", async () => {
        const res = await call("GET", "/health", { headers: { origin: "https://evil.example" } });
        expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });

    test("a preflight for connect succeeds for the web origin", async () => {
        const res = await call("OPTIONS", "/v1/account", {
            headers: {
                origin: WEB_ORIGIN,
                "access-control-request-method": "POST",
                "access-control-request-headers": "authorization,content-type",
            },
        });
        expect(res.status).toBeLessThan(300);
        expect(res.headers.get("access-control-allow-origin")).toBe(WEB_ORIGIN);
        expect(res.headers.get("access-control-allow-methods")).toContain("POST");
        const allowed = res.headers.get("access-control-allow-headers")!.toLowerCase();
        expect(allowed).toContain("authorization");
        expect(allowed).toContain("content-type");
    });
});

describe("errors", () => {
    test("an unknown route is a json 404", async () => {
        const res = await call("GET", "/nope");
        expect(res.status).toBe(404);
        expect(res.json.error.code).toBe("not_found");
        expect(typeof res.json.error.message).toBe("string");
    });

    test("malformed json is a 400", async () => {
        const user = await stack.user();
        const res = await call("POST", "/v1/account", { token: user.token, raw: "{not json" });
        // Auth runs after body parsing, so the parse error wins either way.
        expect(res.status).toBe(400);
        expect(res.json.error.code).toBe("bad_request");
    });

    test("a body over 16kb is a 413", async () => {
        const res = await call("POST", "/v1/account", { raw: JSON.stringify({ pad: "x".repeat(17_000) }) });
        expect(res.status).toBe(413);
        expect(res.json.error.code).toBe("bad_request");
    });
});

describe("authentication", () => {
    test("a missing authorization header is 401", async () => {
        const res = await call("POST", "/v1/account", {});
        expect(res.status).toBe(401);
        expect(res.json.error.code).toBe("unauthorized");
    });

    test("a garbage token is 401", async () => {
        const res = await call("POST", "/v1/account", { token: "garbage" });
        expect(res.status).toBe(401);
        expect(res.json.error.code).toBe("unauthorized");
    });

    test("a token for another app id is 401", async () => {
        const user = await stack.user();
        const token = await stack.privy.token(user.userId, { appId: "other" });
        expect((await connect({ ...user, token })).status).toBe(401);
    });

    test("a token from the wrong issuer is 401", async () => {
        const user = await stack.user();
        const token = await stack.privy.token(user.userId, { issuer: "evil.example" });
        expect((await connect({ ...user, token })).status).toBe(401);
    });

    test("an expired token is 401", async () => {
        const user = await stack.user();
        const token = await stack.privy.token(user.userId, { expiresInSeconds: -10 });
        expect((await connect({ ...user, token })).status).toBe(401);
    });
});

describe("opening accounts", () => {
    test("POST /v1/account opens an account with its deposit address", async () => {
        const user = await stack.user();
        const res = await connect(user);
        expect(res.status).toBe(200);
        expect(res.json).toEqual({
            account: {
                depositAddress: getAddress(res.json.account.depositAddress),
                balance: "0",
                version: 0,
            },
            deposits: { items: [], next: null },
            rules: { chainId: 5042, minDeposit: "0.01" },
            orders: [],
        });
    });

    test("opening twice returns the same deposit address", async () => {
        const user = await stack.user();
        const first = await connect(user);
        const second = await connect(user);
        expect(second.json.account.depositAddress).toBe(first.json.account.depositAddress);
    });

    test("different users get different deposit addresses", async () => {
        const a = await connected();
        const b = await connected();
        expect(a.depositAddress).not.toBe(b.depositAddress);
    });

    test("the deposit address matches the keyring derivation", async () => {
        const user = await stack.user();
        const res = await connect(user);
        const { services } = stack.server;
        const doc = await services.database.collections.accounts.findOne({ privyUserId: user.userId });
        expect(doc).not.toBeNull();
        const keyring = createKeyring(services.config.DEPOSIT_MNEMONIC);
        expect(res.json.account.depositAddress).toBe(getAddress(keyring.addressAt(doc!.depositIndex)));
        expect(doc!.depositIndex).toBeGreaterThanOrEqual(1);
    });

    test("a person with two linked wallets still has one account", async () => {
        const user = await stack.user();
        stack.privy.setUser(user.userId, [user.wallet, privateKeyToAddress(generatePrivateKey())]);
        const a = await connect(user);
        const b = await connect({ ...user, token: await stack.privy.token(user.userId) });
        expect(b.json.account.depositAddress).toBe(a.json.account.depositAddress);
        const { accounts } = stack.server.services.database.collections;
        expect(await accounts.countDocuments({ privyUserId: user.userId })).toBe(1);
    });
});

describe("accounts", () => {
    test("an account can't be read before opening", async () => {
        const user = await stack.user();
        const res = await call("GET", "/v1/account", { token: user.token });
        expect(res.status).toBe(409);
        expect(res.json.error).toEqual({ code: "wallet_not_connected", message: "Open your account first." });
    });

    test("an account is readable after opening", async () => {
        const user = await stack.user();
        const opened = await connect(user);
        const res = await call("GET", "/v1/account", { token: user.token });
        expect(res.status).toBe(200);
        expect(res.json).toEqual(opened.json.account);
    });

    test("deposits can't be listed or reported before opening", async () => {
        const user = await stack.user();
        const listed = await call("GET", "/v1/account/deposits", { token: user.token });
        expect(listed.json.error.code).toBe("wallet_not_connected");
        const reported = await call("POST", "/v1/account/deposits", {
            token: user.token,
            body: { txHash: `0x${"ab".repeat(32)}` },
        });
        expect(reported.json.error.code).toBe("wallet_not_connected");
    });

    test("each user reads their own account", async () => {
        const mine = await connected();
        const theirs = await connected();
        const res = await call("GET", "/v1/account", { token: theirs.user.token });
        expect(res.json.depositAddress).toBe(theirs.depositAddress);
        expect(res.json.depositAddress).not.toBe(mine.depositAddress);
    });

    test("the old wallet routes are gone", async () => {
        const { user } = await connected();
        for (const [method, path] of [
            ["POST", "/v1/wallets/connect"],
            ["GET", `/v1/accounts/${user.wallet}`],
        ] as const) {
            expect((await call(method, path, { token: user.token })).status).toBe(404);
        }
    });
});

describe("deposit history", () => {
    test("deposits page newest first without duplicates", async () => {
        const { user, depositAddress } = await connected();
        const hashes: string[] = [];
        for (const amount of ["1", "2", "3", "4", "5"]) {
            const hash = await stack.chain.send(user.wallet, depositAddress, amount);
            const res = await call("POST", "/v1/account/deposits", {
                token: user.token,
                body: { txHash: hash },
            });
            expect(res.status).toBe(200);
            hashes.push(hash);
        }

        const seen: string[] = [];
        let before: string | undefined;
        let pages = 0;
        do {
            const query = `limit=2${before ? `&before=${before}` : ""}`;
            const res = await call("GET", `/v1/account/deposits?${query}`, { token: user.token });
            expect(res.status).toBe(200);
            expect(res.json.items.length).toBeLessThanOrEqual(2);
            seen.push(...res.json.items.map((item: { txHash: string }) => item.txHash));
            before = res.json.next ?? undefined;
            pages++;
        } while (before && pages < 10);

        expect(pages).toBe(3);
        expect(seen).toEqual([...hashes].reverse());
        expect(new Set(seen).size).toBe(5);
    });

    test("an out of range limit is 400", async () => {
        const { user } = await connected();
        for (const limit of ["0", "101"]) {
            const res = await call("GET", `/v1/account/deposits?limit=${limit}`, {
                token: user.token,
            });
            expect(res.status).toBe(400);
            expect(res.json.error.code).toBe("bad_request");
        }
    });

    test("a malformed cursor is 400", async () => {
        const { user } = await connected();
        const res = await call("GET", "/v1/account/deposits?before=nope", { token: user.token });
        expect(res.status).toBe(400);
    });
});

describe("reporting deposits", () => {
    test("a reported transfer is credited once", async () => {
        const { user, depositAddress } = await connected();
        const hash = await stack.chain.send(user.wallet, depositAddress, "12.5");
        const path = "/v1/account/deposits";
        const first = await call("POST", path, { token: user.token, body: { txHash: hash } });
        expect(first.status).toBe(200);
        expect(first.json).toMatchObject({
            txHash: hash,
            deposits: [{ amount: "12.5" }],
            account: { balance: "12.5" },
        });

        const again = await call("POST", path, { token: user.token, body: { txHash: hash } });
        expect(again.status).toBe(200);
        expect(again.json.deposits).toHaveLength(1);
        expect(again.json.deposits[0].id).toBe(first.json.deposits[0].id);
        expect(again.json.account.balance).toBe("12.5");
    });

    test("a transfer to somewhere else is not a deposit", async () => {
        const { user } = await connected();
        const hash = await stack.chain.send(user.wallet, privateKeyToAddress(generatePrivateKey()), "1");
        const res = await call("POST", "/v1/account/deposits", {
            token: user.token,
            body: { txHash: hash },
        });
        expect(res.status).toBe(422);
        expect(res.json.error.code).toBe("no_deposit");
    });

    test("an unknown transaction is 404", async () => {
        const { user } = await connected();
        const res = await call("POST", "/v1/account/deposits", {
            token: user.token,
            body: { txHash: `0x${"ab".repeat(32)}` },
        });
        expect(res.status).toBe(404);
        expect(res.json.error.code).toBe("tx_not_found");
    });

    test("a malformed hash is 400", async () => {
        const { user } = await connected();
        const res = await call("POST", "/v1/account/deposits", {
            token: user.token,
            body: { txHash: "0x1234" },
        });
        expect(res.status).toBe(400);
        expect(res.json.error.code).toBe("bad_request");
    });
});

describe("rate limits", () => {
    let limited: Stack;
    beforeAll(async () => {
        limited = await startStack({ mongoUri: inject("mongoUri"), anvilUrl: inject("anvilUrl") });
    });
    afterAll(() => limited?.stop());

    test("connect is limited to 30 requests a minute", async () => {
        const user = await limited.user();
        for (let i = 0; i < 30; i++) {
            const res = await connect(user, limited);
            expect(res.status).toBe(200);
        }
        const res = await connect(user, limited);
        expect(res.status).toBe(429);
        expect(res.json.error.code).toBe("rate_limited");
        expect(res.headers.get("ratelimit-policy")).toBeTruthy();
    });
});
