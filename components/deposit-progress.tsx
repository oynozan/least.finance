"use client";

import type { DepositOrderView, OrderState } from "@/server/src/protocol";
import { CloseIcon } from "./icons";
import styles from "./wallet-sidebar.module.css";

export const STEPS = ["Sending", "In a block", "Bridging to Arc", "Added"] as const;

/** How many steps are behind an order in each state. */
const DONE: Partial<Record<OrderState, number>> = { sent: 0, in_block: 2, bridging: 2, delivered: 4 };
const OUTCOMES: Partial<Record<OrderState, string>> = {
    refunded: "Refunded to your wallet",
    failed: "Didn't go through",
};

/** The order is on its way: reported by the wallet and not yet delivered, refunded or failed. */
export const isRunning = (order: DepositOrderView) => ["sent", "in_block", "bridging"].includes(order.state);

/** "2 s", "3 min". */
const eta = (seconds: number) =>
    seconds < 60 ? `${Math.max(1, Math.round(seconds))} s` : `${Math.round(seconds / 60)} min`;

/**
 * The order to show under the Deposit button: the newest one on its way, or one that just ended and
 * wasn't dismissed. An order the wallet never reported (turned down, say) is not shown.
 */
export function shownOrder(orders: DepositOrderView[], dismissed: string | null, since: number) {
    return (
        orders.find(
            (order) =>
                order.id !== dismissed &&
                (isRunning(order) ||
                    ((order.state === "delivered" || order.state in OUTCOMES) && Date.parse(order.updatedAt) >= since)),
        ) ?? null
    );
}

/** Whether the order ended badly, which the status line shows in the loss tone. */
export const isOutcome = (order: DepositOrderView) => order.state in OUTCOMES;

const STATE_TEXT = { done: "done", active: "in progress", waiting: "waiting" } as const;

/**
 * A bridged deposit's steps, each done, active or waiting; an outcome replaces them. It fills the
 * status line, which stays mounted so a change in it is announced.
 */
export function DepositProgress({ order }: { order: DepositOrderView }) {
    const outcome = OUTCOMES[order.state];
    if (outcome) {
        return (
            <span className={styles.outcome}>
                <CloseIcon className={styles.stepMark} />
                {outcome}
            </span>
        );
    }
    const done = DONE[order.state] ?? 0;
    const current = Math.min(done, STEPS.length - 1);
    return (
        <>
            {/* The one line that changes with the step, read out as it does. */}
            <span className="sr-only">
                Step {current + 1} of {STEPS.length}: {STEPS[current]}
            </span>
            {/* Browsed, not announced: each step says where it stands. */}
            <ol className={styles.steps} aria-label="Deposit progress" aria-live="off">
                {STEPS.map((name, i) => {
                    const step = i < done ? "done" : i === done ? "active" : "waiting";
                    return (
                        <li
                            key={name}
                            className={styles.step}
                            data-step={step}
                            aria-current={step === "active" ? "step" : undefined}
                        >
                            <span className={styles.stepMark} aria-hidden="true">
                                {step === "done" ? <Tick /> : step === "active" ? <Spinner /> : null}
                            </span>
                            {name}
                            <span className="sr-only">, {STATE_TEXT[step]}</span>
                            {step === "active" && i === 2 && (
                                <span className={styles.stepEta}>about {eta(order.etaSeconds)}</span>
                            )}
                        </li>
                    );
                })}
            </ol>
        </>
    );
}

/** An arc turning around the active step's mark. */
function Spinner() {
    return (
        <svg viewBox="0 0 20 20" fill="none" className={styles.stepSpinner}>
            <path d="M10 2a8 8 0 0 1 8 8" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" />
        </svg>
    );
}

function Tick() {
    return (
        <svg viewBox="0 0 16 16" fill="none" width={12} height={12}>
            <path
                d="M3 8.5 6.5 12 13 4.5"
                stroke="currentColor"
                strokeWidth={2.4}
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}
