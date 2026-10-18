/** EIP-1193's code for a request the user turned down in their wallet. */
export const USER_REJECTED = 4001;

/** A wallet's way of saying the person said no, when it doesn't use code 4001. */
const REJECTED_WORDING = /reject|declin|denied|cancel/i;

/** What a wallet's error comes to: the person turned it down, or a sentence for what went wrong. */
export type WalletFailure = { kind: "cancelled" } | { kind: "failed"; message: string };

/** A wallet's own words, trimmed to one short line. */
export function oneLine(text: unknown, max = 140): string {
    const line = String(text ?? "")
        .replace(/\s+/g, " ")
        .trim();
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A hash or address shortened for a sentence: 0x12ab…9f3c. */
export const shortHash = (value: string) => (value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value);

/**
 * Reads an error a wallet threw. A turned-down request is `cancelled`; a known fault gets its plain sentence; any
 * other shows the wallet's own words, quoted. `symbol` names the coin a shortfall is about. The full error goes to the
 * console, so a report of "it didn't work" has the wallet's code and message behind it.
 */
export function walletFailure(
    error: unknown,
    { what = "deposit", symbol, solana = false }: { what?: string; symbol?: string; solana?: boolean } = {},
): WalletFailure {
    const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
    const text = typeof message === "string" ? message : "";
    if (code === USER_REJECTED || REJECTED_WORDING.test(text)) return { kind: "cancelled" };
    console.warn(`Your wallet failed the ${what}`, error);
    if (code === -32002) {
        return {
            kind: "failed",
            message: "Your wallet already has a request open. Finish or close it, then try again.",
        };
    }
    if (code === 4100) {
        return {
            kind: "failed",
            message:
                "Your wallet hasn't given this site access to that account. Connect it in the wallet and try again.",
        };
    }
    if (code === 4900 || code === 4901) {
        return {
            kind: "failed",
            message: "Your wallet lost its connection to the network. Reconnect it and try again.",
        };
    }
    if (/insufficient (funds|lamports)/i.test(text)) {
        return {
            kind: "failed",
            message: `Your wallet doesn't have enough ${solana ? "SOL" : (symbol ?? "balance")} for the ${what} plus network fees.`,
        };
    }
    if (solana && /blockhash/i.test(text)) {
        return { kind: "failed", message: "The transaction expired before your wallet signed it. Try again." };
    }
    const words = oneLine(text).replace(/\.+$/, "");
    const who = solana ? "Your Solana wallet" : "Your wallet";
    return {
        kind: "failed",
        message: words
            ? `${who} refused the ${what}: "${words}".`
            : `${who} couldn't send the ${what}${typeof code === "number" ? ` (error ${code})` : ""}.`,
    };
}
