import { newRef, wentWrong } from "../errors.ts";

type Kind = "status" | "timeout" | "network" | "shape";

/** Polymarket (or the proxy in front of it) didn't give a usable answer; the fields say which service, which call and what came back. */
export class UpstreamError extends Error {
    readonly kind: Kind;
    readonly service: string;
    readonly method: string;
    /** The path without its query, which can carry a search the log shouldn't hold twice. */
    readonly path: string;
    readonly status: number | null;
    readonly retryAfter: string | null;
    /** What Polymarket (or the proxy) said, trimmed to one short line. */
    readonly body: string | null;
    readonly timeoutMs: number | null;

    constructor(
        kind: Kind,
        message: string,
        call: { service: string; method: string; path: string },
        extra: {
            status?: number;
            retryAfter?: string | null;
            body?: string | null;
            timeoutMs?: number;
            cause?: unknown;
        } = {},
    ) {
        super(message, { cause: extra.cause });
        this.name = "UpstreamError";
        this.kind = kind;
        this.service = call.service;
        this.method = call.method;
        this.path = call.path;
        this.status = extra.status ?? null;
        this.retryAfter = extra.retryAfter ?? null;
        this.body = extra.body ?? null;
        this.timeoutMs = extra.timeoutMs ?? null;
    }
}

/** One short line of what an upstream said: its own error text when it sent JSON, else the first part of the text. */
export async function readBody(response: Response): Promise<string | null> {
    let text: string;
    try {
        text = await response.text();
    } catch {
        return null;
    }
    let said = text;
    try {
        const json = JSON.parse(text) as { error?: unknown; message?: unknown };
        const field = json.error ?? json.message;
        if (typeof field === "string") said = field;
        else if (field && typeof (field as { message?: unknown }).message === "string")
            said = (field as { message: string }).message;
    } catch {
        // Not JSON: an HTML error page or plain text
    }
    const line = said
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
    return line || null;
}

type Described = { message: string; level: "warn" | "error"; fields: Record<string, unknown> };
const described = new WeakMap<object, Described>();

/** What the person is told, whether to log it as expected (`warn`) or as a bug (`error`), and the fields the log line carries; the same error always gets the same answer, so its ref is the one logged. */
export function describeUpstream(error: unknown): Described {
    if (typeof error !== "object" || error === null) return describeOnce(error);
    let answer = described.get(error);
    if (!answer) {
        answer = describeOnce(error);
        described.set(error, answer);
    }
    return answer;
}

function describeOnce(error: unknown): Described {
    if (error instanceof UpstreamError) {
        const fields = {
            upstream: error.service,
            upstreamCall: `${error.method} ${error.path}`,
            upstreamStatus: error.status,
            upstreamBody: error.body,
            retryAfter: error.retryAfter,
        };
        if (error.kind === "timeout")
            return {
                message: `Polymarket didn't answer in ${Math.round((error.timeoutMs ?? 0) / 1000)} seconds.`,
                level: "warn",
                fields,
            };
        if (error.kind === "status" && error.status === 429)
            return {
                message: "Polymarket is rate limiting us right now. Try again in a minute.",
                level: "warn",
                fields,
            };
        if (error.kind === "status" || error.kind === "network")
            return { message: "Polymarket isn't reachable right now. Try again in a minute.", level: "warn", fields };
        const ref = newRef();
        return {
            message: `Polymarket sent something we couldn't read (ref ${ref}).`,
            level: "error",
            fields: { ...fields, ref },
        };
    }
    const ref = newRef();
    return { message: wentWrong(ref), level: "error", fields: { ref } };
}
