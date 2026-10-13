import type { Config } from "../config.ts";
import { AppError } from "../errors.ts";

/** Throws unless the Solana flow is switched on. */
export function solanaOpen(
    config: Pick<Config, "SOLANA_DEPOSITS" | "SOLANA_WITHDRAWALS">,
    direction: "deposits" | "withdrawals",
): void {
    const on = direction === "deposits" ? config.SOLANA_DEPOSITS : config.SOLANA_WITHDRAWALS;
    if (on !== "on") throw new AppError("unavailable", "Solana isn't open yet.");
}
