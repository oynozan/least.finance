"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type Ref } from "react";
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { ChevronIcon } from "@/components/icons";
import { panelSpring, spring } from "./motion";

export type Scale = { min: number; max: number };

/** Ranges wider than this ratio slide on a log scale, so small amounts aren't crammed into the first pixels. */
const LOG_RATIO = 20;
/** The thumb's size and its inset from the track's edge, in px. */
const THUMB = 44;
const INSET = 6;

const isLog = ({ min, max }: Scale) => min > 0 && max / min > LOG_RATIO;
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** Two significant figures at any size (0.14, 2.3, 47, 1,100), never finer than `decimals` places. */
const stepOf = (value: number, decimals: number) => {
    const finest = 10 ** -decimals;
    return Math.max(finest, 10 ** (Math.floor(Math.log10(Math.max(value, finest))) - 1));
};
const snap = (value: number, decimals: number) => {
    const step = stepOf(value, decimals);
    // Fixed to the places allowed, so 0.14 stays 0.14 rather than 0.14000000000000001
    return Number((Math.round(value / step) * step).toFixed(decimals));
};

/** Where `value` sits along the track, from 0 to 1. */
export function toFraction(scale: Scale, value: number) {
    const { min, max } = scale;
    if (max <= min) return 0;
    const v = clamp(value, min, max);
    return isLog(scale) ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min);
}

/** The value at `fraction` along the track, rounded to a step that suits its size. The ends are exact. */
export function fromFraction(scale: Scale, fraction: number, decimals = 0) {
    const { min, max } = scale;
    const f = clamp(fraction, 0, 1);
    if (f === 0) return min;
    if (f === 1) return max;
    const raw = isLog(scale) ? min * (max / min) ** f : min + (max - min) * f;
    return clamp(snap(raw, decimals), min, max);
}

type SliderProps = {
    scale: Scale;
    /** May sit outside the scale (a typed amount); the thumb then rests at that end. */
    value: number;
    label: string;
    valueText: string;
    /** The places a value may have; small values step by these, so $0.10 to $1 moves a cent at a time. */
    decimals?: number;
    /** The value is out of bounds: the fill takes the loss tone. */
    invalid?: boolean;
    onChange: (value: number) => void;
    /** Told when a drag or a held arrow key starts sliding, before the value it moves to, and when it stops. */
    onScrub?: (active: boolean) => void;
    ref?: Ref<HTMLDivElement>;
};

/**
 * A thick, rounded track with a round thumb. Dragging follows the pointer
 * exactly and reports stepped values; a change from elsewhere (typing)
 * springs the thumb to its place.
 */
export function Slider({ scale, value, label, valueText, decimals = 0, invalid, onChange, onScrub, ref }: SliderProps) {
    const reduce = useReducedMotion();
    const track = useRef<HTMLDivElement>(null);
    const fraction = useMotionValue(toFraction(scale, value));
    const [dragging, setDragging] = useState(false);
    const dragged = useRef(false);
    const disabled = scale.max <= scale.min;

    const left = useTransform(fraction, (f) => `calc(${INSET}px + ${f} * (100% - ${INSET * 2 + THUMB}px))`);
    const fill = useTransform(fraction, (f) => `calc(${f} * (100% - ${INSET * 2 + THUMB}px) + ${INSET + THUMB}px)`);

    const target = toFraction(scale, value);
    const settle = (to: number) => {
        if (reduce) {
            fraction.set(to);
            return;
        }
        return animate(fraction, to, panelSpring);
    };
    // A typed value springs the thumb over; a drag already has it in place.
    useEffect(() => {
        if (dragged.current) return;
        const controls = settle(target);
        return () => controls?.stop();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [target]);

    const fractionAt = (clientX: number) => {
        const rect = track.current!.getBoundingClientRect();
        return clamp((clientX - rect.left - INSET - THUMB / 2) / (rect.width - INSET * 2 - THUMB), 0, 1);
    };

    const drag = (event: PointerEvent<HTMLDivElement>) => {
        const f = fractionAt(event.clientX);
        fraction.set(f);
        onChange(fromFraction(scale, f, decimals));
    };

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (disabled) return;
        const v = clamp(value, scale.min, scale.max);
        const moves: Record<string, () => number> = {
            ArrowRight: () => snap(v + stepOf(v, decimals), decimals),
            ArrowUp: () => snap(v + stepOf(v, decimals), decimals),
            ArrowLeft: () => snap(v - stepOf(v * 0.999, decimals), decimals),
            ArrowDown: () => snap(v - stepOf(v * 0.999, decimals), decimals),
            PageUp: () => fromFraction(scale, toFraction(scale, v) + 0.1, decimals),
            PageDown: () => fromFraction(scale, toFraction(scale, v) - 0.1, decimals),
            Home: () => scale.min,
            End: () => scale.max,
        };
        const move = moves[event.key];
        if (!move) return;
        event.preventDefault();
        onScrub?.(true);
        onChange(clamp(move(), scale.min, scale.max));
    };

    return (
        <div
            ref={(node) => {
                track.current = node;
                if (typeof ref === "function") ref(node);
                else if (ref) ref.current = node;
            }}
            role="slider"
            tabIndex={disabled ? -1 : 0}
            aria-label={label}
            aria-valuemin={scale.min}
            aria-valuemax={scale.max}
            aria-valuenow={clamp(value, scale.min, scale.max)}
            aria-valuetext={valueText}
            aria-disabled={disabled || undefined}
            data-dragging={dragging || undefined}
            className={`group relative h-14 touch-none rounded-full bg-pill outline-2 outline-offset-2 outline-transparent select-none focus-visible:outline-solid ${
                disabled ? "cursor-default opacity-50" : "cursor-grab data-dragging:cursor-grabbing"
            }`}
            onKeyDown={onKeyDown}
            onKeyUp={() => onScrub?.(false)}
            onBlur={() => onScrub?.(false)}
            onPointerDown={(event) => {
                if (disabled || event.button !== 0) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                dragged.current = true;
                setDragging(true);
                onScrub?.(true);
                drag(event);
            }}
            onPointerMove={(event) => {
                if (dragged.current) drag(event);
            }}
            onPointerUp={(event) => {
                if (!dragged.current) return;
                dragged.current = false;
                setDragging(false);
                onScrub?.(false);
                // Into the notch of the stepped value it reported.
                settle(toFraction(scale, fromFraction(scale, fractionAt(event.clientX), decimals)));
            }}
            onPointerCancel={() => {
                dragged.current = false;
                setDragging(false);
                onScrub?.(false);
                settle(target);
            }}
        >
            <motion.span
                aria-hidden="true"
                className={`pointer-events-none absolute inset-y-0 left-0 rounded-full transition-colors duration-200 ${
                    invalid ? "bg-loss/30" : "bg-foreground/15"
                }`}
                style={{ width: disabled ? 0 : fill }}
            />
            <motion.span
                aria-hidden="true"
                className="pointer-events-none absolute top-1.5 flex size-11 items-center justify-center gap-px rounded-full bg-foreground text-background shadow-[0_6px_16px_-6px_rgb(0_0_0/0.6)] group-focus-visible:shadow-[0_0_0_4px_rgb(255_255_255/0.22)]"
                style={{ left }}
                animate={{ scale: dragging ? 1.1 : 1 }}
                transition={spring}
            >
                <ChevronIcon className="size-3 rotate-90 opacity-60" />
                <ChevronIcon className="size-3 -rotate-90 opacity-60" />
            </motion.span>
        </div>
    );
}
