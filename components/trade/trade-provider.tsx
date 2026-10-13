"use client";

import { createContext, use, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useLogin, usePrivy } from "@privy-io/react-auth";
import type { MarketView } from "@/server/src/protocol";
import type { SentenceAction, SentenceView } from "@/lib/sentence";
import { API_URL } from "@/lib/api";
import { CATALOG, QUOTE, TOKENS, type Catalog } from "@/lib/trade/catalog";
import type { WalletHoldings } from "@/lib/trade/context";
import type { TransactionIntent } from "@/lib/trade/intent";
import { toTokens } from "@/lib/trade/live-coins";
import { toPredictionMarket } from "@/lib/trade/markets";
import { walletHoldings } from "@/lib/trade/wallet-holdings";
import { useAccount } from "@/components/account-provider";
import { depositWalletAddress, solanaWalletAddress, useActiveWallet } from "@/components/arc-wallet";
import { walletEnabled } from "@/components/wallet-provider";
import { createCoinsStore } from "./coins-store";
import { createMarketsStore, type MarketsStore } from "./markets-store";
import { useTradeSentence } from "./use-trade-sentence";

export type WalletStatus =
    { status: "connected" } | { status: "loading" } | { status: "disconnected"; connect: () => void };

type TradeState = {
    view: SentenceView<TransactionIntent>;
    dispatch: (action: SentenceAction) => void;
    wallet: WalletStatus;
    /** The question picker's search. */
    search: { onQuery: (query: string) => void; empty?: string; loading?: boolean };
    catalog: Catalog;
    /** A number only while signed in with the server's trading on: predictions are placed for real. */
    maxOrderUSD: number | null;
    /** Every question seen, with the sell prices that value open positions. */
    known: ReadonlyMap<string, MarketView>;
    /** Asks for fresh swap coins in the signing wallets; absent while signed out. */
    refreshHoldings?: () => void;
};

const NO_KNOWN: ReadonlyMap<string, MarketView> = new Map();

const TradeContext = createContext<TradeState | null>(null);

/** The trade sentence's state, shared by the page, the dock and the review panel. */
export function useTrade() {
    const context = use(TradeContext);
    if (!context) throw new Error("useTrade must be used inside <TradeProvider>");
    return context;
}

/**
 * Holds the sentence above the sidebar shell, on the live questions and coin
 * prices. With Privy configured, the wallet decides whether balances apply;
 * without it (no app ID), nobody can sign in, so it stays signed out.
 */
export function TradeProvider({ children }: { children: ReactNode }) {
    if (!walletEnabled) return <SignedOutTradeProvider>{children}</SignedOutTradeProvider>;
    return <PrivyTradeProvider>{children}</PrivyTradeProvider>;
}

/** Signing in needs a Privy app ID, which the wallet button says; until one is set, connecting does nothing. */
const NO_SIGN_IN: WalletStatus = { status: "disconnected", connect: () => undefined };

function SignedOutTradeProvider({ children }: { children: ReactNode }) {
    const { catalog, store, search, known } = useLiveCatalog();
    return (
        <Provide
            wallet={NO_SIGN_IN}
            holdings={null}
            walletCoins={null}
            catalog={catalog}
            store={store}
            search={search}
            known={known}
        >
            {children}
        </Provide>
    );
}

function PrivyTradeProvider({ children }: { children: ReactNode }) {
    const { ready, authenticated, user } = usePrivy();
    const { login } = useLogin();
    const { balance, predictions, swapHoldings, refreshSwapHoldings } = useAccount();
    const { catalog, store, search, maxOrderUSD, known } = useLiveCatalog();
    const active = useActiveWallet();
    // The wallets that will sign: the active EVM one for the eight EVM networks, the active Solana one (else the first linked) for Solana.
    const evm = user ? depositWalletAddress(user, active) : undefined;
    const solana = user ? solanaWalletAddress(user, active) : undefined;
    const wallet = useMemo<WalletHoldings | null>(
        () => (swapHoldings ? walletHoldings(swapHoldings.rows, swapHoldings.read, { evm, solana }) : null),
        [swapHoldings, evm, solana],
    );
    // USDC is what the account has deposited, and still pays for Predict, Long and Short. Until it loads, nothing is capped rather than everything.
    const holdings = useMemo(() => (balance == null ? null : { [QUOTE]: balance }), [balance]);
    // The questions of open positions are read on a timer, whether or not they are trending.
    const heldKey = predictions.positions
        .filter((p) => p.state === "open")
        .map((p) => p.eventId)
        .join(",");
    useEffect(() => {
        store.hold(heldKey ? heldKey.split(",") : []);
        return () => store.hold([]);
    }, [store, heldKey]);
    // The same element type in every branch, so the sentence survives connecting.
    if (!ready) {
        return (
            <Provide
                wallet={{ status: "loading" }}
                holdings={null}
                walletCoins={null}
                catalog={catalog}
                store={store}
                search={search}
                known={known}
            >
                {children}
            </Provide>
        );
    }
    if (!authenticated) {
        return (
            <Provide
                wallet={{ status: "disconnected", connect: () => login({ loginMethods: ["wallet"] }) }}
                holdings={null}
                walletCoins={null}
                catalog={catalog}
                store={store}
                search={search}
                known={known}
            >
                {children}
            </Provide>
        );
    }
    return (
        <Provide
            wallet={{ status: "connected" }}
            holdings={holdings}
            walletCoins={wallet}
            catalog={catalog}
            store={store}
            search={search}
            maxOrderUSD={maxOrderUSD}
            known={known}
            refreshHoldings={refreshSwapHoldings}
        >
            {children}
        </Provide>
    );
}

/** Polymarket's questions and LI.FI's coin prices, whoever is (or isn't) signed in. */
type MarketSearch = TradeState["search"];

function useLiveCatalog(): {
    catalog: Catalog;
    store: MarketsStore;
    search: MarketSearch;
    maxOrderUSD: number | null;
    known: ReadonlyMap<string, MarketView>;
} {
    const [store] = useState(() => createMarketsStore({ apiUrl: API_URL }));
    const [coins] = useState(() => createCoinsStore({ apiUrl: API_URL }));
    useEffect(() => {
        store.start();
        return () => store.stop();
    }, [store]);
    useEffect(() => {
        coins.start();
        return () => coins.stop();
    }, [coins]);
    const { view: coinsView } = useSyncExternalStore(coins.subscribe, coins.getSnapshot, coins.getSnapshot);
    const tokens = useMemo(() => toTokens(coinsView, TOKENS), [coinsView]);
    const { trending, query, results, answered, searchFailed, loading, known, maxOrderUSD } = useSyncExternalStore(
        store.subscribe,
        store.getSnapshot,
        store.getSnapshot,
    );
    const catalog = useMemo<Catalog>(() => {
        const view = (id: string) => {
            const found = known.get(id);
            return found && toPredictionMarket(found, new Date());
        };
        return {
            ...CATALOG,
            tokens,
            // A search with no matches lists the trending questions under its notice.
            markets: (results?.length ? results : trending).map((m) => toPredictionMarket(m, new Date())),
            findMarket: view,
        };
    }, [tokens, trending, results, known]);
    const answeredNow = query !== "" && answered === query;
    const empty = !answeredNow
        ? undefined
        : searchFailed
          ? "Search isn't available right now."
          : results?.length === 0
            ? `No markets match \u201c${query}\u201d.`
            : undefined;
    // A pending search shows the skeleton, and so does the first trending list when no search answers instead.
    const waiting = (query !== "" && !answeredNow) || (loading && results === null);
    const search = useMemo<MarketSearch>(
        () => ({ onQuery: store.search, empty, loading: waiting }),
        [store, empty, waiting],
    );
    return { catalog, store, search, maxOrderUSD, known };
}

function Provide({
    wallet,
    holdings,
    walletCoins,
    catalog,
    store,
    search,
    maxOrderUSD = null,
    known = NO_KNOWN,
    refreshHoldings,
    children,
}: {
    wallet: WalletStatus;
    holdings: Record<string, number> | null;
    /** The signing wallets' coins per network; null until they load, and while signed out. */
    walletCoins: WalletHoldings | null;
    catalog: Catalog;
    store: MarketsStore;
    search: MarketSearch;
    maxOrderUSD?: number | null;
    known?: ReadonlyMap<string, MarketView>;
    refreshHoldings?: () => void;
    children: ReactNode;
}) {
    const { view, dispatch } = useTradeSentence(holdings, catalog, maxOrderUSD, walletCoins);
    const watched = view.verb.id === "predict" ? view.slots.marketId : undefined;
    const marketId = watched?.kind === "choice" && watched.value ? watched.value : null;
    useEffect(() => {
        store.watch(marketId);
        return () => store.watch(null);
    }, [store, marketId]);
    return (
        <TradeContext value={{ view, dispatch, wallet, search, catalog, maxOrderUSD, known, refreshHoldings }}>
            {children}
        </TradeContext>
    );
}
