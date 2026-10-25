"use client";

import { useId, useMemo, useRef, type KeyboardEvent } from "react";
import { motion, useReducedMotion } from "motion/react";
import { smoothPath } from "@/components/trade/chart-path";
import { fitY, type StatsPoint } from "@/lib/stats/chart";
import { formatUsd } from "@/components/wallet-data";

/** The drawing's size: it stretches to the card's width, edge to edge, with strokes kept at their own thickness. */
const WIDTH = 600;
const HEIGHT = 200;

const TONE = { gain: "var(--gain)", loss: "var(--loss)", flat: "var(--muted)" } as const;

const when = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
export const formatAt = (at: number) => when.format(at);

type LineChartProps = {
    points: StatsPoint[];
    /** The range's change, which picks the line's colour. */
    changeUsd: number;
    /** The point being scrubbed, or null. */
    active: number | null;
    onScrub: (index: number | null) => void;
    label: string;
};

/** A smooth line from edge to edge with a soft fill. Pointer and arrow keys scrub it. */
export function LineChart({ points, changeUsd, active, onScrub, label }: LineChartProps) {
    const reduce = useReducedMotion();
    const gradientId = useId().replace(/[^\w-]/g, "");
    const track = useRef<HTMLDivElement>(null);

    const chart = useMemo(() => {
        if (points.length === 0) return null;
        const { min, max } = fitY(points.map((p) => p.usd));
        const t0 = points[0]!.at;
        const t1 = points.at(-1)!.at;
        const xy = points.map(
            (p) =>
                [
                    t1 === t0 ? 0 : ((p.at - t0) / (t1 - t0)) * WIDTH,
                    (1 - (p.usd - min) / (max - min)) * HEIGHT,
                ] as const,
        );
        // One point is drawn as a flat line across.
        const drawn = xy.length === 1 ? [xy[0]!, [WIDTH, xy[0]![1]] as const] : xy;
        const line = smoothPath(drawn);
        return { xy, line, area: `${line}L${WIDTH},${HEIGHT}L0,${HEIGHT}Z` };
    }, [points]);

    if (!chart) return <div className="h-[clamp(160px,28vh,260px)]" />;

    const tone = TONE[changeUsd > 0.005 ? "gain" : changeUsd < -0.005 ? "loss" : "flat"];
    const shown = active ?? points.length - 1;
    const [x, y] = chart.xy[shown]!;

    const point = (clientX: number) => {
        const rect = track.current?.getBoundingClientRect();
        if (!rect || rect.width === 0) return;
        const at = ((clientX - rect.left) / rect.width) * WIDTH;
        let nearest = 0;
        for (let i = 1; i < chart.xy.length; i++)
            if (Math.abs(chart.xy[i]![0] - at) < Math.abs(chart.xy[nearest]![0] - at)) nearest = i;
        onScrub(nearest);
    };

    const onKeyDown = (event: KeyboardEvent) => {
        const last = points.length - 1;
        const at = active ?? last;
        const next = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: last }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        onScrub(Math.min(last, Math.max(0, next)));
    };

    return (
        <div
            ref={track}
            role="slider"
            tabIndex={0}
            aria-label={label}
            aria-valuemin={1}
            aria-valuemax={points.length}
            aria-valuenow={shown + 1}
            aria-valuetext={`${formatAt(points[shown]!.at)}, ${formatUsd(points[shown]!.usd)}`}
            className="relative h-[clamp(160px,28vh,260px)] cursor-crosshair touch-pan-y outline-2 -outline-offset-2 outline-transparent focus-visible:outline-solid"
            onPointerMove={(event) => point(event.clientX)}
            onPointerDown={(event) => point(event.clientX)}
            onPointerLeave={(event) => event.pointerType === "mouse" && onScrub(null)}
            onKeyDown={onKeyDown}
            onBlur={() => onScrub(null)}
        >
            <svg
                viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                preserveAspectRatio="none"
                className="absolute inset-0 block size-full"
                aria-hidden="true"
            >
                <defs>
                    <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={tone} stopOpacity={0.28} />
                        <stop offset="100%" stopColor={tone} stopOpacity={0} />
                    </linearGradient>
                </defs>
                <path d={chart.area} fill={`url(#${gradientId})`} />
                <motion.path
                    d={chart.line}
                    data-line=""
                    fill="none"
                    stroke={tone}
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                    initial={reduce ? false : { opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.5 }}
                />
                {active !== null && (
                    <line
                        x1={x}
                        x2={x}
                        y1={0}
                        y2={HEIGHT}
                        stroke="var(--muted)"
                        strokeOpacity={0.45}
                        strokeWidth={1.5}
                        strokeDasharray="3 4"
                        vectorEffect="non-scaling-stroke"
                    />
                )}
            </svg>
            {/* The dot is a plain element, so the stretched drawing can't squash it; it shows only while scrubbing. */}
            {active !== null && (
                <span
                    aria-hidden="true"
                    className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-panel"
                    style={{
                        left: `clamp(8px, ${(x / WIDTH) * 100}%, calc(100% - 8px))`,
                        top: `clamp(8px, ${(y / HEIGHT) * 100}%, calc(100% - 8px))`,
                        background: tone,
                    }}
                />
            )}
        </div>
    );
}
