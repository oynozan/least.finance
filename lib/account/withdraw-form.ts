import type { WithdrawQuote } from "@/server/src/protocol";
import type { ApiError } from "./state";

/** A linked wallet a withdrawal can go to. */
export type WithdrawWallet = { kind: "evm" | "solana"; address: string };

/** The smallest withdrawal to a Solana wallet, in USDC; the server holds the same figure and checks it again. */
export const SOLANA_MIN_WITHDRAW = 1;
/** How long after the last keystroke the quote is asked for. */
export const QUOTE_DEBOUNCE_MS = 400;

const shorten = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** The same wallet whatever the casing of an Ethereum address; a Solana address is case-sensitive. */
const same = (a: string, b: string) =>
    a === b || (/^0x/i.test(a) && /^0x/i.test(b) && a.toLowerCase() === b.toLowerCase());

export type PickerRow = {
    kind: WithdrawWallet["kind"];
    address: string;
    /** Where the money arrives: EVM wallets are paid on Arc. */
    network: "Arc" | "Solana";
    short: string;
    checked: boolean;
};

/** Every wallet with its network and short address; the one chosen, else the one in use, else the first, is checked. */
export function pickerRows(wallets: WithdrawWallet[], inUse: string | undefined, chosen: string | null): PickerRow[] {
    const picked =
        wallets.find((w) => chosen !== null && same(w.address, chosen)) ??
        wallets.find((w) => inUse !== undefined && same(w.address, inUse)) ??
        wallets[0];
    return wallets.map((w) => ({
        kind: w.kind,
        address: w.address,
        network: w.kind === "solana" ? "Solana" : "Arc",
        short: shorten(w.address),
        checked: w === picked,
    }));
}

/** The "Connect an EVM wallet" row shows only for a person with no wallet of either kind. */
export const showsConnect = (wallets: WithdrawWallet[]) => wallets.length === 0;

/** The smallest amount for a wallet: a Solana wallet's own floor replaces the Arc one. */
export const floorFor = (kind: WithdrawWallet["kind"] | undefined, arcMin: number | null) =>
    kind === "solana" ? SOLANA_MIN_WITHDRAW : arcMin;

/** A decimal string as millionths of a USDC, cut past the sixth place. */
function micro(value: string): number {
    const [whole = "0", fraction = ""] = value.split(".");
    return Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0").slice(0, 6));
}

/** Millionths as dollars and cents, rounded up for a cost and down for what arrives. */
function cents(units: number, round: "up" | "down"): string {
    const total = round === "up" ? Math.ceil(units / 10_000) : Math.floor(units / 10_000);
    return `${Math.floor(total / 100)}.${String(total % 100).padStart(2, "0")}`;
}

/** The lines under the field for a quote: the fee and what arrives, and the account setup when it is part of the fee. */
export function quoteLines(quote: WithdrawQuote): { fee: string; setup: string | null } {
    return {
        fee: `Fee ${cents(micro(quote.fee), "up")} USDC · you receive ${cents(micro(quote.receive), "down")} USDC`,
        setup:
            quote.setup && quote.setupFee !== null
                ? `Includes ${cents(micro(quote.setupFee), "up")} USDC to set up your USDC account.`
                : null,
    };
}

export type QuoteState =
    | { status: "idle" }
    | { status: "loading" }
    | { status: "ready"; quote: WithdrawQuote }
    | { status: "error"; message: string };

/** Asks for the quote of a Solana withdrawal a moment after the amount stops changing and keeps the figure last shown. */
export class WithdrawQuoter {
    #state: QuoteState = { status: "idle" };
    #timer: ReturnType<typeof setTimeout> | undefined;
    #run = 0;
    readonly #listeners = new Set<() => void>();
    readonly #ask: (amount: string, to: string) => Promise<WithdrawQuote | ApiError>;
    readonly #debounceMs: number;

    constructor(
        ask: (amount: string, to: string) => Promise<WithdrawQuote | ApiError>,
        debounceMs = QUOTE_DEBOUNCE_MS,
    ) {
        this.#ask = ask;
        this.#debounceMs = debounceMs;
    }

    subscribe = (listener: () => void) => {
        this.#listeners.add(listener);
        return () => void this.#listeners.delete(listener);
    };

    getSnapshot = () => this.#state;

    /** The fee the person was last shown, which is what a withdrawal is sent as reviewed. */
    reviewedFee(): string | null {
        return this.#state.status === "ready" ? this.#state.quote.fee : null;
    }

    /** Asks after the debounce; a null target (no Solana wallet, no amount) clears the quote. */
    request(target: { amount: string; to: string } | null) {
        clearTimeout(this.#timer);
        this.#run++;
        if (!target) return this.#set({ status: "idle" });
        this.#set({ status: "loading" });
        this.#timer = setTimeout(() => void this.#fetch(target), this.#debounceMs);
    }

    /** Asks at once, as after the server found the fee had changed. */
    refresh(target: { amount: string; to: string }) {
        clearTimeout(this.#timer);
        this.#run++;
        this.#set({ status: "loading" });
        void this.#fetch(target);
    }

    stop() {
        clearTimeout(this.#timer);
        this.#run++;
    }

    async #fetch(target: { amount: string; to: string }) {
        const run = this.#run;
        const result = await this.#ask(target.amount, target.to).catch((error: unknown): ApiError => {
            console.warn("A withdrawal quote threw:", error);
            return {
                code: "unavailable",
                message: `Couldn't price this: ${error instanceof Error && error.message ? error.message : "the request failed"}. Nothing was taken.`,
            };
        });
        if (run !== this.#run) return;
        this.#set("code" in result ? { status: "error", message: result.message } : { status: "ready", quote: result });
    }

    #set(state: QuoteState) {
        this.#state = state;
        for (const listener of this.#listeners) listener();
    }
}
