"use client";

import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    useSyncExternalStore,
    type ReactNode,
    type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
import { panelSpring } from "./motion";

/** Hover this long before a card opens. */
const OPEN_DELAY_MS = 160;
/** Within this long of a card closing, the next one opens at once, so moving pill to pill doesn't wait. */
const WARM_MS = 600;
/** Leaving the pill waits this long, so the pointer can cross the gap onto the card. */
const CLOSE_DELAY_MS = 120;

/** When any card last closed. */
let lastClosedAt = -Infinity;
/** Closes the card open now; opening another calls it, so only one shows at a time. */
let closeOpen: { current: () => void } | null = null;

/** Where the pointer last really was, so a hover the page's own change reports under a still pointer can be told from a move. */
let pointerAt: { x: number; y: number } | null = null;
let tracking = false;
function trackPointer() {
    if (tracking) return;
    tracking = true;
    const record = (event: PointerEvent) => {
        pointerAt = { x: event.clientX, y: event.clientY };
    };
    for (const type of ["pointermove", "pointerdown", "pointerup"] as const)
        window.addEventListener(type, record, { capture: true, passive: true });
}

/**
 * Hover intent for a pill and its card: open after a short hover (at once
 * right after another card closed), close a moment after the pointer is over
 * neither, and at once on Escape. The pill and the card report separately,
 * since Motion tells of the pill's hover ending a frame late: by then a quick
 * pointer may already be on the card. After the pill's picker closes, the
 * card waits for the pointer to move: the browser reports a pointer resting
 * on the pill as a fresh hover once the picker's overlay is gone.
 */
export function useHoverIntent() {
    const [shown, setShown] = useState(false);
    const isShown = useRef(false);
    const over = useRef({ pill: false, card: false });
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const close = useRef<() => void>(() => undefined);
    /** Set while held after a picker closed: stops waiting for the pointer to move. */
    const held = useRef<(() => void) | null>(null);

    const show = useCallback((next: boolean) => {
        clearTimeout(timer.current);
        if (next && closeOpen && closeOpen !== close) closeOpen.current();
        if (next) closeOpen = close;
        else if (closeOpen === close) closeOpen = null;
        if (isShown.current && !next) lastClosedAt = performance.now();
        // A card that goes away under the pointer never reports the pointer leaving it
        if (!next) over.current.card = false;
        isShown.current = next;
        setShown(next);
    }, []);
    useEffect(() => {
        close.current = () => show(false);
    }, [show]);

    const update = useCallback(() => {
        clearTimeout(timer.current);
        if (over.current.pill || over.current.card) {
            if (isShown.current || held.current) return;
            if (performance.now() - lastClosedAt < WARM_MS) show(true);
            else timer.current = setTimeout(() => show(true), OPEN_DELAY_MS);
        } else timer.current = setTimeout(() => show(false), isShown.current ? CLOSE_DELAY_MS : 0);
    }, [show]);

    const pill = useCallback(
        (hovered: boolean) => {
            over.current.pill = hovered;
            update();
        },
        [update],
    );
    const card = useCallback(
        (hovered: boolean) => {
            over.current.card = hovered;
            update();
        },
        [update],
    );

    /** Hides the card until the pointer moves from where it rested, for when the pill's picker has just closed. */
    const hold = useCallback(() => {
        show(false);
        held.current?.();
        const from = pointerAt;
        const onMove = (event: PointerEvent) => {
            if (from && event.clientX === from.x && event.clientY === from.y) return;
            release();
            update();
        };
        const release = () => {
            window.removeEventListener("pointermove", onMove, true);
            held.current = null;
        };
        window.addEventListener("pointermove", onMove, { capture: true, passive: true });
        held.current = release;
    }, [show, update]);

    useEffect(trackPointer, []);

    useEffect(() => {
        if (!shown) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") show(false);
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [shown, show]);

    useEffect(
        () => () => {
            clearTimeout(timer.current);
            held.current?.();
            if (closeOpen === close) closeOpen = null;
        },
        [],
    );

    return { shown, pill, card, hold, hide: useCallback(() => show(false), [show]) };
}

const subscribe = () => () => {};

type HoverCardProps = {
    open: boolean;
    /** The pill the card belongs to. */
    anchor: RefObject<HTMLElement | null>;
    /** The card's width in px; it never exceeds the viewport. */
    width?: number;
    onPointerEnter?: () => void;
    onPointerLeave?: () => void;
    children: ReactNode;
};

/**
 * A card that springs out of a pill on hover, above it, or below it when the
 * pill is on the sentence's last line (so the card covers none of the
 * sentence), and on whichever side fits when the preferred one doesn't,
 * within the viewport and clear of anything marked `data-keep-clear`.
 * A visual preview for pointer users, so nothing in it takes focus. It has
 * no padding of its own: the content can run to its rounded edges.
 */
export function HoverCard(props: HoverCardProps) {
    const isClient = useSyncExternalStore(
        subscribe,
        () => true,
        () => false,
    );
    if (!isClient) return null;
    return createPortal(
        <AnimatePresence>{props.open && <Card key="card" {...props} />}</AnimatePresence>,
        document.body,
    );
}

/** Space kept between the card and the pill, and the viewport's edges. */
const GAP = 12;
const EDGE = 16;
/** A guess at the card's height, until it has rendered and can be measured. */
const TYPICAL_HEIGHT = 240;

type Side = "above" | "below";
type Placement = { left: number; top: number; width: number; side: Side; originX: number; maxHeight: number };

function place(anchor: HTMLElement, width: number, height: number): Placement {
    const rect = anchor.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const w = Math.min(width, vw - EDGE * 2);
    const left = Math.min(Math.max(rect.left + rect.width / 2 - w / 2, EDGE), vw - EDGE - w);
    // Bars marked to keep clear of (the dock, the wallet button) bound the card wherever they're in its column
    let ceiling = EDGE;
    let floor = vh - EDGE;
    for (const bar of document.querySelectorAll("[data-keep-clear]")) {
        const box = bar.getBoundingClientRect();
        if (box.right <= left || box.left >= left + w) continue;
        if (box.top >= rect.bottom) floor = Math.min(floor, box.top - GAP);
        else if (box.bottom <= rect.top) ceiling = Math.max(ceiling, box.bottom + GAP);
    }
    const sentence = anchor.closest("[data-sentence]")?.getBoundingClientRect();
    const lastLine = sentence !== undefined && rect.bottom > sentence.bottom - rect.height / 2;
    const room = { above: rect.top - GAP - ceiling, below: floor - rect.bottom - GAP };
    const preferred: Side = lastLine ? "below" : "above";
    const other: Side = preferred === "above" ? "below" : "above";
    const side =
        room[preferred] >= height
            ? preferred
            : room[other] >= height || room[other] > room[preferred]
              ? other
              : preferred;
    // A card taller than its side's room is cut short there, never laid over its pill
    const shown = Math.min(height, Math.max(room[side], 0));
    const top = side === "above" ? rect.top - GAP - shown : rect.bottom + GAP;
    return {
        left,
        top,
        maxHeight: shown,
        width: w,
        side,
        // Grows out of the pill's middle, wherever the card was clamped to
        originX: rect.left + rect.width / 2 - left,
    };
}

const samePlacement = (a: Placement | null, b: Placement) =>
    !!a &&
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.side === b.side &&
    a.originX === b.originX &&
    a.maxHeight === b.maxHeight;

function Card({ anchor, width = 300, onPointerEnter, onPointerLeave, children }: HoverCardProps) {
    const isPresent = useIsPresent();
    const reduce = useReducedMotion();
    const card = useRef<HTMLDivElement>(null);
    // Placed as it mounts, then with its measured height before the first
    // paint, and again whenever the window scrolls or resizes.
    const [placement, setPlacement] = useState<Placement | null>(() =>
        anchor.current ? place(anchor.current, width, TYPICAL_HEIGHT) : null,
    );
    useLayoutEffect(() => {
        const element = anchor.current;
        if (!element) return;
        const update = () => {
            const next = place(element, width, card.current?.scrollHeight ?? TYPICAL_HEIGHT);
            setPlacement((current) => (samePlacement(current, next) ? current : next));
        };
        update();
        window.addEventListener("resize", update);
        window.addEventListener("scroll", update, true);
        const observer = new ResizeObserver(update);
        if (card.current) observer.observe(card.current);
        return () => {
            window.removeEventListener("resize", update);
            window.removeEventListener("scroll", update, true);
            observer.disconnect();
        };
    }, [anchor, width]);
    const above = placement?.side !== "below";

    return (
        <motion.div
            ref={card}
            data-hover-card=""
            data-closing={isPresent ? undefined : ""}
            data-side={placement?.side}
            aria-hidden="true"
            style={{
                left: placement?.left,
                top: placement?.top,
                width: placement?.width ?? width,
                maxHeight: placement?.maxHeight,
                transformOrigin: `${placement?.originX ?? width / 2}px ${above ? "100%" : "0%"}`,
                visibility: placement ? undefined : "hidden",
                // A leaving card never blocks the pill or card that replaces it.
                pointerEvents: isPresent ? undefined : "none",
            }}
            className="fixed z-50 overflow-hidden rounded-[30px] bg-panel text-foreground shadow-[0_0_0_1px_rgb(255_255_255/0.07),0_28px_70px_-12px_rgb(0_0_0/0.7)]"
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.85, y: above ? 10 : -10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.92, y: above ? 6 : -6 }}
            transition={panelSpring}
            onPointerEnter={onPointerEnter}
            onPointerLeave={onPointerLeave}
        >
            {children}
        </motion.div>
    );
}
