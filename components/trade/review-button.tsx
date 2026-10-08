"use client";

import { useId } from "react";
import { motion, type Transition } from "motion/react";
import { useSidebar } from "@/components/sidebar";
import { useTrade } from "./trade-provider";

const spring: Transition = { type: "spring", visualDuration: 0.35, bounce: 0.45 };

/**
 * Opens the sentence's details in the sidebar. Disabled until every part of
 * the sentence is filled in and valid; the reason is read out.
 */
export function ReviewButton() {
  const { view } = useTrade();
  const { open, view: sidebarView, show, setOpen } = useSidebar();
  const reasonId = useId();
  const disabled = !!view.blocking;
  const reviewing = open && sidebarView === "review";

  return (
    <>
      <motion.button
        type="button"
        aria-disabled={disabled || undefined}
        aria-describedby={disabled ? reasonId : undefined}
        aria-expanded={reviewing}
        aria-controls="wallet-sidebar"
        title={disabled ? view.blocking?.message : undefined}
        className={`h-[52px] rounded-full px-6 text-[17px] font-semibold tracking-[-0.01em] whitespace-nowrap outline-2 outline-offset-2 outline-transparent transition-colors duration-200 focus-visible:outline-solid ${
          disabled ? "cursor-default bg-pill text-muted" : "cursor-pointer bg-gain text-background"
        }`}
        whileHover={disabled ? undefined : { scale: 1.05 }}
        whileTap={disabled ? undefined : { scale: 0.92 }}
        transition={spring}
        onClick={() => {
          if (disabled) return;
          if (reviewing) setOpen(false);
          else show("review");
        }}
      >
        Review
      </motion.button>
      {disabled && view.blocking && (
        <span id={reasonId} className="sr-only">
          {view.blocking.message}
        </span>
      )}
    </>
  );
}
