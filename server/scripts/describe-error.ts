import { scrubUrls } from "../src/logger.ts";

/**
 * An error for an operator script to print: its message, then each cause's message (viem puts the real reason
 * in `cause` and `shortMessage`), with every URL cut to its host since an RPC URL carries the provider's key.
 * Set DEBUG=1 for the stack as well.
 */
export function describeError(error: unknown): string {
    if (!(error instanceof Error)) return scrubUrls(String(error));
    const parts: string[] = [];
    let current: unknown = error;
    for (let depth = 0; current instanceof Error && depth < 5; depth++) {
        const { shortMessage } = current as { shortMessage?: unknown };
        const text = typeof shortMessage === "string" && shortMessage ? shortMessage : current.message;
        const line = scrubUrls(text.split("\n")[0] ?? "").trim();
        if (line && !parts.includes(line)) parts.push(line);
        current = current.cause;
    }
    const said = parts.join(" <- ") || error.name;
    return process.env.DEBUG === "1" && error.stack ? `${said}\n${scrubUrls(error.stack)}` : said;
}
