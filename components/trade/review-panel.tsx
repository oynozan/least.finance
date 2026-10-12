"use client";

import { useEffect, useRef, useState } from "react";
import { MotionConfig, motion, type Variants } from "motion/react";
import { confirmedTrades } from "@/lib/trade/activity";
import { submitIntent } from "@/lib/trade/execute";
import { quoteRows } from "@/lib/trade/prediction-quote";
import type { QuoteView } from "@/server/src/protocol";
import { useAccount } from "@/components/account-provider";
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

const QUOTE_DEBOUNCE_MS = 300;
const QUOTE_REFRESH_MS = 10_000;

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

    // A prediction refused once the sidebar is closed would go unseen, so the wallet opens on its notice.
    const { tradeNotice } = useAccount();
    const shownNotice = useRef<object | null>(null);
    useEffect(() => {
        if (!tradeNotice || tradeNotice === shownNotice.current) return;
        shownNotice.current = tradeNotice;
        if (!open) setOpen(true);
    }, [tradeNotice, open, setOpen]);

    // Remount on every opening, so the entrance replays and an earlier
    // "nothing was sent" doesn't linger. Closing leaves the content as it is,
    // so it slides away whole.
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
            <ReviewBody key={openings} onDone={() => setOpen(false)} />
        </MotionConfig>
    );
}

function ReviewBody({ onDone }: { onDone: () => void }) {
    const { view, wallet, catalog, maxOrderUSD } = useTrade();
    const account = useAccount();
    const [sent, setSent] = useState<string | null>(null);
    const [sending, setSending] = useState(false);
    const [placed, setPlaced] = useState(false);
    // The server's refusal of the prediction just confirmed; the notice itself clears after a few seconds.
    const [refusal, setRefusal] = useState<string | null>(null);
    const refused = account.tradeNotice?.message ?? null;
    if (placed && refused && refused !== refusal) setRefusal(refused);
    const [quoted, setQuoted] = useState<QuoteView | null>(null);
    const intentKey = JSON.stringify(view.intent);
    // A change to the sentence after confirming starts the review over.
    const done = sent !== null && sent === intentKey;
    const notice = view.blocking ?? view.issues.find((issue) => issue.severity === "warning");

    // A prediction is placed for real once signed in with the server's trading on.
    const intent = view.intent;
    const prediction = intent?.type === "prediction" ? intent : null;
    const live = !!prediction && wallet.status === "connected" && maxOrderUSD !== null;
    const market =
        prediction &&
        (catalog.markets.find((m) => m.id === prediction.marketId) ?? catalog.findMarket(prediction.marketId));
    const outcome = market?.outcomes.find((o) => o.id === prediction?.outcomeId);
    const eventId = prediction && live && !view.blocking ? prediction.marketId : null;
    const tokenId = prediction?.outcomeId;
    const amountUSD = prediction?.amountUSD;
    // The provider hands over a new function each render; the effect must not restart on it.
    const ask = useRef(account.quotePrediction);
    useEffect(() => {
        ask.current = account.quotePrediction;
    });
    const asked = useRef(false);
    useEffect(() => {
        if (!eventId || !tokenId || !amountUSD) return;
        let current = true;
        const refresh = () =>
            void ask.current({ eventId, tokenId, amountUSD }).then((result) => {
                if (current) setQuoted("shares" in result ? result : null);
            });
        // The first quote comes as the panel opens; a later amount waits for typing to settle.
        const first = setTimeout(refresh, asked.current ? QUOTE_DEBOUNCE_MS : 0);
        asked.current = true;
        const timer = setInterval(refresh, QUOTE_REFRESH_MS);
        return () => {
            current = false;
            clearTimeout(first);
            clearInterval(timer);
        };
    }, [eventId, tokenId, amountUSD]);
    // Only a quote for the amount on screen; a stale one would show the wrong cost.
    const quote =
        quoted && quoted.tokenId === tokenId && Number(quoted.amountUSD) === Number(amountUSD) ? quoted : null;
    const other = market?.outcomes.length === 2 ? market.outcomes.find((o) => o.id !== outcome?.id) : undefined;
    const preview =
        live && quote && outcome
            ? { ...view.preview, rows: quoteRows(quote, outcome.label, other?.label, outcome.chance) }
            : view.preview;

    const confirm = async () => {
        if (done) return onDone();
        if (wallet.status === "disconnected") return wallet.connect();
        if (!view.intent || view.blocking) return;
        if (live && prediction && market && outcome) {
            // Counted at once; a refusal replaces the done line here, or opens the sidebar if this is closed by then.
            const estimate = (Number(prediction.amountUSD) / outcome.price).toFixed(6).replace(/\.?0+$/, "");
            const result = account.placePrediction({
                eventId: prediction.marketId,
                tokenId: prediction.outcomeId,
                amountUSD: prediction.amountUSD,
                quotedPrice: quote?.worstPrice ?? outcome.price,
                question: market.question,
                outcome: outcome.label,
                shares: quote?.shares ?? estimate,
            });
            setPlaced(result.sent);
            setSent(intentKey);
            return;
        }
        setSending(true);
        await submitIntent(view.intent);
        // Listed on the PnL page, marked as not sent.
        confirmedTrades.add(view.intent);
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
            animate="shown"
        >
            <motion.p
                variants={rise}
                className="text-[28px] leading-[1.25] font-medium tracking-[-0.02em] text-balance"
            >
                {view.text}
            </motion.p>

            {done ? (
                <motion.div
                    variants={rise}
                    initial="hidden"
                    animate="shown"
                    role="status"
                    className="flex flex-col gap-3"
                >
                    {refusal ? (
                        <p className="text-[17px] leading-snug text-loss">{refusal}</p>
                    ) : placed ? (
                        <p className="text-[17px] leading-snug">Prediction placed.</p>
                    ) : live && prediction ? (
                        <p className="text-[17px] leading-snug">Nothing was sent.</p>
                    ) : (
                        <>
                            <p className="text-[17px] leading-snug">
                                Trading isn&apos;t live yet, so nothing was sent. This is the request it would make:
                            </p>
                            <pre className="overflow-x-auto rounded-2xl bg-pill px-4 py-3 text-[13px] leading-relaxed text-muted">
                                {JSON.stringify(view.intent, null, 2)}
                            </pre>
                        </>
                    )}
                </motion.div>
            ) : (
                <motion.div variants={rise}>
                    <TransactionPreview preview={preview} />
                </motion.div>
            )}

            {!done && notice && (
                <motion.p
                    variants={rise}
                    className={`text-[15px] leading-snug ${
                        notice.severity === "warning"
                            ? "text-[#f7d15b]"
                            : notice.severity === "error"
                              ? "text-loss"
                              : "text-muted"
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
