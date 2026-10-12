"use client";

import { createContext, use, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useLogin, usePrivy } from "@privy-io/react-auth";
import type { MarketView } from "@/server/src/protocol";
import type { SentenceAction, SentenceView } from "@/lib/sentence";
import { API_URL } from "@/lib/api";
import { CATALOG, MOCK_HOLDINGS, QUOTE, type Catalog } from "@/lib/trade/catalog";
import type { TransactionIntent } from "@/lib/trade/intent";
import { toPredictionMarket } from "@/lib/trade/markets";
import { useAccount } from "@/components/account-provider";
import { walletEnabled } from "@/components/wallet-provider";
import { createMarketsStore, type MarketsStore } from "./markets-store";
import { useTradeSentence } from "./use-trade-sentence";

export type WalletStatus =
    { status: "demo" | "connected" } | { status: "loading" } | { status: "disconnected"; connect: () => void };

type TradeState = {
    view: SentenceView<TransactionIntent>;
    dispatch: (action: SentenceAction) => void;
    wallet: WalletStatus;
    /** The question picker's search; absent while the questions are mock ones. */
    search?: { onQuery: (query: string) => void; empty?: string };
    catalog: Catalog;
    /** A number only while signed in with the server's trading on: predictions are placed for real. */
    maxOrderUSD: number | null;
    /** Every question seen, with the sell prices that value open positions. */
    known: ReadonlyMap<string, MarketView>;
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
 * Holds the sentence above the sidebar shell. With Privy configured, the
 * wallet decides whether balances apply; without it (no app ID), it runs as
 * a demo on mock balances.
 */
export function TradeProvider({ children }: { children: ReactNode }) {
    if (!walletEnabled) {
        return (
            <Provide wallet={{ status: "demo" }} holdings={MOCK_HOLDINGS} catalog={CATALOG}>
                {children}
            </Provide>
        );
    }
    return <PrivyTradeProvider>{children}</PrivyTradeProvider>;
}

function PrivyTradeProvider({ children }: { children: ReactNode }) {
    const { ready, authenticated } = usePrivy();
    const { login } = useLogin();
    const { balance } = useAccount();
    const { catalog, store, search, maxOrderUSD, known } = useLiveCatalog();
    const { predictions } = useAccount();
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
                catalog={catalog}
                store={store}
                search={search}
                known={known}
            >
                {children}
            </Provide>
        );
    }
    // USDC is what the account has deposited; other coins stay mock until trading is live.
    // Until the account loads, nothing is capped rather than everything.
    const holdings = balance == null ? null : { ...MOCK_HOLDINGS, [QUOTE]: balance };
    return (
        <Provide
            wallet={{ status: "connected" }}
            holdings={holdings}
            catalog={catalog}
            store={store}
            search={search}
            maxOrderUSD={maxOrderUSD}
            known={known}
        >
            {children}
        </Provide>
    );
}

/** Polymarket's questions in place of the mock ones, whoever is (or isn't) signed in. */
type MarketSearch = NonNullable<TradeState["search"]>;

function useLiveCatalog(): {
    catalog: Catalog;
    store: MarketsStore;
    search: MarketSearch;
    maxOrderUSD: number | null;
    known: ReadonlyMap<string, MarketView>;
} {
    const [store] = useState(() => createMarketsStore({ apiUrl: API_URL }));
    useEffect(() => {
        store.start();
        return () => store.stop();
    }, [store]);
    const { trending, query, results, answered, known, maxOrderUSD } = useSyncExternalStore(
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
            // A search with no matches lists the trending questions under its notice.
            markets: (results?.length ? results : trending).map((m) => toPredictionMarket(m, new Date())),
            findMarket: view,
        };
    }, [trending, results, known]);
    const empty = results?.length === 0 && answered === query ? `No markets match \u201c${query}\u201d.` : undefined;
    const search = useMemo<MarketSearch>(() => ({ onQuery: store.search, empty }), [store, empty]);
    return { catalog, store, search, maxOrderUSD, known };
}

function Provide({
    wallet,
    holdings,
    catalog,
    store,
    search,
    maxOrderUSD = null,
    known = NO_KNOWN,
    children,
}: {
    wallet: WalletStatus;
    holdings: Record<string, number> | null;
    catalog: Catalog;
    store?: MarketsStore;
    search?: MarketSearch;
    maxOrderUSD?: number | null;
    known?: ReadonlyMap<string, MarketView>;
    children: ReactNode;
}) {
    const { view, dispatch } = useTradeSentence(holdings, catalog, maxOrderUSD);
    const watched = view.verb.id === "predict" ? view.slots.marketId : undefined;
    const marketId = watched?.kind === "choice" && watched.value ? watched.value : null;
    useEffect(() => {
        store?.watch(marketId);
        return () => store?.watch(null);
    }, [store, marketId]);
    return (
        <TradeContext value={{ view, dispatch, wallet, search, catalog, maxOrderUSD, known }}>{children}</TradeContext>
    );
}
