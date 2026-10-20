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
    perpCloseBlock,
    positionFacts,
    positionName,
    positionTitle,
    sellableShares,
    trendOf,
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
    /** The market's sell price and smallest sale; null where its question isn't known yet. */
    market: { sellPrice: number | null; minShares: number | null };
    onSell: (position: PositionView, sellPrice: number | null) => void;
    onClosePerp: (positionId: string) => void;
    ref?: Ref<HTMLLIElement>;
};

/**
 * One open position: what it is, what it has made and what it is worth.
 * Hovering (or focusing, or tapping on touch) opens its details below and
 * slides in a close button tinted by the PnL.
 */
export function PositionRow({ position, entranceDelay, market, onSell, onClosePerp, ref }: PositionRowProps) {
    const { symbol } = position;
    const title = positionTitle(position);
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);
    const [tapped, setTapped] = useState(false);
    const revealed = hovered || focused || tapped;
    const worth = position.status === "pending" ? null : liveValue(position, market.sellPrice);
    // To the cent, so a hair under zero reads as a flat $0.00; an order still filling, or a prediction whose price isn't in yet, says nothing
    const pnl = worth ? Math.round(worth.pnl * 100) / 100 : null;
    const trend = trendOf(pnl ?? 0);
    // Close waits while an order fills or a close is under way, and for a prediction too small to sell
    const reason = closeBlock(position, market.minShares);
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
                {pnl !== null && <span className={styles.change}>{formatPnl(pnl)}</span>}
                {/* Why a close was refused stays in sight until the next close, not only in the screen reader's description. */}
                {position.kind === "perp-live" && position.status === "open" && position.notice && (
                    <span className={styles.notice}>{position.notice}</span>
                )}
            </span>
            <span className={styles.pnl}>{liveText(position, worth?.value ?? null)}</span>
            {/* Always mounted, only collapsed, so keyboard users can tab to it. */}
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
                        if (reason) return;
                        if (position.kind === "perp-live") onClosePerp(position.position.id);
                        else if (position.position) onSell(position.position, market.sellPrice);
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
            <span className={styles.facts}>
                <span>
                    <dl>
                        {positionFacts(position).map(([label, value]) => (
                            <div key={label} className={styles.fact}>
                                <dt>{label}</dt>
                                <dd>{value}</dd>
                            </div>
                        ))}
                    </dl>
                </span>
            </span>
        </motion.li>
    );
}

/** Why a live position can't be closed now, or null when it can. */
function closeBlock(live: Position, minShares: number | null): string | null {
    if (live.kind === "perp-live") return perpCloseBlock(live);
    if (!live.position) return BUY_PENDING;
    return minShares !== null && sellableShares(live.shares) < minShares ? TOO_SMALL : null;
}

/** What sits at the row's right edge: the wait, or the position's worth. */
function liveText(live: Position, value: number | null) {
    if (live.status === "pending") return "Pending";
    if (live.status === "closing") return "Closing";
    return formatUsd(value ?? live.size);
}
