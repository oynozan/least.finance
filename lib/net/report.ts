const told = new Set<string>();

/** Says a failure once per kind in the console, so a retrying fetch doesn't fill it. */
function warnOnce(kind: string, message: string) {
    if (told.has(kind)) return;
    told.add(kind);
    console.warn(message);
}

/** A public fetch the server refused: the console gets its status and its own words. */
export async function reportRefusal(what: string, response: Response) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: unknown } } | null;
    const said = typeof body?.error?.message === "string" ? `: ${body.error.message}` : "";
    warnOnce(`${what}:${response.status}`, `${what} answered ${response.status}${said}`);
}

/** A public fetch that got no answer at all: offline, or the server is down. */
export function reportUnreachable(what: string, error: unknown) {
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    warnOnce(
        `${what}:${offline ? "offline" : "down"}`,
        offline ? `${what}: you're offline` : `${what}: the server didn't answer (${String(error)})`,
    );
}
