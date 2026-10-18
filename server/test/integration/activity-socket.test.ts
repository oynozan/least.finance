import { afterAll, beforeAll, describe, expect, inject, test, vi } from "vitest";
import type { Ack, ActivityPage, WalletSession } from "../../src/protocol.ts";
import { seedRows, type SeedRow } from "../support/history-seed.ts";
import { startStack, type AppSocket, type Stack } from "../support/stack.ts";

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let stack: Stack;
beforeAll(async () => {
    stack = await startStack({ mongoUri: inject("mongoUri"), anvilUrl: inject("anvilUrl") });
});
afterAll(() => stack?.stop());

const collections = () => stack.server.services.database.collections;

/** A signed-in user with an open account */
async function person() {
    const user = await stack.user();
    const socket = await stack.socket(user);
    const opened = (await socket.timeout(5000).emitWithAck("account:open", {})) as Ack<WalletSession>;
    if (!opened.ok) throw new Error(opened.error.code);
    const account = (await collections().accounts.findOne({ privyUserId: user.userId }))!;
    return { socket, accountId: account._id };
}

const list = (socket: AppSocket, payload: unknown) =>
    socket.timeout(5000).emitWithAck("activity:list", payload as object) as Promise<Ack<ActivityPage>>;

const deposits = (count: number, usdc = "1"): SeedRow[] =>
    Array.from({ length: count }, (_, i) => ({ kind: "deposit", usdc, at: new Date(Date.now() - (i + 1) * 60_000) }));

const depositIds = (page: ActivityPage) =>
    page.items.map((item) => (item.kind === "deposit" ? item.deposit.id : `${item.kind}?`));

describe("activity:list", () => {
    test("activity:list answers the first page and then the next with the cursor", async () => {
        const { socket, accountId } = await person();
        await seedRows(collections(), accountId, deposits(60));

        const first = await list(socket, { limit: 50 });
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        expect(first.data.items).toHaveLength(50);
        expect(first.data.next).toEqual(expect.any(String));

        const second = await list(socket, { limit: 50, before: first.data.next });
        expect(second.ok).toBe(true);
        if (!second.ok) return;
        expect(second.data.items).toHaveLength(10);
        expect(second.data.next).toBeNull();

        const ids = [...depositIds(first.data), ...depositIds(second.data)];
        expect(new Set(ids).size).toBe(60);
    });

    test("filter trades lists no deposits", async () => {
        const { socket, accountId } = await person();
        await seedRows(collections(), accountId, [
            { kind: "deposit", usdc: "100", at: ago(3) },
            { kind: "withdrawal", usdc: "5", at: ago(2) },
            { kind: "swap", at: ago(2) },
            { kind: "prediction", state: "won", cost: "10", payout: "20", openedAt: ago(5), settledAt: ago(1) },
            { kind: "perp", state: "closed", collateral: "10", proceeds: "12", openedAt: ago(4), settledAt: ago(1) },
        ]);

        const trades = await list(socket, { filter: "trades" });
        const all = await list(socket, {});

        expect(trades.ok && trades.data.items.map((item) => item.kind).sort()).toEqual([
            "perp",
            "perp",
            "prediction",
            "prediction",
            "swap",
        ]);
        expect(all.ok && all.data.items).toHaveLength(7);
    });

    test("an unbound socket is refused with wallet_not_connected", async () => {
        const socket = await stack.socket(await stack.user());

        const result = await list(socket, {});

        expect(result).toMatchObject({ ok: false, error: { code: "wallet_not_connected" } });
    });

    test("two users never see each other's rows", async () => {
        const first = await person();
        const second = await person();
        const [firstId] = await seedRows(collections(), first.accountId, [
            { kind: "deposit", usdc: "100", at: ago(1) },
        ]);
        const [secondId] = await seedRows(collections(), second.accountId, [
            { kind: "deposit", usdc: "7", at: ago(1) },
            { kind: "swap", at: ago(1) },
        ]);

        const a = await list(first.socket, {});
        const b = await list(second.socket, {});

        expect(a.ok && a.data.items).toHaveLength(1);
        expect(a.ok && a.data.items[0]).toMatchObject({ kind: "deposit", deposit: { id: firstId!.toHexString() } });
        expect(b.ok && b.data.items).toHaveLength(2);
        expect(b.ok && b.data.items.map((item) => item.kind).sort()).toEqual(["deposit", "swap"]);
        expect(b.ok && JSON.stringify(b.data)).toContain(secondId!.toHexString());
        expect(a.ok && JSON.stringify(a.data)).not.toContain(secondId!.toHexString());
    });

    test("bad payloads answer bad_request naming the field", async () => {
        const { socket } = await person();
        const id = "a".repeat(24);
        const cases: [unknown, string][] = [
            [{ limit: 0 }, "limit"],
            [{ limit: 101 }, "limit"],
            [{ limit: 1.5 }, "limit"],
            [{ filter: "x" }, "filter"],
            [{ before: "garbage" }, "before"],
            [{ before: `1:9:${id}` }, "before"],
            [{ before: `99999999999999999:0:${id}` }, "before"],
            [{ before: `9000000000000000:0:${id}` }, "before"],
        ];

        for (const [payload, field] of cases) {
            const result = await list(socket, payload);
            expect(result).toMatchObject({ ok: false, error: { code: "bad_request" } });
            if (!result.ok) expect(result.error.message).toContain(field);
        }
    });

    test("the 61st request in a minute is rate_limited by its own limiter", async () => {
        const { socket } = await person();
        const other = await person();
        const results: Ack<ActivityPage>[] = [];
        // The bind's account:open is the 40th event of the shared window
        for (let i = 0; i < 39; i++) results.push(await list(socket, {}));
        await pause(10_500);
        for (let i = 0; i < 21; i++) results.push(await list(socket, {}));
        const last = await list(socket, {});
        const unaffected = await list(other.socket, {});

        expect(results).toHaveLength(60);
        expect(results.every((result) => result.ok)).toBe(true);
        expect(last).toMatchObject({
            ok: false,
            error: { code: "rate_limited", message: expect.stringMatching(/^Too many requests. Try again in \d+ seconds?.$/) },
        });
        expect(unaffected.ok).toBe(true);
    });

    test("a database error answers internal", async () => {
        const { socket, accountId } = await person();
        await seedRows(collections(), accountId, deposits(2));
        const spy = vi.spyOn(stack.server.services.feed, "page").mockRejectedValueOnce(new Error("db down"));

        const failed = await list(socket, {});
        const next = await list(socket, {});

        expect(failed).toMatchObject({ ok: false, error: { code: "internal" } });
        if (!failed.ok) expect(failed.error.message).not.toContain("db down");
        expect(next.ok && next.data.items).toHaveLength(2);
        spy.mockRestore();
    });
});
