/** What a node or cluster said that means it turned the transaction down, by the words it uses. */
const REFUSALS: [name: string, test: RegExp][] = [
    ["insufficient funds", /insufficient funds|insufficient lamports/i],
    ["underpriced", /underpriced/i],
    ["gas too low", /gas too low/i],
    ["intrinsic gas", /intrinsic gas/i],
    ["invalid sender", /invalid sender/i],
    ["exceeds balance", /exceeds (the )?balance/i],
    ["execution reverted", /execution reverted/i],
    ["transfer amount exceeds", /transfer amount exceeds/i],
    ["invalid address", /invalid address/i],
];

const ALREADY_SENT = /already known|nonce too low|already imported/i;

/** Every saying along an error's cause chain: the library's summary, the node's details, the message's first line. The RPC URL and request body a viem error prints further down are not among them, since they could match a pattern by accident. */
function sayings(error: unknown): string[] {
    const said: string[] = [];
    let current: unknown = error;
    for (let depth = 0; depth < 6 && current !== undefined && current !== null; depth += 1) {
        if (current instanceof Error) {
            const e = current as Error & { shortMessage?: unknown; details?: unknown };
            for (const part of [e.shortMessage, e.details, e.message])
                if (typeof part === "string") said.push(part.split("\n")[0]!);
            current = e.cause;
        } else {
            said.push(String(current).split("\n")[0]!);
            break;
        }
    }
    return said;
}

/** The pattern that says the network turned the transaction down, so it was never accepted and the amount can go back; null when it didn't. */
export function refusedBy(error: unknown): string | null {
    if (error instanceof Error && error.name === "SolanaRefusal") return "solana refusal";
    const said = sayings(error);
    return REFUSALS.find(([, test]) => said.some((text) => test.test(text)))?.[0] ?? null;
}

/** The network turned the transaction down, so it was never accepted and the amount can go back. */
export const refused = (error: unknown) => refusedBy(error) !== null;

/** A node already holding or having mined the transaction: the receipt decides the rest. */
export const alreadySent = (error: unknown) => sayings(error).some((text) => ALREADY_SENT.test(text));

const oneLine = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);

/** What a node or RPC said, on one line: viem's headline, its details and the cause, with the JSON-RPC code when there is one. */
export function upstreamLine(error: unknown, max = 240): string {
    const e = error as {
        shortMessage?: unknown;
        details?: unknown;
        message?: unknown;
        code?: unknown;
        cause?: { message?: unknown; code?: unknown };
    } | null;
    if (!e || typeof e !== "object") return oneLine(String(error), max);
    const parts: string[] = [];
    const add = (value: unknown) => {
        if (typeof value !== "string") return;
        const text = oneLine(value.split("\n")[0]!, max);
        if (text && !parts.some((part) => part.includes(text) || text.includes(part))) parts.push(text);
    };
    add(e.shortMessage ?? e.message);
    add(e.details);
    add(e.cause?.message);
    const code = typeof e.code === "number" ? e.code : typeof e.cause?.code === "number" ? e.cause.code : null;
    return oneLine(`${parts.join(" - ")}${code !== null ? ` (code ${code})` : ""}`, max) || "no message";
}

/** The network's refusal in plain words: a sentence for the ones we know, otherwise what it said, quoted. */
export function networkSays(error: unknown): string {
    const text = String(error);
    if (error instanceof Error && error.name === "SolanaRefusal") {
        if (/insufficient|no record of a prior credit|AccountNotFound/i.test(text))
            return "Our Solana wallet can't pay for this transfer right now (balance or fees).";
        return `The Solana network rejected the transfer: "${upstreamLine(error)}".`;
    }
    if (/insufficient funds|exceeds (the )?balance/i.test(text))
        return "Our payout wallet can't cover the network fee right now, so the network refused it.";
    if (/underpriced/i.test(text)) return "The network wanted a higher fee than we offered.";
    if (/gas too low|intrinsic gas/i.test(text)) return "The network says the gas limit was too low.";
    if (/execution reverted|transfer amount exceeds/i.test(text))
        return `The token contract rejected the transfer (for example because the receiving address is blocked): "${upstreamLine(error)}".`;
    if (/invalid sender|invalid address/i.test(text)) return "The network refused the destination address.";
    return `The network refused it: "${upstreamLine(error)}".`;
}
