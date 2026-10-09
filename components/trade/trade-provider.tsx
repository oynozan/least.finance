"use client";

import { createContext, use, type ReactNode } from "react";
import { useLogin, usePrivy } from "@privy-io/react-auth";
import type { SentenceAction, SentenceView } from "@/lib/sentence";
import { MOCK_HOLDINGS, QUOTE } from "@/lib/trade/catalog";
import type { TransactionIntent } from "@/lib/trade/intent";
import { useAccount } from "@/components/account-provider";
import { walletEnabled } from "@/components/wallet-provider";
import { useTradeSentence } from "./use-trade-sentence";

export type WalletStatus =
    { status: "demo" | "connected" } | { status: "loading" } | { status: "disconnected"; connect: () => void };

type TradeState = {
    view: SentenceView<TransactionIntent>;
    dispatch: (action: SentenceAction) => void;
    wallet: WalletStatus;
};

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
            <Provide wallet={{ status: "demo" }} holdings={MOCK_HOLDINGS}>
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
    // The same element type in every branch, so the sentence survives connecting.
    if (!ready) {
        return (
            <Provide wallet={{ status: "loading" }} holdings={null}>
                {children}
            </Provide>
        );
    }
    if (!authenticated) {
        return (
            <Provide
                wallet={{ status: "disconnected", connect: () => login({ loginMethods: ["wallet"] }) }}
                holdings={null}
            >
                {children}
            </Provide>
        );
    }
    // USDC is what the account has deposited; other coins stay mock until trading is live.
    // Until the account loads, nothing is capped rather than everything.
    const holdings = balance == null ? null : { ...MOCK_HOLDINGS, [QUOTE]: balance };
    return (
        <Provide wallet={{ status: "connected" }} holdings={holdings}>
            {children}
        </Provide>
    );
}

function Provide({
    wallet,
    holdings,
    children,
}: {
    wallet: WalletStatus;
    holdings: Record<string, number> | null;
    children: ReactNode;
}) {
    const { view, dispatch } = useTradeSentence(holdings);
    return <TradeContext value={{ view, dispatch, wallet }}>{children}</TradeContext>;
}
