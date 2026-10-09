"use client";

import { useState, type ReactNode, type Ref } from "react";
import { AnimatePresence, motion, useReducedMotion, type Transition } from "motion/react";
import { iconVariants, layoutSpring, pillVariants, spring, wobble } from "./motion";

export type IconPose = "rest" | "hover" | "tap";

type PillBodyProps = {
    /** Identifies the content; a change swaps it with a spring. */
    contentKey: string;
    /** Re-measures the pill's size when it changes; defaults to `contentKey`. */
    layoutKey?: string;
    children: ReactNode;
    icon?: ReactNode;
    pose?: IconPose;
    /** Persistent content after the swapped part (a chevron, a unit). */
    trailing?: ReactNode;
    layoutTransition?: Transition;
    className?: string;
};

/**
 * The visible pill. Its background is the size-animating layout node and
 * clips horizontally, so a longer label is revealed by the pill's edge as
 * it grows. The content inside is a position-only layout node, which Motion
 * counter-scales, so glyphs never stretch. No JS width spring: the pill
 * always has its natural width, so one layout pass sees the final sentence.
 */
export function PillBody({
    contentKey,
    layoutKey = contentKey,
    children,
    icon,
    pose = "rest",
    trailing,
    layoutTransition = layoutSpring,
    className = "",
}: PillBodyProps) {
    const reduce = useReducedMotion();
    return (
        <motion.span
            layout
            layoutDependency={layoutKey}
            transition={{ layout: layoutTransition }}
            // A numeric radius is what Motion's scale correction rewrites per frame.
            style={{ borderRadius: 999 }}
            className={`flex max-w-full bg-pill transition-colors duration-150 [overflow-x:clip] [overflow-y:visible] ${className}`}
        >
            <motion.span
                layout="position"
                layoutDependency={layoutKey}
                transition={{ layout: layoutTransition }}
                className="relative flex min-w-0 items-center"
            >
                <AnimatePresence mode="popLayout" initial={false}>
                    <motion.span
                        key={contentKey}
                        className={`flex min-w-0 shrink-0 items-center gap-[0.2em] whitespace-nowrap ${
                            icon ? "pl-[0.13em]" : "pl-[0.36em]"
                        } ${trailing ? "pr-[0.14em]" : "pr-[0.36em]"}`}
                        initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.5, y: "40%" }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.5, y: "-40%" }}
                        transition={spring}
                    >
                        {icon && (
                            <motion.span
                                className="-my-[0.12em] flex shrink-0 select-none"
                                variants={iconVariants}
                                initial="rest"
                                animate={pose}
                                transition={wobble}
                            >
                                {icon}
                            </motion.span>
                        )}
                        {/* The only baseline-aligned item: the pill shares the text's baseline.
                Trimmed to cap height and baseline, even padding centers the
                caps at any size; without text-box, the leading approximates it. */}
                        <span className="self-baseline py-[0.08em] leading-[1.06] [text-box:trim-both_cap_alphabetic] supports-[text-box:trim-both_cap_alphabetic]:py-[calc((1.22em-1cap)/2)]">
                            {children}
                        </span>
                    </motion.span>
                </AnimatePresence>
                {trailing}
            </motion.span>
        </motion.span>
    );
}

type PillButtonProps = Omit<PillBodyProps, "pose" | "className"> & {
    ref?: Ref<HTMLButtonElement>;
    onClick: () => void;
    "aria-label": string;
    "aria-describedby"?: string;
    "aria-haspopup"?: "dialog";
    "aria-expanded"?: boolean;
    "aria-controls"?: string;
    "aria-invalid"?: boolean;
    tone?: "default" | "muted" | "gain" | "loss";
};

const TONE = {
    default: "",
    muted: "text-muted",
    gain: "text-gain",
    loss: "text-loss",
} as const;

/** A pill that opens something: springs on hover and press. */
export function PillButton({ ref, onClick, tone = "default", ...props }: PillButtonProps) {
    const [hovered, setHovered] = useState(false);
    const [pressed, setPressed] = useState(false);
    const {
        contentKey,
        layoutKey,
        children,
        icon,
        trailing,
        layoutTransition,
        "aria-label": label,
        "aria-describedby": describedBy,
        "aria-haspopup": hasPopup,
        "aria-expanded": expanded,
        "aria-controls": controls,
        "aria-invalid": invalid,
    } = props;

    // The icon pose is state, not inherited from whileHover: an icon mounted
    // by a swap has to join a hover that is already in progress.
    const pose: IconPose = pressed ? "tap" : hovered ? "hover" : "rest";

    return (
        <motion.button
            ref={ref}
            type="button"
            aria-label={label}
            aria-describedby={describedBy}
            aria-haspopup={hasPopup}
            aria-expanded={expanded}
            aria-controls={controls}
            aria-invalid={invalid || undefined}
            onClick={onClick}
            variants={pillVariants}
            initial={false}
            whileHover="hover"
            whileTap="tap"
            onHoverStart={() => setHovered(true)}
            onHoverEnd={() => setHovered(false)}
            onTapStart={() => setPressed(true)}
            onTap={() => setPressed(false)}
            onTapCancel={() => setPressed(false)}
            transition={spring}
            // No visible outline (the pill lightens instead); the transparent one
            // becomes a system focus ring in forced-colors mode.
            className={`group inline-flex max-w-full cursor-pointer outline-2 outline-offset-2 outline-transparent focus-visible:outline-solid ${TONE[tone]}`}
        >
            <PillBody
                contentKey={contentKey}
                layoutKey={layoutKey}
                icon={icon}
                pose={pose}
                trailing={trailing}
                layoutTransition={layoutTransition}
                className="group-hover:bg-pill-hover group-focus-visible:bg-pill-hover group-aria-expanded:bg-pill-hover"
            >
                {children}
            </PillBody>
        </motion.button>
    );
}
