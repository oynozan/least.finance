import { expect, test, vi } from "vitest";
import { cleanPoints, HISTORY_FRESH_MS, historyQuery, MarketHistory, thin } from "../../src/markets/history.ts";
import type { HistoryQuery, RawPoint } from "../../src/markets/polymarket-data.ts";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW - ms);

test("historyQuery picks the resolution for each age", () => {
    expect(historyQuery(ago(2 * HOUR), NOW)).toEqual({ interval: "1d", fidelity: 5, stepMs: 300_000 });
    expect(historyQuery(new Date(NOW + DAY), NOW)).toEqual({ interval: "1d", fidelity: 5, stepMs: 300_000 });
    expect(historyQuery(ago(2 * DAY), NOW)).toEqual({ interval: "max", fidelity: 12, stepMs: 720_000 });
    expect(historyQuery(ago(DAY + 60_000), NOW).fidelity).toBe(10);
    expect(historyQuery(ago(29 * DAY), NOW).fidelity).toBe(168);
    expect(historyQuery(ago(30 * DAY), NOW)).toEqual({ interval: "max", fidelity: 720, stepMs: 43_200_000 });
    expect(historyQuery(ago(179 * DAY), NOW).fidelity).toBe(720);
    expect(historyQuery(ago(180 * DAY), NOW)).toEqual({ interval: "max", fidelity: 1440, stepMs: 86_400_000 });
    expect(historyQuery(null, NOW)).toEqual({ interval: "max", fidelity: 60, stepMs: 3_600_000 });
});

test("cleanPoints sorts, drops what is out of range, and converts", () => {
    const opened = new Date(5_000_000);
    const raw: RawPoint[] = [
        { t: 3000, p: 0.5 },
        { t: 5000, p: 0.123456 },
        { t: 4000, p: 0.2 },
        { t: 6000, p: 1.2 },
        { t: 7000, p: NaN },
        { t: Infinity, p: 0.5 },
        { t: 8000, p: 0.9 },
    ];
    expect(cleanPoints(raw, opened)).toEqual([
        [5_000_000, 0.1235],
        [8_000_000, 0.9],
    ]);
    expect(cleanPoints(raw, null).map(([t]) => t)).toEqual([3_000_000, 4_000_000, 5_000_000, 8_000_000]);
});

test("thin keeps the ends and the order, and leaves short lists alone", () => {
    const points = Array.from({ length: 1000 }, (_, i) => i);
    const out = thin(points, 300);
    expect(out).toHaveLength(300);
    expect(out[0]).toBe(0);
    expect(out[299]).toBe(999);
    expect(out).toEqual([...out].sort((a, b) => a - b));
    const short = Array.from({ length: 300 }, (_, i) => i);
    expect(thin(short, 300)).toEqual(short);
});

const logger = { warn: vi.fn() } as any;

function setup(outcomeIds = ["a", "b", "c"], openedAt: Date | null = ago(2 * HOUR)) {
    const clock = { now: NOW };
    const state = { calls: [] as { tokens: string[]; query: HistoryQuery }[], fail: false, omit: new Set<string>() };
    const inflight = new Map<string, number>();
    const data = {
        async priceHistory(tokens: string[], query: HistoryQuery) {
            state.calls.push({ tokens, query });
            for (const t of tokens) inflight.set(t, (inflight.get(t) ?? 0) + 1);
            await new Promise((r) => setTimeout(r, 5));
            for (const t of tokens) inflight.set(t, inflight.get(t)! - 1);
            if (state.fail) throw new Error("down");
            return new Map(
                tokens
                    .filter((t) => !state.omit.has(t))
                    .map((t) => [t, [{ t: (NOW - HOUR) / 1000, p: 0.5 }]] as [string, RawPoint[]]),
            );
        },
    };
    const markets = {
        async event(id: string) {
            return id === "ev" ? ({ id, outcomes: outcomeIds.map((tokenId) => ({ tokenId })) } as any) : null;
        },
        openedAt: () => openedAt,
    };
    const history = new MarketHistory({ data, markets, logger, now: () => clock.now });
    return { history, clock, state, inflight };
}

test("view answers in the order asked", async () => {
    const { history } = setup();
    const view = await history.view("ev", ["c", "a"]);
    expect(view!.outcomes.map((o) => o.tokenId)).toEqual(["c", "a"]);
    expect(view!.eventId).toBe("ev");
    expect(view!.outcomes[0]!.points).toEqual([[NOW - HOUR, 0.5]]);
});

test("unknown tokens and events give null without a call", async () => {
    const { history, state } = setup();
    expect(await history.view("ev", ["a", "zzz"])).toBeNull();
    expect(await history.view("nope", ["a"])).toBeNull();
    expect(state.calls).toHaveLength(0);
});

test("fresh entries are not read again, stale ones are, alone", async () => {
    const { history, state, clock } = setup();
    await history.view("ev", ["a"]);
    clock.now += HISTORY_FRESH_MS - 1;
    await history.view("ev", ["a"]);
    expect(state.calls).toHaveLength(1);
    await history.view("ev", ["b"]);
    clock.now += 1;
    await history.view("ev", ["a", "b"]);
    expect(state.calls).toHaveLength(3);
    expect(state.calls[2]!.tokens).toEqual(["a"]);
});

test("concurrent views share one read per token", async () => {
    const { history, state } = setup();
    await Promise.all([history.view("ev", ["a", "b"]), history.view("ev", ["b", "c"])]);
    const asked = state.calls.flatMap((c) => c.tokens).sort();
    expect(asked).toEqual(["a", "b", "c"]);
});

test("a failure serves entries within the stale limit", async () => {
    const { history, state, clock } = setup();
    await history.view("ev", ["a"]);
    state.fail = true;
    clock.now += 10 * 60_000;
    const view = await history.view("ev", ["a"]);
    expect(view!.outcomes[0]!.points).toHaveLength(1);
});

test("a failure past the stale limit, or with no cache, rejects", async () => {
    const { history, state, clock } = setup();
    state.fail = true;
    await expect(history.view("ev", ["a"])).rejects.toThrow();
    state.fail = false;
    await history.view("ev", ["a"]);
    state.fail = true;
    clock.now += 31 * 60_000;
    await expect(history.view("ev", ["a"])).rejects.toThrow();
});

test("a token Polymarket leaves out has no points, and that is cached", async () => {
    const { history, state } = setup();
    state.omit.add("b");
    const view = await history.view("ev", ["a", "b"]);
    expect(view!.outcomes[1]!.points).toEqual([]);
    await history.view("ev", ["b"]);
    expect(state.calls).toHaveLength(1);
});

test("the cache drops the oldest read past 1,000 tokens", async () => {
    const ids = Array.from({ length: 1001 }, (_, i) => `t${i}`);
    const { history, state } = setup(ids);
    for (const id of ids) await history.view("ev", [id]);
    const before = state.calls.length;
    await history.view("ev", ["t1000"]);
    expect(state.calls).toHaveLength(before);
    await history.view("ev", ["t0"]);
    expect(state.calls).toHaveLength(before + 1);
});

test("readAt is the oldest read and stepMs the largest", async () => {
    const { history, clock } = setup();
    await history.view("ev", ["a"]);
    const first = clock.now;
    clock.now += 60_000;
    const view = await history.view("ev", ["a", "b"]);
    expect(view!.readAt).toBe(new Date(first).toISOString());
    expect(view!.stepMs).toBe(300_000);
});
