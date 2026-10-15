"use client";

import { useEffect, type ReactNode } from "react";
import { AnimatePresence, motion, useAnimate, useReducedMotion, type Transition } from "motion/react";
import { CloseIcon } from "./icons";

/** Where a button that doubles as its own progress bar is: at rest, waiting on the server, or just answered. */
export type ProgressPhase = "idle" | "running" | "done" | "error";

/** The fill eases toward 90% over the expected wait, so a slow answer never looks finished. */
const HOLD_AT = 0.9;

const glyph: Transition = { type: "spring", visualDuration: 0.3, bounce: 0.3 };

// The palette's foreground, pill-hover, gain and loss, as literals Motion can tween between.
const GRAY = "rgb(245 245 243 / 0.14)";
const GREEN = "rgb(104 214 112 / 0.62)";
const GAIN = "rgb(104 214 112)";
const LOSS = "rgb(255 107 91 / 0.4)";

/**
 * Runs a button's progress fill, after React Bits' CallChip: while it waits a fill sweeps across and turns
 * from gray to green; done fills it green, an error tints it red with a shake, and idle fades the fill out.
 * The fill is a `pointer-events-none absolute inset-0 origin-left opacity-0` span inside the button.
 */
export function useProgressFill(phase: ProgressPhase, expectedMs: number) {
    const reduce = useReducedMotion();
    const [fill, animate] = useAnimate<HTMLSpanElement>();
    const [button, animateButton] = useAnimate<HTMLButtonElement>();

    useEffect(() => {
        const node = fill.current;
        if (!node) return;
        if (phase === "running") {
            // From empty and gray every time, whatever the last wait left behind.
            const controls = animate(
                node,
                { scaleX: [0, HOLD_AT], backgroundColor: [GRAY, GREEN], opacity: [1, 1] },
                { duration: reduce ? 0 : expectedMs / 1000, ease: [0.25, 0.6, 0.3, 1] },
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
    }, [phase, expectedMs, animate, animateButton, fill, button, reduce]);

    return { fill, button };
}

/** The phase's glyph, swapped with a short rise: a spinner while running, a check once done, a cross on error. */
export function ProgressGlyph({ phase, idle = null }: { phase: ProgressPhase; idle?: ReactNode }) {
    const icon = phase === "running" ? "spinner" : phase === "done" ? "check" : phase === "error" ? "error" : "idle";
    return (
        <AnimatePresence mode="popLayout" initial={false}>
            {(icon !== "idle" || idle) && (
                <motion.span
                    key={icon}
                    className="absolute inset-0 flex items-center justify-center"
                    initial={{ opacity: 0, y: "70%", filter: "blur(3px)" }}
                    animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                    exit={{ opacity: 0, y: "-70%", filter: "blur(3px)" }}
                    transition={glyph}
                >
                    {icon === "spinner" ? (
                        <Spinner />
                    ) : icon === "check" ? (
                        <Tick />
                    ) : icon === "error" ? (
                        <CloseIcon className="size-3.5" />
                    ) : (
                        idle
                    )}
                </motion.span>
            )}
        </AnimatePresence>
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
