"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useConnectWallet } from "@privy-io/react-auth";
import { MotionConfig, motion, type Variants } from "motion/react";
import { submitIntent } from "@/lib/trade/execute";
import type { TradeCtx } from "@/lib/trade/context";
import { formatUnits } from "@/lib/trade/format";
import type { TransactionIntent } from "@/lib/trade/intent";
import { networkName } from "@/lib/trade/networks";
import { quoteRows as perpQuoteRows } from "@/lib/trade/perp-quote";
import { quoteRows } from "@/lib/trade/prediction-quote";
import { swapQuoteRows } from "@/lib/trade/swap-quote";
import { isSwapIntent, kindOf, swapSides, toSwapRequest } from "@/lib/trade/swap-request";
import { walletHoldings } from "@/lib/trade/wallet-holdings";
import type {
    PerpQuoteRequest,
    PerpQuoteView,
    QuoteView,
    SwapOrderView,
    SwapQuoteView,
    SwapRequest,
} from "@/server/src/protocol";
import { OFFLINE_COPY } from "@/components/account-client";
import { useAccount } from "@/components/account-provider";
import { useLinkOtherWallet } from "@/components/arc-wallet";
import { CloseIcon } from "@/components/icons";
import { shortenAddress } from "@/components/wallet-data";
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
const SWAP_REFRESH_MS = 15_000;

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
            <ReviewBody key={openings} showing={showing} onDone={() => setOpen(false)} />
        </MotionConfig>
    );
}

/** What became of a swap the wallet sent, in the words of the spec. */
function swapOutcome(order: SwapOrderView): { text: string; bad: boolean } {
    const { from, to } = order;
    switch (order.state) {
        case "done":
            return { text: `Received ${formatUnits(Number(to.received ?? to.amount), to.token)}.`, bad: false };
        case "partial":
            return {
                text: `Received ${formatUnits(Number(to.received ?? 0), to.receivedSymbol ?? to.token)} on ${networkName(to.network)} instead of ${to.token}.`,
                bad: true,
            };
        case "refunded":
            return {
                text: `The swap didn't go through. Your ${formatUnits(Number(from.amount), from.token)} is back on ${networkName(from.network)}.`,
                bad: true,
            };
        case "failed":
        case "expired":
            return {
                text: `The swap failed, so your ${from.token} stayed in your wallet. Only the network fee was spent.`,
                bad: true,
            };
        default:
            return { text: "Swap sent.", bad: false };
    }
}

/** The confirm button's class, shared by every action the panel ends with. */
function ActionButton({
    label,
    blocked = false,
    disabled = false,
    onClick,
}: {
    label: string;
    blocked?: boolean;
    disabled?: boolean;
    onClick: () => void;
}) {
    return (
        <motion.button
            type="button"
            aria-disabled={blocked || undefined}
            disabled={disabled}
            className={`h-14 w-full rounded-full text-[17px] font-semibold tracking-[-0.01em] outline-2 outline-offset-2 outline-transparent transition-colors focus-visible:outline-solid ${
                blocked ? "cursor-default bg-pill text-muted" : "cursor-pointer bg-gain text-background"
            }`}
            whileHover={blocked ? undefined : { scale: 1.02 }}
            whileTap={blocked ? undefined : { scale: 0.97 }}
            transition={spring}
            onClick={onClick}
        >
            {label}
        </motion.button>
    );
}

/** Links the wallet kind a swap still needs; only mounted while signed in, where Privy is there. */
function ConnectKind({ kind }: { kind: "evm" | "solana" }) {
    const link = useLinkOtherWallet();
    return <ActionButton label="Connect" onClick={() => link(kind)} />;
}

/** Opens Privy's wallet connect for a linked wallet that isn't connected in this browser. */
function ConnectHere({ address }: { address: string }) {
    const { connectWallet } = useConnectWallet();
    const walletChainType = address.startsWith("0x") ? "ethereum-only" : "solana-only";
    return <ActionButton label="Connect" onClick={() => connectWallet({ walletChainType })} />;
}

const same = (a: SwapRequest, b: SwapRequest) =>
    a.from.token === b.from.token &&
    a.from.network === b.from.network &&
    a.to.token === b.to.token &&
    a.to.network === b.to.network &&
    Number(a.amountUSD) === Number(b.amountUSD);

type SwapAnswer = { key: string; quote: SwapQuoteView } | { key: string; error: string };

type PerpAnswer = { key: string; quote: PerpQuoteView } | { key: string; error: string };

function ReviewBody({ showing, onDone }: { showing: boolean; onDone: () => void }) {
    const { view, wallet, catalog, maxOrderUSD } = useTrade();
    const account = useAccount();
    const [sent, setSent] = useState<string | null>(null);
    const [sending, setSending] = useState(false);
    const [accepted, setAccepted] = useState(false);
    // The server's refusal of the prediction just confirmed; the notice itself clears after a few seconds.
    const [refusal, setRefusal] = useState<string | null>(null);
    const refused = account.tradeNotice?.message ?? null;
    if (accepted && refused && refused !== refusal) setRefusal(refused);
    const [quoted, setQuoted] = useState<QuoteView | null>(null);
    // A confirmed perp's own pending position blocks its sentence, so the review keeps the intent while the sentence is unchanged.
    const [kept, setKept] = useState<{ text: string; intent: TransactionIntent } | null>(null);
    const intent = view.intent ?? (kept && kept.text === view.text ? kept.intent : null);
    const intentKey = JSON.stringify(intent);
    // A change to the sentence after confirming starts the review over.
    const done = sent !== null && sent === intentKey;
    const notice = view.blocking ?? view.issues.find((issue) => issue.severity === "warning");

    // A swap, buy or sell is real once signed in: LI.FI quotes it and the person's own wallet signs it.
    const swapIntent = isSwapIntent(intent) ? intent : null;
    const { swapHoldings, signers, connected, swaps, state: accountState } = account;
    const swapCtx = useMemo<TradeCtx>(
        () => ({
            catalog,
            holdings: null,
            wallet: swapHoldings ? walletHoldings(swapHoldings.rows, swapHoldings.read, signers) : null,
        }),
        [catalog, swapHoldings, signers],
    );
    const [swapId, setSwapId] = useState<string | null>(null);
    const [placing, setPlacing] = useState(false);
    const [problem, setProblem] = useState<{ key: string; message: string } | null>(null);
    const [answer, setAnswer] = useState<SwapAnswer | null>(null);
    const built =
        swapIntent && showing && !done && !view.blocking && wallet.status === "connected"
            ? toSwapRequest(swapIntent, swapCtx, signers, connected)
            : null;
    const request = built && !("missing" in built) && !("connect" in built) ? built : null;
    const missing = built && "missing" in built ? built.missing : null;
    const toConnect = built && "connect" in built ? built.connect : null;
    const requestKey = request && accountState.status === "ready" ? JSON.stringify(request) : null;
    const askSwap = useRef(account.quoteSwap);
    useEffect(() => {
        askSwap.current = account.quoteSwap;
    });
    const requote = useRef<(() => void) | null>(null);
    const swapAsked = useRef(false);
    useEffect(() => {
        if (!requestKey) return;
        const asked = JSON.parse(requestKey) as SwapRequest;
        let current = true;
        const refresh = () =>
            void askSwap.current(asked).then((result) => {
                if (!current) return;
                setAnswer(
                    "error" in result
                        ? { key: requestKey, error: result.error.message }
                        : { key: requestKey, quote: result },
                );
            });
        requote.current = refresh;
        // The first quote comes as the panel opens; a later request waits for typing to settle.
        const first = setTimeout(refresh, swapAsked.current ? QUOTE_DEBOUNCE_MS : 0);
        swapAsked.current = true;
        const timer = setInterval(refresh, SWAP_REFRESH_MS);
        return () => {
            current = false;
            requote.current = null;
            clearTimeout(first);
            clearInterval(timer);
        };
    }, [requestKey]);
    // Only an answer to the request on screen; a stale one would show the wrong amount.
    const swapQuote =
        requestKey && request && answer?.key === requestKey && "quote" in answer && same(answer.quote.request, request)
            ? answer.quote
            : null;
    const swapError = requestKey && answer?.key === requestKey && "error" in answer ? answer.error : null;
    const sides = swapIntent ? swapSides(swapIntent, swapCtx) : null;
    const placed = swapId ? swaps.find((o) => o.id === swapId) : undefined;

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
    const preview =
        live && quote && outcome
            ? { ...view.preview, rows: quoteRows(quote, outcome.label, other?.label, outcome.chance) }
            : perp && perpQuote
              ? { ...view.preview, rows: perpQuoteRows(perpQuote, perp) }
              : swapQuote
                ? { ...view.preview, rows: swapQuoteRows(swapQuote, swapCtx) }
                : view.preview;
    const problemNow = problem?.key === intentKey ? problem.message : null;

    const confirmSwap = async () => {
        if (!request || !swapQuote || placing) return;
        setPlacing(true);
        setProblem(null);
        const result = await account.placeSwap(request, swapQuote.toAmountMin);
        setPlacing(false);
        // A wallet rejection says nothing; the button is simply "Confirm swap" again.
        if (result.status === "sent") {
            setSwapId(result.order.id);
            setSent(intentKey);
        } else if (result.status === "failed") {
            setProblem({ key: intentKey, message: result.message });
            requote.current?.();
        } else if (result.status === "switch_failed") {
            setProblem({ key: intentKey, message: `Switch your wallet to ${result.network} and try again.` });
        }
    };

    const confirm = async () => {
        if (done) return onDone();
        if (wallet.status === "disconnected") return wallet.connect();
        if (!view.intent || view.blocking) return;
        if (swapIntent) return void (await confirmSwap());
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
            setAccepted(result.sent);
            setSent(intentKey);
            return;
        }
        if (perpLive && perp && perpQuote) {
            const result = account.placePerp({ ...perp, requestId: crypto.randomUUID() }, perpQuote);
            // Offline changes nothing; the person is told so here.
            if (!result.sent) setRefusal(OFFLINE_COPY);
            setAccepted(result.sent);
            setKept({ text: view.text, intent: perp });
            setSent(intentKey);
            return;
        }
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
            : placing
              ? "Confirm in your wallet"
              : view.cta.replace(/^Review/, "Confirm");
    // A swap waits for LI.FI's quote of what is on screen.
    const awaitingQuote = (!!swapIntent && !!request && !swapQuote) || (perpLive && !perpQuote);
    const blocked =
        !done &&
        wallet.status !== "disconnected" &&
        (!!view.blocking || wallet.status === "loading" || awaitingQuote || (!!swapIntent && !request));
    // Where a missing wallet is needed, in the spec's words.
    const needs = (kind: "evm" | "solana") => (kind === "solana" ? "a Solana" : "an EVM");
    const missingMessage =
        missing && sides
            ? kindOf(sides.to.network) === missing
                ? `Connect ${needs(missing)} wallet to receive ${sides.to.token} on ${networkName(sides.to.network)}.`
                : `Connect ${needs(missing)} wallet to pay with ${sides.from.token} on ${networkName(sides.from.network)}.`
            : null;
    const connectMessage = toConnect ? `Connect ${shortenAddress(toConnect)} to pay.` : null;
    const swapNotice = missingMessage ?? connectMessage ?? problemNow ?? swapError ?? perpError;

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
                    {swapIntent ? (
                        <p
                            className={`text-[17px] leading-snug ${placed && swapOutcome(placed).bad ? "text-loss" : ""}`}
                        >
                            {placed ? swapOutcome(placed).text : "Swap sent."}
                        </p>
                    ) : refusal ? (
                        <p className="text-[17px] leading-snug text-loss">{refusal}</p>
                    ) : accepted ? (
                        <p className="text-[17px] leading-snug">{perp ? "Position opened." : "Prediction placed."}</p>
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

            {!done && swapQuote?.needsApproval && !swapNotice && (
                <motion.p variants={rise} className="text-[15px] leading-snug text-muted">
                    Approve {swapQuote.request.from.token} in your wallet, then confirm the swap.
                </motion.p>
            )}

            {!done && swapNotice && (
                <motion.p variants={rise} role="alert" className="text-[15px] leading-snug text-loss">
                    {swapNotice}
                </motion.p>
            )}

            {!done && wallet.status === "disconnected" && (
                <motion.p variants={rise} className="text-[15px] text-muted">
                    Connect a wallet to check your balance.
                </motion.p>
            )}

            <motion.div variants={rise} className="mt-auto pt-2">
                {!done && missing ? (
                    <ConnectKind kind={missing} />
                ) : !done && toConnect ? (
                    <ConnectHere address={toConnect} />
                ) : (
                    <ActionButton label={label} blocked={blocked} disabled={sending || placing} onClick={confirm} />
                )}
            </motion.div>
        </motion.div>
    );
}
