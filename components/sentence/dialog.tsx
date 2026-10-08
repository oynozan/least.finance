"use client";

import { useRef, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
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
  className?: string;
  children: ReactNode;
};

const subscribe = () => () => {};

/**
 * A centered panel with no backdrop: the overlay is transparent and only
 * catches outside clicks. Escape and an outside click close it; Tab stays
 * inside it.
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

function Panel({ onClose, id, labelledBy, onKeyDown, width = 440, className = "", children }: DialogProps) {
  const isPresent = useIsPresent();
  const reduce = useReducedMotion();
  const panel = useRef<HTMLDivElement>(null);

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
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
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
        style={{ width: `min(100%, ${width}px)` }}
        className={`max-h-[calc(100dvh-32px)] overflow-y-auto rounded-[34px] bg-panel p-2.5 text-foreground shadow-[0_0_0_1px_rgb(255_255_255/0.07),0_28px_70px_-12px_rgb(0_0_0/0.7)] outline-none [scrollbar-width:none] ${className}`}
        initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.85, y: 24 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.92, y: 12 }}
        transition={panelSpring}
        onKeyDown={handleKeyDown}
      >
        {children}
      </motion.div>
    </div>
  );
}
