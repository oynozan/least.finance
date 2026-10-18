/** How long a read from our server may take before the page says it didn't answer. */
export const REQUEST_TIMEOUT_MS = 15_000;

/** Why a request got no answer at all, in plain words: offline, no answer in time, or unreachable. */
export function silenceOf(error: unknown): string {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return "You're offline.";
    if (error instanceof Error && error.name === "TimeoutError")
        return `The server didn't answer in ${REQUEST_TIMEOUT_MS / 1000} seconds.`;
    return "Couldn't reach the server.";
}

/** The server's own message from a failed answer, else its status. */
export async function serverSaid(response: Response): Promise<string> {
    try {
        const body = (await response.json()) as { error?: unknown };
        const error = body?.error;
        if (typeof error === "string") return error;
        const message = (error as { message?: unknown } | undefined)?.message;
        if (typeof message === "string" && message) return message;
    } catch {
        // Not JSON: a proxy's page
    }
    return `The server answered ${response.status}.`;
}
