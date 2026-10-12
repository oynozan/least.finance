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

/** A bridged deposit's steps, each done, active or waiting; an outcome replaces them. */
export function DepositProgress({ order }: { order: DepositOrderView }) {
    const outcome = OUTCOMES[order.state];
    const done = DONE[order.state] ?? 0;
    return (
        <div role="status" className={`${styles.status} ${styles.progress}`} data-tone={outcome ? "loss" : undefined}>
            {outcome ? (
                <span className={styles.outcome}>
                    <CloseIcon className={styles.stepMark} />
                    {outcome}
                </span>
            ) : (
                <ol className={styles.steps} aria-label="Deposit progress">
                    {STEPS.map((name, i) => {
                        const step = i < done ? "done" : i === done ? "active" : "waiting";
                        return (
                            <li key={name} className={styles.step} data-step={step}>
                                <span className={styles.stepMark} aria-hidden="true">
                                    {step === "done" ? (
                                        <Tick />
                                    ) : step === "active" ? (
                                        <span className={styles.pendingDot} />
                                    ) : null}
                                </span>
                                {name}
                                {step === "active" && i === 2 && (
                                    <span className={styles.stepEta}>about {eta(order.etaSeconds)}</span>
                                )}
                            </li>
                        );
                    })}
                </ol>
            )}
        </div>
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
