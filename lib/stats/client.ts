import { API_URL } from "@/lib/api";
import type { ApiError, StatsPnlView, StatsPositionsPage, StatsRange, StatsView } from "@/server/src/protocol";

async function get<T>(path: string): Promise<T | ApiError> {
    try {
        const response = await fetch(`${API_URL}${path}`, { cache: "no-store" });
        const body = (await response.json().catch(() => null)) as (T & { error?: ApiError }) | null;
        if (response.ok && body) return body;
        return body?.error ?? { code: "internal", message: "Couldn't reach the server." };
    } catch {
        return { code: "internal", message: "Couldn't reach the server." };
    }
}

/** Whether a reply is a failure rather than the data. */
export const failed = <T extends object>(reply: T | ApiError): reply is ApiError =>
    "code" in reply && "message" in reply;

export const fetchStats = () => get<StatsView>("/stats");

export const fetchPnl = (range: StatsRange) => get<StatsPnlView>(`/stats/pnl?range=${encodeURIComponent(range)}`);

/** `ask` is the query string's parameters: page, state and kind. */
export const fetchPositions = (ask: Record<string, string | number>) =>
    get<StatsPositionsPage>(
        `/stats/positions?${new URLSearchParams(Object.entries(ask).map(([k, v]) => [k, String(v)]))}`,
    );
