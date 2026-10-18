import { brief } from "../errors.ts";
import type { Coin } from "./catalog.ts";

/** What a bridge is called in a sentence. */
export const BRIDGE_NAMES: Record<string, string> = { relay: "Relay", across: "Across", cctp: "Circle" };
export const bridgeName = (provider: string) => BRIDGE_NAMES[provider] ?? provider;

/** A bridge's own refusal of a quote: its HTTP status, error code and words, kept verbatim for the log. */
export class UpstreamRefusal extends Error {
    readonly provider: string;
    readonly status: number;
    readonly code: string | null;
    /** What the bridge said, verbatim. */
    readonly upstream: string;
    readonly data: unknown;

    constructor(input: { provider: string; status: number; code?: string | null; message?: string; data?: unknown }) {
        const upstream = input.message ?? "";
        super(
            `${bridgeName(input.provider)} refused a quote (${input.status}${input.code ? ` ${input.code}` : ""}): ${brief(upstream, 300)}`,
        );
        this.name = "UpstreamRefusal";
        this.provider = input.provider;
        this.status = input.status;
        this.code = input.code ?? null;
        this.upstream = upstream;
        this.data = input.data;
    }
}

/** A quote request a bridge didn't answer in time. */
export class QuoteTimeout extends Error {
    readonly provider: string;
    readonly timeoutMs: number;

    constructor(provider: string, timeoutMs: number) {
        super(`${provider} gave no quote within ${timeoutMs} ms`);
        this.name = "QuoteTimeout";
        this.provider = provider;
        this.timeoutMs = timeoutMs;
    }
}

/** A bridge's non-OK answer to a request that isn't a refusal of the person's deposit: an outage or a throttle. The body is kept, trimmed. */
export async function badAnswer(provider: string, what: string, response: Response): Promise<Error> {
    const body = brief(await response.text().catch(() => ""), 300);
    return new Error(`${bridgeName(provider)} answered ${response.status} to a ${what}${body ? `: ${body}` : ""}`);
}

const RELAY_UNSUPPORTED = new Set([
    "NO_SWAP_ROUTES_FOUND",
    "NO_QUOTES",
    "UNSUPPORTED_ROUTE",
    "UNSUPPORTED_CURRENCY",
    "UNSUPPORTED_CHAIN",
    "ROUTE_TEMPORARILY_RESTRICTED",
    "CHAIN_DISABLED",
]);

/** The plain sentence for a bridge's refusal: a known code gets its meaning, any other the bridge's own words, quoted. */
export function refusalMessage(refusal: UpstreamRefusal, coin: Coin): { message: string; known: boolean } {
    const name = bridgeName(refusal.provider);
    const code = refusal.code ?? "";
    const cannot = `${name} can't bridge ${coin.symbol} from ${coin.chainName} to Arc right now.`;
    if (refusal.provider === "relay") {
        if (code === "AMOUNT_TOO_LOW") {
            return { message: "Relay's minimum for this route is higher than that. Try a larger amount.", known: true };
        }
        if (code === "INSUFFICIENT_LIQUIDITY") {
            return {
                message:
                    "Relay doesn't have enough liquidity on this route right now. Try a smaller amount or try again later.",
                known: true,
            };
        }
        if (RELAY_UNSUPPORTED.has(code)) return { message: cannot, known: true };
        if (code === "SWAP_IMPACT_TOO_HIGH") {
            return { message: "That deposit would lose too much to price impact. Try a smaller amount.", known: true };
        }
        if (code === "SANCTIONED_WALLET_ADDRESS" || code === "SANCTIONED_CURRENCY") {
            return { message: "Relay refuses this wallet or coin.", known: true };
        }
        if (code === "SOLANA_TX_TOO_LARGE") {
            return {
                message: "Relay couldn't fit this Solana deposit in one transaction. Try a smaller amount.",
                known: true,
            };
        }
    }
    if (refusal.provider === "across") {
        if (code === "AMOUNT_TOO_LOW") {
            return { message: "Across' minimum for this route is higher than that. Try a larger amount.", known: true };
        }
        if (code === "AMOUNT_TOO_HIGH")
            return { message: "That's more than Across can bridge in one go.", known: true };
        if (code === "ROUTE_NOT_ENABLED")
            return { message: `Across doesn't bridge ${coin.symbol} to Arc.`, known: true };
        if (code === "SWAP_QUOTE_UNAVAILABLE" || code === "SWAP_LIQUIDITY_INSUFFICIENT") {
            return { message: "Across has no quote or liquidity for this right now.", known: true };
        }
    }
    const words = brief(refusal.upstream, 140).replace(/\.+$/, "");
    return {
        message: words
            ? `${name} refused the deposit: "${words}".`
            : `${name} refused the deposit (${refusal.status}).`,
        known: false,
    };
}

/** Circle's reason for holding a transfer back, as a sentence. */
export function delayMessage(reason: string): string {
    if (reason === "insufficient_fee") {
        return "Circle is holding the transfer because its fee changed; it will mint when the fee is covered.";
    }
    if (reason === "amount_above_max") return "Circle won't mint a transfer this large in one go.";
    return `Circle is holding the transfer: "${brief(reason, 100)}".`;
}

/** A Circle-forwarder failure's detail starts with this, so its message can say the burn needs recovery. */
export const FORWARD_FAILED = "forward failed";

/** Why a deposit order ended without delivering. */
export type OrderFailureCode =
    | "source_reverted"
    | "source_replaced"
    | "source_failed"
    | "source_not_found"
    | "bridge_failed"
    | "bridge_refunded"
    | "expired"
    | "given_up";

export type OrderFailureInput = { code: OrderFailureCode; detail: string };

/** What the person is told about a deposit order that didn't deliver. */
export function orderFailureMessage(
    order: {
        provider: string;
        coin: Coin;
        /** What the person can quote to support: the end of the order id. */ ref: string;
    },
    failure: OrderFailureInput,
    expiryMinutes = 10,
): string {
    const { coin } = order;
    const name = bridgeName(order.provider);
    const detail = brief(failure.detail, 160).replace(/\.+$/, "");
    const quoted = detail ? ` "${detail}"` : "";
    switch (failure.code) {
        case "source_reverted":
            return `The transaction reverted on ${coin.chainName}, so nothing was bridged. Your ${coin.symbol} stays in your wallet; only the network fee was spent.`;
        case "source_replaced":
            return `Your wallet replaced that transaction with another one (a speed-up or a cancel), so this deposit won't arrive. Nothing was bridged.`;
        case "source_failed":
            return `Solana rejected the transaction (${detail || "no reason given"}). Nothing left your wallet except the network fee.`;
        case "source_not_found":
            return `Solana never confirmed the transaction within ${expiryMinutes} minutes; it was probably dropped. Nothing was sent.`;
        case "bridge_refunded":
            return `${name} refunded this deposit to your wallet${quoted ? `, saying:${quoted}` : ""}.`;
        case "bridge_failed":
            return order.provider === "cctp" && failure.detail.startsWith(FORWARD_FAILED)
                ? `Circle's forwarder failed to mint on Arc. Your USDC is burned on Solana and needs manual recovery (ref ${order.ref}).`
                : `${name} couldn't finish this deposit${quoted ? `, saying:${quoted}` : ""}. If your ${coin.symbol} already left your wallet, it is refunded to it.`;
        case "expired":
            return "Your wallet never sent this deposit, so the order expired. Nothing was taken.";
        case "given_up":
            return `${name} hadn't finished this deposit after 24 hours, so we stopped following it. Check your wallet's activity, or ask support with ref ${order.ref}.`;
    }
}

/** Says yes at most once per `ms` for each key, so a failure that repeats on every poll leaves one line a minute, not one a poll. */
export function throttle(ms: number, now: () => number = Date.now): (key: string) => boolean {
    const last = new Map<string, number>();
    return (key) => {
        const at = now();
        const before = last.get(key);
        if (before !== undefined && at - before < ms) return false;
        last.set(key, at);
        return true;
    };
}
