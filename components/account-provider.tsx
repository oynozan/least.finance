"use client";

import { parseUnits } from "viem";
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
    optimisticHoldings,
    toUsdc,
    type AccountState,
    type ApiError,
    type HistoryRow,
    type CoinWithdrawalView,
    type HoldingView,
    type OptimisticTrade,
    type PendingWithdrawal,
} from "@/lib/account/state";
import type { CoinWithdrawRequest, TradeOrderRequest } from "@/server/src/trading/types";
import { sameWallet } from "@/lib/account/balances";
import { API_URL } from "@/lib/api";
import { ensureNetwork } from "@/lib/wallet/network";
import type {
    ActivityFilter,
    ActivityPage,
    CoinBalance,
    DepositOrderView,
    PerpOrderRequest,
    PerpQuoteRequest,
    PerpQuoteView,
    PerpsView,
    PnlSeries,
    PositionView,
    PositionsView,
    QuoteView,
    WithdrawLimits,
    WithdrawQuote,
    WithdrawalView,
} from "@/server/src/protocol";
import {
    AccountClient,
    type AccountSnapshot,
    type DepositNotice,
    type DepositResult,
    type Placed,
} from "./account-client";
import { arc } from "./arc";
import { linkedWallets, solanaWalletAddress, useActiveWallet } from "./arc-wallet";
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
    /** Bridge orders still open, newest first. */
    orders: DepositOrderView[];
    /** Whether a deposit can be sent from this wallet now: it's connected in this browser and can sign. */
    canDepositFrom: (wallet: string) => boolean;
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
    placePrediction: (input: PlaceInput) => Placed;
    /** Sells a whole position, counted at once; the outcome arrives as a push. */
    closePosition: (position: PositionView, sellPrice: number | null) => void;
    dismissTradeNotice: () => void;
    /** The server's perp positions and in-flight orders; a pending open's position is among them. */
    perps: PerpsView;
    /** What opening a perp position would cost right now. */
    quotePerp: (req: PerpQuoteRequest) => Promise<PerpQuoteView | ApiError>;
    /** Opens a perp position on the quote shown, counted at once; the outcome arrives as a push. */
    placePerp: (req: PerpOrderRequest, quote: PerpQuoteView) => Placed;
    /** Closes a whole perp position; the outcome arrives as a push. */
    closePerp: (positionId: string) => Promise<void>;
    /** How many times a socket bound to the account and the server pushed `pnl:changed`; the series is asked again on either. */
    pnl: AccountSnapshot["pnl"];
    /** The balance and PnL series with its days cut in the zone `tz`. */
    loadPnlSeries: (tz: string) => Promise<PnlSeries | ApiError>;
    /** One page of the account's history under `filter`, the one after the cursor `before` or the newest */
    loadActivityPage: (req: { before?: string; filter: ActivityFilter }) => Promise<ActivityPage | ApiError>;
    /** The account's recent withdrawals, newest first. */
    withdrawals: WithdrawalView[];
    /** Withdrawals asked for that the server hasn't shown back yet, newest first. */
    pendingWithdrawals: PendingWithdrawal[];
    /** What a withdrawal may be right now. */
    withdrawLimits: () => Promise<WithdrawLimits | ApiError>;
    /** What a withdrawal of `amount` to the linked Solana wallet `to` would cost and deliver. */
    withdrawQuote: (amount: string, to: string) => Promise<WithdrawQuote | ApiError>;
    /** Withdraws `amount` USDC to the linked wallet `to` (with the fee shown for a Solana one); the amount is counted at once. */
    withdraw: (amount: string, to: string, reviewedFee?: string) => Promise<"sent" | "refused" | "failed" | "changed">;
    /** The coins the account holds, with trades and sends still on their way counted. */
    holdings: HoldingView[];
    /** Buys, sells or swaps from the balance, counted at once; a refusal rolls it back and shows as the trade notice. */
    placeTrade: (req: TradeOrderRequest) => Placed;
    /** Sends units of a held coin to an address, counted at once. */
    withdrawHolding: (req: CoinWithdrawRequest) => { requestId: string; sent: boolean };
    /** The account's coin sends, newest first. */
    coinWithdrawals: CoinWithdrawalView[];
};

type PlaceInput = Parameters<AccountClient["placePrediction"]>[0];

const IDLE: AccountSnapshot = {
    state: { status: "idle" },
    notice: null,
    balances: null,
    tradeNotice: null,
    pnl: { bound: 0, changed: 0 },
};
const NO_PREDICTIONS: PositionsView = { positions: [], orders: [] };
const NO_PERPS: PerpsView = { positions: [], orders: [] };
const NO_OPTIMISTIC: OptimisticTrade[] = [];
const NO_HOLDINGS: HoldingView[] = [];
const NO_COIN_WITHDRAWALS: CoinWithdrawalView[] = [];
const NO_WITHDRAWALS: WithdrawalView[] = [];
const NO_PENDING_WITHDRAWALS: PendingWithdrawal[] = [];
const UNAVAILABLE: ApiError = { code: "unavailable", message: "Predictions aren't available right now." };

const UNAVAILABLE_PERP: ApiError = { code: "unavailable", message: "Long and short aren't available right now." };

const UNAVAILABLE_WITHDRAW: ApiError = { code: "unavailable", message: "Withdrawals aren't available right now." };

const UNAVAILABLE_PNL: ApiError = { code: "unavailable", message: "Your history isn't available right now." };

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

    // Both act for the wallet of the row picked, not the active one.
    const depositCoin = async (coin: string, amount: string, from: string): Promise<DepositResult> => {
        if (coin.startsWith("solana:")) {
            if (solanaSigner?.address !== from) return "failed";
            const sol = snapshot.balances?.rows.find((r) => r.coin === "solana:SOL" && r.wallet === from)?.amount;
            try {
                return await client.solanaDeposit(coin, amount, {
                    address: from,
                    signer: solanaSigner,
                    solBalance: sol == null ? null : parseUnits(sol, 9),
                });
            } catch {
                return "failed";
            }
        }
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
            depositCoin={depositCoin}
            canDepositFrom={(wallet) =>
                wallets.some((w) => sameWallet(w.address, wallet)) || solanaSigner?.address === wallet
            }
            refreshBalances={refreshBalances}
            dismissNotice={() => client.dismissNotice()}
            quotePrediction={(input) => client.quotePrediction(input)}
            placePrediction={(input) => client.placePrediction(input)}
            closePosition={(position, sellPrice) => client.closePosition(position, sellPrice)}
            dismissTradeNotice={() => client.dismissTradeNotice()}
            quotePerp={(req) => client.quotePerp(req)}
            placePerp={(req, quote) => client.placePerp(req, quote)}
            closePerp={(positionId) => client.closePerp(positionId)}
            loadPnlSeries={(tz) => client.loadPnlSeries(tz)}
            loadActivityPage={(req) => client.loadActivityPage(req)}
            withdrawLimits={() => client.withdrawLimits()}
            withdrawQuote={(amount, to) => client.withdrawQuote(amount, to)}
            withdraw={(amount, to, reviewedFee) => client.withdraw(amount, to, reviewedFee)}
            placeTrade={(req) => client.placeTrade(req)}
            withdrawHolding={(req) => client.withdrawHolding(req)}
        >
            {children}
        </Provide>
    );
}

function Provide({
    snapshot,
    deposit = async () => "failed",
    depositCoin = async () => "failed",
    canDepositFrom = () => false,
    dismissNotice = () => undefined,
    refreshBalances = () => undefined,
    quotePrediction = async () => UNAVAILABLE,
    placePrediction = () => ({ requestId: "", sent: false, answer: Promise.resolve(null) }),
    closePosition = () => undefined,
    dismissTradeNotice = () => undefined,
    quotePerp = async () => UNAVAILABLE_PERP,
    placePerp = (req) => ({ requestId: req.requestId, sent: false, answer: Promise.resolve(null) }),
    closePerp = async () => undefined,
    loadPnlSeries = async () => UNAVAILABLE_PNL,
    loadActivityPage = async () => UNAVAILABLE_PNL,
    withdrawLimits = async () => UNAVAILABLE_WITHDRAW,
    withdrawQuote = async () => UNAVAILABLE_WITHDRAW,
    withdraw = async () => "failed",
    placeTrade = (req) => ({ requestId: req.requestId, sent: false, answer: Promise.resolve(null) }),
    withdrawHolding = (req) => ({ requestId: req.requestId, sent: false }),
    children,
}: {
    snapshot: AccountSnapshot;
    deposit?: Account["deposit"];
    depositCoin?: Account["depositCoin"];
    canDepositFrom?: Account["canDepositFrom"];
    dismissNotice?: () => void;
    refreshBalances?: () => void;
    quotePrediction?: Account["quotePrediction"];
    placePrediction?: Account["placePrediction"];
    closePosition?: Account["closePosition"];
    dismissTradeNotice?: () => void;
    quotePerp?: Account["quotePerp"];
    placePerp?: Account["placePerp"];
    closePerp?: Account["closePerp"];
    loadPnlSeries?: Account["loadPnlSeries"];
    loadActivityPage?: Account["loadActivityPage"];
    withdrawLimits?: Account["withdrawLimits"];
    withdrawQuote?: Account["withdrawQuote"];
    withdraw?: Account["withdraw"];
    placeTrade?: Account["placeTrade"];
    withdrawHolding?: Account["withdrawHolding"];
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
        depositCoin,
        canDepositFrom,
        deposit,
        dismissNotice,
        predictions: state.status === "ready" ? state.predictions : NO_PREDICTIONS,
        optimisticTrades: state.status === "ready" ? state.optimistic : NO_OPTIMISTIC,
        tradeNotice: snapshot.tradeNotice,
        quotePrediction,
        placePrediction,
        closePosition,
        dismissTradeNotice,
        perps: state.status === "ready" ? state.perps : NO_PERPS,
        quotePerp,
        placePerp,
        closePerp,
        pnl: snapshot.pnl,
        loadPnlSeries,
        loadActivityPage,
        withdrawals: state.status === "ready" ? state.withdrawals : NO_WITHDRAWALS,
        pendingWithdrawals: state.status === "ready" ? state.pendingWithdrawals : NO_PENDING_WITHDRAWALS,
        withdrawLimits,
        withdrawQuote,
        withdraw,
        holdings: state.status === "ready" ? optimisticHoldings(state) : NO_HOLDINGS,
        placeTrade,
        withdrawHolding,
        coinWithdrawals: state.status === "ready" ? state.coinWithdrawals : NO_COIN_WITHDRAWALS,
    };
    return <AccountContext value={value}>{children}</AccountContext>;
}
