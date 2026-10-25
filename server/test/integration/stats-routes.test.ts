import { afterAll, beforeAll, expect, test } from "vitest";
import { startStack, type Stack } from "../support/stack.ts";
import { inject } from "vitest";

let s: Stack;
beforeAll(async () => {
    s = await startStack({ mongoUri: inject("mongoUri"), anvilUrl: inject("anvilUrl") });
});
afterAll(async () => {
    await s.stop();
});

test("GET /stats is 503 until the first refresh finishes", async () => {
    const { stats } = s.server.services;
    const real = stats.view.bind(stats);
    stats.view = () => null;
    try {
        const response = await fetch(`${s.url}/stats`);
        expect(response.status).toBe(503);
        expect(((await response.json()) as any).error).toMatchObject({
            code: "unavailable",
            message: "Stats are still loading.",
        });
    } finally {
        stats.view = real;
    }
});

test("GET /stats answers 200 with the view once the first refresh is done", async () => {
    await s.server.services.stats.refresh();
    const response = await fetch(`${s.url}/stats`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const view = (await response.json()) as any;
    expect(view).toMatchObject({ estimated: false, heldUsd: expect.any(String), equityUsd: expect.any(String) });
    expect(view.wallets).toHaveLength(7);
    expect(view.owed.length).toBeGreaterThan(0);
    expect(Object.keys(view.fees)).toEqual(["7D", "30D", "All"]);
});

test("GET /stats/pnl serves a range and refuses a bad one", async () => {
    const week = (await (await fetch(`${s.url}/stats/pnl`)).json()) as any;
    expect(week.range).toBe("7D");
    expect(week.points.length).toBeGreaterThan(0);
    expect((await fetch(`${s.url}/stats/pnl?range=All`)).status).toBe(200);
    const bad = await fetch(`${s.url}/stats/pnl?range=bad`);
    expect(bad.status).toBe(400);
});
