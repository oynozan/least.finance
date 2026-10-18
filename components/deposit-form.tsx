"use client";

import { useState, type FormEvent } from "react";
import { motion, useAnimate, useReducedMotion, type Transition } from "motion/react";
import { formatUnits } from "@/lib/trade/format";
import type { CoinBalance } from "@/server/src/protocol";
import type { DepositResult } from "./account-client";
import { CloseIcon } from "./icons";
import { ProgressGlyph } from "./progress-fill";
import { formatUsd } from "./wallet-data";
import styles from "./wallet-sidebar.module.css";

const spring: Transition = { type: "spring", visualDuration: 0.35, bounce: 0.3 };

/** Left in the wallet for gas: a transfer costs about 0.0005 USDC on Arc. */
const GAS_RESERVE = 0.01;
/** USDC's usual precision; Arc's 18 native decimals are more than anyone types. */
export const MAX_DECIMALS = 6;

const OVER_WALLET = "That's more than your wallet holds, after gas.";
const IN_WALLET = "Confirm the deposit in your wallet.";
const NOT_SIGNABLE = "Connect this wallet to deposit from it.";
/** A dollar amount is typed to the cent. */
const USD_DECIMALS = 2;
/** A coin amount worked out from dollars keeps at most this many decimals. */
const COIN_PLACES = 8;

/** The most the wallet can send and still pay for gas, to the cent. */
export const maxDeposit = (walletBalance: number) => Math.max(0, Math.floor((walletBalance - GAS_RESERVE) * 100) / 100);

/** "1,234.56": commas grouping thousands before a decimal point */
const COMMA_GROUPED = /^\d{1,3}(,\d{3})+\.\d*$/;
/** "1.234,56": points grouping thousands before a decimal comma */
const POINT_GROUPED = /^\d{1,3}(\.\d{3})+,\d*$/;

/**
 * Keeps digits and one decimal point, with at most `decimals` decimals. A pasted number grouped by thousands keeps
 * its value when its decimal separator says which is which; otherwise the first comma or point is the decimal point
 * and any later one, typed by mistake, is dropped, so an unclear amount only ever reads smaller.
 */
export function cleanAmount(text: string, decimals: number) {
    const kept = text.replace(/[^\d.,]/g, "");
    const plain = COMMA_GROUPED.test(kept)
        ? kept.replace(/,/g, "")
        : POINT_GROUPED.test(kept)
          ? kept.replace(/\./g, "").replace(",", ".")
          : kept.replace(/,/g, ".");
    const [whole = "", ...rest] = plain.split(".");
    if (rest.length === 0) return whole;
    return `${whole}.${rest.join("").slice(0, decimals)}`;
}

/** `value` rounded down to `places` decimals, without trailing zeros: never more than was typed. A hair over 1 absorbs float noise, so 0.3 / 0.1 is 3. */
function floorTo(value: number, places: number) {
    const scale = 10 ** places;
    return (Math.floor(value * scale * (1 + 1e-12)) / scale).toFixed(places).replace(/\.?0+$/, "");
}

/** "25." → "25", ".5" → "0.5"; null when there's no number yet. */
export function normalizeAmount(text: string) {
    const [whole = "", fraction = ""] = text.split(".");
    if (whole === "" && fraction === "") return null;
    return fraction ? `${whole || "0"}.${fraction}` : whole;
}

type DepositFormProps = {
    /** The coin being deposited, in the wallet it was picked from. */
    coin: CoinBalance;
    /** The wallet's own USDC on Arc, undefined while loading and null when it couldn't be read. */
    walletBalance: number | null | undefined;
    minDeposit: number;
    onSubmit: (amount: string) => Promise<DepositResult>;
    /** The coin's dollar price, kept fresh by the page; null until known. Leave out for USDC on Arc. */
    price?: number | null;
    /** Whether the coin's wallet can sign here yet; a Solana wallet takes a moment after sign-in. */
    signable?: boolean;
    onClose: () => void;
};

/** The amount to send from the wallet, in place of the deposit button. */
export function DepositForm({
    coin,
    walletBalance,
    minDeposit,
    onSubmit,
    price = null,
    signable = true,
    onClose,
}: DepositFormProps) {
    const [text, setText] = useState("");
    const [sending, setSending] = useState(false);
    const [walletProblem, setWalletProblem] = useState<string | null>(null);
    // USDC on Arc keeps its dollar path; any other coin is typed in its own units, or in dollars once its unit is clicked.
    const isArc = coin.coin === "arc:USDC";
    const [unit, setUnit] = useState<"coin" | "usd">("coin");
    const inUsd = !isArc && unit === "usd" && price !== null;
    const decimals = isArc ? MAX_DECIMALS : inUsd ? USD_DECIMALS : coin.decimals;

    const [field, animateField] = useAnimate<HTMLLabelElement>();
    const reduceMotion = useReducedMotion();

    const typed = normalizeAmount(text);
    // What's sent is always in the coin's own units; dollars are worked out at the price the page holds.
    const toCoin = (usd: number) => floorTo(usd / price!, Math.min(coin.decimals, COIN_PLACES));
    const amount = typed === null || !inUsd ? typed : toCoin(Number(typed));
    const value = amount === null ? 0 : Number(amount);
    const max = isArc
        ? walletBalance == null
            ? null
            : maxDeposit(walletBalance)
        : coin.spendable === null
          ? null
          : Number(coin.spendable);
    const isOver = (v: number) => max !== null && v > max;
    // More than the wallet holds shows on the amount itself: red, with a shake.
    const over = isOver(value);
    const issue =
        amount === null || value === 0 || over
            ? null
            : isArc && value < minDeposit
              ? `The minimum deposit is ${formatUsd(minDeposit)}.`
              : null;
    const canSend = amount !== null && value > 0 && !over && issue === null && signable && !sending;

    /** Switches between the coin and dollars, carrying the amount over at the price. */
    const switchUnit = () => {
        if (price === null) return;
        const next = unit === "coin" ? "usd" : "coin";
        if (typed !== null) setText(next === "usd" ? floorTo(value * price, USD_DECIMALS) : (amount ?? ""));
        setUnit(next);
    };

    const shake = () => {
        if (!reduceMotion)
            animateField(field.current, { x: [0, -9, 8, -6, 4, -2, 0] }, { duration: 0.42, ease: "easeOut" });
    };

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (over) return shake();
        if (!signable && amount !== null && value > 0) return setWalletProblem(NOT_SIGNABLE);
        if (!canSend || amount === null) return;
        setSending(true);
        setWalletProblem(null);
        const result = await onSubmit(amount);
        setSending(false);
        // Turned down in the wallet: the amount stays, ready to try again.
        if (result === "cancelled") return;
        // Refused by the server or failed on the way: either way it says what went wrong and what to do.
        if (typeof result === "object") return setWalletProblem("refused" in result ? result.refused : result.failed);
        // Sent: the balance already counts it, and the status line follows its confirmation.
        onClose();
    };

    // Worked out here as the amount is typed, at the price the page holds: the other unit's figure.
    const estimate =
        isArc || price === null || amount === null || value === 0 || over
            ? null
            : inUsd
              ? `≈ ${formatUnits(value, coin.symbol)}`
              : `≈ ${formatUsd(value * price)}`;
    // Only problems are written out; the wallet's balance is for screen readers.
    const hint =
        walletProblem ??
        (sending ? IN_WALLET : null) ??
        issue ??
        estimate ??
        (isArc && walletBalance === null
            ? "Couldn't read your Arc balance (Arc's network didn't answer). You can still type an amount."
            : null);
    const held = isArc ? walletBalance : coin.amount === null ? null : Number(coin.amount);
    const wallet = over
        ? OVER_WALLET
        : held === undefined
          ? "Checking your wallet…"
          : held === null
            ? ""
            : isArc
              ? `In your wallet: ${formatUsd(held)}`
              : `In your wallet: ${coin.amount} ${coin.symbol}`;

    return (
        <motion.div
            className={styles.depositPanel}
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={spring}
        >
            <form
                className={styles.depositForm}
                onSubmit={submit}
                onKeyDown={(event) => {
                    if (event.key === "Escape" && !sending) {
                        event.stopPropagation();
                        onClose();
                    }
                }}
            >
                <label
                    ref={field}
                    className={styles.amountField}
                    data-invalid={over || issue !== null || undefined}
                    data-over={over || undefined}
                >
                    {isArc && (
                        <span className={styles.amountPrefix} aria-hidden="true">
                            $
                        </span>
                    )}
                    <input
                        className={styles.amountInput}
                        aria-label="Deposit amount"
                        aria-describedby="deposit-wallet deposit-hint"
                        aria-invalid={over || issue !== null || undefined}
                        inputMode="decimal"
                        autoComplete="off"
                        placeholder="0.00"
                        // The form only opens on request, so the amount is what comes next.
                        autoFocus
                        readOnly={sending}
                        value={text}
                        onChange={(event) => {
                            const next = cleanAmount(event.target.value, decimals);
                            const nextTyped = Number(normalizeAmount(next) ?? 0);
                            const nextValue = inUsd ? Number(toCoin(nextTyped)) : nextTyped;
                            // Shakes on the way past the wallet, not while deleting back down.
                            if (isOver(nextValue) && nextValue > value) shake();
                            setText(next);
                            setWalletProblem(null);
                        }}
                    />
                    {!isArc &&
                        (price === null ? (
                            <span className={styles.amountUnit} aria-hidden="true">
                                {coin.symbol}
                            </span>
                        ) : (
                            <button
                                type="button"
                                className={`${styles.amountUnit} ${styles.unitToggle}`}
                                aria-label={inUsd ? `Type the amount in ${coin.symbol}` : "Type the amount in USD"}
                                disabled={sending}
                                onClick={switchUnit}
                            >
                                {inUsd ? "USD" : coin.symbol}
                            </button>
                        ))}
                    {max !== null && max > 0 && (
                        <button
                            type="button"
                            className={styles.maxButton}
                            disabled={sending}
                            onClick={() =>
                                setText(
                                    isArc
                                        ? String(max)
                                        : inUsd
                                          ? floorTo(Number(coin.spendable ?? max) * price!, USD_DECIMALS)
                                          : (coin.spendable ?? String(max)),
                                )
                            }
                        >
                            Max
                        </button>
                    )}
                </label>
                <motion.button
                    type="submit"
                    className={`${styles.deposit} ${styles.confirmDeposit}`}
                    // Not `disabled`, which would drop keyboard focus while the wallet opens.
                    aria-disabled={!canSend || undefined}
                    aria-busy={sending || undefined}
                    whileHover={canSend ? { scale: 1.04 } : undefined}
                    whileTap={canSend ? { scale: 0.94 } : undefined}
                    transition={spring}
                >
                    {/* The label keeps its room while a spinner stands in, so the amount field never gets squeezed. */}
                    <span className={sending ? "invisible" : undefined}>Deposit</span>
                    {sending && (
                        <span className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
                            <span className="relative flex size-3.5 items-center justify-center">
                                <ProgressGlyph phase="running" />
                            </span>
                        </span>
                    )}
                </motion.button>
                <motion.button
                    type="button"
                    className={styles.iconButton}
                    aria-label="Cancel deposit"
                    title="Cancel deposit"
                    disabled={sending}
                    whileHover={sending ? undefined : { scale: 1.08 }}
                    whileTap={sending ? undefined : { scale: 0.9 }}
                    transition={spring}
                    onClick={onClose}
                >
                    <CloseIcon />
                </motion.button>
            </form>
            <p
                id="deposit-hint"
                className={styles.depositHint}
                data-tone={walletProblem || issue ? "error" : undefined}
                aria-live="polite"
            >
                {hint}
            </p>
            <span id="deposit-wallet" className="sr-only" aria-live="polite">
                {wallet}
            </span>
        </motion.div>
    );
}
