import { io, type Socket } from "socket.io-client";
import { parseGwei, toHex } from "viem";
import {
    accountReducer,
    initialAccountState,
    pendingPerpId,
    toWei,
    type AccountAction,
    type AccountState,
    type ApiError,
    type DepositQuoteView,
    type Hex,
    type PerpPositionView,
    type PositionView,
    type PredictionFailure,
    type QuoteView,
    type WithdrawLimits,
} from "@/lib/account/state";
import { sellableShares } from "@/components/wallet-data";
import { estimateTrade } from "@/lib/account/spot";
import type { CoinWithdrawRequest, TradeOrderRequest } from "@/server/src/trading/types";
import { dropAfterSend, loadCachedBalances, needsRefresh, saveCachedBalances } from "@/lib/account/balances";
import {
    clearUnreported,
    dropHolding,
    keepUnreported,
    reportUnreported,
    settlesReport,
    settleHoldings,
    trackOrder,
    type Tracking,
} from "@/lib/account/swaps";
import { loadCachedSwapHoldings, saveCachedSwapHoldings, validHoldings } from "@/lib/trade/wallet-holdings";
import { networkName, type NetworkCheck } from "@/lib/wallet/network";
import { resetPnlStores } from "@/lib/pnl/series-store";
import type {
    ActivityFilter,
    ActivityPage,
    BalancesView,
    ClientToServerEvents,
    PerpOrderRequest,
    PerpQuoteRequest,
    PerpQuoteView,
    PnlSeries,
    ServerToClientEvents,
    SwapHoldingsView,
    SwapOrderView,
    SwapQuoteView,
    SwapRequest,
    SwapTxView,
    WithdrawQuote,
} from "@/server/src/protocol";
import { buildDepositTransaction, signWithFreshKeys, withFreshSigners } from "@/lib/account/solana-tx";
import { arc } from "./arc";

type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** The minimal EIP-1193 surface a deposit needs from the wallet. */
export type WalletProvider = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

/** Where a deposit stands, as the sidebar tells it. */
export type DepositNotice =
    /** Sent from the wallet; the server is confirming it. */
    | { kind: "confirming"; amount: bigint }
    | { kind: "credited"; amount: bigint }
    /** The server couldn't confirm it, so it came back out of the balance. */
    /** `withdrawal`: a failed withdrawal, which the deposit button ignores. */
    | { kind: "reverted"; message: string; withdrawal?: true };

/** How the wallet took a deposit: turned down, failed to send, or sent (and now being confirmed). */
/** `refused` is the server's reason for not opening the deposit, such as "That's too small to cover the fee." */
export type DepositResult =
    "cancelled" | "failed" | "sent" | "switch_failed" | "wrong_network" | "needs_sol" | { refused: string };

/** What a Solana wallet without SOL for the network fee is told before any order is opened. */
export const NEEDS_SOL = "You need a little SOL to send from Solana.";

/** What a bridged deposit needs from the wallet: its provider, its address, and a move to the source chain. */
export type BridgeWallet = {
    provider: WalletProvider;
    from: string;
    ensure(chainId: number): Promise<"ready" | "declined" | "switch_failed" | "wrong_network">;
};

/** What a swap needs from the wallets: the EVM one to send from, and the Solana one to sign with. */
export type SwapSigner = {
    evm?: { from: string; provider: WalletProvider; ensure(chainId: number): Promise<NetworkCheck> };
    /** Signs, sends and returns the base58 signature of a Solana transaction. */
    solana?: { address: string; signAndSend(tx: Uint8Array): Promise<string> };
};

/** How the wallet took a swap: sent (the server follows it), turned down, refused with a message, or on the wrong network. */
export type SwapResult =
    | { status: "sent"; order: SwapOrderView }
    | { status: "cancelled" }
    | { status: "failed"; message: string }
    | { status: "switch_failed"; network: string };

export type AccountSnapshot = {
    state: AccountState;
    notice: DepositNotice | null;
    balances: BalancesView | null;
    /** The coins the account's wallets hold on the swap networks; null until a snapshot (cached or pushed) is in. */
    swapHoldings: SwapHoldingsView | null;
    /** The account's open swap orders and those settled in the last 7 days, newest first. */
    swaps: SwapOrderView[];
    /** Why the last prediction didn't go through, or that it couldn't be sent. */
    tradeNotice: { message: string } | null;
    /** `bound` counts the sockets bound to the account; `changed` counts the server's `pnl:changed` pushes. */
    pnl: { bound: number; changed: number };
};

/** What the person is told when a placed prediction fails on the server. */
const FAILURE_COPY: Record<PredictionFailure, string> = {
    price_moved: "The price moved, so your prediction didn't go through. Nothing was spent.",
    market_closed: "This market just closed. Nothing was spent.",
    unavailable: "Polymarket isn't answering. Nothing was spent.",
    rejected: "Your prediction didn't go through. Nothing was spent.",
};
const PRICE_MOVED_COPY = "The price moved, so the trade didn't go through. Nothing was spent.";
export const OFFLINE_COPY = "You're offline. Nothing was spent.";
const SELL_FAILED_COPY = "Couldn't sell right now. Your position is back.";
const WITHDRAW_FAILED_COPY = "Didn't go through. Your balance is back.";
/** The price sent when none is known; the exchange takes the best bid anyway, within a cent of it. */
const UNQUOTED_SELL_PRICE = 0.01;

/** EIP-1193's code for a request the user turned down in their wallet. */
const USER_REJECTED = 4001;
/** Arc drops transactions offering under 20 gwei, so this leaves room for the base fee to rise. */
const MAX_FEE_PER_GAS = parseGwei("40");
const PRIORITY_FEE_PER_GAS = parseGwei("1");
/** The server waits up to 30s for a transaction to land; this covers that and the round trip. */
const REPORT_TIMEOUT_MS = 45_000;
const CONNECT_TIMEOUT_MS = 15_000;
const RECEIPT_POLL_MS = 1_000;
const RECEIPT_TIMEOUT_MS = 120_000;
const CREDITED_NOTICE_MS = 5_000;
const TRADE_NOTICE_MS = 8_000;
const MAX_RETRY_MS = 30_000;

const SWAPS_UNAVAILABLE = "Swaps aren't available right now.";
const MAX_SWAPS = 50;

/** The list with the order put in at the top, or in place of its earlier copy. */
const withSwap = (swaps: SwapOrderView[], order: SwapOrderView) =>
    swaps.some((o) => o.id === order.id)
        ? swaps.map((o) => (o.id === order.id ? order : o))
        : [order, ...swaps].slice(0, MAX_SWAPS);

const REJECTED_WORDING = /reject|declin|denied|cancel/i;
/** Lamports a Solana wallet needs to pay the network fee (about 0.00001 SOL is quoted). */
const MIN_FEE_LAMPORTS = BigInt(10_000);

const UNREACHABLE: ApiError = { code: "unavailable", message: "Couldn't reach the server. Retrying…" };
/** Failures worth asking again about; the rest (a wallet that isn't the user's, say) won't change by retrying. */
const RETRYABLE = new Set<ApiError["code"]>(["unavailable", "internal", "rate_limited"]);

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The signed-in person's account on the server, kept live over a socket.
 * Deposits are optimistic: one counts the moment the wallet sends it, and
 * comes back out if the server can't confirm it.
 */
export class AccountClient {
    readonly #url: string;
    #snapshot: AccountSnapshot = {
        state: initialAccountState,
        notice: null,
        balances: null,
        swapHoldings: null,
        swaps: [],
        tradeNotice: null,
        pnl: { bound: 0, changed: 0 },
    };
    readonly #listeners = new Set<() => void>();
    #socket: AppSocket | null = null;
    #userId: string | null = null;
    #retry: ReturnType<typeof setTimeout> | undefined;
    #noticeTimer: ReturnType<typeof setTimeout> | undefined;
    #tradeTimer: ReturnType<typeof setTimeout> | undefined;
    #attempt = 0;
    /** Counts socket connections, so a trade can tell it was sent on an earlier one. */
    #connection = 0;
    /** Deposits being confirmed right now, so a reconnect doesn't report one twice. */
    readonly #confirming = new Set<string>();
    /** Swap orders whose hashes are being reported right now. */
    readonly #reporting = new Set<string>();
    /** The socket whose `account:open` has succeeded; swap hashes are reported only on it. */
    #bound: AppSocket | null = null;
    /** The rows lowered for swaps still open, so a settled order puts back only its own. */
    #tracking: Tracking = {};

    constructor(url: string) {
        this.#url = url;
    }

    subscribe = (listener: () => void) => {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    };

    getSnapshot = () => this.#snapshot;

    /** Binds to the Privy user's account, using the access token for every (re)connect. A no-op if already bound to them. */
    connect(userId: string, accessToken: () => Promise<string | null>) {
        if (this.#socket && this.#userId === userId) return;
        this.disconnect();
        this.#userId = userId;
        // The last snapshot shows at once; the server's push replaces it.
        this.#snapshot = {
            ...this.#snapshot,
            balances: loadCachedBalances(userId),
            swapHoldings: loadCachedSwapHoldings(userId),
        };
        this.#emit();
        this.#dispatch({ type: "connecting" });

        const socket: AppSocket = io(this.#url, {
            transports: ["websocket"],
            // Fetched again on each reconnect, so an expired token is replaced.
            auth: (done) => {
                accessToken().then(
                    (token) => done({ token: token ?? "" }),
                    () => done({ token: "" }),
                );
            },
            reconnectionDelayMax: 10_000,
        });
        this.#socket = socket;

        socket.on("connect", () => {
            this.#attempt = 0;
            this.#connection++;
            this.#bound = null;
            void this.#bind(socket);
        });
        socket.on("deposit:credited", ({ deposit, account }) => {
            this.#dispatch({ type: "credited", deposit, account });
        });
        socket.on("deposit:progress", ({ order }) => {
            this.#dispatch({ type: "order", order });
        });
        socket.on("prediction:update", (update) => {
            this.#dispatch({ type: "prediction", update });
            const { order } = update;
            if (order.state !== "failed") return;
            this.#tradeNotice(order.side === "sell" ? SELL_FAILED_COPY : FAILURE_COPY[order.reason ?? "rejected"]);
        });
        socket.on("perp:update", (update) => {
            this.#dispatch({ type: "perp", update });
            const { order, position } = update;
            // A rejection, a partial fill or a liquidation carries the words the person is told.
            if (
                order.reason &&
                (order.state === "rejected" || order.state === "filled" || position?.state === "liquidated")
            )
                this.#tradeNotice(order.reason);
        });
        socket.on("perps", (perps) => {
            this.#dispatch({ type: "perpsSnapshot", perps, connection: this.#connection });
        });
        socket.on("withdrawal:update", ({ withdrawal, account }) => {
            this.#dispatch({ type: "withdrawal", withdrawal, account });
            if (withdrawal.state === "failed")
                this.#notify({ kind: "reverted", message: WITHDRAW_FAILED_COPY, withdrawal: true });
        });
        socket.on("holdings:update", ({ holdings }) => {
            this.#dispatch({ type: "holdings", holdings });
        });
        socket.on("trade:filled", (trade) => {
            this.#dispatch({ type: "spot-settled", requestId: trade.requestId });
        });
        socket.on("holding:withdrawal", (withdrawal) => {
            this.#dispatch({ type: "coin-withdrawal", withdrawal });
        });
        socket.on("position:settled", ({ position, account }) => {
            this.#dispatch({ type: "position-settled", position, account });
        });
        socket.on("positions", (positions) => {
            this.#dispatch({ type: "positions", positions, connection: this.#connection });
        });
        socket.on("balances", (view) => {
            if (this.#userId) saveCachedBalances(this.#userId, view);
            this.#snapshot = { ...this.#snapshot, balances: view };
            this.#emit();
        });
        socket.on("swap:holdings", (pushed) => {
            const view = validHoldings(pushed);
            if (!view) return;
            if (this.#userId) saveCachedSwapHoldings(this.#userId, view);
            // A read replaces every row, the ones this client changed included.
            this.#tracking = {};
            this.#snapshot = { ...this.#snapshot, swapHoldings: view };
            this.#emit();
        });
        socket.on("swaps", ({ orders }) => {
            this.#snapshot = { ...this.#snapshot, swaps: orders };
            this.#emit();
        });
        socket.on("swap:update", ({ order }) => this.#swapUpdated(order));
        socket.on("pnl:changed", () => {
            const { pnl } = this.#snapshot;
            this.#snapshot = { ...this.#snapshot, pnl: { ...pnl, changed: pnl.changed + 1 } };
            this.#emit();
        });
        socket.on("disconnect", (reason) => {
            this.#bound = null;
            // The server hung up (its token check expired); a fresh token brings it back.
            if (reason === "io server disconnect") socket.connect();
        });
        socket.on("connect_error", (error) => {
            // A dropped transport retries by itself; a refusal from the server doesn't.
            if (socket.active) return;
            const refusal = (error as Error & { data?: ApiError }).data;
            this.#dispatch({ type: "failed", error: refusal ?? UNREACHABLE });
            clearTimeout(this.#retry);
            this.#retry = setTimeout(() => socket.connect(), Math.min(MAX_RETRY_MS, 1_000 * 2 ** this.#attempt++));
        });
    }

    /** Binds the socket to the person's account, asking again while the server can't answer. */
    async #bind(socket: AppSocket) {
        for (let attempt = 0; ; attempt++) {
            const result = await socket
                .timeout(CONNECT_TIMEOUT_MS)
                .emitWithAck("account:open", {})
                .catch(() => null);
            if (this.#socket !== socket || !socket.connected) return;
            if (result?.ok) {
                this.#dispatch({ type: "session", session: result.data });
                this.#bound = socket;
                const { pnl } = this.#snapshot;
                this.#snapshot = { ...this.#snapshot, pnl: { ...pnl, bound: pnl.bound + 1 } };
                this.#emit();
                // Deposits still pending from before a reconnect are reported again.
                const { state } = this.#snapshot;
                if (state.status === "ready") {
                    for (const p of state.pending) void this.#confirm(socket, p.txHash, p.amount);
                }
                // Swap hashes the server never acknowledged are reported again.
                void this.#reportSwapHashes(socket);
                return;
            }
            const error = result?.error ?? UNREACHABLE;
            this.#dispatch({ type: "failed", error });
            if (!RETRYABLE.has(error.code)) return;
            await pause(Math.min(MAX_RETRY_MS, 1_000 * 2 ** attempt));
            if (this.#socket !== socket || !socket.connected) return;
        }
    }

    disconnect() {
        clearTimeout(this.#retry);
        clearTimeout(this.#noticeTimer);
        clearTimeout(this.#tradeTimer);
        this.#socket?.removeAllListeners();
        this.#socket?.disconnect();
        this.#socket = null;
        this.#userId = null;
        this.#attempt = 0;
        this.#confirming.clear();
        this.#reporting.clear();
        this.#bound = null;
        this.#tracking = {};
        resetPnlStores();
        const { state, notice, balances, swapHoldings, swaps, tradeNotice, pnl } = this.#snapshot;
        if (
            state.status !== "idle" ||
            notice ||
            balances ||
            swapHoldings ||
            swaps.length ||
            tradeNotice ||
            pnl.bound !== 0 ||
            pnl.changed !== 0
        ) {
            this.#snapshot = {
                state: initialAccountState,
                notice: null,
                balances: null,
                swapHoldings: null,
                swaps: [],
                tradeNotice: null,
                pnl: { bound: 0, changed: 0 },
            };
            this.#emit();
        }
    }

    /**
     * Sends `amount` USDC from the wallet to the account's deposit address and
     * counts it straight away. Resolves once the wallet has sent it; the
     * server's confirmation follows in the notice.
     */
    async deposit(amount: string, wallet: { provider: WalletProvider; from: string }): Promise<DepositResult> {
        const { state } = this.#snapshot;
        const socket = this.#socket;
        if (state.status !== "ready" || !socket) return "failed";
        const value = toWei(amount);

        let txHash: Hex;
        try {
            txHash = (await wallet.provider.request({
                method: "eth_sendTransaction",
                params: [
                    {
                        from: wallet.from,
                        to: state.account.depositAddress,
                        value: toHex(value),
                        // Named, so a wallet that has moved to another network refuses it rather than sending that network's coin.
                        chainId: toHex(state.rules.chainId),
                        maxFeePerGas: toHex(MAX_FEE_PER_GAS),
                        maxPriorityFeePerGas: toHex(PRIORITY_FEE_PER_GAS),
                    },
                ],
            })) as Hex;
        } catch (error) {
            return (error as { code?: unknown }).code === USER_REJECTED ? "cancelled" : "failed";
        }
        if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return "failed";
        // The user signed out or switched wallets while the wallet was open; that account's server
        // credits the deposit, and it mustn't show up in this one.
        if (this.#socket !== socket) return "sent";

        this.#dispatch({ type: "sent", txHash, amount: value, sentAt: Date.now() });
        this.#notify({ kind: "confirming", amount: value });
        this.#dropBalance("arc:USDC", wallet.from, amount);
        void this.#confirm(socket, txHash, value);
        return "sent";
    }

    /** What `amount` of `coin` in `wallet` would pay out in USDC on Arc. */
    async quote(coin: string, amount: string, wallet: string): Promise<DepositQuoteView | ApiError> {
        const socket = this.#socket;
        if (this.#snapshot.state.status !== "ready" || !socket) return UNREACHABLE;
        const result = await socket
            .timeout(CONNECT_TIMEOUT_MS)
            .emitWithAck("deposit:quote", { coin, amount, wallet })
            .catch(() => null);
        if (!result) return UNREACHABLE;
        return result.ok ? result.data : result.error;
    }

    /** The balance and PnL series, cut into days of the zone `tz`. */
    async loadPnlSeries(tz: string): Promise<PnlSeries | ApiError> {
        const socket = this.#socket;
        if (this.#snapshot.state.status !== "ready" || !socket || this.#bound !== socket) return UNREACHABLE;
        const result = await socket
            .timeout(CONNECT_TIMEOUT_MS)
            .emitWithAck("pnl:series", { tz })
            .catch(() => null);
        if (!result) return UNREACHABLE;
        return result.ok ? result.data : result.error;
    }

    /** One page of the account's history under `filter`, the one after the cursor `before` or the newest */
    async loadActivityPage(req: { before?: string; filter: ActivityFilter }): Promise<ActivityPage | ApiError> {
        const socket = this.#socket;
        if (this.#snapshot.state.status !== "ready" || !socket || this.#bound !== socket) return UNREACHABLE;
        const result = await socket
            .timeout(CONNECT_TIMEOUT_MS)
            .emitWithAck("activity:list", { filter: req.filter, ...(req.before ? { before: req.before } : {}) })
            .catch(() => null);
        if (!result) return UNREACHABLE;
        return result.ok ? result.data : result.error;
    }

    /** What a withdrawal may be right now. */
    async withdrawLimits(): Promise<WithdrawLimits | ApiError> {
        const socket = this.#socket;
        if (this.#snapshot.state.status !== "ready" || !socket) return UNREACHABLE;
        const result = await socket
            .timeout(CONNECT_TIMEOUT_MS)
            .emitWithAck("withdraw:limits", {})
            .catch(() => null);
        if (!result) return UNREACHABLE;
        return result.ok ? result.data : result.error;
    }

    /** What a withdrawal of `amount` to the Solana wallet `to` would cost and deliver; nothing is taken. */
    async withdrawQuote(amount: string, to: string): Promise<WithdrawQuote | ApiError> {
        const socket = this.#socket;
        if (this.#snapshot.state.status !== "ready" || !socket) return UNREACHABLE;
        const result = await socket
            .timeout(CONNECT_TIMEOUT_MS)
            .emitWithAck("withdraw:quote", { amount, to })
            .catch(() => null);
        if (!result) return UNREACHABLE;
        return result.ok ? result.data : result.error;
    }

    /**
     * Withdraws `amount` USDC to `to` and counts it at once; `reviewedFee` is the fee the person saw for a Solana wallet.
     * A refusal rolls it back with the server's message; "changed" means the fee rose past what was shown, nothing was
     * taken and the person is asked again; a missing answer leaves it counted, since the server may have taken it.
     */
    async withdraw(
        amount: string,
        to: string,
        reviewedFee?: string,
    ): Promise<"sent" | "refused" | "failed" | "changed"> {
        const socket = this.#socket;
        if (this.#snapshot.state.status !== "ready" || !socket?.connected) return "failed";
        const requestId = crypto.randomUUID();
        this.#dispatch({ type: "withdraw", withdrawal: { requestId, amount: toWei(amount), to, at: Date.now() } });
        const result = await socket
            .timeout(REPORT_TIMEOUT_MS)
            .emitWithAck("withdraw:create", { requestId, amount, to, ...(reviewedFee ? { reviewedFee } : {}) })
            .catch(() => null);
        if (this.#socket !== socket || !result) return "failed";
        if (result.ok) {
            const { account, ...withdrawal } = result.data;
            this.#dispatch({ type: "withdrawal", withdrawal, account });
            return "sent";
        }
        this.#dispatch({ type: "withdraw-refused", requestId });
        if (result.error.code === "quote_changed") return "changed";
        this.#notify({ kind: "reverted", message: result.error.message });
        return "refused";
    }

    /** What a prediction buy would cost and return right now. */
    async quotePrediction(input: {
        eventId: string;
        tokenId: string;
        amountUSD: string;
    }): Promise<QuoteView | ApiError> {
        const socket = this.#socket;
        if (this.#snapshot.state.status !== "ready" || !socket) return UNREACHABLE;
        const result = await socket
            .timeout(CONNECT_TIMEOUT_MS)
            .emitWithAck("prediction:quote", input)
            .catch(() => null);
        if (!result) return UNREACHABLE;
        return result.ok ? result.data : result.error;
    }

    /**
     * Places a prediction buy and counts it at once. The server's push decides the outcome;
     * only a refusal rolls it back here, and a missing answer leaves it accepted.
     */
    placePrediction(input: {
        eventId: string;
        tokenId: string;
        amountUSD: string;
        quotedPrice: number;
        question: string;
        outcome: string;
        shares: string;
    }): { requestId: string; sent: boolean } {
        const requestId = crypto.randomUUID();
        const socket = this.#socket;
        this.#tradeNotice(null);
        if (this.#snapshot.state.status !== "ready" || !socket?.connected) {
            this.#tradeNotice(OFFLINE_COPY);
            return { requestId, sent: false };
        }
        const { question, outcome, shares, ...wire } = input;
        this.#dispatch({
            type: "predict",
            trade: {
                requestId,
                side: "buy",
                eventId: input.eventId,
                tokenId: input.tokenId,
                question,
                outcome,
                amountWei: toWei(input.amountUSD),
                shares,
                at: Date.now(),
                connection: this.#connection,
            },
        });
        void socket
            .timeout(REPORT_TIMEOUT_MS)
            .emitWithAck("prediction:order", { requestId, ...wire })
            .catch(() => null)
            .then((result) => {
                if (this.#socket !== socket || !result) return;
                if (result.ok) {
                    const { account, ...order } = result.data;
                    this.#dispatch({ type: "placed", order, account });
                    return;
                }
                this.#dispatch({ type: "predict-failed", requestId });
                this.#tradeNotice(result.error.message);
            });
        return { requestId, sent: true };
    }

    /**
     * Sells a whole position and counts the proceeds at once, hiding the position. The server's push
     * decides the outcome; only a refusal rolls it back here, and a missing answer leaves it accepted.
     */
    closePosition(position: PositionView, sellPrice: number | null): void {
        const requestId = crypto.randomUUID();
        const socket = this.#socket;
        this.#tradeNotice(null);
        if (this.#snapshot.state.status !== "ready" || !socket?.connected) {
            this.#tradeNotice(OFFLINE_COPY);
            return;
        }
        const estimate = sellPrice === null ? 0 : sellableShares(position.shares) * sellPrice;
        this.#dispatch({
            type: "predict",
            trade: {
                requestId,
                side: "sell",
                positionId: position.id,
                proceedsWei: toWei(estimate.toFixed(6)),
                at: Date.now(),
                connection: this.#connection,
            },
        });
        void socket
            .timeout(REPORT_TIMEOUT_MS)
            .emitWithAck("prediction:close", {
                requestId,
                positionId: position.id,
                quotedPrice: sellPrice ?? UNQUOTED_SELL_PRICE,
            })
            .catch(() => null)
            .then((result) => {
                if (this.#socket !== socket || !result || result.ok) return;
                this.#dispatch({ type: "predict-failed", requestId });
                this.#tradeNotice(result.error.message);
            });
    }

    /** What opening a perp position would cost right now. */
    async quotePerp(req: PerpQuoteRequest): Promise<PerpQuoteView | ApiError> {
        const socket = this.#socket;
        if (this.#snapshot.state.status !== "ready" || !socket) return UNREACHABLE;
        const result = await socket
            .timeout(CONNECT_TIMEOUT_MS)
            .emitWithAck("perp:quote", req)
            .catch(() => null);
        if (!result) return UNREACHABLE;
        return result.ok ? result.data : result.error;
    }

    /**
     * Opens a perp position and counts it at once: the collateral leaves the shown balance and a pending
     * position with the quote's size and entry stands in. The server's push decides the outcome;
     * only a refusal rolls it back here, and a missing answer leaves it accepted.
     */
    placePerp(req: PerpOrderRequest, quote: PerpQuoteView): { requestId: string; sent: boolean } {
        const { requestId } = req;
        const socket = this.#socket;
        this.#tradeNotice(null);
        if (this.#snapshot.state.status !== "ready" || !socket?.connected) {
            this.#tradeNotice(OFFLINE_COPY);
            return { requestId, sent: false };
        }
        const now = new Date().toISOString();
        const position: PerpPositionView = {
            id: pendingPerpId(requestId),
            asset: req.asset,
            side: req.side,
            leverage: req.leverage,
            sizeCoin: quote.sizeCoin,
            entryPx: quote.entryPx,
            collateralUSD: req.collateralUSD,
            liquidationPx: quote.liquidationPx,
            markPx: null,
            unrealizedPnlUSD: "0",
            cumFundingUSD: "0",
            state: "open",
            proceedsUSD: null,
            notice: null,
            openedAt: now,
            settledAt: null,
            updatedAt: now,
        };
        this.#dispatch({
            type: "perpAccepted",
            requestId,
            position,
            collateralWei: toWei(req.collateralUSD),
            connection: this.#connection,
        });
        void socket
            .timeout(REPORT_TIMEOUT_MS)
            .emitWithAck("perp:order", req)
            .catch(() => null)
            .then((result) => {
                if (this.#socket !== socket || !result) return;
                if (result.ok) {
                    const { account, order } = result.data;
                    this.#dispatch({ type: "perp", update: { order, position: null, account } });
                    return;
                }
                this.#dispatch({ type: "perpFailed", requestId });
                this.#tradeNotice(result.error.message);
            });
        return { requestId, sent: true };
    }

    /** Closes a whole perp position; the server's push says how it went, and a refusal is shown here. */
    async closePerp(positionId: string): Promise<void> {
        const socket = this.#socket;
        this.#tradeNotice(null);
        if (this.#snapshot.state.status !== "ready" || !socket?.connected) {
            this.#tradeNotice(OFFLINE_COPY);
            return;
        }
        const result = await socket
            .timeout(REPORT_TIMEOUT_MS)
            .emitWithAck("perp:close", { requestId: crypto.randomUUID(), positionId })
            .catch(() => null);
        if (this.#socket !== socket || !result || result.ok) return;
        this.#tradeNotice(result.error.message);
    }

    /**
     * Buys, sells or swaps from the balance and counts it at once; the answer settles it with the server's balance and
     * coins, a refusal rolls it back with the server's message, and a missing answer leaves it counted.
     */
    placeTrade(req: TradeOrderRequest): { requestId: string; sent: boolean } {
        const { requestId } = req;
        const socket = this.#socket;
        const estimate = estimateTrade(req);
        this.#tradeNotice(null);
        if (this.#snapshot.state.status !== "ready" || !socket?.connected || !estimate) {
            this.#tradeNotice(OFFLINE_COPY);
            return { requestId, sent: false };
        }
        this.#dispatch({ type: "spot", trade: estimate });
        void socket
            .timeout(REPORT_TIMEOUT_MS)
            .emitWithAck("trade:order", req)
            .catch(() => null)
            .then((result) => {
                if (this.#socket !== socket || !result) return;
                if (result.ok) {
                    this.#dispatch({
                        type: "spot-filled",
                        requestId,
                        balance: result.balance,
                        holdings: result.holdings,
                    });
                    return;
                }
                this.#dispatch({ type: "spot-failed", requestId });
                this.#tradeNotice(result.code === "price_moved" ? PRICE_MOVED_COPY : result.message);
            });
        return { requestId, sent: true };
    }

    /** Sends a held coin to the person's own address and counts it as gone at once; a refusal puts it back with the server's message. */
    withdrawHolding(req: CoinWithdrawRequest): { requestId: string; sent: boolean } {
        const { requestId } = req;
        const socket = this.#socket;
        this.#tradeNotice(null);
        if (this.#snapshot.state.status !== "ready" || !socket?.connected) {
            this.#tradeNotice(OFFLINE_COPY);
            return { requestId, sent: false };
        }
        this.#dispatch({ type: "coin-send", send: { requestId, symbol: req.symbol, units: req.units } });
        void socket
            .timeout(REPORT_TIMEOUT_MS)
            .emitWithAck("holding:withdraw", req)
            .catch(() => null)
            .then((result) => {
                if (this.#socket !== socket || !result) return;
                if (result.ok) {
                    this.#dispatch({
                        type: "coin-withdrawal",
                        withdrawal: result.withdrawal,
                        holdings: result.holdings,
                    });
                    return;
                }
                this.#dispatch({ type: "coin-send-failed", requestId });
                this.#tradeNotice(result.message);
            });
        return { requestId, sent: true };
    }

    dismissTradeNotice() {
        this.#tradeNotice(null);
    }

    #tradeNotice(message: string | null) {
        clearTimeout(this.#tradeTimer);
        const tradeNotice = message ? { message } : null;
        if (!tradeNotice && !this.#snapshot.tradeNotice) return;
        this.#snapshot = { ...this.#snapshot, tradeNotice };
        this.#emit();
        if (tradeNotice) {
            this.#tradeTimer = setTimeout(() => {
                if (this.#snapshot.tradeNotice === tradeNotice) this.#tradeNotice(null);
            }, TRADE_NOTICE_MS);
        }
    }

    /**
     * Opens a bridge order and has the wallet sign its transactions one by one, each
     * once the one before has landed. The server follows the order from the hashes on.
     */
    async bridgeDeposit(coin: string, amount: string, wallet: BridgeWallet): Promise<DepositResult> {
        const socket = this.#socket;
        if (this.#snapshot.state.status !== "ready" || !socket) return "failed";
        try {
            const opened = await socket
                .timeout(CONNECT_TIMEOUT_MS)
                .emitWithAck("deposit:order", { coin, amount, wallet: wallet.from })
                .catch(() => null);
            if (!opened || this.#socket !== socket) return "failed";
            if (!opened.ok) return { refused: opened.error.message };
            const { order, txs } = opened.data;
            this.#dispatch({ type: "order", order });

            const hashes: Hex[] = [];
            for (const [i, tx] of txs.entries()) {
                const network = await wallet.ensure(tx.chainId);
                if (network === "declined") return "cancelled";
                if (network !== "ready") return network;
                const hash = (await wallet.provider.request({
                    method: "eth_sendTransaction",
                    params: [
                        { from: wallet.from, to: tx.to, data: tx.data, value: tx.value, chainId: toHex(tx.chainId) },
                    ],
                })) as Hex;
                if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return "failed";
                hashes.push(hash);
                if (i < txs.length - 1 && !(await this.#landed(wallet.provider, hash))) return "failed";
            }
            if (this.#socket !== socket) return "sent";

            const reported = await socket
                .timeout(CONNECT_TIMEOUT_MS)
                .emitWithAck("deposit:source", { orderId: order.id, txHashes: hashes })
                .catch(() => null);
            if (reported?.ok) this.#dispatch({ type: "order", order: reported.data });
            this.#dropBalance(coin, wallet.from, amount);
            return "sent";
        } catch (error) {
            return (error as { code?: unknown }).code === USER_REJECTED ? "cancelled" : "failed";
        }
    }

    /**
     * Opens a Solana deposit order, builds its transaction on a fresh blockhash and has the wallet
     * sign and send it. The server follows the order from the signature on.
     */
    async solanaDeposit(
        coin: string,
        amount: string,
        wallet: { address: string; signer: SwapSigner["solana"]; solBalance: bigint | null },
    ): Promise<DepositResult> {
        const socket = this.#socket;
        if (this.#snapshot.state.status !== "ready" || !socket || !wallet.signer) return "failed";
        if (wallet.solBalance !== null && wallet.solBalance < MIN_FEE_LAMPORTS) return "needs_sol";
        try {
            // The quote says what the transaction costs in SOL (a CCTP burn also pays rent), so a short wallet is told before an order opens.
            if (wallet.solBalance !== null) {
                const quoted = await this.quote(coin, amount, wallet.address);
                if (this.#socket !== socket) return "failed";
                if ("code" in quoted) return { refused: quoted.message };
                if (quoted.sol && wallet.solBalance < BigInt(quoted.sol.needed)) return "needs_sol";
            }
            const opened = await socket
                .timeout(CONNECT_TIMEOUT_MS)
                .emitWithAck("deposit:order", { coin, amount, wallet: wallet.address })
                .catch(() => null);
            if (!opened || this.#socket !== socket) return "failed";
            if (!opened.ok) return { refused: opened.error.message };
            const { order, txs } = opened.data;
            this.#dispatch({ type: "order", order });
            const tx = txs[0];
            if (txs.length !== 1 || tx?.kind !== "solana") return "failed";

            // Fetched right before signing, so the blockhash is as fresh as the wallet prompt allows.
            const recent = await socket
                .timeout(CONNECT_TIMEOUT_MS)
                .emitWithAck("solana:blockhash", {})
                .catch(() => null);
            if (!recent?.ok || this.#socket !== socket) return "failed";
            const { instructions, keyPairs } = await withFreshSigners(tx.instructions);
            const bytes = await signWithFreshKeys(
                buildDepositTransaction({
                    payer: wallet.address,
                    blockhash: recent.data,
                    instructions,
                    lookupTables: tx.lookupTables,
                }),
                keyPairs,
            );
            const signature = await wallet.signer.signAndSend(bytes);
            if (typeof signature !== "string" || signature === "") return "failed";
            if (this.#socket !== socket) return "sent";

            const reported = await socket
                .timeout(CONNECT_TIMEOUT_MS)
                .emitWithAck("deposit:source", { orderId: order.id, txHashes: [signature] })
                .catch(() => null);
            if (reported?.ok) this.#dispatch({ type: "order", order: reported.data });
            this.#dropBalance(coin, wallet.address, amount);
            return "sent";
        } catch (error) {
            const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
            const rejected = code === USER_REJECTED || (typeof message === "string" && REJECTED_WORDING.test(message));
            return rejected ? "cancelled" : "failed";
        }
    }

    /** Whether a transaction succeeded in a block within 120 s, asking the wallet every second. */
    async #landed(provider: WalletProvider, hash: Hex) {
        const deadline = Date.now() + RECEIPT_TIMEOUT_MS;
        while (Date.now() < deadline) {
            const receipt = (await provider.request({ method: "eth_getTransactionReceipt", params: [hash] })) as {
                status?: string;
            } | null;
            if (receipt) return receipt.status !== "0x0";
            await pause(RECEIPT_POLL_MS);
        }
        return false;
    }

    /**
     * Has the server credit a sent deposit, or takes it back out if the server
     * says it can't be. Losing the connection decides nothing: the deposit
     * stays pending and is reported again once the socket is back.
     */
    async #confirm(socket: AppSocket, txHash: Hex, value: bigint) {
        const key = txHash.toLowerCase();
        if (this.#confirming.has(key)) return;
        this.#confirming.add(key);
        const result = await socket
            .timeout(REPORT_TIMEOUT_MS)
            .emitWithAck("deposit:submit", { txHash })
            .catch(() => null)
            .finally(() => this.#confirming.delete(key));
        if (this.#socket !== socket || result === null) return;
        if (result.ok) {
            this.#dispatch({ type: "settled", receipt: result.data });
            this.#notify({ kind: "credited", amount: value }, CREDITED_NOTICE_MS);
            return;
        }
        // The chain scan may have credited it while the report failed.
        const { state } = this.#snapshot;
        if (state.status === "ready" && state.deposits.some((d) => d.txHash.toLowerCase() === txHash.toLowerCase())) {
            this.#notify({ kind: "credited", amount: value }, CREDITED_NOTICE_MS);
            return;
        }
        this.#dispatch({ type: "reverted", txHash });
        this.#notify({ kind: "reverted", message: result.error.message });
    }

    /**
     * Asks the server for fresh balances, silently. Nothing is sent while the view is under 30 s old,
     * unless one of `wallets` has no rows in it yet.
     */
    refreshBalances(wallets: string[] = []) {
        const socket = this.#socket;
        if (!socket || this.#snapshot.state.status !== "ready") return;
        if (!needsRefresh(this.#snapshot.balances, wallets, Date.now())) return;
        socket.emit("balances:refresh", {}, () => undefined);
    }

    /** Asks the server to read the wallets' swap coins again, silently; it skips a read within 15 s of the last. */
    refreshSwapHoldings() {
        const socket = this.#socket;
        if (!socket?.connected || this.#snapshot.state.status !== "ready") return;
        socket.emit("swap:holdings:refresh", {}, () => undefined);
    }

    /** What a swap would pay right now, with no order opened. */
    async quoteSwap(req: SwapRequest): Promise<SwapQuoteView | { error: ApiError }> {
        const socket = this.#socket;
        if (this.#snapshot.state.status !== "ready" || !socket) return { error: UNREACHABLE };
        const result = await socket
            .timeout(CONNECT_TIMEOUT_MS)
            .emitWithAck("swap:quote", req)
            .catch(() => null);
        if (!result) return { error: UNREACHABLE };
        return result.ok ? result.data : { error: result.error };
    }

    /**
     * Opens a swap order and has the wallet sign its transactions one by one, each once the one
     * before has landed. After the last, the paid amount leaves the shown holdings and the hashes
     * are reported; they are kept until the server acknowledges them. The order is listed only
     * once the wallet has sent it: one whose prompt was turned down never started.
     */
    async placeSwap(req: SwapRequest & { reviewedMin: string }, signer: SwapSigner): Promise<SwapResult> {
        const socket = this.#socket;
        const userId = this.#userId;
        if (this.#snapshot.state.status !== "ready" || !socket || !userId) {
            return { status: "failed", message: SWAPS_UNAVAILABLE };
        }
        const opened = await socket
            .timeout(CONNECT_TIMEOUT_MS)
            .emitWithAck("swap:order", req)
            .catch(() => null);
        if (!opened) return { status: "failed", message: SWAPS_UNAVAILABLE };
        if (!opened.ok) return { status: "failed", message: opened.error.message };
        const { order, txs } = opened.data;
        if (this.#socket !== socket) return { status: "failed", message: SWAPS_UNAVAILABLE };

        const hashes: string[] = [];
        try {
            for (const [i, tx] of txs.entries()) {
                const sent = await this.#signSwapTx(tx, signer);
                if (typeof sent !== "string") return sent;
                hashes.push(sent);
                if (i < txs.length - 1 && tx.kind === "evm" && signer.evm) {
                    if (!(await this.#landed(signer.evm.provider, sent as Hex))) {
                        return {
                            status: "failed",
                            message: `The swap failed, so your ${req.from.token} stayed in your wallet. Only the network fee was spent.`,
                        };
                    }
                }
            }
        } catch (error) {
            return this.#swapRefusal(error);
        }
        if (!hashes.length) return { status: "failed", message: SWAPS_UNAVAILABLE };

        keepUnreported(userId, { orderId: order.id, txHashes: hashes });
        if (this.#socket === socket) {
            // On its way as soon as the wallet sent it; the server's answer to the report replaces this.
            this.#showSwap({ ...order, state: "sent", txHashes: hashes, updatedAt: new Date().toISOString() });
            this.#tracking = trackOrder(this.#tracking, order.id, {
                paid: {
                    wallet: req.wallet,
                    network: req.from.network,
                    symbol: req.from.token,
                    amount: order.from.amount,
                },
                receiver: req.receiver,
                to: { network: req.to.network, symbol: req.to.token },
            });
            this.#changeHoldings((view) =>
                dropHolding(view, {
                    wallet: req.wallet,
                    network: req.from.network,
                    symbol: req.from.token,
                    amount: order.from.amount,
                }),
            );
            await this.#reportSwapHashes(socket);
        }
        return { status: "sent", order: this.#snapshot.swaps.find((o) => o.id === order.id) ?? order };
    }

    /** Has the wallet send one swap transaction and returns its hash, or why it didn't go. */
    async #signSwapTx(tx: SwapTxView, signer: SwapSigner): Promise<string | SwapResult> {
        if (tx.kind === "solana") {
            if (!signer.solana) return { status: "failed", message: SWAPS_UNAVAILABLE };
            const bytes = Uint8Array.from(atob(tx.data), (c) => c.charCodeAt(0));
            return signer.solana.signAndSend(bytes);
        }
        const wallet = signer.evm;
        if (!wallet) return { status: "failed", message: SWAPS_UNAVAILABLE };
        const network = await wallet.ensure(tx.chainId);
        if (network === "declined") return { status: "cancelled" };
        if (network !== "ready") return { status: "switch_failed", network: networkName(tx.chainId) };
        const hash = await wallet.provider.request({
            method: "eth_sendTransaction",
            params: [
                {
                    from: wallet.from,
                    to: tx.to,
                    data: tx.data,
                    value: toHex(BigInt(tx.value)),
                    chainId: toHex(tx.chainId),
                    // Arc drops transactions under its minimum fee, so the fee is set here, never taken from the quote.
                    ...(tx.chainId === arc.id
                        ? { maxFeePerGas: toHex(MAX_FEE_PER_GAS), maxPriorityFeePerGas: toHex(PRIORITY_FEE_PER_GAS) }
                        : {}),
                },
            ],
        });
        if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
            return { status: "failed", message: SWAPS_UNAVAILABLE };
        }
        return hash;
    }

    /** A turned-down wallet prompt is a cancel; any other failure is a refusal with the generic copy. */
    #swapRefusal(error: unknown): SwapResult {
        const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
        const rejected = code === USER_REJECTED || (typeof message === "string" && REJECTED_WORDING.test(message));
        return rejected ? { status: "cancelled" } : { status: "failed", message: SWAPS_UNAVAILABLE };
    }

    /** Reports the kept swap hashes once bound; only a settled answer about an order stops keeping its hashes. */
    async #reportSwapHashes(socket: AppSocket) {
        const userId = this.#userId;
        if (!userId) return;
        const bound = this.#bound === socket;
        await reportUnreported(
            userId,
            this.#reporting,
            async ({ orderId, txHashes }) => {
                const result = await socket
                    .timeout(REPORT_TIMEOUT_MS)
                    .emitWithAck("swap:sent", { orderId, txHashes })
                    .catch(() => null);
                if (this.#socket !== socket || !result) return false;
                if (result.ok) {
                    this.#swapUpdated(result.data);
                    return true;
                }
                return settlesReport(result);
            },
            bound,
        );
    }

    /** Puts an order into the list, or replaces it there, and nothing else. */
    #showSwap(order: SwapOrderView) {
        this.#snapshot = { ...this.#snapshot, swaps: withSwap(this.#snapshot.swaps, order) };
        this.#emit();
    }

    /** Puts an order into the list and settles the holdings rows this client changed for it. */
    #swapUpdated(order: SwapOrderView) {
        this.#snapshot = { ...this.#snapshot, swaps: withSwap(this.#snapshot.swaps, order) };
        const { swapHoldings } = this.#snapshot;
        if (swapHoldings && this.#tracking[order.id]) {
            const settled = settleHoldings(swapHoldings, this.#tracking, order);
            this.#tracking = settled.tracking;
            this.#changeHoldings(() => settled.view);
        }
        if (order.txHashes.length > 0 && this.#userId) clearUnreported(this.#userId, order.id);
        this.#emit();
    }

    /** Replaces the cached swap holdings with `change` applied; the next read corrects it. */
    #changeHoldings(change: (view: SwapHoldingsView) => SwapHoldingsView) {
        const { swapHoldings } = this.#snapshot;
        if (!swapHoldings) return;
        const view = change(swapHoldings);
        if (this.#userId) saveCachedSwapHoldings(this.#userId, view);
        this.#snapshot = { ...this.#snapshot, swapHoldings: view };
        this.#emit();
    }

    /** Takes a sent amount out of the shown balance; the next read corrects it. */
    #dropBalance(coin: string, wallet: string, amount: string) {
        const { balances } = this.#snapshot;
        if (!balances || !this.#userId) return;
        const view = dropAfterSend(balances, coin, wallet, amount);
        saveCachedBalances(this.#userId, view);
        this.#snapshot = { ...this.#snapshot, balances: view };
        this.#emit();
    }

    /** Older deposits, past the ones already loaded. */
    async loadOlder() {
        const { state } = this.#snapshot;
        if (state.status !== "ready" || !state.next || !this.#socket) return;
        const result = await this.#socket
            .timeout(CONNECT_TIMEOUT_MS)
            .emitWithAck("deposits:list", { before: state.next })
            .catch(() => null);
        if (result?.ok) this.#dispatch({ type: "older", deposits: result.data.items, next: result.data.next });
    }

    dismissNotice() {
        this.#notify(null);
    }

    #dispatch(action: AccountAction) {
        const state = accountReducer(this.#snapshot.state, action);
        if (state === this.#snapshot.state) return;
        this.#snapshot = { ...this.#snapshot, state };
        this.#emit();
    }

    #notify(notice: DepositNotice | null, clearAfterMs?: number) {
        clearTimeout(this.#noticeTimer);
        this.#snapshot = { ...this.#snapshot, notice };
        this.#emit();
        if (notice && clearAfterMs) {
            this.#noticeTimer = setTimeout(() => {
                if (this.#snapshot.notice === notice) this.#notify(null);
            }, clearAfterMs);
        }
    }

    #emit() {
        for (const listener of this.#listeners) listener();
    }
}
