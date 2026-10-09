"use client";

import { createContext, use, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { historyRows, optimisticBalance, toUsdc, type AccountState, type HistoryRow } from "@/lib/account/state";
import { AccountClient, type AccountSnapshot, type DepositNotice, type DepositResult } from "./account-client";
import { arc } from "./arc";
import { walletEnabled } from "./wallet-provider";

/** The deposit server. Unset in development, it's the local one. */
const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

export type Account = {
    state: AccountState;
    /** In USDC, pending deposits included; undefined while loading and null when it couldn't be loaded. */
    balance: number | null | undefined;
    history: HistoryRow[];
    notice: DepositNotice | null;
    /** Sends a deposit of `amount` USDC (a decimal string) from the signed-in wallet. */
    deposit: (amount: string) => Promise<DepositResult>;
    dismissNotice: () => void;
};

const IDLE: AccountSnapshot = { state: { status: "idle" }, notice: null };

const AccountContext = createContext<Account | null>(null);

export function useAccount() {
    const context = use(AccountContext);
    if (!context) throw new Error("useAccount must be used inside <AccountProvider>");
    return context;
}

/** The connected wallet's account on the server: its balance, deposits, and the way to add one. */
export function AccountProvider({ children }: { children: ReactNode }) {
    if (!walletEnabled) return <Provide snapshot={IDLE}>{children}</Provide>;
    return <PrivyAccountProvider>{children}</PrivyAccountProvider>;
}

function PrivyAccountProvider({ children }: { children: ReactNode }) {
    const { ready, authenticated, user, getAccessToken } = usePrivy();
    const { wallets } = useWallets();
    const [client] = useState(() => new AccountClient(API_URL));
    const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, () => IDLE);
    const address = user?.wallet?.address;

    // The latest token getter, without reconnecting whenever its identity changes.
    const accessToken = useRef(getAccessToken);
    useEffect(() => {
        accessToken.current = getAccessToken;
    });

    useEffect(() => {
        if (ready && authenticated && address) client.connect(address, () => accessToken.current());
        else client.disconnect();
    }, [client, ready, authenticated, address]);
    useEffect(() => () => client.disconnect(), [client]);

    const deposit = async (amount: string): Promise<DepositResult> => {
        // After an account switch in the wallet app, its newest account is the one that will sign.
        const wallet = wallets.find((w) => address && w.address.toLowerCase() === address.toLowerCase()) ?? wallets[0];
        if (!wallet) return "failed";
        try {
            if (wallet.chainId !== `eip155:${arc.id}`) await wallet.switchChain(arc.id);
            const provider = await wallet.getEthereumProvider();
            return await client.deposit(amount, { provider, from: wallet.address });
        } catch (error) {
            return (error as { code?: unknown }).code === 4001 ? "cancelled" : "failed";
        }
    };

    return (
        <Provide snapshot={snapshot} deposit={deposit} dismissNotice={() => client.dismissNotice()}>
            {children}
        </Provide>
    );
}

function Provide({
    snapshot,
    deposit = async () => "failed",
    dismissNotice = () => undefined,
    children,
}: {
    snapshot: AccountSnapshot;
    deposit?: Account["deposit"];
    dismissNotice?: () => void;
    children: ReactNode;
}) {
    const { state, notice } = snapshot;
    const wei = optimisticBalance(state);
    const balance = wei !== null ? toUsdc(wei) : state.status === "failed" ? null : undefined;
    const value: Account = { state, balance, history: historyRows(state), notice, deposit, dismissNotice };
    return <AccountContext value={value}>{children}</AccountContext>;
}
