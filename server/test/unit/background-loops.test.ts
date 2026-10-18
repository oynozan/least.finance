import { pino } from "pino";
import { expect, test, vi } from "vitest";
import { MarketService } from "../../src/markets/markets.ts";
import { PerpTracker } from "../../src/perps/tracker.ts";
import { PredictionReconciler } from "../../src/predictions/reconciler.ts";
import { PredictionRedeemer } from "../../src/predictions/redeemer.ts";
import { PredictionResolver } from "../../src/predictions/resolver.ts";
import { PredictionTracker } from "../../src/predictions/tracker.ts";

type Loop = { start(): void; stop(): Promise<void> };

const cases: [string, new (deps: any) => Loop, string, string][] = [
    ["prediction tracking", PredictionTracker, "tick", "pollMs"],
    ["prediction resolution", PredictionResolver, "tick", "resolveMs"],
    ["prediction redemption", PredictionRedeemer, "tick", "intervalMs"],
    ["prediction reconciliation", PredictionReconciler, "tick", "intervalMs"],
    ["perp tracking", PerpTracker, "pass", "pollMs"],
    ["market sync", MarketService, "tick", "syncMs"],
];

for (const [name, Loop, method, interval] of cases) {
    // The perp loop's usual wait is a second, which the backoff doubles, so it fails once
    const failures = name === "perp tracking" ? 1 : 4;
    test(`the ${name} loop logs its first failed pass once, backs off, and says when it works again`, async () => {
        const lines: Record<string, any>[] = [];
        const logger = pino({ level: "info" }, { write: (chunk: string) => void lines.push(JSON.parse(chunk)) });
        let calls = 0;
        const spy = vi.spyOn(Loop.prototype as any, method).mockImplementation(async () => {
            calls += 1;
            if (calls <= failures) throw new Error("mongo down");
        });
        const loop = new Loop({ logger, service: { refreshFloat: async () => undefined }, [interval]: 1 });
        try {
            loop.start();
            await vi.waitFor(() => expect(lines.some((line) => line.event === "loop.recovered")).toBe(true), {
                timeout: 5_000,
            });
        } finally {
            await loop.stop();
            spy.mockRestore();
        }
        const failed = lines.filter((line) => line.event === "loop.failed");
        expect(failed).toHaveLength(1);
        expect(failed[0]).toMatchObject({ level: 40, loop: name, consecutive: 1, err: { message: "mongo down" } });
        expect(lines.find((line) => line.event === "loop.recovered")).toMatchObject({ loop: name, failures });
    });
}
