import { pino } from "pino";
import { describe, expect, test } from "vitest";
import type { PriceRange } from "../../src/protocol.ts";
import { createDefiLlama, LLAMA_IDS, LlamaError, MAX_POINTS } from "../../src/prices/defillama.ts";
import { PRICE_RANGES, PriceHistory } from "../../src/prices/history.ts";
import { COINS } from "../../src/swaps/coins.ts";

const llama = createDefiLlama({ url: "https://coins.llama.fi" });
const history = new PriceHistory({ llama, logger: pino({ level: "warn" }) });

const POINTS: Record<PriceRange, number> = { "1d": 96, "7d": 168, "30d": 120, "90d": 90, "1y": 365 };

describe("DefiLlama's free coins API", () => {
    test.each(PRICE_RANGES)("%s prices every swap coin over the whole range", async (range) => {
        const view = await history.view(range);

        expect(view).not.toBeNull();
        expect(view!.coins.map((coin) => coin.symbol)).toEqual(COINS.map((coin) => coin.symbol));
        for (const coin of view!.coins) {
            // DefiLlama has the odd gap of a few hours, which it skips rather than fills
            expect(coin.points.length, coin.symbol).toBeGreaterThanOrEqual(POINTS[range] * 0.9);
            expect(coin.points.length, coin.symbol).toBeLessThanOrEqual(POINTS[range]);
            // The last point is the latest price, not the last whole step
            expect(Date.now() - coin.points.at(-1)![0], coin.symbol).toBeLessThan(3_600_000);
            expect(coin.points.every(([, usd]) => usd > 0)).toBe(true);
        }
        for (const stable of ["USDC", "USDT"]) {
            const points = view!.coins.find((coin) => coin.symbol === stable)!.points;
            expect(
                points.every(([, usd]) => Math.abs(usd - 1) < 0.03),
                stable,
            ).toBe(true);
        }
    });

    test(`still refuses a chart over ${MAX_POINTS} points`, async () => {
        const raw = await fetch(
            `https://coins.llama.fi/chart/${LLAMA_IDS.ETH},${LLAMA_IDS.BTC}?end=${Math.floor(Date.now() / 1000)}&span=251&period=1h`,
        );
        expect(raw.status).toBe(400);
        expect(await raw.text()).toMatch(/maximum of 500/);
        // The client refuses it before sending
        await expect(
            llama.chart({ ids: [LLAMA_IDS.ETH!, LLAMA_IDS.BTC!], end: 0, span: 251, period: "1h" }),
        ).rejects.toThrow(LlamaError);
    });
});
