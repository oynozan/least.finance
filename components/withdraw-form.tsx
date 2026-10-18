"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { motion, useAnimate, useReducedMotion, type Transition } from "motion/react";
import type { ApiError } from "@/lib/account/state";
import {
    floorFor,
    pickerRows,
    quoteLines,
    showsConnect,
    WithdrawQuoter,
    type WithdrawWallet,
} from "@/lib/account/withdraw-form";
import type { WithdrawLimits, WithdrawQuote } from "@/server/src/protocol";
import type { WithdrawResult } from "./account-client";
import { MAX_DECIMALS, cleanAmount, normalizeAmount } from "./deposit-form";
import { CloseIcon, PlusIcon } from "./icons";
import { NetworkLogo } from "./network-icons";
import { formatUsd } from "./wallet-data";
import styles from "./wallet-sidebar.module.css";

const spring: Transition = { type: "spring", visualDuration: 0.35, bounce: 0.3 };

// EVM wallets are paid on Arc.
const ARC = 5042;

// Arrow keys move the picked recipient, wrapping at the ends.
const ARROWS: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };

const OVER_MAX = "That's more than you can withdraw right now.";
/** Follows the server's own words about the new fee. */
const CHANGED_NEXT = "Check the new amount and press Withdraw again.";

/** How long after a failed limits read the form asks again. */
const LIMITS_RETRY_MS = 3_000;

const TIMED_OUT =
    "The server didn't answer in 45 seconds. Your withdrawal may still go through, so check your balance and history before trying again.";
const CONNECTION_SWITCHED = "The connection changed while sending. Check your balance and history before trying again.";

type WithdrawFormProps = {
    /** The linked wallets a withdrawal can go to. */
    wallets: WithdrawWallet[];
    /** The wallet picked to begin with. */
    defaultTo: string | undefined;
    limits: () => Promise<WithdrawLimits | ApiError>;
    /** What a withdrawal to a Solana wallet would cost and deliver. */
    quote: (amount: string, to: string) => Promise<WithdrawQuote | ApiError>;
    onSubmit: (amount: string, to: string, reviewedFee?: string) => Promise<WithdrawResult>;
    onConnect: () => void;
    onClose: () => void;
};

/** The amount to withdraw and the wallet to send it to, in place of the Deposit and Withdraw buttons. */
export function WithdrawForm({ wallets, defaultTo, limits, quote, onSubmit, onConnect, onClose }: WithdrawFormProps) {
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
    const arcMin = loaded ? Number(loaded.min) : null;

    const rows = pickerRows(wallets, defaultTo, chosen);
    const picked = rows.find((row) => row.checked);
    const to = picked?.address;
    const solana = picked?.kind === "solana";
    const min = floorFor(picked?.kind, arcMin);
    const amount = normalizeAmount(text);
    const value = amount === null ? 0 : Number(amount);
    const isOver = (v: number) => max !== null && v > max;
    const over = isOver(value);
    const issue =
        amount === null || value === 0 || over
            ? null
            : min !== null && value < min
              ? solana
                  ? `The smallest withdrawal to Solana is ${formatUsd(min)}.`
                  : `The minimum withdrawal is ${formatUsd(min)}.`
              : null;

    // A Solana wallet's fee is asked for as the amount settles, and a withdrawal is sent only with the fee shown.
    // The first `quote` is kept: it asks the same client however often the parent renders.
    const [quoter] = useState(() => new WithdrawQuoter(quote));
    useEffect(() => () => quoter.stop(), [quoter]);
    const priced = useSyncExternalStore(quoter.subscribe, quoter.getSnapshot, quoter.getSnapshot);
    const target = solana && to && amount !== null && value > 0 && !over && issue === null ? { amount, to } : null;
    const targetKey = target ? `${target.to}:${target.amount}` : "";
    useEffect(() => {
        quoter.request(
            targetKey
                ? {
                      to: targetKey.slice(0, targetKey.indexOf(":")),
                      amount: targetKey.slice(targetKey.indexOf(":") + 1),
                  }
                : null,
        );
    }, [quoter, targetKey]);
    const lines = priced.status === "ready" ? quoteLines(priced.quote) : null;
    const quoteError = priced.status === "error" ? priced.message : null;

    // Limits only guide the field; the server checks them again, so a slow read never holds the button.
    const canSend =
        amount !== null &&
        value > 0 &&
        !over &&
        issue === null &&
        !!to &&
        !sending &&
        (!solana || priced.status === "ready");

    const shake = () => {
        if (!reduceMotion)
            animateField(field.current, { x: [0, -9, 8, -6, 4, -2, 0] }, { duration: 0.42, ease: "easeOut" });
    };

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (over || issue !== null) return shake();
        if (!canSend || amount === null || !to) return;
        setSending(true);
        setProblem(null);
        const result = await onSubmit(amount, to, solana ? (quoter.reviewedFee() ?? undefined) : undefined);
        setSending(false);
        // Refused: the status line says why, and the amount stays to be changed.
        if (result === "refused") return;
        // The fee rose: the new figures are shown and nothing is sent until Withdraw is pressed again.
        if (typeof result === "object" && result.problem === "changed") {
            setProblem(`${result.message} ${CHANGED_NEXT}`);
            if (target) quoter.refresh(target);
            return;
        }
        if (result === "offline") return setProblem("You're offline. Nothing was taken.");
        if (result === "not-ready") return setProblem("Still connecting to your account. Try again in a moment.");
        if (result === "timeout") return setProblem(TIMED_OUT);
        if (result === "failed") return setProblem(CONNECTION_SWITCHED);
        onClose();
    };

    const hint = problem ?? issue ?? quoteError ?? readError;
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
                        aria-describedby="withdraw-max withdraw-quote withdraw-hint"
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

            {showsConnect(wallets) ? (
                <button type="button" className={styles.recipient} onClick={onConnect}>
                    <span className={styles.recipientMark} aria-hidden="true">
                        <PlusIcon />
                    </span>
                    Connect an EVM wallet
                </button>
            ) : (
                rows.length > 1 && (
                    <div role="radiogroup" aria-label="Withdraw to" className={styles.recipients}>
                        {rows.map((row, index) => (
                            <button
                                key={row.address}
                                type="button"
                                role="radio"
                                aria-checked={row.checked}
                                aria-label={`${row.short} on ${row.network}`}
                                // Roving tabindex: only the picked row is a tab stop.
                                tabIndex={row.checked ? 0 : -1}
                                className={styles.recipient}
                                disabled={sending}
                                onClick={() => setChosen(row.address)}
                                onKeyDown={(event) => {
                                    const step = ARROWS[event.key];
                                    if (!step) return;
                                    event.preventDefault();
                                    const next = rows[(index + step + rows.length) % rows.length]!;
                                    setChosen(next.address);
                                    const children = event.currentTarget.parentElement?.children;
                                    (children?.[rows.indexOf(next)] as HTMLElement | undefined)?.focus();
                                }}
                            >
                                <NetworkLogo
                                    network={row.kind === "solana" ? "solana" : ARC}
                                    className={styles.recipientMark}
                                />
                                {row.short}
                            </button>
                        ))}
                    </div>
                )
            )}

            {lines && (
                <p id="withdraw-quote" className={styles.depositHint} aria-live="polite">
                    {lines.fee}
                    {lines.setup && (
                        <>
                            <br />
                            {lines.setup}
                        </>
                    )}
                </p>
            )}
            <p
                id="withdraw-hint"
                className={styles.depositHint}
                data-tone={problem || issue || quoteError || readError ? "error" : undefined}
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
