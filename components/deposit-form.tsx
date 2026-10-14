"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { motion, useAnimate, useReducedMotion, type Transition } from "motion/react";
import { previewText } from "@/lib/account/deposit-preview";
import type { ApiError, DepositQuoteView } from "@/lib/account/state";
import type { CoinBalance } from "@/server/src/protocol";
import { NEEDS_SOL, type DepositResult } from "./account-client";
import { CloseIcon } from "./icons";
import { formatUsd } from "./wallet-data";
import styles from "./wallet-sidebar.module.css";

const spring: Transition = { type: "spring", visualDuration: 0.35, bounce: 0.3 };

/** Left in the wallet for gas: a transfer costs about 0.0005 USDC on Arc. */
const GAS_RESERVE = 0.01;
/** USDC's usual precision; Arc's 18 native decimals are more than anyone types. */
export const MAX_DECIMALS = 6;

const OVER_WALLET = "That's more than your wallet holds, after gas.";
/** How long the amount rests before the quote is asked for. */
const QUOTE_DELAY_MS = 400;

/** The most the wallet can send and still pay for gas, to the cent. */
export const maxDeposit = (walletBalance: number) => Math.max(0, Math.floor((walletBalance - GAS_RESERVE) * 100) / 100);

/** Keeps digits and one decimal point, with at most `decimals` decimals. */
export function cleanAmount(text: string, decimals: number) {
    const [whole = "", ...rest] = text
        .replace(/,/g, ".")
        .replace(/[^\d.]/g, "")
        .split(".");
    if (rest.length === 0) return whole;
    return `${whole}.${rest.join("").slice(0, decimals)}`;
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
    /** What an amount of a bridged coin would pay out on Arc; leave out for USDC on Arc. */
    preview?: (amount: string) => Promise<DepositQuoteView | ApiError>;
    onClose: () => void;
};

/** The amount to send from the wallet, in place of the deposit button. */
export function DepositForm({ coin, walletBalance, minDeposit, onSubmit, preview, onClose }: DepositFormProps) {
    const [text, setText] = useState("");
    const [sending, setSending] = useState(false);
    const [walletProblem, setWalletProblem] = useState<string | null>(null);
    const [quoted, setQuoted] = useState<{ amount: string; result: DepositQuoteView | ApiError } | null>(null);
    // USDC on Arc keeps its dollar path; any other coin is typed in its own units.
    const isArc = coin.coin === "arc:USDC";
    const decimals = isArc ? MAX_DECIMALS : coin.decimals;

    const [field, animateField] = useAnimate<HTMLLabelElement>();
    const reduceMotion = useReducedMotion();

    const amount = normalizeAmount(text);
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
    // The quote that belongs to the amount showing, once it has come back.
    const quote = preview && quoted?.amount === amount ? quoted.result : null;
    const quoteError = quote && "code" in quote ? quote.message : null;
    const payout = quote && !("code" in quote) ? quote : null;
    const issue =
        amount === null || value === 0 || over
            ? null
            : isArc && value < minDeposit
              ? `The minimum deposit is ${formatUsd(minDeposit)}.`
              : quoteError;
    const canSend = amount !== null && value > 0 && !over && issue === null && !sending;

    // Asks for the quote once the amount has rested; an answer for an amount since changed is dropped.
    const ask = useRef(preview);
    useEffect(() => {
        ask.current = preview;
    });
    const quoting = preview !== undefined;
    useEffect(() => {
        if (!quoting || amount === null || Number(amount) === 0) return;
        let current = true;
        const timer = setTimeout(() => {
            void ask.current?.(amount).then((result) => current && setQuoted({ amount, result }));
        }, QUOTE_DELAY_MS);
        return () => {
            current = false;
            clearTimeout(timer);
        };
    }, [quoting, amount]);

    const shake = () => {
        if (!reduceMotion)
            animateField(field.current, { x: [0, -9, 8, -6, 4, -2, 0] }, { duration: 0.42, ease: "easeOut" });
    };

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (over) return shake();
        if (!canSend || amount === null) return;
        setSending(true);
        setWalletProblem(null);
        const result = await onSubmit(amount);
        setSending(false);
        // Turned down in the wallet: the amount stays, ready to try again.
        if (result === "cancelled") return;
        if (result === "needs_sol") return setWalletProblem(NEEDS_SOL);
        if (result === "failed") return setWalletProblem("Your wallet couldn't send the deposit. Try again.");
        if (result === "switch_failed")
            return setWalletProblem(
                isArc
                    ? "Your wallet couldn't switch to Arc. Add Arc (chain ID 5042) in its network settings, or connect another wallet."
                    : `Your wallet couldn't switch to ${coin.chainName}. Switch it there yourself and try again.`,
            );
        if (result === "wrong_network")
            return setWalletProblem(`Your wallet is on another network. Switch it to ${coin.chainName} and try again.`);
        // Sent: the balance already counts it, and the status line follows its confirmation.
        onClose();
    };

    // Only problems are written out; the wallet's balance is for screen readers.
    const preText = payout ? previewText(coin, amount, payout) : null;
    const hint =
        walletProblem ??
        issue ??
        preText ??
        (isArc && walletBalance === null ? "Couldn't read your wallet's balance." : null);
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
                            const nextValue = Number(normalizeAmount(next) ?? 0);
                            // Shakes on the way past the wallet, not while deleting back down.
                            if (isOver(nextValue) && nextValue > value) shake();
                            setText(next);
                            setWalletProblem(null);
                        }}
                    />
                    {!isArc && (
                        <span className={styles.amountUnit} aria-hidden="true">
                            {coin.symbol}
                        </span>
                    )}
                    {max !== null && max > 0 && (
                        <button
                            type="button"
                            className={styles.maxButton}
                            disabled={sending}
                            onClick={() => setText(isArc ? String(max) : (coin.spendable ?? String(max)))}
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
                    whileHover={canSend ? { scale: 1.04 } : undefined}
                    whileTap={canSend ? { scale: 0.94 } : undefined}
                    transition={spring}
                >
                    {sending ? "Confirm in wallet" : "Deposit"}
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
