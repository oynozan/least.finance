import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MarketView, TrendingView } from "@/server/src/protocol";

/** The test backend's API, which answers with the fake Polymarket's fixtures. */
export const API = `http://localhost:${process.env.E2E_API_PORT ?? 4100}`;

const fixtures = JSON.parse(
    readFileSync(join(process.cwd(), "server/test/fixtures/polymarket/events.json"), "utf8"),
) as {
    samples: Record<string, string>;
    top: { markets: { id: string; clobTokenIds: string }[] }[];
    extra: { markets: { id: string; clobTokenIds: string }[] }[];
};

/** Event IDs of the fixture's notable events. */
export const samples = fixtures.samples;

async function get<T>(path: string): Promise<T> {
    const response = await fetch(`${API}${path}`);
    if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
    return (await response.json()) as T;
}

/** A sample's question as the API shapes it. */
export const sampleView = (id: string) => get<MarketView>(`/markets/${id}`);

/** The trending list, in the order the picker shows it. */
export const trendingView = () => get<TrendingView>("/markets/trending");

/** The Polymarket market a token belongs to, which is what resolving takes. */
export function marketIdOf(tokenId: string): string {
    for (const event of [...fixtures.top, ...fixtures.extra]) {
        for (const market of event.markets) {
            if ((JSON.parse(market.clobTokenIds) as string[]).includes(tokenId)) return market.id;
        }
    }
    throw new Error(`No market for token ${tokenId}`);
}
