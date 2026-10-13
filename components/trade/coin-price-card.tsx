"use client";

import { useId, useMemo, useRef, useState } from "react";
import NumberFlow, { type Format } from "@number-flow/react";
import { AnimatePresence, motion, useReducedMotion, type Transition } from "motion/react";
import { CoinIcon } from "@/components/coin-icons";
import { smoothPath } from "./chart-path";
import type { PricePoints } from "./price-history-store";

/** The chart's drawing size, the card's own width: it runs to the card's edges and scales evenly with it. */
const WIDTH = 300;
const HEIGHT = 120;
/** Room above the line for the stroke, and below it for the fill, clear of the card's rounded corners. */
const TOP = 10;
const BOTTOM = 26;
/** A coin that barely moves (a stablecoin) is drawn on at least this share of its price, so noise stays flat. */
const MIN_SPAN = 0.02;
/** A change smaller than this reads as no change. */
const FLAT_PCT = 0.05;

const TONE = {
    gain: { chip: "bg-gain/15 text-gain", line: "var(--gain)" },
    loss: { chip: "bg-loss/15 text-loss", line: "var(--loss)" },
    flat: { chip: "bg-pill text-muted", line: "var(--muted)" },
} as const;

const draw: Transition = { duration: 0.7, ease: [0.3, 0.7, 0.2, 1] };
const pop: Transition = { type: "spring", visualDuration: 0.3, bounce: 0.5 };
const swap: Transition = { type: "spring", visualDuration: 0.25, bounce: 0.3 };
const follow: Transition = { type: "spring", visualDuration: 0.15, bounce: 0 };

/** Cents from $1, four significant digits under it: "$96,120.45", "$0.1823". */
const priceFormat = (usd: number): Format =>
    usd >= 1
        ? { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }
        : { style: "currency", currency: "USD", maximumSignificantDigits: 4 };

/** "+3.21%", "−1.05%". */
const formatChange = (pct: number) => `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct).toFixed(2)}%`;

const when = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric" });

type CoinPriceCardProps = {
    symbol: string;
    name: string;
    points: PricePoints;
};

/**
 * A coin's dollar price over the range: where it is now, how far it moved,
 * and the line it took, from edge to edge of the card. Pointing along the line rolls the price to that
 * moment, and the ticker gives way to when it was.
 */
export function CoinPriceCard({ symbol, name, points }: CoinPriceCardProps) {
    const reduce = useReducedMotion();
    // A bare name, so url(#…) needs no escaping
    const gradientId = useId().replace(/[^\w-]/g, "");
    const svg = useRef<SVGSVGElement>(null);
    const [active, setActive] = useState<number | null>(null);

    const chart = useMemo(() => {
        const first = points[0]![1];
        const last = points.at(-1)![1];
        const prices = points.map(([, usd]) => usd);
        const low = Math.min(...prices);
        const high = Math.max(...prices);
        const pct = ((last - first) / first) * 100;
        const trend = Math.abs(pct) < FLAT_PCT ? "flat" : pct > 0 ? "gain" : "loss";

        const span = Math.max(high - low, ((high + low) / 2) * MIN_SPAN);
        const floor = (high + low) / 2 - span / 2;
        const t0 = points[0]![0];
        const t1 = points.at(-1)![0];
        const xy = points.map(
            ([time, usd]) =>
                [
                    ((time - t0) / (t1 - t0 || 1)) * WIDTH,
                    TOP + (1 - (usd - floor) / span) * (HEIGHT - TOP - BOTTOM),
                ] as const,
        );
        const line = smoothPath(xy);
        // The fill runs from the line down to the card's bottom edge
        const area = `${line}L${WIDTH},${HEIGHT}L0,${HEIGHT}Z`;
        return { pct, trend, xy, line, area } as const;
    }, [points]);
    const tone = TONE[chart.trend];

    const shown = active ?? points.length - 1;
    const price = points[shown]![1];
    const [x, y] = chart.xy[shown]!;

    // The point nearest the pointer along the line
    const point = (clientX: number) => {
        const rect = svg.current?.getBoundingClientRect();
        if (!rect) return;
        const at = ((clientX - rect.left) / rect.width) * WIDTH;
        let nearest = 0;
        for (let i = 1; i < chart.xy.length; i++)
            if (Math.abs(chart.xy[i]![0] - at) < Math.abs(chart.xy[nearest]![0] - at)) nearest = i;
        setActive(nearest);
    };

    return (
        <div className="flex flex-col gap-4" data-coin-card={symbol}>
            <div className="flex items-center gap-3 px-5 pt-5">
                <CoinIcon symbol={symbol} className="size-10 shrink-0" />
                <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[17px] leading-snug font-medium tracking-[-0.01em]">{name}</span>
                    {/* The ticker, or when the pointed-at price was */}
                    <span className="relative h-[1.375em] overflow-hidden text-[14px] leading-snug text-muted">
                        <AnimatePresence mode="popLayout" initial={false}>
                            <motion.span
                                key={active === null ? "symbol" : "when"}
                                data-subtitle=""
                                className="absolute inset-x-0 truncate tabular-nums"
                                initial={reduce ? { opacity: 0 } : { opacity: 0, y: "70%" }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={reduce ? { opacity: 0 } : { opacity: 0, y: "-70%" }}
                                transition={swap}
                            >
                                {active === null ? symbol : when.format(points[active]![0])}
                            </motion.span>
                        </AnimatePresence>
                    </span>
                </div>
                <div className="flex flex-col items-end gap-1">
                    <span className="text-[17px] leading-snug font-medium tracking-[-0.01em]" data-price={price}>
                        <NumberFlow value={price} format={priceFormat(price)} willChange />
                    </span>
                    <motion.span
                        className={`inline-flex h-6 items-center rounded-full px-2.5 text-[13px] font-medium tabular-nums ${tone.chip}`}
                        initial={reduce ? false : { scale: 0.8, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ ...pop, delay: reduce ? 0 : 0.08 }}
                    >
                        {formatChange(chart.pct)}
                    </motion.span>
                </div>
            </div>

            <svg
                ref={svg}
                viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                className="block h-auto w-full cursor-crosshair overflow-visible"
                aria-hidden="true"
                data-chart=""
                onPointerMove={(event) => point(event.clientX)}
                onPointerLeave={() => setActive(null)}
            >
                <defs>
                    <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={tone.line} stopOpacity={0.28} />
                        <stop offset="100%" stopColor={tone.line} stopOpacity={0} />
                    </linearGradient>
                </defs>
                {/* Catches the pointer over the whole chart, not only on the line */}
                <rect width={WIDTH} height={HEIGHT} fill="transparent" />
                <motion.path
                    d={chart.area}
                    fill={`url(#${gradientId})`}
                    initial={reduce ? false : { opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.5, delay: reduce ? 0 : 0.2 }}
                />
                <motion.path
                    d={chart.line}
                    data-line=""
                    fill="none"
                    stroke={tone.line}
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    initial={reduce ? false : { pathLength: 0 }}
                    animate={{ pathLength: 1 }}
                    transition={draw}
                />
                {active !== null && (
                    <motion.line
                        y1={0}
                        y2={HEIGHT}
                        stroke="var(--muted)"
                        strokeOpacity={0.45}
                        strokeWidth={1.5}
                        strokeDasharray="3 4"
                        strokeLinecap="round"
                        initial={{ x1: x, x2: x }}
                        animate={{ x1: x, x2: x }}
                        transition={follow}
                    />
                )}
                {/* The line runs to the card's edges, so the pointed-at price's dot shows only while pointing */}
                <AnimatePresence>
                    {active !== null && (
                        <motion.circle
                            key="dot"
                            fill={tone.line}
                            stroke="var(--panel)"
                            strokeWidth={2.5}
                            r={5.5}
                            initial={{ scale: 0, cx: x, cy: y }}
                            animate={{ scale: 1, cx: x, cy: y }}
                            exit={{ scale: 0 }}
                            transition={{ default: follow, scale: pop }}
                            style={{ transformBox: "fill-box", transformOrigin: "center" }}
                        />
                    )}
                </AnimatePresence>
            </svg>
        </div>
    );
}
