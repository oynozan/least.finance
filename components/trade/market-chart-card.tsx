"use client";

import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import NumberFlow from "@number-flow/react";
import { AnimatePresence, motion, useReducedMotion, type Transition } from "motion/react";
import type { Outcome, PredictionMarket } from "@/lib/trade/catalog";
import { chanceScale, formatPts, valueAt, type ChancePoints } from "@/lib/trade/chance-chart";
import { chartedOutcomes, lineColor } from "@/lib/trade/market-lines";
import { smoothPath } from "./chart-path";
import { MarketImage } from "./market-image";
import { renderTradeIcon } from "./trade-icons";

/** The chart's drawing size, the card's own width: it runs to the card's edges and scales evenly with it. */
const WIDTH = 300;
const HEIGHT = 120;
/** Room above the line for the stroke, and below it for the fill, clear of the card's rounded corners. */
const TOP = 10;
const BOTTOM = 26;

const TONE = {
    gain: "bg-gain/15 text-gain",
    loss: "bg-loss/15 text-loss",
    flat: "bg-pill text-muted",
} as const;

const draw: Transition = { duration: 0.7, ease: [0.3, 0.7, 0.2, 1] };
const pop: Transition = { type: "spring", visualDuration: 0.3, bounce: 0.5 };
const swap: Transition = { type: "spring", visualDuration: 0.25, bounce: 0.3 };
const follow: Transition = { type: "spring", visualDuration: 0.15, bounce: 0 };

const when = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric" });

const PERCENT = { style: "percent", maximumFractionDigits: 0 } as const;

type ChartLine = { id: string; color: string; points: ChancePoints };

/** Whether a card has anything to draw: some line with at least 2 points. */
export function drawable(lines: Iterable<ChancePoints>): boolean {
    for (const line of lines) if (line.length >= 2) return true;
    return false;
}

/** The subtitle that gives way to the pointed-at date while pointing. */
function Subtitle({ rest, time }: { rest: string; time: number | null }) {
    const reduce = useReducedMotion();
    return (
        <span className="relative h-[1.375em] overflow-hidden text-[14px] leading-snug text-muted">
            <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                    key={time === null ? "rest" : "when"}
                    data-subtitle=""
                    className="absolute inset-x-0 truncate tabular-nums"
                    initial={reduce ? { opacity: 0 } : { opacity: 0, y: "70%" }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduce ? { opacity: 0 } : { opacity: 0, y: "-70%" }}
                    transition={swap}
                >
                    {time === null ? rest : when.format(time)}
                </motion.span>
            </AnimatePresence>
        </span>
    );
}

type ChartProps = {
    lines: readonly ChartLine[];
    /** Whether the first line gets a fill down to the card's bottom edge. */
    fill: boolean;
    time: number | null;
    onTime: (time: number | null) => void;
};

/** The lines on one shared time axis and chance scale, with a crosshair and a dot per line while pointing. */
function Chart({ lines, fill, time, onTime }: ChartProps) {
    const reduce = useReducedMotion();
    // A bare name, so url(#…) needs no escaping
    const gradientId = useId().replace(/[^\w-]/g, "");
    const svg = useRef<SVGSVGElement>(null);

    const chart = useMemo(() => {
        const all = lines.flatMap((line) => line.points);
        if (all.length === 0) return null;
        const t0 = Math.min(...lines.filter((l) => l.points.length).map((l) => l.points[0]![0]));
        const t1 = Math.max(...all.map(([t]) => t));
        const { floor, span } = chanceScale(all.map(([, chance]) => chance));
        const xOf = (t: number) => ((t - t0) / (t1 - t0 || 1)) * WIDTH;
        const yOf = (chance: number) => TOP + (1 - (chance - floor) / span) * (HEIGHT - TOP - BOTTOM);
        const paths = lines.map((line) =>
            line.points.length >= 2 ? smoothPath(line.points.map(([t, c]) => [xOf(t), yOf(c)] as const)) : null,
        );
        return { t0, t1, xOf, yOf, paths };
    }, [lines]);
    if (!chart) return null;

    const point = (clientX: number) => {
        const rect = svg.current?.getBoundingClientRect();
        if (!rect) return;
        const share = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
        onTime(chart.t0 + share * (chart.t1 - chart.t0));
    };

    const x = time === null ? 0 : chart.xOf(time);

    return (
        <svg
            ref={svg}
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            className="block h-auto w-full cursor-crosshair overflow-visible"
            aria-hidden="true"
            data-chart=""
            onPointerMove={(event) => point(event.clientX)}
            onPointerLeave={() => onTime(null)}
        >
            <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={`var(${lines[0]!.color})`} stopOpacity={0.28} />
                    <stop offset="100%" stopColor={`var(${lines[0]!.color})`} stopOpacity={0} />
                </linearGradient>
            </defs>
            {/* Catches the pointer over the whole chart, not only on the line */}
            <rect width={WIDTH} height={HEIGHT} fill="transparent" />
            {fill && chart.paths[0] && (
                <motion.path
                    d={`${chart.paths[0]}L${WIDTH},${HEIGHT}L0,${HEIGHT}Z`}
                    fill={`url(#${gradientId})`}
                    initial={reduce ? false : { opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.5, delay: reduce ? 0 : 0.2 }}
                />
            )}
            {lines.map((line, i) =>
                chart.paths[i] ? (
                    <motion.path
                        key={line.id}
                        d={chart.paths[i]}
                        data-line={line.id}
                        fill="none"
                        stroke={`var(${line.color})`}
                        strokeWidth={2.5}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        initial={reduce ? false : { pathLength: 0 }}
                        animate={{ pathLength: 1 }}
                        transition={draw}
                    />
                ) : null,
            )}
            {time !== null && (
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
            {/* The lines run to the card's edges, so a dot shows only while pointing, and only where its line has begun */}
            <AnimatePresence>
                {lines.map((line) => {
                    const chance = time === null ? null : valueAt(line.points, time);
                    if (chance === null) return null;
                    const y = chart.yOf(chance);
                    return (
                        <motion.circle
                            key={line.id}
                            fill={`var(${line.color})`}
                            stroke="var(--panel)"
                            strokeWidth={2.5}
                            r={5.5}
                            initial={{ scale: 0, cx: x, cy: y }}
                            animate={{ scale: 1, cx: x, cy: y }}
                            exit={{ scale: 0 }}
                            transition={{ default: follow, scale: pop }}
                            style={{ transformBox: "fill-box", transformOrigin: "center" }}
                        />
                    );
                })}
            </AnimatePresence>
        </svg>
    );
}

type QuestionChartCardProps = {
    market: PredictionMarket;
    lines: ReadonlyMap<string, ChancePoints>;
};

/**
 * A question's leading outcomes over its life, one line each on a shared axis, with a legend
 * underneath. Pointing rolls every percentage to that moment, and "Ends …" gives way to the date.
 */
export function QuestionChartCard({ market, lines }: QuestionChartCardProps) {
    const [time, setTime] = useState<number | null>(null);
    const { drawn, more } = chartedOutcomes(market);
    const shown = useMemo(
        () =>
            drawn.flatMap((outcome) => {
                const points = lines.get(outcome.id);
                return points?.length
                    ? [{ outcome, id: outcome.id, color: lineColor(market, outcome.id), points }]
                    : [];
            }),
        [drawn, lines, market],
    );

    return (
        <div className="flex flex-col gap-4" data-market-card="question">
            <div className="flex items-center gap-3 px-5 pt-5">
                {market.image && (
                    <span className="flex shrink-0 text-[35px]">
                        <MarketImage src={market.image} />
                    </span>
                )}
                <div className="flex min-w-0 flex-1 flex-col">
                    <span className="line-clamp-2 text-[17px] leading-snug font-medium tracking-[-0.01em]">
                        {market.question}
                    </span>
                    <Subtitle rest={`Ends ${market.closes}`} time={time} />
                </div>
            </div>

            <Chart lines={shown} fill={false} time={time} onTime={setTime} />

            <div className="flex flex-col gap-2 px-5 pb-5">
                {shown.map(({ outcome, id, color, points }) => {
                    const chance = time === null ? points.at(-1)![1] : valueAt(points, time);
                    return (
                        <div key={id} data-legend={id} className="flex items-center gap-2.5 text-[15px] leading-snug">
                            <span
                                aria-hidden="true"
                                className="size-2 shrink-0 rounded-full"
                                style={{ background: `var(${color})` }}
                            />
                            <span className="min-w-0 flex-1 truncate">{outcome.label}</span>
                            <span className="font-medium tabular-nums" data-chance={chance ?? ""}>
                                {chance === null ? "—" : <NumberFlow value={chance} format={PERCENT} willChange />}
                            </span>
                        </div>
                    );
                })}
                {more > 0 && (
                    <div data-more="" className="text-[14px] leading-snug text-muted">
                        +{more} more
                    </div>
                )}
            </div>
        </div>
    );
}

/** The YES/NO mark, else the outcome's own picture, else nothing. */
function outcomeIcon(outcome: Outcome): ReactNode {
    if (/^(yes|no)$/i.test(outcome.label))
        return renderTradeIcon({ set: "outcome", id: outcome.label.toLowerCase(), tone: outcome.tone });
    return outcome.image ? renderTradeIcon({ set: "image", id: outcome.image }) : null;
}

type OutcomeChartCardProps = {
    market: PredictionMarket;
    outcome: Outcome;
    points: ChancePoints;
};

/**
 * One outcome's chance over the market's life: where it stands, how many points it moved, and the line it took.
 * Pointing rolls the chance and the move to that moment, and "Ends …" gives way to the date.
 */
export function OutcomeChartCard({ market, outcome, points }: OutcomeChartCardProps) {
    const reduce = useReducedMotion();
    const [time, setTime] = useState<number | null>(null);
    const lines = useMemo(
        () => [{ id: outcome.id, color: lineColor(market, outcome.id), points }],
        [market, outcome.id, points],
    );

    const chance = time === null ? points.at(-1)![1] : (valueAt(points, time) ?? points[0]![1]);
    const change = formatPts(chance - points[0]![1]);
    const icon = outcomeIcon(outcome);

    return (
        <div className="flex flex-col gap-4" data-market-card="outcome">
            <div className="flex items-center gap-3 px-5 pt-5">
                {icon && <span className="flex shrink-0 text-[35px]">{icon}</span>}
                <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[17px] leading-snug font-medium tracking-[-0.01em]">
                        {outcome.label}
                    </span>
                    <Subtitle rest={`Ends ${market.closes}`} time={time} />
                </div>
                <div className="flex flex-col items-end gap-1">
                    <span className="text-[17px] leading-snug font-medium tracking-[-0.01em]" data-chance={chance}>
                        <NumberFlow value={chance} format={PERCENT} willChange />
                    </span>
                    <motion.span
                        className={`inline-flex h-6 items-center rounded-full px-2.5 text-[13px] font-medium tabular-nums ${TONE[change.trend]}`}
                        initial={reduce ? false : { scale: 0.8, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ ...pop, delay: reduce ? 0 : 0.08 }}
                        data-change={change.text}
                    >
                        {change.text}
                    </motion.span>
                </div>
            </div>

            <Chart lines={lines} fill time={time} onTime={setTime} />
        </div>
    );
}
