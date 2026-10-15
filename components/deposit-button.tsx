"use client";

import { useEffect, useState } from "react";
import { motion, type Transition } from "motion/react";
import type { DepositOrderView } from "@/server/src/protocol";
import type { DepositNotice } from "./account-client";
import { PlusIcon } from "./icons";
import { ProgressGlyph, useProgressFill, type ProgressPhase as Phase } from "./progress-fill";
import styles from "./wallet-sidebar.module.css";

/** About how long the server takes to confirm a deposit; the fill eases toward 90% over it. */
const EXPECTED_MS = 5_000;
/** How long the finished state stays before the button settles back. */
const DONE_MS = 1_400;
const ERROR_MS = 1_600;

const press: Transition = { type: "spring", visualDuration: 0.35, bounce: 0.3 };

const phaseOf = (notice: DepositNotice | null): Phase =>
    notice?.kind === "confirming"
        ? "running"
        : notice?.kind === "credited"
          ? "done"
          : notice?.kind === "reverted" && !notice.withdrawal
            ? "error"
            : "idle";

/** A bridged deposit runs from the wallet's report until it lands, is refunded or fails. */
const phaseOfOrder = (order: DepositOrderView | null | undefined): Phase =>
    !order
        ? "idle"
        : order.state === "delivered"
          ? "done"
          : order.state === "refunded" || order.state === "failed"
            ? "error"
            : "running";

type DepositButtonProps = {
    notice: DepositNotice | null;
    /** The bridged deposit being followed, if any. */
    order?: DepositOrderView | null;
    /** The account hasn't loaded. */
    disabled: boolean;
    onClick: () => void;
};

/**
 * The deposit button, which doubles as the deposit's progress bar, after
 * React Bits' CallChip: while the server confirms it, a fill sweeps across
 * and turns from gray to green; once it's credited it fills and holds green
 * with a check, then settles back.
 */
export function DepositButton({ notice, order, disabled, onClick }: DepositButtonProps) {
    const target = notice ? phaseOf(notice) : phaseOfOrder(order);
    const subject = notice ?? order ?? null;
    // Done and failed hold for a moment, then the button settles back even while the notice stays.
    const [settled, setSettled] = useState<DepositNotice | DepositOrderView | null>(null);
    const phase = settled === subject && target !== "running" ? "idle" : target;
    const { fill, button } = useProgressFill(phase, EXPECTED_MS);

    useEffect(() => {
        if (target !== "done" && target !== "error") return;
        const timer = setTimeout(() => setSettled(subject), target === "done" ? DONE_MS : ERROR_MS);
        return () => clearTimeout(timer);
    }, [target, subject]);

    const busy = phase === "running";

    return (
        <motion.button
            ref={button}
            type="button"
            className={`${styles.deposit} overflow-hidden`}
            aria-disabled={disabled || undefined}
            aria-busy={busy || undefined}
            data-phase={phase}
            title={disabled ? "Loading your account…" : undefined}
            // Gray while it works, so the fill reads against it; white again once it settles.
            animate={{
                backgroundColor: phase === "idle" ? "rgb(245 245 243)" : "rgb(53 53 50)",
                color: phase === "idle" || phase === "done" ? "rgb(23 23 23)" : "rgb(245 245 243)",
            }}
            whileHover={disabled ? undefined : { scale: 1.04 }}
            whileTap={disabled ? undefined : { scale: 0.94 }}
            transition={{ ...press, backgroundColor: { duration: 0.25 }, color: { duration: 0.25 } }}
            onClick={onClick}
        >
            <span
                ref={fill}
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 origin-left rounded-[inherit] opacity-0"
            />
            <span className="relative flex size-3.5 items-center justify-center" aria-hidden="true">
                <ProgressGlyph phase={phase} idle={<PlusIcon className={styles.depositIcon} />} />
            </span>
            <span className="relative">Deposit</span>
        </motion.button>
    );
}
