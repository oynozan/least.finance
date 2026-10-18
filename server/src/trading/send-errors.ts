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
