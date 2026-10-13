"use client";

import {
    createContext,
    use,
    useCallback,
    useEffect,
    useMemo,
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
    type OptimisticTrade,
} from "@/lib/account/state";
import { API_URL } from "@/lib/api";
import type { Signers } from "@/lib/trade/swap-request";
import { ensureNetwork } from "@/lib/wallet/network";
import type {
    CoinBalance,
    DepositOrderView,
    DepositQuoteView,
    PositionView,
    PositionsView,
    QuoteView,
    SwapHoldingsView,
    SwapOrderView,
    SwapQuoteView,
    SwapRequest,
} from "@/server/src/protocol";
import {
    AccountClient,
    type AccountSnapshot,
    type DepositNotice,
    type DepositResult,
    type SwapResult,
} from "./account-client";
import { arc } from "./arc";
import { depositWalletAddress, linkedWallets, solanaWalletAddress, useActiveWallet } from "./arc-wallet";
import { useSolanaSigner } from "./solana-signer";
import { walletEnabled } from "./wallet-provider";

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
    /** The coins the account's wallets hold on the swap networks and which of them were read; null until a snapshot (cached or pushed) is in. */
    swapHoldings: SwapHoldingsView | null;
    /** Asks the server to read those coins again; it skips a read within 15 s of the last. */
    refreshSwapHoldings: () => void;
    /** The account's open swap orders and those settled in the last 7 days, newest first. */
    swaps: SwapOrderView[];
    /** The wallets that sign swaps: the active EVM one, and the Solana one; none while signed out. */
    signers: Signers;
    /** What a swap would pay right now, with no order opened. */
    quoteSwap: (req: SwapRequest) => Promise<SwapQuoteView | { error: ApiError }>;
    /** Opens a swap order and has the wallet that pays sign it; `reviewedMin` is the minimum received the person saw. */
    placeSwap: (req: SwapRequest, reviewedMin: string) => Promise<SwapResult>;
    /** Bridge orders still open, newest first. */
    orders: DepositOrderView[];
    /** What `amount` of `coin` would pay out on Arc, from the wallet the deposit uses. */
    quote: (coin: string, amount: string, wallet: string) => Promise<DepositQuoteView | ApiError>;
    /** Bridges `amount` of `coin` into the account from the wallet the deposit uses. */
    depositCoin: (coin: string, amount: string, wallet: string) => Promise<DepositResult>;
    /** Sends a deposit of `amount` USDC (a decimal string) on Arc from the wallet `from`. */
    deposit: (amount: string, from: string) => Promise<DepositResult>;
    dismissNotice: () => void;
    /** The server's positions and orders; empty while signed out. */
    predictions: PositionsView;
    /** Accepted buys the server hasn't shown back yet, newest first. */
    optimisticTrades: OptimisticTrade[];
    tradeNotice: { message: string } | null;
    /** What a prediction buy would cost and return right now. */
    quotePrediction: (input: { eventId: string; tokenId: string; amountUSD: string }) => Promise<QuoteView | ApiError>;
    /** Places a prediction buy, counted at once; the outcome arrives as a push. */
    placePrediction: (input: PlaceInput) => { requestId: string; sent: boolean };
    /** Sells a whole position, counted at once; the outcome arrives as a push. */
    closePosition: (position: PositionView, sellPrice: number | null) => void;
    dismissTradeNotice: () => void;
};

type PlaceInput = Parameters<AccountClient["placePrediction"]>[0];

const IDLE: AccountSnapshot = {
    state: { status: "idle" },
    notice: null,
    balances: null,
    swapHoldings: null,
    swaps: [],
    tradeNotice: null,
};
const NO_PREDICTIONS: PositionsView = { positions: [], orders: [] };
const NO_OPTIMISTIC: OptimisticTrade[] = [];
const UNAVAILABLE: ApiError = { code: "unavailable", message: "Predictions aren't available right now." };

const NO_SIGNERS: Signers = {};

const NO_SWAPS: ApiError = { code: "unavailable", message: "Swaps aren't available right now." };

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
    const active = useActiveWallet();
    const solanaAddress = user ? solanaWalletAddress(user, active) : undefined;
    const solanaSigner = useSolanaSigner(solanaAddress);
    const evmAddress = user ? depositWalletAddress(user, active) : undefined;
    const signers = useMemo(() => ({ evm: evmAddress, solana: solanaAddress }), [evmAddress, solanaAddress]);

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
    const refreshSwapHoldings = useCallback(() => client.refreshSwapHoldings(), [client]);
    // A wallet linked mid-session has no swap coins read yet.
    useEffect(() => {
        if (accountReady) refreshSwapHoldings();
    }, [accountReady, refreshSwapHoldings, walletKey]);

    const deposit = async (amount: string, from: string): Promise<DepositResult> => {
        const wallet = wallets.find((w) => w.address.toLowerCase() === from.toLowerCase());
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

    // All three act for the wallet of the row picked, not the active one.
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

    const placeSwap = async (req: SwapRequest, reviewedMin: string): Promise<SwapResult> => {
        // The wallet that pays signs: the linked EVM one, or the Solana one.
        const paying = wallets.find((w) => w.address.toLowerCase() === req.wallet.toLowerCase());
        try {
            const evm = paying
                ? {
                      from: paying.address,
                      provider: await paying.getEthereumProvider(),
                      ensure: (id: number) => ensureNetwork(paying, id),
                  }
                : undefined;
            return await client.placeSwap({ ...req, reviewedMin }, { evm, solana: solanaSigner });
        } catch (error) {
            return (error as { code?: unknown }).code === 4001
                ? { status: "cancelled" }
                : { status: "failed", message: NO_SWAPS.message };
        }
    };

    return (
        <Provide
            snapshot={snapshot}
            signers={signers}
            quoteSwap={(req) => client.quoteSwap(req)}
            placeSwap={placeSwap}
            deposit={deposit}
            quote={quote}
            depositCoin={depositCoin}
            refreshBalances={refreshBalances}
            refreshSwapHoldings={refreshSwapHoldings}
            dismissNotice={() => client.dismissNotice()}
            quotePrediction={(input) => client.quotePrediction(input)}
            placePrediction={(input) => client.placePrediction(input)}
            closePosition={(position, sellPrice) => client.closePosition(position, sellPrice)}
            dismissTradeNotice={() => client.dismissTradeNotice()}
        >
            {children}
        </Provide>
    );
}

function Provide({
    snapshot,
    signers = NO_SIGNERS,
    deposit = async () => "failed",
    quote = async () => NO_WALLET,
    depositCoin = async () => "failed",
    quoteSwap = async () => ({ error: NO_SWAPS }),
    placeSwap = async () => ({ status: "failed", message: NO_SWAPS.message }),
    dismissNotice = () => undefined,
    refreshBalances = () => undefined,
    refreshSwapHoldings = () => undefined,
    quotePrediction = async () => UNAVAILABLE,
    placePrediction = () => ({ requestId: "", sent: false }),
    closePosition = () => undefined,
    dismissTradeNotice = () => undefined,
    children,
}: {
    snapshot: AccountSnapshot;
    signers?: Signers;
    deposit?: Account["deposit"];
    quote?: Account["quote"];
    depositCoin?: Account["depositCoin"];
    quoteSwap?: Account["quoteSwap"];
    placeSwap?: Account["placeSwap"];
    dismissNotice?: () => void;
    refreshBalances?: () => void;
    refreshSwapHoldings?: () => void;
    quotePrediction?: Account["quotePrediction"];
    placePrediction?: Account["placePrediction"];
    closePosition?: Account["closePosition"];
    dismissTradeNotice?: () => void;
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
        swapHoldings: snapshot.swapHoldings,
        refreshSwapHoldings,
        swaps: snapshot.swaps,
        signers,
        quoteSwap,
        placeSwap,
        orders: state.status === "ready" ? state.orders : [],
        quote,
        depositCoin,
        deposit,
        dismissNotice,
        predictions: state.status === "ready" ? state.predictions : NO_PREDICTIONS,
        optimisticTrades: state.status === "ready" ? state.optimistic : NO_OPTIMISTIC,
        tradeNotice: snapshot.tradeNotice,
        quotePrediction,
        placePrediction,
        closePosition,
        dismissTradeNotice,
    };
    return <AccountContext value={value}>{children}</AccountContext>;
}
