"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useAnimate, useReducedMotion, type Transition } from "motion/react";
import type { DepositNotice } from "./account-client";
import { CloseIcon, PlusIcon } from "./icons";
import styles from "./wallet-sidebar.module.css";

type Phase = "idle" | "running" | "done" | "error";

/** About how long the server takes to confirm a deposit; the fill eases toward 90% over it. */
const EXPECTED_MS = 5_000;
const HOLD_AT = 0.9;
/** How long the finished state stays before the button settles back. */
const DONE_MS = 1_400;
const ERROR_MS = 1_600;

const press: Transition = { type: "spring", visualDuration: 0.35, bounce: 0.3 };
const glyph: Transition = { type: "spring", visualDuration: 0.3, bounce: 0.3 };

// The palette's foreground, pill-hover, gain and loss, as literals Motion can tween between.
const GRAY = "rgb(245 245 243 / 0.14)";
const GREEN = "rgb(104 214 112 / 0.62)";
const GAIN = "rgb(104 214 112)";
const LOSS = "rgb(255 107 91 / 0.4)";

const phaseOf = (notice: DepositNotice | null): Phase =>
    notice?.kind === "confirming"
        ? "running"
        : notice?.kind === "credited"
          ? "done"
          : notice?.kind === "reverted"
            ? "error"
            : "idle";

type DepositButtonProps = {
    notice: DepositNotice | null;
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
export function DepositButton({ notice, disabled, onClick }: DepositButtonProps) {
    const reduce = useReducedMotion();
    const [fill, animate] = useAnimate<HTMLSpanElement>();
    const [button, animateButton] = useAnimate<HTMLButtonElement>();
    const target = phaseOf(notice);
    // Done and failed hold for a moment, then the button settles back even while the notice stays.
    const [settled, setSettled] = useState<DepositNotice | null>(null);
    const phase = settled === notice && target !== "running" ? "idle" : target;

    useEffect(() => {
        if (target !== "done" && target !== "error") return;
        const timer = setTimeout(() => setSettled(notice), target === "done" ? DONE_MS : ERROR_MS);
        return () => clearTimeout(timer);
    }, [target, notice]);

    useEffect(() => {
        const node = fill.current;
        if (!node) return;
        if (phase === "running") {
            // From empty and gray every time, whatever the last deposit left behind.
            const controls = animate(
                node,
                { scaleX: [0, HOLD_AT], backgroundColor: [GRAY, GREEN], opacity: [1, 1] },
                { duration: reduce ? 0 : EXPECTED_MS / 1000, ease: [0.25, 0.6, 0.3, 1] },
            );
            return () => controls.stop();
        }
        if (phase === "done") {
            const controls = animate(
                node,
                { scaleX: 1, backgroundColor: GAIN, opacity: 1 },
                { duration: 0.25, ease: "easeOut" },
            );
            return () => controls.stop();
        }
        if (phase === "error") {
            const controls = animate(node, { backgroundColor: LOSS }, { duration: 0.2 });
            if (!reduce && button.current)
                animateButton(button.current, { x: [0, -6, 6, -4, 4, -2, 0] }, { duration: 0.45, ease: "easeOut" });
            return () => controls.stop();
        }
        const controls = animate(node, { opacity: 0 }, { duration: 0.3 });
        return () => controls.stop();
    }, [phase, animate, animateButton, fill, button, reduce]);

    const busy = phase === "running";
    const icon = phase === "running" ? "spinner" : phase === "done" ? "check" : phase === "error" ? "error" : "plus";

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
                <AnimatePresence mode="popLayout" initial={false}>
                    <motion.span
                        key={icon}
                        className="absolute inset-0 flex items-center justify-center"
                        initial={{ opacity: 0, y: "70%", filter: "blur(3px)" }}
                        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                        exit={{ opacity: 0, y: "-70%", filter: "blur(3px)" }}
                        transition={glyph}
                    >
                        {icon === "plus" ? (
                            <PlusIcon className={styles.depositIcon} />
                        ) : icon === "spinner" ? (
                            <Spinner />
                        ) : icon === "check" ? (
                            <Tick />
                        ) : (
                            <CloseIcon className={styles.depositIcon} />
                        )}
                    </motion.span>
                </AnimatePresence>
            </span>
            <span className="relative">Deposit</span>
        </motion.button>
    );
}

function Spinner() {
    return (
        <motion.svg
            viewBox="0 0 16 16"
            fill="none"
            className="size-3.5"
            animate={{ rotate: 360 }}
            transition={{ repeat: Infinity, duration: 0.9, ease: "linear" }}
        >
            <circle cx={8} cy={8} r={6} stroke="currentColor" strokeOpacity={0.25} strokeWidth={2.2} />
            <path d="M8 2a6 6 0 0 1 6 6" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" />
        </motion.svg>
    );
}

/** A plain stroke check; the sticker CheckIcon is too loud inside a button. */
function Tick() {
    return (
        <svg viewBox="0 0 16 16" fill="none" className="size-3.5">
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
