"use client";

import { useId, useState, type Ref } from "react";
import { motion, type Transition, type Variants } from "motion/react";
import { CoinIcon } from "./coin-icons";
import { canHover } from "./pointer";
import type { PositionView } from "@/lib/account/state";
import {
    BUY_PENDING,
    TOO_SMALL,
    formatPnl,
    formatUsd,
    liveValue,
    positionDetail,
    positionName,
    positionTitle,
    sellableShares,
    trendOf,
    type LivePredictionPosition,
    type Position,
} from "./wallet-data";
import styles from "./position-row.module.css";

const spring: Transition = { type: "spring", visualDuration: 0.35, bounce: 0.3 };
const reveal: Transition = { type: "spring", visualDuration: 0.3, bounce: 0.2 };
const rise: Transition = { type: "spring", visualDuration: 0.26, bounce: 0.25 };

/** Driven by the list as the sidebar opens; each row brings its own delay. */
const rowVariants: Variants = {
    hidden: { opacity: 0, y: 28, scale: 0.94 },
    shown: (delay: number) => ({ opacity: 1, y: 0, scale: 1, transition: { ...rise, delay } }),
};

type PositionRowProps = {
    position: Position;
    /** Seconds to wait before rising in when the sidebar opens. */
    entranceDelay: number;
    onClose: (id: string) => void;
    /** The market's sell price and smallest sale for a live prediction; null until its question is known. */
    market?: { sellPrice: number | null; minShares: number | null };
    onSell?: (position: PositionView, sellPrice: number | null) => void;
    ref?: Ref<HTMLLIElement>;
};

/**
 * One open position: what it is ("Long BTC", or a prediction's question),
 * its leverage or outcome with its size, and the PnL. Hovering (or focusing,
 * or tapping on touch) slides in a close button tinted by the PnL.
 */
export function PositionRow({ position, entranceDelay, onClose, market, onSell, ref }: PositionRowProps) {
    const { id, symbol } = position;
    const title = positionTitle(position);
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);
    const [tapped, setTapped] = useState(false);
    const revealed = hovered || focused || tapped;
    const live = position.kind === "prediction-live" ? position : null;
    const worth = live && live.status === "open" ? liveValue(live, market?.sellPrice ?? null) : null;
    const pnl = worth ? worth.pnl : position.pnl;
    const trend = trendOf(pnl);
    // Only a position that resolved or was bought but not yet filled has no sale to make
    const reason = live ? closeBlock(live, market?.minShares ?? null) : null;
    const reasonId = `${useId()}-reason`;

    return (
        <motion.li
            ref={ref}
            layout
            className={styles.row}
            data-trend={trend}
            data-revealed={revealed}
            variants={rowVariants}
            custom={entranceDelay}
            exit={{ opacity: 0, x: 72, scale: 0.9, transition: { duration: 0.22, ease: [0.4, 0, 1, 1] } }}
            transition={spring}
            onPointerEnter={(event) => canHover(event) && setHovered(true)}
            onPointerLeave={() => setHovered(false)}
            onPointerUp={(event) => !canHover(event) && setTapped((t) => !t)}
            // Keyboard focus only: a tap also focuses, and would pin it open.
            onFocus={(event) => setFocused(event.target.matches(":focus-visible"))}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
            }}
        >
            <CoinIcon symbol={symbol} className={styles.logo} />
            <span className={styles.text}>
                {/* A question can run long: it ends in an ellipsis, in full on hover. */}
                <span className={styles.title} title={title}>
                    {title}
                </span>
                <span className={styles.detail}>
                    {positionDetail(position)}
                    {worth && ` · ${formatPnl(worth.pnl)}`}
                </span>
            </span>
            <span className={styles.pnl}>{live ? liveText(live, worth?.value ?? null) : formatPnl(pnl)}</span>
            {/* Always mounted, only collapsed, so keyboard users can tab to it. */}
            {(!live || live.status === "pending" || live.status === "open") && (
                <motion.span
                    className={styles.closeSlot}
                    initial={false}
                    animate={revealed ? { width: "auto", opacity: 1 } : { width: 0, opacity: 0 }}
                    transition={reveal}
                >
                    <motion.button
                        type="button"
                        className={styles.close}
                        aria-label={`Close ${positionName(position)}`}
                        aria-disabled={reason ? true : undefined}
                        aria-describedby={reason ? reasonId : undefined}
                        initial={false}
                        animate={revealed ? { scale: 1, x: 0 } : { scale: 0.6, x: 12 }}
                        whileTap={{ scale: 0.9 }}
                        transition={spring}
                        onClick={() => {
                            if (!live) onClose(id);
                            else if (!reason && live.position) onSell?.(live.position, market?.sellPrice ?? null);
                        }}
                    >
                        Close
                    </motion.button>
                    {reason && (
                        <span id={reasonId} className="sr-only">
                            {reason}
                        </span>
                    )}
                </motion.span>
            )}
        </motion.li>
    );
}

/** Why a live prediction can't be sold now, or null when it can. */
function closeBlock(live: LivePredictionPosition, minShares: number | null): string | null {
    if (!live.position) return BUY_PENDING;
    return minShares !== null && sellableShares(live.shares) < minShares ? TOO_SMALL : null;
}

/** What sits at the row's right edge: the wait, the outcome, or the position's worth. */
function liveText(live: LivePredictionPosition, value: number | null) {
    if (live.status === "pending") return "Pending";
    if (live.status === "won") return `Won ${formatUsd(live.payout ?? 0)}`;
    if (live.status === "lost") return "Lost";
    return formatUsd(value ?? live.size);
}
