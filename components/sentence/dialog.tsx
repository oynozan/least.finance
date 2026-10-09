"use client";

import {
    useLayoutEffect,
    useRef,
    useState,
    useSyncExternalStore,
    type KeyboardEvent,
    type ReactNode,
    type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
import { panelSpring } from "./motion";

type DialogProps = {
    open: boolean;
    onClose: () => void;
    id?: string;
    labelledBy: string;
    /** Extra key handling inside the panel (arrow keys, typeahead...). */
    onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
    /** The panel's width in px; it never exceeds the viewport. */
    width?: number;
    /** Drops the panel down from this element (or up, where there's more room) instead of centering it. */
    anchor?: RefObject<HTMLElement | null>;
    className?: string;
    children: ReactNode;
};

const subscribe = () => () => {};

/**
 * A panel with no backdrop, centered or dropped down from an anchor: the
 * overlay is transparent and only catches outside clicks. Escape and an
 * outside click close it; Tab stays inside it.
 */
export function FloatingDialog(props: DialogProps) {
    const isClient = useSyncExternalStore(
        subscribe,
        () => true,
        () => false,
    );
    if (!isClient) return null;
    return createPortal(
        <AnimatePresence>{props.open && <Panel key="panel" {...props} />}</AnimatePresence>,
        document.body,
    );
}

const FOCUSABLE = 'button:not([tabindex="-1"]), input, [tabindex="0"]';

/** Space kept between the panel and the anchor, and the viewport's edges. */
const GAP = 10;
const EDGE = 16;
/** A guess at the panel's height, until it has rendered and can be measured. */
const TYPICAL_HEIGHT = 300;

type Placement = { left: number; width: number; maxHeight: number } & (
    { top: number; bottom?: undefined } | { bottom: number; top?: undefined }
);

/** Under the anchor, centered on it and kept on screen; above it when it only fits there, or fits better. */
function place(anchor: HTMLElement, width: number, height = TYPICAL_HEIGHT): Placement {
    const rect = anchor.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const w = Math.min(width, vw - EDGE * 2);
    const left = Math.min(Math.max(rect.left + rect.width / 2 - w / 2, EDGE), vw - EDGE - w);
    const below = vh - rect.bottom - GAP - EDGE;
    const above = rect.top - GAP - EDGE;
    if (height <= below || below >= above) return { left, width: w, top: rect.bottom + GAP, maxHeight: below };
    return { left, width: w, bottom: vh - rect.top + GAP, maxHeight: above };
}

function Panel({ onClose, id, labelledBy, onKeyDown, width = 440, anchor, className = "", children }: DialogProps) {
    const isPresent = useIsPresent();
    const reduce = useReducedMotion();
    const panel = useRef<HTMLDivElement>(null);
    // Placed as it mounts (the panel only renders in the browser), then once
    // more with its measured height before the first paint, and on resize.
    const [placement, setPlacement] = useState<Placement | null>(() =>
        anchor?.current ? place(anchor.current, width) : null,
    );
    useLayoutEffect(() => {
        const element = anchor?.current;
        if (!element) return;
        const update = () => setPlacement(place(element, width, panel.current?.scrollHeight));
        update();
        window.addEventListener("resize", update);
        return () => window.removeEventListener("resize", update);
    }, [anchor, width]);
    const up = placement?.bottom !== undefined;

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Escape") {
            // Closes only this panel, not the sidebar behind it.
            event.preventDefault();
            event.stopPropagation();
            onClose();
            return;
        }
        if (event.key === "Tab") {
            const focusable = [...(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
            const index = focusable.indexOf(document.activeElement as HTMLElement);
            event.preventDefault();
            if (focusable.length > 1) {
                const next = (index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length;
                focusable[next]?.focus();
            }
            return;
        }
        onKeyDown?.(event);
    };

    return (
        <div
            className={`fixed inset-0 z-50 ${anchor ? "" : "flex items-center justify-center p-4"}`}
            style={isPresent ? undefined : { pointerEvents: "none" }}
            onPointerDown={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <motion.div
                ref={panel}
                id={id}
                role="dialog"
                aria-modal="true"
                aria-labelledby={labelledBy}
                tabIndex={-1}
                data-floating-dialog=""
                data-closing={isPresent ? undefined : ""}
                style={
                    anchor
                        ? {
                              position: "absolute",
                              left: placement?.left,
                              top: placement?.top,
                              bottom: placement?.bottom,
                              width: placement?.width ?? width,
                              maxHeight: placement?.maxHeight,
                              // Grows out of the pill it drops from.
                              transformOrigin: up ? "50% 100%" : "50% 0%",
                              visibility: placement ? undefined : "hidden",
                          }
                        : { width: `min(100%, ${width}px)` }
                }
                className={`max-h-[calc(100dvh-32px)] overflow-y-auto rounded-[34px] bg-panel p-2.5 text-foreground shadow-[0_0_0_1px_rgb(255_255_255/0.07),0_28px_70px_-12px_rgb(0_0_0/0.7)] outline-none [scrollbar-width:none] ${className}`}
                initial={
                    reduce
                        ? { opacity: 0 }
                        : anchor
                          ? { opacity: 0, scale: 0.8, y: up ? 12 : -12 }
                          : { opacity: 0, scale: 0.85, y: 24 }
                }
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={
                    reduce
                        ? { opacity: 0 }
                        : anchor
                          ? { opacity: 0, scale: 0.9, y: up ? 8 : -8 }
                          : { opacity: 0, scale: 0.92, y: 12 }
                }
                transition={panelSpring}
                onKeyDown={handleKeyDown}
            >
                {children}
            </motion.div>
        </div>
    );
}
