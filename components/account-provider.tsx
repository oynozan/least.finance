"use client";

import {
    createContext,
    use,
    useCallback,
    useEffect,
    useRef,
    useState,
    useSyncExternalStore,
    type ReactNode,
} from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import {
    historyRows,
    optimisticBalance,
    toUsdc,
    type AccountState,
    type ApiError,
    type HistoryRow,
} from "@/lib/account/state";
import { ensureNetwork } from "@/lib/wallet/network";
import type { CoinBalance, DepositOrderView, DepositQuoteView } from "@/server/src/protocol";
import { AccountClient, type AccountSnapshot, type DepositNotice, type DepositResult } from "./account-client";
import { arc } from "./arc";
import { depositWalletAddress, linkedWallets, useActiveWallet } from "./arc-wallet";
import { walletEnabled } from "./wallet-provider";

/** The deposit server. Unset in development, it's the local one. */
const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4500";

export type Account = {
    state: AccountState;
    /** In USDC, pending deposits included; undefined while loading and null when it couldn't be loaded. */
    balance: number | null | undefined;
    history: HistoryRow[];
    notice: DepositNotice | null;
    /** Every coin in every linked wallet; null until a snapshot (cached or pushed) is in. */
    balances: CoinBalance[] | null;
    /** Reads fresh balances silently; does nothing within 30 s of the last read unless a linked wallet is new. */
    refreshBalances: () => void;
    /** Bridge orders still open, newest first. */
    orders: DepositOrderView[];
    /** What `amount` of `coin` would pay out on Arc, from the wallet the deposit uses. */
    quote: (coin: string, amount: string, wallet: string) => Promise<DepositQuoteView | ApiError>;
    /** Bridges `amount` of `coin` into the account from the wallet the deposit uses. */
    depositCoin: (coin: string, amount: string, wallet: string) => Promise<DepositResult>;
    /** Sends a deposit of `amount` USDC (a decimal string) from the signed-in wallet. */
    deposit: (amount: string) => Promise<DepositResult>;
    dismissNotice: () => void;
};

const IDLE: AccountSnapshot = { state: { status: "idle" }, notice: null, balances: null };

const NO_WALLET: ApiError = { code: "bad_request", message: "Connect a wallet to deposit." };

const AccountContext = createContext<Account | null>(null);

export function useAccount() {
    const context = use(AccountContext);
    if (!context) throw new Error("useAccount must be used inside <AccountProvider>");
    return context;
}

/** The signed-in person's account on the server: its balance, deposits, and the way to add one. */
export function AccountProvider({ children }: { children: ReactNode }) {
    if (!walletEnabled) return <Provide snapshot={IDLE}>{children}</Provide>;
    return <PrivyAccountProvider>{children}</PrivyAccountProvider>;
}

function PrivyAccountProvider({ children }: { children: ReactNode }) {
    const { ready, authenticated, user, getAccessToken } = usePrivy();
    const { wallets } = useWallets();
    const [client] = useState(() => new AccountClient(API_URL));
    const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, () => IDLE);
    const userId = user?.id;
    // Deposits come from the person's EVM wallet, whichever wallet they're using.
    const active = useActiveWallet();
    const address = user && depositWalletAddress(user, active);

    // The latest token getter, without reconnecting whenever its identity changes.
    const accessToken = useRef(getAccessToken);
    useEffect(() => {
        accessToken.current = getAccessToken;
    });

    useEffect(() => {
        if (ready && authenticated && userId) client.connect(userId, () => accessToken.current());
        else client.disconnect();
    }, [client, ready, authenticated, userId]);
    useEffect(() => () => client.disconnect(), [client]);

    // A key, so the effect runs when the linked wallets change and not on every render.
    const walletKey = user
        ? linkedWallets(user)
              .map((w) => w.address)
              .join(",")
        : "";
    const refreshBalances = useCallback(
        () => client.refreshBalances(walletKey ? walletKey.split(",") : []),
        [client, walletKey],
    );
    const accountReady = snapshot.state.status === "ready";
    // A wallet linked from the sidebar or Deposit is read at once.
    useEffect(() => {
        if (accountReady) refreshBalances();
    }, [accountReady, refreshBalances]);

    const deposit = async (amount: string): Promise<DepositResult> => {
        // After an account switch in the wallet app, its newest account is the one that will sign.
        const wallet = wallets.find((w) => address && w.address.toLowerCase() === address.toLowerCase()) ?? wallets[0];
        if (!wallet) return "failed";
        try {
            const network = await ensureNetwork(wallet, arc.id);
            if (network === "declined") return "cancelled";
            if (network !== "ready") return network;
            const provider = await wallet.getEthereumProvider();
            return await client.deposit(amount, { provider, from: wallet.address });
        } catch (error) {
            return (error as { code?: unknown }).code === 4001 ? "cancelled" : "failed";
        }
    };

    // Both act for the wallet of the row picked, not the active one.
    const quote = (coin: string, amount: string, from: string) =>
        wallets.some((w) => w.address.toLowerCase() === from.toLowerCase())
            ? client.quote(coin, amount, from)
            : Promise.resolve(NO_WALLET);

    const depositCoin = async (coin: string, amount: string, from: string): Promise<DepositResult> => {
        const wallet = wallets.find((w) => w.address.toLowerCase() === from.toLowerCase());
        if (!wallet) return "failed";
        try {
            const provider = await wallet.getEthereumProvider();
            return await client.bridgeDeposit(coin, amount, {
                provider,
                from: wallet.address,
                ensure: (id) => ensureNetwork(wallet, id),
            });
        } catch (error) {
            return (error as { code?: unknown }).code === 4001 ? "cancelled" : "failed";
        }
    };

    return (
        <Provide
            snapshot={snapshot}
            deposit={deposit}
            quote={quote}
            depositCoin={depositCoin}
            refreshBalances={refreshBalances}
            dismissNotice={() => client.dismissNotice()}
        >
            {children}
        </Provide>
    );
}

function Provide({
    snapshot,
    deposit = async () => "failed",
    quote = async () => NO_WALLET,
    depositCoin = async () => "failed",
    dismissNotice = () => undefined,
    refreshBalances = () => undefined,
    children,
}: {
    snapshot: AccountSnapshot;
    deposit?: Account["deposit"];
    quote?: Account["quote"];
    depositCoin?: Account["depositCoin"];
    dismissNotice?: () => void;
    refreshBalances?: () => void;
    children: ReactNode;
}) {
    const { state, notice } = snapshot;
    const wei = optimisticBalance(state);
    const balance = wei !== null ? toUsdc(wei) : state.status === "failed" ? null : undefined;
    const value: Account = {
        state,
        balance,
        history: historyRows(state),
        notice,
        balances: snapshot.balances?.rows ?? null,
        refreshBalances,
        orders: state.status === "ready" ? state.orders : [],
        quote,
        depositCoin,
        deposit,
        dismissNotice,
    };
    return <AccountContext value={value}>{children}</AccountContext>;
}
