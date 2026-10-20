import type { Locator } from "@playwright/test";
import { io, type Socket } from "socket.io-client";
import type {
    Ack,
    ClientToServerEvents,
    MarketOutcomeView,
    MarketView,
    PredictionOrderView,
    ServerToClientEvents,
} from "@/server/src/protocol";
import { signUp } from "./backend";
import { API, trendingView } from "./polymarket";

export type Bought = { market: MarketView; outcome: MarketOutcomeView };

/** What a position row's details give for `label`, such as "Shares" or "Entry price"; there while the row is closed, only folded away. */
export const positionFact = (row: Locator, label: string) =>
    row
        .locator("dl > div")
        .filter({ has: row.page().locator("dt", { hasText: new RegExp(`^${label}$`) }) })
        .locator("dd");

// predictions.spec.ts and pnl.spec.ts resolve these questions, which would settle a position bought here.
const RESOLVED = new Set([12, 13, 14, 15, 16, 17]);

/**
 * Two-outcome trending questions, oldest bought first, and the second outcome of each: the specs that steer the fake
 * Polymarket do it on the first outcome's token, so these never meet a held or rejected order.
 */
export async function predictionsToBuy(count: number): Promise<Bought[]> {
    const binary = (await trendingView()).markets.filter((m) => m.outcomes.length === 2);
    const usable = binary.filter((_, i) => !RESOLVED.has(i));
    if (usable.length < count) throw new Error(`Only ${usable.length} questions to buy`);
    return usable.slice(0, count).map((market) => ({ market, outcome: market.outcomes[1]! }));
}

const ack = <T>(send: (done: (result: Ack<T>) => void) => void) =>
    new Promise<T>((resolve, reject) =>
        send((result) => (result.ok ? resolve(result.data) : reject(new Error(result.error.message)))),
    );

/**
 * Buys each prediction for the person who owns `address`, through the server's socket as the app does, and waits
 * for every fill. The account needs the dollars first (`seedDeposits`); each buy is $`amountUSD`.
 */
export async function buyPredictions(address: string, picks: readonly Bought[], amountUSD = "10") {
    const { token } = await signUp(address);
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(API, {
        transports: ["websocket"],
        auth: { token },
        reconnection: false,
    });
    const settled = new Map<string, (order: PredictionOrderView) => void>();
    socket.on("prediction:update", ({ requestId, order }) => {
        if (order.state === "filled" || order.state === "failed") settled.get(requestId)?.(order);
    });
    try {
        await new Promise<void>((resolve, reject) => {
            socket.once("connect", resolve);
            socket.once("connect_error", reject);
        });
        await ack((done) => socket.emit("account:open", {}, done));
        // One at a time, so the positions open in the order given.
        for (const { market, outcome } of picks) {
            const requestId = crypto.randomUUID();
            const filled = new Promise<PredictionOrderView>((resolve) => settled.set(requestId, resolve));
            const placed = await ack<PredictionOrderView>((done) =>
                socket.emit(
                    "prediction:order",
                    {
                        requestId,
                        eventId: market.id,
                        tokenId: outcome.tokenId,
                        amountUSD,
                        quotedPrice: outcome.buyPrice,
                    },
                    done,
                ),
            );
            const order = placed.state === "filled" || placed.state === "failed" ? placed : await filled;
            if (order.state !== "filled") throw new Error(`The buy on ${market.title} ${order.state}: ${order.reason}`);
        }
    } finally {
        socket.disconnect();
    }
}
