"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MotionConfig, motion, type Transition, type Variants } from "motion/react";
import { submitIntent } from "@/lib/trade/execute";
import { formatUnits, formatUsd } from "@/lib/trade/format";
import type { TransactionIntent } from "@/lib/trade/intent";
import { quoteRows as perpQuoteRows } from "@/lib/trade/perp-quote";
import { quoteRows } from "@/lib/trade/prediction-quote";
import { askOf, lessSpread } from "@/lib/trade/spread";
import { isSpotIntent, toTradeRequest } from "@/lib/trade/spot-request";
import type { TradeOrderRequest } from "@/server/src/trading/types";
import type { ApiError, PerpQuoteRequest, PerpQuoteView, QuoteView } from "@/server/src/protocol";
import { OFFLINE_COPY, type Placed } from "@/components/account-client";
import { useAccount } from "@/components/account-provider";
import { CloseIcon } from "@/components/icons";
import { ProgressGlyph, useProgressFill, type ProgressPhase } from "@/components/progress-fill";
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

/** About how long the server takes to answer an order; the button's fill eases toward 90% over it. */
const ORDER_EXPECTED_MS = 1_200;
/** How long the answer stays on the button before it settles back. */
const DONE_FLASH_MS = 900;
const ERROR_FLASH_MS = 1_200;
/** How long a filled order's check shows before the wallet takes over. */
const WALLET_AFTER_MS = 700;

// The palette's gain, pill, pill-hover, background, foreground and muted, as literals Motion can tween between.
const READY = "rgb(104 214 112)";
const BLOCKED = "rgb(43 43 41)";
const BUSY = "rgb(53 53 50)";
const DARK = "rgb(23 23 23)";
const LIGHT = "rgb(245 245 243)";
const MUTED = "rgb(143 143 138)";

const glyphSlot: Transition = { type: "spring", visualDuration: 0.3, bounce: 0.2 };

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
    const { open, view: sidebarView, setOpen, show } = useSidebar();
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
            {/* Done hands over to the wallet, where what the order did already shows. */}
            <ReviewBody key={openings} showing={showing} onDone={() => show("wallet")} />
        </MotionConfig>
    );
}

/** What a confirmed trade did, at the prices shown and the spread. */
function tradeOutcome(req: TradeOrderRequest): string {
    const price = Number(req.quotedPriceUSD);
    if (req.verb === "buy") return `Bought ≈ ${formatUnits(Number(req.amountUSD) / askOf(price), req.symbol)}.`;
    const units = Number(req.units);
    if (req.verb === "sell")
        return `Sold ${formatUnits(units, req.symbol)} for ≈ ${formatUsd(lessSpread(units * price))}.`;
    const got = lessSpread(units * price) / Number(req.quotedToPriceUSD);
    return `Swapped ${formatUnits(units, req.symbol)} for ≈ ${formatUnits(got, req.toSymbol ?? "")}.`;
}

/**
 * The confirm button, shared by every action the panel ends with. While an order waits on the server it doubles
 * as a progress bar, like the deposit button: a fill sweeps across, then a check or a red shake gives the answer.
 */
function ActionButton({
    label,
    blocked = false,
    disabled = false,
    phase = "idle",
    onClick,
}: {
    label: string;
    blocked?: boolean;
    disabled?: boolean;
    phase?: ProgressPhase;
    onClick: () => void;
}) {
    const { fill, button } = useProgressFill(phase, ORDER_EXPECTED_MS);
    const busy = phase === "running";
    const still = blocked || busy;
    return (
        <motion.button
            ref={button}
            type="button"
            aria-disabled={blocked || undefined}
            aria-busy={busy || undefined}
            disabled={disabled}
            className={`relative flex h-14 w-full items-center justify-center overflow-hidden rounded-full text-[17px] font-semibold tracking-[-0.01em] outline-2 outline-offset-2 outline-transparent focus-visible:outline-solid ${
                still ? "cursor-default" : "cursor-pointer"
            }`}
            initial={false}
            // Gray while it waits, so the fill reads against it; green again once it settles.
            animate={{
                backgroundColor: blocked ? BLOCKED : phase === "idle" ? READY : BUSY,
                color: blocked ? MUTED : phase === "idle" || phase === "done" ? DARK : LIGHT,
            }}
            whileHover={still ? undefined : { scale: 1.02 }}
            whileTap={still ? undefined : { scale: 0.97 }}
            transition={{ ...spring, backgroundColor: { duration: 0.25 }, color: { duration: 0.25 } }}
            onClick={onClick}
        >
            <span
                ref={fill}
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 origin-left rounded-[inherit] opacity-0"
            />
            {/* The glyph's room opens beside the label only while there is a glyph to show. */}
            <motion.span
                aria-hidden="true"
                className="relative h-3.5 shrink-0"
                initial={false}
                animate={phase === "idle" ? { width: 0, marginRight: 0 } : { width: 14, marginRight: 10 }}
                transition={glyphSlot}
            >
                <ProgressGlyph phase={phase} />
            </motion.span>
            <span className="relative">{label}</span>
        </motion.button>
    );
}

type PerpAnswer = { key: string; quote: PerpQuoteView } | { key: string; error: string };
/** The server's answer to a prediction quote: the quote, or the refusal an order this size would meet too. */
type QuoteAnswer = { tokenId: string; amountUSD: string; quote: QuoteView | null; refusal: string | null };

/** A quote refusal that would refuse the order as well, in the words the review shows; other failures only drop the quote. */
function quoteRefusal(error: ApiError): string | null {
    if (error.code === "below_minimum") return error.message;
    if (error.code === "market_closed") return "This market just closed.";
    return null;
}

function ReviewBody({ showing, onDone }: { showing: boolean; onDone: () => void }) {
    const { view, wallet, catalog, maxOrderUSD } = useTrade();
    const account = useAccount();
    const [sent, setSent] = useState<string | null>(null);
    const [sending, setSending] = useState(false);
    const [notExecuted, setNotExecuted] = useState<string | null>(null);
    // What the trade just confirmed came to, in the words the done line uses.
    const [summary, setSummary] = useState<string | null>(null);
    const [accepted, setAccepted] = useState(false);
    // Waiting on the server's answer to the order just confirmed.
    const [placing, setPlacing] = useState(false);
    // The answer, shown on the button for a moment.
    const [flash, setFlash] = useState<"done" | "error" | null>(null);
    useEffect(() => {
        if (!flash) return;
        const timer = setTimeout(() => setFlash(null), flash === "done" ? DONE_FLASH_MS : ERROR_FLASH_MS);
        return () => clearTimeout(timer);
    }, [flash]);
    // The server's refusal of the order just confirmed; the notice itself clears after a few seconds.
    const [refusal, setRefusal] = useState<string | null>(null);
    // An accepted order that fails later (a prediction that doesn't fill, a rejected perp) is told as the notice.
    const refused = account.tradeNotice?.message ?? null;
    if (accepted && refused && refused !== refusal) setRefusal(refused);
    // Each confirm's answer is shown only while it is the latest.
    const attempt = useRef(0);
    const follow = (placed: Placed) => {
        const mine = ++attempt.current;
        setRefusal(placed.sent ? null : OFFLINE_COPY);
        setAccepted(false);
        setPlacing(placed.sent);
        setFlash(placed.sent ? null : "error");
        if (!placed.sent) return;
        void placed.answer.then((message) => {
            if (attempt.current !== mine) return;
            setPlacing(false);
            setFlash(message ? "error" : "done");
            if (message) setRefusal(message);
            else setAccepted(true);
        });
    };
    const [quoteAnswer, setQuoteAnswer] = useState<QuoteAnswer | null>(null);
    // A confirmed order can block its own sentence (a perp's pending position, a coin sold whole), so the review
    // keeps the intent while the sentence is unchanged.
    const [kept, setKept] = useState<{ text: string; intent: TransactionIntent } | null>(null);
    const intent = view.intent ?? (kept && kept.text === view.text ? kept.intent : null);
    const intentKey = JSON.stringify(intent);
    // A change to the sentence after confirming starts the review over.
    const confirmed = sent !== null && sent === intentKey;
    // The details stay on screen while the server answers; the outcome replaces them.
    const running = confirmed && placing;
    const done = confirmed && !placing;
    // A filled order hands over to the wallet a moment after its check, where the new coin or position stands.
    const finish = useRef(onDone);
    useEffect(() => {
        finish.current = onDone;
    });
    useEffect(() => {
        if (!showing || !done || !accepted) return;
        const timer = setTimeout(() => finish.current(), WALLET_AFTER_MS);
        return () => clearTimeout(timer);
    }, [showing, done, accepted]);
    const notice = view.blocking ?? view.issues.find((issue) => issue.severity === "warning");

    // Buy, Sell and Swap run from the account balance once signed in: no wallet signs, and the fill is instant.
    const spotIntent = isSpotIntent(intent) ? intent : null;
    const { holdings, state: accountState } = account;
    const tradeRequest = useMemo(
        () =>
            spotIntent && wallet.status === "connected" && accountState.status === "ready"
                ? toTradeRequest(
                      spotIntent,
                      {
                          price: (symbol) => catalog.tokens.find((t) => t.symbol === symbol)?.priceUSD ?? null,
                          held: (symbol) => Number(holdings.find((h) => h.symbol === symbol)?.units ?? 0),
                          heldText: (symbol) => holdings.find((h) => h.symbol === symbol)?.units ?? "0",
                      },
                      "",
                  )
                : null,
        [spotIntent, wallet.status, accountState.status, catalog.tokens, holdings],
    );
    // A prediction is placed for real once signed in with the server's trading on.
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
                if (!current) return;
                setQuoteAnswer(
                    "shares" in result
                        ? { tokenId, amountUSD, quote: result, refusal: null }
                        : { tokenId, amountUSD, quote: null, refusal: quoteRefusal(result) },
                );
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
    // Only an answer for the amount on screen; a stale one would show the wrong cost.
    const answered =
        quoteAnswer && quoteAnswer.tokenId === tokenId && Number(quoteAnswer.amountUSD) === Number(amountUSD)
            ? quoteAnswer
            : null;
    const quote = answered?.quote ?? null;
    // A refusal the order would meet too: a minimum risen with the price since the sentence was checked, say
    const quoteRefused = eventId ? (answered?.refusal ?? null) : null;
    const other = market?.outcomes.length === 2 ? market.outcomes.find((o) => o.id !== outcome?.id) : undefined;

    // A perp is opened for real once signed in and the server's trading is on (an intent exists only then).
    const perp = intent?.type === "perp" ? intent : null;
    const perpLive = !!perp && wallet.status === "connected";
    const perpRequest = useMemo<PerpQuoteRequest | null>(
        () =>
            perp && perpLive && showing && !done && accountState.status === "ready"
                ? { asset: perp.asset, side: perp.side, leverage: perp.leverage, collateralUSD: perp.collateralUSD }
                : null,
        [perp, perpLive, showing, done, accountState.status],
    );
    const perpKey = perpRequest ? JSON.stringify(perpRequest) : null;
    const askPerp = useRef(account.quotePerp);
    useEffect(() => {
        askPerp.current = account.quotePerp;
    });
    const [perpAnswer, setPerpAnswer] = useState<PerpAnswer | null>(null);
    const perpAsked = useRef(false);
    useEffect(() => {
        if (!perpKey) return;
        const asked = JSON.parse(perpKey) as PerpQuoteRequest;
        let current = true;
        const refresh = () =>
            void askPerp.current(asked).then((result) => {
                if (!current) return;
                setPerpAnswer(
                    "entryPx" in result ? { key: perpKey, quote: result } : { key: perpKey, error: result.message },
                );
            });
        // The first quote comes as the panel opens; a later change waits for typing to settle.
        const first = setTimeout(refresh, perpAsked.current ? QUOTE_DEBOUNCE_MS : 0);
        perpAsked.current = true;
        const timer = setInterval(refresh, QUOTE_REFRESH_MS);
        return () => {
            current = false;
            clearTimeout(first);
            clearInterval(timer);
        };
    }, [perpKey]);
    // Only an answer to the request on screen; a stale one would show the wrong price.
    const perpQuote = perpKey && perpAnswer?.key === perpKey && "quote" in perpAnswer ? perpAnswer.quote : null;
    const perpError = perpKey && perpAnswer?.key === perpKey && "error" in perpAnswer ? perpAnswer.error : null;
    // A sentence an error blocks promises nothing: no "You buy 2.299 YES shares" beside the reason it can't go ahead.
    const preview =
        view.blocking?.severity === "error"
            ? { title: view.preview.title, rows: [] }
            : live && quote && outcome
              ? { ...view.preview, rows: quoteRows(quote, outcome.label, other?.label, outcome.chance) }
              : perp && perpQuote
                ? { ...view.preview, rows: perpQuoteRows(perpQuote, perp) }
                : view.preview;

    // A trade waits for the prices it is made at; a perp for its quote.
    const awaitingQuote = (!!spotIntent && !tradeRequest) || (perpLive && !perpQuote);
    const blocked =
        !confirmed &&
        wallet.status !== "disconnected" &&
        (!!view.blocking || wallet.status === "loading" || awaitingQuote || !!quoteRefused);

    const confirm = async () => {
        if (running) return;
        if (done) return onDone();
        if (wallet.status === "disconnected") return wallet.connect();
        // A grayed-out button does nothing
        if (!view.intent || blocked) return;
        setKept({ text: view.text, intent: view.intent });
        if (spotIntent) {
            if (!tradeRequest) return;
            follow(account.placeTrade({ ...tradeRequest, requestId: crypto.randomUUID() }));
            setSummary(tradeOutcome(tradeRequest));
            setSent(intentKey);
            return;
        }
        if (live && prediction && market && outcome) {
            if (quoteRefused) return;
            // Counted at once; a refusal replaces the done line here, or opens the sidebar if this is closed by then.
            const estimate = (Number(prediction.amountUSD) / outcome.price).toFixed(6).replace(/\.?0+$/, "");
            follow(
                account.placePrediction({
                    eventId: prediction.marketId,
                    tokenId: prediction.outcomeId,
                    amountUSD: prediction.amountUSD,
                    quotedPrice: quote?.worstPrice ?? outcome.price,
                    question: market.question,
                    outcome: outcome.label,
                    shares: quote?.shares ?? estimate,
                }),
            );
            setSent(intentKey);
            return;
        }
        if (perpLive && perp && perpQuote) {
            follow(account.placePerp({ ...perp, requestId: crypto.randomUUID() }, perpQuote));
            setSent(intentKey);
            return;
        }
        setSending(true);
        setNotExecuted(null);
        const submission = await submitIntent(view.intent);
        setSending(false);
        if (submission.status === "unsupported") return setNotExecuted(submission.message);
        setSent(intentKey);
    };

    const confirmLabel = view.cta.replace(/^Review/, "Confirm");
    const label = done
        ? "Done"
        : running
          ? confirmLabel
          : wallet.status === "disconnected"
            ? (CONNECT[view.verb.id] ?? "Connect")
            : view.blocking
              ? (view.blocking.cta ?? view.cta)
              : confirmLabel;
    const swapNotice = perpError ?? quoteRefused ?? notExecuted;

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
                    ) : accepted ? (
                        <p className="text-[17px] leading-snug">
                            {spotIntent ? summary : perp ? "Position opened." : "Prediction placed."}
                        </p>
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

            {!confirmed && notice && (
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

            {!confirmed && swapNotice && (
                <motion.p variants={rise} role="alert" className="text-[15px] leading-snug text-loss">
                    {swapNotice}
                </motion.p>
            )}

            {!confirmed && wallet.status === "disconnected" && (
                <motion.p variants={rise} className="text-[15px] text-muted">
                    Connect a wallet to check your balance.
                </motion.p>
            )}

            <motion.div variants={rise} className="mt-auto pt-2">
                <ActionButton
                    label={label}
                    blocked={blocked}
                    disabled={sending}
                    phase={running ? "running" : (flash ?? "idle")}
                    onClick={confirm}
                />
            </motion.div>
        </motion.div>
    );
}
