"use client";

import { useId } from "react";
import { motion, type Transition } from "motion/react";
import { useSidebar } from "@/components/sidebar";
import { dockAction } from "@/lib/trade/dock-action";
import { useTrade } from "./trade-provider";

const spring: Transition = { type: "spring", visualDuration: 0.35, bounce: 0.45 };

/**
 * The dock's button. It opens the sentence's details in the sidebar; while a
 * problem blocks the sentence it says the way out instead ("Not enough USDC")
 * and opens the pill that holds it, or, where no pill does, can't be pressed.
 * The problem's wording is its description, read out and shown on hover.
 */
export function ReviewButton() {
    const { view, openSlot } = useTrade();
    const { open, view: sidebarView, show, setOpen } = useSidebar();
    const reasonId = useId();
    const action = dockAction(view);
    const reviewing = open && sidebarView === "review";
    const blocked = action.kind === "blocked";

    return (
        <>
            <motion.button
                type="button"
                aria-disabled={blocked || undefined}
                aria-describedby={action.kind === "review" ? undefined : reasonId}
                aria-expanded={action.kind === "review" ? reviewing : undefined}
                aria-controls={action.kind === "review" ? "wallet-sidebar" : undefined}
                aria-haspopup={action.kind === "open" ? "dialog" : undefined}
                title={action.kind === "review" ? undefined : action.message}
                data-action={action.kind}
                // One line always: where a phone has no room for all of a long way out, it ends in an ellipsis, and the
                // description says it whole. Sliding open, it keeps its width and the dock's edge reveals it.
                className={`h-12 min-w-0 rounded-full px-4 text-[15px] leading-[1.3] font-semibold tracking-[-0.01em] whitespace-nowrap outline-2 outline-offset-2 outline-transparent transition-colors duration-200 group-data-[sliding]/review:shrink-0 focus-visible:outline-solid sm:px-6 sm:text-[17px] ${
                    blocked
                        ? "cursor-default bg-pill text-muted"
                        : action.kind === "open"
                          ? "cursor-pointer bg-loss text-background"
                          : "cursor-pointer bg-gain text-background"
                }`}
                whileHover={blocked ? undefined : { scale: 1.05 }}
                whileTap={blocked ? undefined : { scale: 0.92 }}
                transition={spring}
                onClick={() => {
                    if (action.kind === "blocked") return;
                    if (action.kind === "open") return openSlot(action.slot);
                    if (reviewing) setOpen(false);
                    else show("review");
                }}
            >
                <span className="block truncate">{action.kind === "review" ? "Review" : action.label}</span>
            </motion.button>
            {action.kind !== "review" && (
                <span id={reasonId} className="sr-only">
                    {action.message}
                </span>
            )}
        </>
    );
}
