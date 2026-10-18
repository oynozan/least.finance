import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { parseUnits } from "viem";
import { afterAll, beforeAll, describe, expect, inject, test, vi } from "vitest";
import type { PerpOrderDoc } from "../../src/db/mongo.ts";
import { toDecimal } from "../../src/db/money.ts";
import type {
    Ack,
    PerpUpdate,
    PnlSeries,
    PredictionPlaced,
    PredictionUpdate,
    WalletSession,
} from "../../src/protocol.ts";
import { seedRows } from "../support/history-seed.ts";
import { startStack, type AppSocket, type Stack } from "../support/stack.ts";

const TRADING_ENV = {
    PREDICTIONS_TRADING: "on",
    POLYMARKET_POOL_KEY: `0x${"1".repeat(64)}`,
    POLYMARKET_BUILDER_API_KEY: "key",
    POLYMARKET_BUILDER_API_SECRET: "secret",
    POLYMARKET_BUILDER_API_PASSPHRASE: "passphrase",
};

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const wei = (usdc: string) => parseUnits(usdc, 18);
const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

let stack: Stack;
beforeAll(async () => {
    stack = await startStack({ mongoUri: inject("mongoUri"), anvilUrl: inject("anvilUrl"), env: TRADING_ENV });
});
afterAll(() => stack?.stop());

const collections = () => stack.server.services.database.collections;

type Person = Awaited<ReturnType<typeof person>>;

/** A signed-in user with an open account; `changes()` counts the `pnl:changed` its socket received. */
async function person() {
    const user = await stack.user();
    const socket = await stack.socket(user);
    let changed = 0;
    socket.on("pnl:changed", () => changed++);
    const opened = (await socket.timeout(5000).emitWithAck("account:open", {})) as Ack<WalletSession>;
    if (!opened.ok) throw new Error(opened.error.code);
    const account = (await collections().accounts.findOne({ privyUserId: user.userId }))!;
    return { user, socket, session: opened.data, accountId: account._id, changes: () => changed };
}

const series = (socket: AppSocket, payload: unknown) =>
    socket.timeout(5000).emitWithAck("pnl:series", payload as { tz: string }) as Promise<Ack<PnlSeries>>;

const lastBalances = (data: PnlSeries) =>
    (["7D", "30D", "All"] as const).map((range) => data.ranges[range].points.at(-1)!.balance);

describe("pnl:series", () => {
    test("pnl:series answers all three ranges for the bound account", async () => {
        const { socket, accountId } = await person();
        await seedRows(collections(), accountId, [
            { kind: "deposit", usdc: "100", at: ago(10) },
            { kind: "deposit", usdc: "25", at: ago(2) },
        ]);

        const result = await series(socket, { tz: "UTC" });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.data.tz).toBe("UTC");
        expect(result.data.ranges["7D"].points).toHaveLength(7);
        expect(result.data.ranges["30D"].points).toHaveLength(30);
        expect(result.data.ranges.All.points.length).toBeGreaterThanOrEqual(7);
        expect(lastBalances(result.data)).toEqual(["125", "125", "125"]);
    });

    test("an unbound socket is refused with wallet_not_connected", async () => {
        const socket = await stack.socket(await stack.user());

        const result = await series(socket, { tz: "UTC" });

        expect(result).toMatchObject({ ok: false, error: { code: "wallet_not_connected" } });
    });

    test("two users never see each other's totals", async () => {
        const first = await person();
        const second = await person();
        await seedRows(collections(), first.accountId, [{ kind: "deposit", usdc: "100", at: ago(1) }]);
        await seedRows(collections(), second.accountId, [{ kind: "deposit", usdc: "7", at: ago(1) }]);

        const [a, b] = await Promise.all([series(first.socket, { tz: "UTC" }), series(second.socket, { tz: "UTC" })]);

        expect(a.ok && lastBalances(a.data)).toEqual(["100", "100", "100"]);
        expect(b.ok && lastBalances(b.data)).toEqual(["7", "7", "7"]);
    });

    test("bad payloads answer bad_request naming tz", async () => {
        const { socket } = await person();
        for (const payload of [undefined, {}, { tz: 5 }, { tz: "x".repeat(65) }]) {
            const result = await series(socket, payload);
            expect(result).toMatchObject({ ok: false, error: { code: "bad_request" } });
            if (!result.ok) expect(result.error.message).toContain("time zone");
        }
    });

    test("an unknown zone answers tz UTC", async () => {
        const { socket } = await person();

        const result = await series(socket, { tz: "Not/AZone" });

        expect(result).toMatchObject({ ok: true, data: { tz: "UTC" } });
    });

    test("the 31st request in a minute is rate_limited", async () => {
        const { socket } = await person();
        const results: Ack<PnlSeries>[] = [];
        for (let i = 0; i < 31; i++) results.push(await series(socket, { tz: "UTC" }));

        expect(results.slice(0, 30).every((result) => result.ok)).toBe(true);
        expect(results[30]).toMatchObject({
            ok: false,
            error: {
                code: "rate_limited",
                message: expect.stringMatching(/^Too many requests. Try again in \d+ seconds?.$/),
            },
        });
    });

    test("a database error answers internal and the socket keeps working", async () => {
        const { socket } = await person();
        const spy = vi.spyOn(stack.server.services.pnl, "series").mockRejectedValueOnce(new Error("db down"));

        const failed = await series(socket, { tz: "UTC" });
        const next = await series(socket, { tz: "UTC" });

        expect(failed).toMatchObject({ ok: false, error: { code: "internal" } });
        if (!failed.ok) expect(failed.error.message).not.toContain("db down");
        expect(next).toMatchObject({ ok: true, data: { tz: "UTC" } });
        spy.mockRestore();
    });
});

describe("pnl:changed", () => {
    /** The owner and a second user bound to its own account. */
    const pair = async () => ({ owner: await person(), bystander: await person() });
    type Pair = Awaited<ReturnType<typeof pair>>;

    /** The owner got exactly one push, and the other user got none. */
    async function expectOwnerOnly({ owner, bystander }: Pair) {
        await expect.poll(() => owner.changes()).toBe(1);
        await settle();
        expect(owner.changes()).toBe(1);
        expect(bystander.changes()).toBe(0);
    }

    /** Nobody got a push once `ready` is true and the push that would follow it has had time to arrive. */
    async function expectNone({ owner, bystander }: Pair, ready: () => unknown) {
        await expect.poll(ready).toBeTruthy();
        await settle();
        expect(owner.changes()).toBe(0);
        expect(bystander.changes()).toBe(0);
    }

    const accountOf = async (accountId: ObjectId) => (await collections().accounts.findOne({ _id: accountId }))!;

    async function fund({ accountId }: Person, usdc: string) {
        const { accounts, ledger } = collections();
        const updated = await accounts.findOneAndUpdate(
            { _id: accountId },
            { $inc: { balance: toDecimal(wei(usdc)), version: 1 } },
            { returnDocument: "after" },
        );
        await ledger.insertOne({
            _id: new ObjectId(),
            accountId,
            kind: "deposit",
            amount: toDecimal(wei(usdc)),
            balanceAfter: updated!.balance,
            refId: new ObjectId(),
            createdAt: new Date(),
        });
    }

    async function outcome() {
        const eventId = stack.polymarket.fixtures.samples.yesNo;
        const response = await fetch(`${stack.url}/markets/${eventId}`);
        const event = (await response.json()) as { outcomes: { tokenId: string }[] };
        return { eventId, tokenId: event.outcomes[0]!.tokenId };
    }

    /** An open position of 20 shares in the person's account. */
    async function holding(accountId: ObjectId, tokenId: string, eventId: string) {
        const now = new Date();
        const _id = new ObjectId();
        await collections().positions.insertOne({
            _id,
            accountId,
            eventId,
            marketId: "1",
            tokenId,
            conditionId: "0xcondition",
            question: "Will it rain?",
            outcome: "YES",
            shares: toDecimal(20_123_456n),
            cost: toDecimal(wei("10")),
            state: "open",
            proceeds: null,
            payout: null,
            openedAt: now,
            settledAt: null,
            updatedAt: now,
        });
        return _id.toHexString();
    }

    // Every field perpOrderView reads, or the handler throws and sends nothing
    const perpOrder = (accountId: ObjectId) =>
        ({
            _id: new ObjectId(),
            accountId,
            requestId: randomUUID(),
            kind: "close",
            asset: "BTC",
            side: "long",
            leverage: 5,
            state: "done",
            reason: null,
            steps: {},
            collateral: toDecimal(wei("10")),
            sizeCoin: "0.01",
            createdAt: new Date(),
            updatedAt: new Date(),
        }) as unknown as PerpOrderDoc;

    test("a deposit credit reaches only the owner", async () => {
        const both = await pair();
        const { owner } = both;

        await stack.chain.send(owner.user.wallet, owner.session.account.depositAddress, "5");

        await expectOwnerOnly(both);
    });

    test("a withdrawal update reaches only the owner", async () => {
        const both = await pair();
        const { owner } = both;
        const [id] = await seedRows(collections(), owner.accountId, [
            { kind: "withdrawal", usdc: "4", at: new Date(), state: "failed" },
        ]);
        const withdrawal = (await collections().withdrawals.findOne({ _id: id }))!;

        stack.server.services.bus.emit("withdrawal:updated", {
            withdrawal,
            account: await accountOf(owner.accountId),
        });

        await expectOwnerOnly(both);
    });

    test("a sell fill reaches only the owner", async () => {
        const both = await pair();
        const { owner } = both;
        const updates: PredictionUpdate[] = [];
        owner.socket.on("prediction:update", (update) => updates.push(update));
        const { eventId, tokenId } = await outcome();
        const positionId = await holding(owner.accountId, tokenId, eventId);
        const bid = Number(stack.polymarket.book(tokenId)!.bids[0]!.price);

        const closed = await owner.socket
            .timeout(5000)
            .emitWithAck("prediction:close", { requestId: randomUUID(), positionId, quotedPrice: bid });

        expect(closed.ok).toBe(true);
        await expectOwnerOnly(both);
        expect(updates.map((update) => update.order)).toMatchObject([{ side: "sell", state: "filled" }]);
    });

    test("a settled perp reaches only the owner", async () => {
        const both = await pair();
        const { owner } = both;
        const [id] = await seedRows(collections(), owner.accountId, [
            {
                kind: "perp",
                state: "closed",
                collateral: "10",
                proceeds: "12",
                openedAt: ago(1),
                settledAt: new Date(),
            },
        ]);
        const position = (await collections().perpPositions.findOne({ _id: id }))!;

        stack.server.services.bus.emit("perp:updated", {
            order: perpOrder(owner.accountId),
            position,
            account: await accountOf(owner.accountId),
        });

        await expectOwnerOnly(both);
    });

    test("a settled prediction reaches only the owner", async () => {
        const both = await pair();
        const { owner } = both;
        const [id] = await seedRows(collections(), owner.accountId, [
            { kind: "prediction", state: "won", cost: "10", payout: "20", openedAt: ago(1), settledAt: new Date() },
        ]);
        const position = (await collections().positions.findOne({ _id: id }))!;

        stack.server.services.bus.emit("position:settled", { position, account: await accountOf(owner.accountId) });

        await expectOwnerOnly(both);
    });

    test("a buy fill pushes nothing", async () => {
        const both = await pair();
        const { owner } = both;
        await fund(owner, "100");
        const updates: PredictionUpdate[] = [];
        owner.socket.on("prediction:update", (update) => updates.push(update));
        const { eventId, tokenId } = await outcome();
        const quote = await stack.server.services.markets.outcome(eventId, tokenId);

        const placed = (await owner.socket.timeout(5000).emitWithAck("prediction:order", {
            requestId: randomUUID(),
            eventId,
            tokenId,
            amountUSD: "10",
            quotedPrice: quote!.outcome.buyPrice,
        })) as Ack<PredictionPlaced>;

        expect(placed.ok).toBe(true);
        await expectNone(both, () => updates.find((update) => update.order.state === "filled"));
        expect(updates.map((update) => update.order.side)).toEqual(["buy"]);
    });

    test("a funding tick on an open perp pushes nothing", async () => {
        const both = await pair();
        const { owner } = both;
        const updates: PerpUpdate[] = [];
        owner.socket.on("perp:update", (update) => updates.push(update));
        const [id] = await seedRows(collections(), owner.accountId, [
            { kind: "perp", state: "open", collateral: "10", openedAt: ago(1) },
        ]);
        const position = (await collections().perpPositions.findOne({ _id: id }))!;
        expect(position.settledAt).toBeNull();

        stack.server.services.bus.emit("perp:updated", {
            order: perpOrder(owner.accountId),
            position,
            account: await accountOf(owner.accountId),
        });

        await expectNone(both, () => updates.length);
    });
});
