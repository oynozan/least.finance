"use client";

import { useState } from "react";
import { MotionConfig, motion, type Variants } from "motion/react";
import { submitIntent } from "@/lib/trade/execute";
import { CloseIcon } from "@/components/icons";
import { spring } from "@/components/sentence/motion";
import { useSidebar } from "@/components/sidebar";
import { useTrade } from "./trade-provider";
import { TransactionPreview } from "./transaction-preview";

/** The confirm button while no wallet is connected. */
const CONNECT: Record<string, string> = {
  swap: "Connect to swap",
  buy: "Connect to buy",
  sell: "Connect to sell",
  long: "Connect to go long",
  short: "Connect to go short",
  predict: "Connect to predict",
};

const sections: Variants = {
  hidden: {},
  // Delayed so the content rises once the panel has mostly arrived.
  shown: { transition: { staggerChildren: 0.04, delayChildren: 0.14 } },
};

const rise: Variants = {
  hidden: { opacity: 0, y: 14 },
  shown: { opacity: 1, y: 0, transition: { type: "spring", visualDuration: 0.32, bounce: 0.2 } },
};

/** The sidebar's review view: the sentence's details, and the confirm step. */
export function ReviewPanel() {
  const { open, view: sidebarView, setOpen } = useSidebar();
  const showing = open && sidebarView === "review";

  // Remount on every opening, so the entrance replays and an earlier
  // "nothing was sent" doesn't linger.
  const [openings, setOpenings] = useState(0);
  const [wasShowing, setWasShowing] = useState(showing);
  if (showing !== wasShowing) {
    setWasShowing(showing);
    if (showing) setOpenings((n) => n + 1);
  }

  return (
    <MotionConfig reducedMotion="user">
      <header className="flex items-center gap-2 pt-[18px] pr-[18px] pl-[22px]">
        <p className="flex-1 text-sm font-medium text-muted">Review</p>
        <motion.button
          type="button"
          aria-label="Close review"
          title="Close review"
          className="grid size-9 cursor-pointer place-items-center rounded-full bg-pill text-muted outline-2 outline-transparent transition-colors hover:bg-pill-hover hover:text-foreground focus-visible:bg-pill-hover focus-visible:text-foreground focus-visible:outline-solid"
          whileHover={{ scale: 1.08 }}
          whileTap={{ scale: 0.9 }}
          transition={spring}
          onClick={() => setOpen(false)}
        >
          <CloseIcon className="size-4" />
        </motion.button>
      </header>
      <ReviewBody key={openings} showing={showing} onDone={() => setOpen(false)} />
    </MotionConfig>
  );
}

function ReviewBody({ showing, onDone }: { showing: boolean; onDone: () => void }) {
  const { view, wallet } = useTrade();
  const [sent, setSent] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const intentKey = JSON.stringify(view.intent);
  // A change to the sentence after confirming starts the review over.
  const done = sent !== null && sent === intentKey;
  const notice = view.blocking ?? view.issues.find((issue) => issue.severity === "warning");

  const confirm = async () => {
    if (done) return onDone();
    if (wallet.status === "disconnected") return wallet.connect();
    if (!view.intent || view.blocking) return;
    setSending(true);
    await submitIntent(view.intent);
    setSending(false);
    setSent(intentKey);
  };

  const label = done
    ? "Done"
    : wallet.status === "disconnected"
      ? (CONNECT[view.verb.id] ?? "Connect")
      : view.blocking
        ? (view.blocking.cta ?? view.cta)
        : view.cta.replace(/^Review/, "Confirm");
  const blocked = !done && wallet.status !== "disconnected" && (!!view.blocking || wallet.status === "loading");

  return (
    <motion.div
      className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-[22px] pt-8 pb-6 [scrollbar-width:none]"
      variants={sections}
      initial="hidden"
      animate={showing ? "shown" : "hidden"}
    >
      <motion.p
        variants={rise}
        className="text-[28px] leading-[1.25] font-medium tracking-[-0.02em] text-balance"
      >
        {view.text}
      </motion.p>

      {done ? (
        <motion.div variants={rise} initial="hidden" animate="shown" role="status" className="flex flex-col gap-3">
          <p className="text-[17px] leading-snug">Trading isn&apos;t live yet, so nothing was sent. This is the request it would make:</p>
          <pre className="overflow-x-auto rounded-2xl bg-pill px-4 py-3 text-[13px] leading-relaxed text-muted">
            {JSON.stringify(view.intent, null, 2)}
          </pre>
        </motion.div>
      ) : (
        <motion.div variants={rise}>
          <TransactionPreview preview={view.preview} />
        </motion.div>
      )}

      {!done && notice && (
        <motion.p
          variants={rise}
          className={`text-[15px] leading-snug ${
            notice.severity === "warning" ? "text-[#f7d15b]" : notice.severity === "error" ? "text-loss" : "text-muted"
          }`}
        >
          {notice.message}
        </motion.p>
      )}

      {!done && wallet.status === "disconnected" && (
        <motion.p variants={rise} className="text-[15px] text-muted">
          Connect a wallet to check your balance.
        </motion.p>
      )}

      <motion.div variants={rise} className="mt-auto pt-2">
        <motion.button
          type="button"
          aria-disabled={blocked || undefined}
          disabled={sending}
          className={`h-14 w-full rounded-full text-[17px] font-semibold tracking-[-0.01em] outline-2 outline-offset-2 outline-transparent transition-colors focus-visible:outline-solid ${
            blocked ? "cursor-default bg-pill text-muted" : "cursor-pointer bg-gain text-background"
          }`}
          whileHover={blocked ? undefined : { scale: 1.02 }}
          whileTap={blocked ? undefined : { scale: 0.97 }}
          transition={spring}
          onClick={confirm}
        >
          {label}
        </motion.button>
      </motion.div>
    </motion.div>
  );
}
