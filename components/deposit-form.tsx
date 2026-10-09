"use client";

import { useState, type FormEvent } from "react";
import { motion, useAnimate, useReducedMotion, type Transition } from "motion/react";
import type { DepositResult } from "./account-client";
import { CloseIcon } from "./icons";
import { formatUsd } from "./wallet-data";
import styles from "./wallet-sidebar.module.css";

const spring: Transition = { type: "spring", visualDuration: 0.35, bounce: 0.3 };

/** Left in the wallet for gas: a transfer costs about 0.0005 USDC on Arc. */
const GAS_RESERVE = 0.01;
/** USDC's usual precision; Arc's 18 native decimals are more than anyone types. */
const MAX_DECIMALS = 6;

const OVER_WALLET = "That's more than your wallet holds, after gas.";

/** The most the wallet can send and still pay for gas, to the cent. */
export const maxDeposit = (walletBalance: number) => Math.max(0, Math.floor((walletBalance - GAS_RESERVE) * 100) / 100);

/** Keeps digits and one decimal point, with at most six decimals. */
function cleanAmount(text: string) {
    const [whole = "", ...rest] = text
        .replace(/,/g, ".")
        .replace(/[^\d.]/g, "")
        .split(".");
    if (rest.length === 0) return whole;
    return `${whole}.${rest.join("").slice(0, MAX_DECIMALS)}`;
}

/** "25." → "25", ".5" → "0.5"; null when there's no number yet. */
function normalizeAmount(text: string) {
    const [whole = "", fraction = ""] = text.split(".");
    if (whole === "" && fraction === "") return null;
    return fraction ? `${whole || "0"}.${fraction}` : whole;
}

type DepositFormProps = {
    /** The wallet's own USDC, undefined while loading and null when it couldn't be read. */
    walletBalance: number | null | undefined;
    minDeposit: number;
    onSubmit: (amount: string) => Promise<DepositResult>;
    onClose: () => void;
};

/** The amount to send from the wallet, in place of the deposit button. */
export function DepositForm({ walletBalance, minDeposit, onSubmit, onClose }: DepositFormProps) {
    const [text, setText] = useState("");
    const [sending, setSending] = useState(false);
    const [walletProblem, setWalletProblem] = useState<string | null>(null);

    const [field, animateField] = useAnimate<HTMLLabelElement>();
    const reduceMotion = useReducedMotion();

    const amount = normalizeAmount(text);
    const value = amount === null ? 0 : Number(amount);
    const max = walletBalance == null ? null : maxDeposit(walletBalance);
    const isOver = (v: number) => max !== null && v > max;
    // More than the wallet holds shows on the amount itself: red, with a shake.
    const over = isOver(value);
    const issue =
        amount === null || value === 0 || over
            ? null
            : value < minDeposit
              ? `The minimum deposit is ${formatUsd(minDeposit)}.`
              : null;
    const canSend = amount !== null && value > 0 && !over && issue === null && !sending;

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
        if (result === "failed") return setWalletProblem("Your wallet couldn't send the deposit. Try again.");
        if (result === "switch_failed")
            return setWalletProblem(
                "Your wallet couldn't switch to Arc. Add Arc (chain ID 5042) in its network settings, or connect another wallet.",
            );
        if (result === "wrong_network")
            return setWalletProblem("Your wallet is on another network. Switch it to Arc and try again.");
        // Sent: the balance already counts it, and the status line follows its confirmation.
        onClose();
    };

    // Only problems are written out; the wallet's balance is for screen readers.
    const hint = walletProblem ?? issue ?? (walletBalance === null ? "Couldn't read your wallet's balance." : null);
    const wallet = over
        ? OVER_WALLET
        : walletBalance === undefined
          ? "Checking your wallet…"
          : walletBalance === null
            ? ""
            : `In your wallet: ${formatUsd(walletBalance)}`;

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
                    <span className={styles.amountPrefix} aria-hidden="true">
                        $
                    </span>
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
                            const next = cleanAmount(event.target.value);
                            const nextValue = Number(normalizeAmount(next) ?? 0);
                            // Shakes on the way past the wallet, not while deleting back down.
                            if (isOver(nextValue) && nextValue > value) shake();
                            setText(next);
                            setWalletProblem(null);
                        }}
                    />
                    {max !== null && max > 0 && (
                        <button
                            type="button"
                            className={styles.maxButton}
                            disabled={sending}
                            onClick={() => setText(String(max))}
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
