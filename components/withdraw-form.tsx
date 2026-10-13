"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { motion, useAnimate, useReducedMotion, type Transition } from "motion/react";
import type { ApiError } from "@/lib/account/state";
import type { WithdrawLimits } from "@/server/src/protocol";
import { MAX_DECIMALS, cleanAmount, normalizeAmount } from "./deposit-form";
import { CloseIcon, PlusIcon } from "./icons";
import { NetworkLogo } from "./network-icons";
import { formatUsd, shortenAddress } from "./wallet-data";
import styles from "./wallet-sidebar.module.css";

const spring: Transition = { type: "spring", visualDuration: 0.35, bounce: 0.3 };

// Withdrawals always pay out on Arc.
const ARC = 5042;

// Arrow keys move the picked recipient, wrapping at the ends.
const ARROWS: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };

const OVER_MAX = "That's more than you can withdraw right now.";
/** How long after a failed limits read the form asks again. */
const LIMITS_RETRY_MS = 3_000;

type WithdrawFormProps = {
    /** The linked EVM wallets a withdrawal can go to. */
    wallets: string[];
    /** The wallet picked to begin with. */
    defaultTo: string | undefined;
    limits: () => Promise<WithdrawLimits | ApiError>;
    onSubmit: (amount: string, to: string) => Promise<"sent" | "refused" | "failed">;
    onConnect: () => void;
    onClose: () => void;
};

/** The amount to withdraw and the wallet to send it to, in place of the Deposit and Withdraw buttons. */
export function WithdrawForm({ wallets, defaultTo, limits, onSubmit, onConnect, onClose }: WithdrawFormProps) {
    const [text, setText] = useState("");
    const [sending, setSending] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const [chosen, setChosen] = useState<string | null>(null);
    const [read, setRead] = useState<WithdrawLimits | ApiError | null>(null);
    const [field, animateField] = useAnimate<HTMLLabelElement>();
    const reduceMotion = useReducedMotion();

    // What the server allows is read as the form opens, and again every few seconds while that read fails.
    const ask = useRef(limits);
    useEffect(() => {
        ask.current = limits;
    });
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        let current = true;
        let retry: ReturnType<typeof setTimeout> | undefined;
        void ask.current().then((result) => {
            if (!current) return;
            setRead(result);
            if ("code" in result) retry = setTimeout(() => setAttempt((n) => n + 1), LIMITS_RETRY_MS);
        });
        return () => {
            current = false;
            clearTimeout(retry);
        };
    }, [attempt]);

    const loaded = read !== null && !("code" in read) ? read : null;
    const readError = read !== null && "code" in read ? read.message : null;
    // Cut, never rounded up past what can be paid.
    const maxText = loaded ? cleanAmount(loaded.max, MAX_DECIMALS) : null;
    const max = maxText === null ? null : Number(maxText);
    const min = loaded ? Number(loaded.min) : null;

    const to = wallets.find((w) => w.toLowerCase() === chosen?.toLowerCase()) ?? defaultTo ?? wallets[0];
    const amount = normalizeAmount(text);
    const value = amount === null ? 0 : Number(amount);
    const isOver = (v: number) => max !== null && v > max;
    const over = isOver(value);
    const issue =
        amount === null || value === 0 || over
            ? null
            : min !== null && value < min
              ? `The minimum withdrawal is ${formatUsd(min)}.`
              : null;
    // Limits only guide the field; the server checks them again, so a slow read never holds the button.
    const canSend = amount !== null && value > 0 && !over && issue === null && !!to && !sending;

    const shake = () => {
        if (!reduceMotion)
            animateField(field.current, { x: [0, -9, 8, -6, 4, -2, 0] }, { duration: 0.42, ease: "easeOut" });
    };

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (over) return shake();
        if (!canSend || amount === null || !to) return;
        setSending(true);
        setProblem(null);
        const result = await onSubmit(amount, to);
        setSending(false);
        // Refused: the status line says why, and the amount stays to be changed.
        if (result === "refused") return;
        if (result === "failed")
            return setProblem("Couldn't reach the server. Check your balance before trying again.");
        onClose();
    };

    const hint = problem ?? issue ?? readError;
    const maxNote = over ? OVER_MAX : max === null ? "" : `You can withdraw up to ${formatUsd(max)}`;

    return (
        <motion.div
            className={styles.depositPanel}
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={spring}
            // Escape anywhere in the panel closes only the form, not the sidebar.
            onKeyDown={(event) => {
                if (event.key === "Escape" && !sending) {
                    event.stopPropagation();
                    onClose();
                }
            }}
        >
            <form className={styles.depositForm} onSubmit={submit}>
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
                        aria-label="Withdraw amount"
                        aria-describedby="withdraw-max withdraw-hint"
                        aria-invalid={over || issue !== null || undefined}
                        inputMode="decimal"
                        autoComplete="off"
                        placeholder="0.00"
                        autoFocus
                        readOnly={sending}
                        value={text}
                        onChange={(event) => {
                            const next = cleanAmount(event.target.value, MAX_DECIMALS);
                            const nextValue = Number(normalizeAmount(next) ?? 0);
                            // Shakes on the way past the maximum, not while deleting back down.
                            if (isOver(nextValue) && nextValue > value) shake();
                            setText(next);
                            setProblem(null);
                        }}
                    />
                    {max !== null && max > 0 && (
                        <button
                            type="button"
                            className={styles.maxButton}
                            disabled={sending}
                            onClick={() => setText(maxText!)}
                        >
                            Max
                        </button>
                    )}
                </label>
                <motion.button
                    type="submit"
                    className={`${styles.deposit} ${styles.confirmDeposit}`}
                    aria-disabled={!canSend || undefined}
                    whileHover={canSend ? { scale: 1.04 } : undefined}
                    whileTap={canSend ? { scale: 0.94 } : undefined}
                    transition={spring}
                >
                    Withdraw
                </motion.button>
                <motion.button
                    type="button"
                    className={styles.iconButton}
                    aria-label="Cancel withdrawal"
                    title="Cancel withdrawal"
                    disabled={sending}
                    whileHover={sending ? undefined : { scale: 1.08 }}
                    whileTap={sending ? undefined : { scale: 0.9 }}
                    transition={spring}
                    onClick={onClose}
                >
                    <CloseIcon />
                </motion.button>
            </form>

            {wallets.length === 0 ? (
                <button type="button" className={styles.recipient} onClick={onConnect}>
                    <span className={styles.recipientMark} aria-hidden="true">
                        <PlusIcon />
                    </span>
                    Connect an EVM wallet
                </button>
            ) : (
                wallets.length > 1 && (
                    <div role="radiogroup" aria-label="Withdraw to" className={styles.recipients}>
                        {wallets.map((wallet, index) => (
                            <button
                                key={wallet}
                                type="button"
                                role="radio"
                                aria-checked={wallet === to}
                                aria-label={shortenAddress(wallet)}
                                // Roving tabindex: only the picked row is a tab stop.
                                tabIndex={wallet === to ? 0 : -1}
                                className={styles.recipient}
                                disabled={sending}
                                onClick={() => setChosen(wallet)}
                                onKeyDown={(event) => {
                                    const step = ARROWS[event.key];
                                    if (!step) return;
                                    event.preventDefault();
                                    const next = wallets[(index + step + wallets.length) % wallets.length]!;
                                    setChosen(next);
                                    const rows = event.currentTarget.parentElement?.children;
                                    (rows?.[wallets.indexOf(next)] as HTMLElement | undefined)?.focus();
                                }}
                            >
                                <NetworkLogo network={ARC} className={styles.recipientMark} />
                                {shortenAddress(wallet)}
                            </button>
                        ))}
                    </div>
                )
            )}

            <p
                id="withdraw-hint"
                className={styles.depositHint}
                data-tone={problem || issue || readError ? "error" : undefined}
                aria-live="polite"
            >
                {hint}
            </p>
            <span id="withdraw-max" className="sr-only" aria-live="polite">
                {maxNote}
            </span>
        </motion.div>
    );
}
