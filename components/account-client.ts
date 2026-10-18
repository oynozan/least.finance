import { io, type Socket } from "socket.io-client";
import { formatUnits, parseGwei, toHex } from "viem";
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
import { estimateTrade, unconfirmedCopy, unsentCopy, whyNoEstimate } from "@/lib/account/spot";
import type { CoinWithdrawRequest, TradeOrderRequest } from "@/server/src/trading/types";
import { dropAfterSend, loadCachedBalances, needsRefresh, saveCachedBalances } from "@/lib/account/balances";
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
    WithdrawQuote,
} from "@/server/src/protocol";
import { buildDepositTransaction, signWithFreshKeys, withFreshSigners } from "@/lib/account/solana-tx";
import { oneLine, shortHash, walletFailure } from "@/lib/wallet/failure";
import { networkName, networkProblem, type NetworkCheck } from "@/lib/wallet/network";

type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** The minimal EIP-1193 surface a deposit needs from the wallet. */
export type WalletProvider = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

/** Where a deposit stands, as the sidebar tells it. */
export type DepositNotice =
    /** Sent from the wallet; the server is confirming it. `message` says why it is taking longer than usual. */
    | { kind: "confirming"; amount: bigint; message?: string }
    | { kind: "credited"; amount: bigint }
    /** The server couldn't confirm it, so it came back out of the balance. */
    /** `withdrawal`: a failed withdrawal, which the deposit button ignores. */
    | { kind: "reverted"; message: string; withdrawal?: true };

/**
 * How the wallet took a deposit: turned down, sent (and now being confirmed), or not sent with a reason.
 * `refused` is the server's reason for not opening the deposit, such as "That's too small to cover the fee."
 * `failed` is ours or the wallet's, in plain words: what went wrong and what to do.
 */
export type DepositResult = "cancelled" | "sent" | { refused: string } | { failed: string };

/** What a Solana wallet short of SOL is told before any order is opened, with the numbers. */
export function needsSolMessage(needed: bigint, have: bigint, rent: boolean) {
    return `You need about ${formatUnits(needed, 9)} SOL to send this from Solana (the network fee${rent ? " plus rent for the transfer" : ""}); your wallet has ${formatUnits(have, 9)} SOL.`;
}

/** What a bridged deposit needs from the wallet: its provider, its address, and a move to the source chain. */
export type BridgeWallet = {
    provider: WalletProvider;
    from: string;
    ensure(chainId: number): Promise<NetworkCheck>;
};

/** The Solana wallet a deposit is signed with: signs, sends and returns the base58 signature of a transaction. */
export type SolanaSigner = { address: string; signAndSend(tx: Uint8Array): Promise<string> };

export type AccountSnapshot = {
    state: AccountState;
    notice: DepositNotice | null;
    balances: BalancesView | null;
    /** Why the last prediction didn't go through, or that it couldn't be sent. */
    tradeNotice: { message: string } | null;
    /** `bound` counts the sockets bound to the account; `changed` counts the server's `pnl:changed` pushes. */
    pnl: { bound: number; changed: number };
};

/** What the person is told when a placed prediction fails and the server sent no message of its own. */
const FAILURE_COPY: Record<PredictionFailure, string> = {
    price_moved: "The price moved, so your prediction didn't go through. Nothing was spent.",
    market_closed: "This market just closed. Nothing was spent.",
    unavailable: "Polymarket isn't answering. Nothing was spent.",
    rejected: "Your prediction didn't go through. Nothing was spent.",
};
export const OFFLINE_COPY = "You're offline. Nothing was spent.";

/** An order handed to the server: `answer` settles with the refusal's words, or null once accepted or left unanswered. */
export type Placed = { requestId: string; sent: boolean; answer: Promise<string | null> };
/** How a withdrawal request ended; all but "sent", "refused" and a changed fee mean the server never answered. */
export type WithdrawResult =
    | "sent"
    | "refused"
    | "failed"
    | "offline"
    | "timeout"
    | "not-ready"
    | { problem: "changed"; message: string };
const SELL_FAILED_COPY = "Couldn't sell right now. Your position is back.";
/** Only for a failed withdrawal an older server sent no reason for. */
const WITHDRAW_FAILED_COPY = "The withdrawal failed, and no reason was recorded. Your balance is back.";
/** The price sent when none is known; the exchange takes the best bid anyway, within a cent of it. */
const UNQUOTED_SELL_PRICE = 0.01;

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
/** How long after the last try a sent deposit's hashes are offered to the server again, when it didn't take them. */
const REGISTER_RETRY_MS = [2_000, 4_000, 8_000, 16_000];
/** How many times a deposit the server can't find is asked about again before it stops counting. */
const NOT_FOUND_RETRIES = 3;

/** Lamports a Solana wallet needs to pay the network fee (about 0.00001 SOL is quoted). */
const MIN_FEE_LAMPORTS = BigInt(10_000);

const OFFLINE: ApiError = { code: "unavailable", message: "You're offline." };
const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;
const unanswered = (ms: number): ApiError => ({
    code: "unavailable",
    message: `The server didn't answer in ${Math.round(ms / 1000)} seconds.`,
});
/** Why a connection attempt failed, from the transport's own words ("websocket error"). */
const connectFailed = (error: Error): ApiError =>
    isOffline()
        ? OFFLINE
        : { code: "unavailable", message: `Couldn't connect to the server (${error.message}). Retrying…` };

/** Why an acknowledgement never came: the connection was gone, or the server was too slow. */
const noAnswer = (socket: { connected: boolean }, what: string, waitMs: number) =>
    socket.connected
        ? `The server didn't confirm ${what} within ${waitMs / 1000} seconds.`
        : `You went offline before the server confirmed ${what}.`;

/** Why the server gave no answer, said as it was: offline, or no answer in time. */
const silence = () =>
    isOffline() ? "You're offline" : `The server didn't answer in ${CONNECT_TIMEOUT_MS / 1000} seconds`;
/** Said when a deposit can't start because the account isn't open or the server went quiet; nothing has left the wallet. */
const notSent = (reason: string) => ({ failed: `${reason}, so nothing was sent from your wallet.` });
const SIGNED_OUT = { failed: "You were signed out while this was open, so nothing was sent." };
/** Said when a wallet answers a send with something that is not a hash; the deposit may have gone. */
const notAHash = (value: unknown) => {
    console.warn("Your wallet answered a send with something other than a transaction hash", value);
    return {
        failed: `Your wallet answered with something other than a transaction hash ("${oneLine(typeof value === "string" ? value : JSON.stringify(value), 30)}"). Check your wallet's activity before trying again; the deposit may have been sent.`,
    };
};
/** Failures worth asking again about; the rest (a wallet that isn't the user's, say) won't change by retrying. */
const RETRYABLE = new Set<ApiError["code"]>(["unavailable", "internal", "rate_limited"]);
/** Refusals of a deposit report that say nothing about the deposit, so it stays pending and is reported again */
const REPORT_RETRYABLE = new Set<ApiError["code"]>([...RETRYABLE, "wallet_not_connected"]);

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
    /** Whether the last try to get a sign-in token from Privy gave none, so a refusal for it can say so. */
    #tokenFailed = false;
    /** Counts socket connections, so a trade can tell it was sent on an earlier one. */
    #connection = 0;
    /** Deposits being confirmed right now, so a reconnect doesn't report one twice. */
    readonly #confirming = new Set<string>();
    /** The socket whose `account:open` has succeeded; deposits are reported only on it. */
    #bound: AppSocket | null = null;
    /** Reports waiting for a socket to be bound to the account */
    readonly #bindWaiters = new Set<() => void>();

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
        this.#snapshot = { ...this.#snapshot, balances: loadCachedBalances(userId) };
        this.#emit();
        this.#dispatch({ type: "connecting" });

        const socket: AppSocket = io(this.#url, {
            transports: ["websocket"],
            // Fetched again on each reconnect, so an expired token is replaced.
            auth: (done) => {
                accessToken().then(
                    (token) => {
                        this.#tokenFailed = token === null;
                        done({ token: token ?? "" });
                    },
                    () => {
                        this.#tokenFailed = true;
                        done({ token: "" });
                    },
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
            // The server says why; the generic lines are for an older server that doesn't
            this.#tradeNotice(
                order.message ?? (order.side === "sell" ? SELL_FAILED_COPY : FAILURE_COPY[order.reason ?? "rejected"]),
            );
        });
        socket.on("perp:update", (update) => {
            this.#dispatch({ type: "perp", update });
            const { order, position } = update;
            // A rejection, a partial fill or a liquidation carries the words the person is told.
            if (
                order.reason &&
                (order.state === "rejected" ||
                    order.state === "filled" ||
                    // A close that took only part of the position says how much
                    (order.state === "done" && order.kind === "close") ||
                    position?.state === "liquidated")
            )
                this.#tradeNotice(order.reason);
        });
        socket.on("perps", (perps) => {
            this.#dispatch({ type: "perpsSnapshot", perps, connection: this.#connection });
        });
        socket.on("withdrawal:update", ({ withdrawal, account }) => {
            this.#dispatch({ type: "withdrawal", withdrawal, account });
            if (withdrawal.state === "failed") {
                // The server says why; the generic line is for an older server that doesn't
                const message = withdrawal.message ?? WITHDRAW_FAILED_COPY;
                this.#notify({ kind: "reverted", message, withdrawal: true });
            }
        });
        socket.on("holdings:update", ({ holdings }) => {
            this.#dispatch({ type: "holdings", holdings });
        });
        socket.on("trade:filled", ({ requestId, account }) => {
            this.#dispatch({ type: "spot-settled", requestId, account });
        });
        socket.on("holding:withdrawal", (withdrawal) => {
            this.#dispatch({ type: "coin-withdrawal", withdrawal });
            // A send that failed after it was accepted: the server says why
            if (withdrawal.state === "failed" && withdrawal.message) this.#tradeNotice(withdrawal.message);
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
            const lacksToken = refusal?.code === "unauthorized" && this.#tokenFailed;
            this.#dispatch({
                type: "failed",
                error: lacksToken
                    ? {
                          code: "unauthorized",
                          message: "Couldn't get your sign-in token from Privy. Reload and sign in again.",
                      }
                    : (refusal ?? connectFailed(error)),
            });
            clearTimeout(this.#retry);
            this.#retry = setTimeout(() => socket.connect(), Math.min(MAX_RETRY_MS, 1_000 * 2 ** this.#attempt++));
        });
    }

    /** What a request is answered with while the account isn't ready: why, not just that it isn't. */
    #notReady(): ApiError {
        if (isOffline()) return OFFLINE;
        const { state } = this.#snapshot;
        if (state.status === "failed") return state.error;
        return { code: "unavailable", message: "Still connecting to your account." };
    }

    /** What a request is answered with when the server never replied: offline, a dropped connection, or the wait that ran out. */
    #noAnswer(socket: AppSocket | null, waitedMs: number): ApiError {
        if (isOffline()) return OFFLINE;
        if (!socket?.connected) {
            return { code: "unavailable", message: "The connection to the server dropped. Reconnecting…" };
        }
        return unanswered(waitedMs);
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
                this.#dispatch({ type: "session", session: result.data, connection: this.#connection });
                this.#bound = socket;
                this.#releaseBindWaiters();
                const { pnl } = this.#snapshot;
                this.#snapshot = { ...this.#snapshot, pnl: { ...pnl, bound: pnl.bound + 1 } };
                this.#emit();
                // Deposits still pending from before a reconnect are reported again.
                const { state } = this.#snapshot;
                if (state.status === "ready") {
                    for (const p of state.pending) void this.#confirm(socket, p.txHash, p.amount);
                }
                return;
            }
            const error = result?.error ?? this.#noAnswer(socket, CONNECT_TIMEOUT_MS);
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
        this.#bound = null;
        this.#releaseBindWaiters();
        resetPnlStores();
        const { state, notice, balances, tradeNotice, pnl } = this.#snapshot;
        if (state.status !== "idle" || notice || balances || tradeNotice || pnl.bound !== 0 || pnl.changed !== 0) {
            this.#snapshot = {
                state: initialAccountState,
                notice: null,
                balances: null,
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
        if (state.status !== "ready" || !socket) return { failed: this.#notReady().message };
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
            const failure = walletFailure(error, { symbol: "USDC" });
            return failure.kind === "cancelled" ? "cancelled" : { failed: failure.message };
        }
        if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return notAHash(txHash);
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
        if (this.#snapshot.state.status !== "ready" || !socket) return this.#notReady();
        const result = await socket
            .timeout(CONNECT_TIMEOUT_MS)
            .emitWithAck("deposit:quote", { coin, amount, wallet })
            .catch(() => null);
        if (!result) return this.#noAnswer(socket, CONNECT_TIMEOUT_MS);
        return result.ok ? result.data : result.error;
    }

    /** The balance and PnL series, cut into days of the zone `tz`. */
    async loadPnlSeries(tz: string): Promise<PnlSeries | ApiError> {
        const socket = this.#socket;
        if (this.#snapshot.state.status !== "ready" || !socket || this.#bound !== socket) return this.#notReady();
        const result = await socket
            .timeout(CONNECT_TIMEOUT_MS)
            .emitWithAck("pnl:series", { tz })
            .catch(() => null);
        if (!result) return this.#noAnswer(socket, CONNECT_TIMEOUT_MS);
        return result.ok ? result.data : result.error;
    }

    /** One page of the account's history under `filter`, the one after the cursor `before` or the newest */
    async loadActivityPage(req: { before?: string; filter: ActivityFilter }): Promise<ActivityPage | ApiError> {
        const socket = this.#socket;
        if (this.#snapshot.state.status !== "ready" || !socket || this.#bound !== socket) return this.#notReady();
        const result = await socket
            .timeout(CONNECT_TIMEOUT_MS)
            .emitWithAck("activity:list", { filter: req.filter, ...(req.before ? { before: req.before } : {}) })
            .catch(() => null);
        if (!result) return this.#noAnswer(socket, CONNECT_TIMEOUT_MS);
        return result.ok ? result.data : result.error;
    }

    /** What a withdrawal may be right now. */
    async withdrawLimits(): Promise<WithdrawLimits | ApiError> {
        const socket = this.#socket;
        if (this.#snapshot.state.status !== "ready" || !socket) return this.#notReady();
        const result = await socket
            .timeout(CONNECT_TIMEOUT_MS)
            .emitWithAck("withdraw:limits", {})
            .catch(() => null);
        if (!result) return this.#noAnswer(socket, CONNECT_TIMEOUT_MS);
        return result.ok ? result.data : result.error;
    }

    /** What a withdrawal of `amount` to the Solana wallet `to` would cost and deliver; nothing is taken. */
    async withdrawQuote(amount: string, to: string): Promise<WithdrawQuote | ApiError> {
        const socket = this.#socket;
        if (this.#snapshot.state.status !== "ready" || !socket) return this.#notReady();
        const result = await socket
            .timeout(CONNECT_TIMEOUT_MS)
            .emitWithAck("withdraw:quote", { amount, to })
            .catch(() => null);
        if (!result) return this.#noAnswer(socket, CONNECT_TIMEOUT_MS);
        return result.ok ? result.data : result.error;
    }

    /**
     * Withdraws `amount` USDC to `to` and counts it at once; `reviewedFee` is the fee the person saw for a Solana wallet.
     * A refusal rolls it back with the server's message; "changed" means the fee rose past what was shown, nothing was
     * taken and the person is asked again, with the server's words; a missing answer leaves it counted, since the server
     * may have taken it, and says whether the server was slow or the connection dropped.
     */
    async withdraw(amount: string, to: string, reviewedFee?: string): Promise<WithdrawResult> {
        const socket = this.#socket;
        if (isOffline()) return "offline";
        if (this.#snapshot.state.status !== "ready" || !socket?.connected) return "not-ready";
        const requestId = crypto.randomUUID();
        this.#dispatch({
            type: "withdraw",
            withdrawal: { requestId, amount: toWei(amount), to, at: Date.now(), connection: this.#connection },
        });
        const result = await socket
            .timeout(REPORT_TIMEOUT_MS)
            .emitWithAck("withdraw:create", { requestId, amount, to, ...(reviewedFee ? { reviewedFee } : {}) })
            .catch(() => null);
        if (this.#socket !== socket) return "failed";
        if (!result) return isOffline() ? "offline" : "timeout";
        if (result.ok) {
            const { account, ...withdrawal } = result.data;
            this.#dispatch({ type: "withdrawal", withdrawal, account });
            return "sent";
        }
        this.#dispatch({ type: "withdraw-refused", requestId });
        if (result.error.code === "quote_changed") return { problem: "changed", message: result.error.message };
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
        if (this.#snapshot.state.status !== "ready" || !socket) return this.#notReady();
        const result = await socket
            .timeout(CONNECT_TIMEOUT_MS)
            .emitWithAck("prediction:quote", input)
            .catch(() => null);
        if (!result) return this.#noAnswer(socket, CONNECT_TIMEOUT_MS);
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
    }): Placed {
        const requestId = crypto.randomUUID();
        const socket = this.#socket;
        this.#tradeNotice(null);
        if (this.#snapshot.state.status !== "ready" || !socket?.connected) {
            this.#tradeNotice(OFFLINE_COPY);
            return { requestId, sent: false, answer: Promise.resolve(OFFLINE_COPY) };
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
        const answer = socket
            .timeout(REPORT_TIMEOUT_MS)
            .emitWithAck("prediction:order", { requestId, ...wire })
            .catch(() => null)
            .then((result) => {
                if (this.#socket !== socket || !result) return null;
                if (result.ok) {
                    const { account, ...order } = result.data;
                    this.#dispatch({ type: "placed", order, account });
                    return null;
                }
                this.#dispatch({ type: "predict-failed", requestId });
                this.#tradeNotice(result.error.message);
                return result.error.message;
            });
        return { requestId, sent: true, answer };
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
        if (this.#snapshot.state.status !== "ready" || !socket) return this.#notReady();
        const result = await socket
            .timeout(CONNECT_TIMEOUT_MS)
            .emitWithAck("perp:quote", req)
            .catch(() => null);
        if (!result) return this.#noAnswer(socket, CONNECT_TIMEOUT_MS);
        return result.ok ? result.data : result.error;
    }

    /**
     * Opens a perp position and counts it at once: the collateral leaves the shown balance and a pending
     * position with the quote's size and entry stands in. The server's push decides the outcome;
     * only a refusal rolls it back here, and a missing answer leaves it accepted.
     */
    placePerp(req: PerpOrderRequest, quote: PerpQuoteView): Placed {
        const { requestId } = req;
        const socket = this.#socket;
        this.#tradeNotice(null);
        if (this.#snapshot.state.status !== "ready" || !socket?.connected) {
            this.#tradeNotice(OFFLINE_COPY);
            return { requestId, sent: false, answer: Promise.resolve(OFFLINE_COPY) };
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
            feesUSD: String(Number(quote.takerFeeUSD) + Number(quote.ourFeeUSD)),
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
        const answer = socket
            .timeout(REPORT_TIMEOUT_MS)
            .emitWithAck("perp:order", req)
            .catch(() => null)
            .then((result) => {
                if (this.#socket !== socket) return null;
                if (!result) {
                    // The position stays counted; the person is told it isn't confirmed, so a second tap doesn't double it
                    this.#tradeNotice(
                        `${noAnswer(socket, `your ${req.side} ${req.asset}`, REPORT_TIMEOUT_MS)} It may still go through; check Positions before trying again.`,
                    );
                    return null;
                }
                if (result.ok) {
                    const { account, order } = result.data;
                    this.#dispatch({ type: "perp", update: { order, position: null, account } });
                    return null;
                }
                this.#dispatch({ type: "perpFailed", requestId });
                this.#tradeNotice(result.error.message);
                return result.error.message;
            });
        return { requestId, sent: true, answer };
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
        if (this.#socket !== socket) return;
        if (!result) {
            this.#tradeNotice(
                `${noAnswer(socket, "the close", REPORT_TIMEOUT_MS)} Check whether the position is still open before trying again.`,
            );
            return;
        }
        if (result.ok) return;
        this.#tradeNotice(result.error.message);
    }

    /**
     * Buys, sells or swaps from the balance and counts it at once; the answer settles it with the server's balance and
     * coins, a refusal rolls it back with the server's message, and a missing answer leaves it counted.
     */
    placeTrade(req: TradeOrderRequest): Placed {
        const { requestId } = req;
        const socket = this.#socket;
        const estimate = estimateTrade(req);
        this.#tradeNotice(null);
        const unsent = this.#unsent(req.verb) ?? (estimate ? null : whyNoEstimate(req));
        if (unsent || !estimate || !socket) {
            const message = unsent ?? unsentCopy("unreachable", req.verb);
            this.#tradeNotice(message);
            return { requestId, sent: false, answer: Promise.resolve(message) };
        }
        this.#dispatch({ type: "spot", trade: estimate });
        const answer = socket
            .timeout(REPORT_TIMEOUT_MS)
            .emitWithAck("trade:order", req)
            .catch(() => null)
            .then((result) => {
                if (!result) return this.#unconfirmed(socket, req.verb);
                if (this.#socket !== socket) return null;
                if (result.ok) {
                    this.#dispatch({
                        type: "spot-filled",
                        requestId,
                        balance: result.balance,
                        holdings: result.holdings,
                    });
                    return null;
                }
                this.#dispatch({ type: "spot-failed", requestId });
                // The server's words carry the prices and what was kept; generic copy only if it sent none
                const message = result.message || `The server refused the ${req.verb} (${result.code}).`;
                this.#tradeNotice(message);
                return message;
            });
        return { requestId, sent: true, answer };
    }

    /** Why an order can't be sent now, or null when it can: the account still loading, failed to load, or the connection down. */
    #unsent(verb: "buy" | "sell" | "swap" | "send"): string | null {
        const { state } = this.#snapshot;
        if (state.status === "failed") return unsentCopy("failed", verb, state.error.message);
        if (state.status !== "ready") return unsentCopy("loading", verb);
        if (!this.#socket?.connected) {
            const offline = typeof navigator !== "undefined" && navigator.onLine === false;
            return unsentCopy(offline ? "offline" : "unreachable", verb);
        }
        return null;
    }

    /** The server never answered, so the order may or may not have gone through; the person is told so and not that it worked. */
    #unconfirmed(socket: AppSocket, verb: "buy" | "sell" | "swap" | "send"): string | null {
        // Another account or a replaced connection owns the notice now
        if (this.#socket === null) return null;
        const message = unconfirmedCopy(verb, REPORT_TIMEOUT_MS / 1000);
        if (this.#socket === socket) this.#tradeNotice(message);
        return message;
    }

    /** Sends a held coin to the person's own address and counts it as gone at once; a refusal puts it back with the server's message. */
    withdrawHolding(req: CoinWithdrawRequest): { requestId: string; sent: boolean; message?: string } {
        const { requestId } = req;
        const socket = this.#socket;
        this.#tradeNotice(null);
        const unsent = this.#unsent("send");
        if (unsent || !socket) {
            const message = unsent ?? unsentCopy("unreachable", "send");
            this.#tradeNotice(message);
            return { requestId, sent: false, message };
        }
        this.#dispatch({ type: "coin-send", send: { requestId, symbol: req.symbol, units: req.units } });
        void socket
            .timeout(REPORT_TIMEOUT_MS)
            .emitWithAck("holding:withdraw", req)
            .catch(() => null)
            .then((result) => {
                if (!result) {
                    this.#unconfirmed(socket, "send");
                    return;
                }
                if (this.#socket !== socket) return;
                if (result.ok) {
                    this.#dispatch({
                        type: "coin-withdrawal",
                        withdrawal: result.withdrawal,
                        holdings: result.holdings,
                    });
                    return;
                }
                this.#dispatch({ type: "coin-send-failed", requestId });
                this.#tradeNotice(result.message || `The server refused the send (${result.code}).`);
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
        if (this.#snapshot.state.status !== "ready" || !socket) return { failed: this.#notReady().message };
        const symbol = coin.split(":")[1];
        try {
            const opened = await socket
                .timeout(CONNECT_TIMEOUT_MS)
                .emitWithAck("deposit:order", { coin, amount, wallet: wallet.from })
                .catch(() => null);
            if (this.#socket !== socket) return SIGNED_OUT;
            if (!opened) return notSent(silence());
            if (!opened.ok) return { refused: opened.error.message };
            const { order, txs } = opened.data;
            this.#dispatch({ type: "order", order });

            const hashes: Hex[] = [];
            for (const [i, tx] of txs.entries()) {
                const network = await wallet.ensure(tx.chainId);
                if (network === "declined") return "cancelled";
                if (network !== "ready") return { failed: networkProblem(network, tx.chainId) };
                const hash = (await wallet.provider.request({
                    method: "eth_sendTransaction",
                    params: [
                        { from: wallet.from, to: tx.to, data: tx.data, value: tx.value, chainId: toHex(tx.chainId) },
                    ],
                })) as Hex;
                if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return notAHash(hash);
                hashes.push(hash);
                if (i < txs.length - 1) {
                    const landed = await this.#landed(wallet.provider, hash);
                    const chain = networkName(tx.chainId);
                    if (landed === "reverted") {
                        return {
                            failed: `The approval transaction reverted on ${chain}, so the deposit wasn't sent. Nothing was bridged.`,
                        };
                    }
                    if (landed === "timeout") {
                        return {
                            failed: `The approval hasn't confirmed on ${chain} after 2 minutes. Check your wallet's activity, then try again.`,
                        };
                    }
                }
            }
            if (this.#socket !== socket) return "sent";

            await this.#registerSource(socket, order.id, hashes);
            this.#dropBalance(coin, wallet.from, amount);
            return "sent";
        } catch (error) {
            const failure = walletFailure(error, { symbol });
            return failure.kind === "cancelled" ? "cancelled" : { failed: failure.message };
        }
    }

    /**
     * Tells the server which transactions the wallet sent for an order. A refusal or a missing answer is asked again
     * in the background while it could change; one that won't is told to the person with the hash, since the money has
     * gone and the order would otherwise stay unfollowed.
     */
    async #registerSource(socket: AppSocket, orderId: string, hashes: string[]) {
        const first = await this.#sendSource(socket, orderId, hashes);
        if (first === null || first === "registered") return;
        if (!first.again) return this.#notifyUnregistered(hashes, first.reason);
        void (async () => {
            let reason = first.reason;
            for (const delay of REGISTER_RETRY_MS) {
                await pause(delay);
                const next = await this.#sendSource(socket, orderId, hashes);
                if (next === null || next === "registered") return;
                reason = next.reason;
                if (!next.again) break;
            }
            this.#notifyUnregistered(hashes, reason);
        })();
    }

    /** One try at reporting an order's hashes: registered, moot (the account changed), or refused with a reason and whether asking again could help. */
    async #sendSource(socket: AppSocket, orderId: string, hashes: string[]) {
        if (this.#socket !== socket) return null;
        const reported = await socket
            .timeout(CONNECT_TIMEOUT_MS)
            .emitWithAck("deposit:source", { orderId, txHashes: hashes })
            .catch(() => null);
        if (this.#socket !== socket) return null;
        if (reported?.ok) {
            this.#dispatch({ type: "order", order: reported.data });
            return "registered" as const;
        }
        return {
            reason: reported ? reported.error.message : `${silence()}.`,
            again: !reported || RETRYABLE.has(reported.error.code),
        };
    }

    #notifyUnregistered(hashes: string[], reason: string) {
        const hash = hashes.at(-1);
        this.#notify({
            kind: "reverted",
            message: `Your deposit was sent${hash ? ` (${shortHash(hash)})` : ""} but we couldn't register it with the server: ${reason} It will still be credited once the bridge pays out on Arc, but its progress won't show here.`,
        });
    }

    /**
     * Opens a Solana deposit order, builds its transaction on a fresh blockhash and has the wallet
     * sign and send it. The server follows the order from the signature on.
     */
    async solanaDeposit(
        coin: string,
        amount: string,
        wallet: { address: string; signer: SolanaSigner | undefined; solBalance: bigint | null },
    ): Promise<DepositResult> {
        const socket = this.#socket;
        if (this.#snapshot.state.status !== "ready" || !socket) return { failed: this.#notReady().message };
        if (!wallet.signer) {
            return { failed: `Connect ${shortHash(wallet.address)} in your wallet app to deposit from it.` };
        }
        if (wallet.solBalance !== null && wallet.solBalance < MIN_FEE_LAMPORTS) {
            return { refused: needsSolMessage(MIN_FEE_LAMPORTS, wallet.solBalance, false) };
        }
        try {
            // The quote says what the transaction costs in SOL (a CCTP burn also pays rent), so a short wallet is told before an order opens.
            if (wallet.solBalance !== null) {
                const quoted = await this.quote(coin, amount, wallet.address);
                if (this.#socket !== socket) return SIGNED_OUT;
                if ("code" in quoted) return { refused: quoted.message };
                if (quoted.sol && wallet.solBalance < BigInt(quoted.sol.needed)) {
                    return {
                        refused: needsSolMessage(
                            BigInt(quoted.sol.needed),
                            wallet.solBalance,
                            BigInt(quoted.sol.held) > BigInt(0),
                        ),
                    };
                }
            }
            const opened = await socket
                .timeout(CONNECT_TIMEOUT_MS)
                .emitWithAck("deposit:order", { coin, amount, wallet: wallet.address })
                .catch(() => null);
            if (this.#socket !== socket) return SIGNED_OUT;
            if (!opened) return notSent(silence());
            if (!opened.ok) return { refused: opened.error.message };
            const { order, txs } = opened.data;
            this.#dispatch({ type: "order", order });
            const tx = txs[0];
            if (txs.length !== 1 || tx?.kind !== "solana") {
                return {
                    failed: `The bridge returned a transaction we can't use (${txs.length} part${txs.length === 1 ? "" : "s"}). Nothing was sent.`,
                };
            }

            // Fetched right before signing, so the blockhash is as fresh as the wallet prompt allows.
            const recent = await socket
                .timeout(CONNECT_TIMEOUT_MS)
                .emitWithAck("solana:blockhash", {})
                .catch(() => null);
            if (this.#socket !== socket) return SIGNED_OUT;
            if (!recent) return notSent(silence());
            if (!recent.ok) return { refused: recent.error.message };
            let bytes: Uint8Array;
            try {
                const { instructions, keyPairs } = await withFreshSigners(tx.instructions);
                bytes = await signWithFreshKeys(
                    buildDepositTransaction({
                        payer: wallet.address,
                        blockhash: recent.data,
                        instructions,
                        lookupTables: tx.lookupTables,
                    }),
                    keyPairs,
                );
            } catch (error) {
                console.warn("Couldn't build the Solana deposit transaction", error);
                return {
                    failed: `Couldn't build the Solana transaction: "${oneLine((error as Error | null)?.message)}". Nothing was sent.`,
                };
            }
            const signature = await wallet.signer.signAndSend(bytes);
            if (typeof signature !== "string" || signature === "") {
                console.warn("Your Solana wallet answered a send without a signature", signature);
                return {
                    failed: "Your Solana wallet answered without a transaction signature. Check its activity before trying again; the deposit may have been sent.",
                };
            }
            if (this.#socket !== socket) return "sent";

            await this.#registerSource(socket, order.id, [signature]);
            this.#dropBalance(coin, wallet.address, amount);
            return "sent";
        } catch (error) {
            const failure = walletFailure(error, { solana: true });
            return failure.kind === "cancelled" ? "cancelled" : { failed: failure.message };
        }
    }

    /** Whether a transaction succeeded in a block within 120 s, asking the wallet every second: it landed, reverted, or never showed. */
    async #landed(provider: WalletProvider, hash: Hex): Promise<"landed" | "reverted" | "timeout"> {
        const deadline = Date.now() + RECEIPT_TIMEOUT_MS;
        while (Date.now() < deadline) {
            const receipt = (await provider.request({ method: "eth_getTransactionReceipt", params: [hash] })) as {
                status?: string;
            } | null;
            if (receipt) return receipt.status === "0x0" ? "reverted" : "landed";
            await pause(RECEIPT_POLL_MS);
        }
        return "timeout";
    }

    /** Has the server credit a sent deposit, taking it back out only if the server says it can't be, and reporting it again after any other answer */
    async #confirm(socket: AppSocket, txHash: Hex, value: bigint) {
        const key = txHash.toLowerCase();
        if (this.#confirming.has(key)) return;
        this.#confirming.add(key);
        let notFound = 0;
        try {
            for (let attempt = 0; ; attempt++) {
                // An unbound socket would be told to open the account first, and a deposit isn't taken back for that
                if (!(await this.#untilBound(socket))) return;
                const result = await socket
                    .timeout(REPORT_TIMEOUT_MS)
                    .emitWithAck("deposit:submit", { txHash })
                    .catch(() => null);
                if (this.#socket !== socket) return;
                if (result === null) {
                    // No answer isn't a no: say it's taking long and ask again
                    this.#notify({
                        kind: "confirming",
                        amount: value,
                        message: isOffline()
                            ? "You're offline; still waiting to confirm this deposit."
                            : `The server hasn't confirmed this deposit yet (${shortHash(txHash)}); still checking.`,
                    });
                    await pause(Math.min(MAX_RETRY_MS, 1_000 * 2 ** attempt));
                    if (this.#socket !== socket) return;
                    continue;
                }
                if (result.ok) {
                    this.#dispatch({ type: "settled", receipt: result.data });
                    this.#notify({ kind: "credited", amount: value }, CREDITED_NOTICE_MS);
                    return;
                }
                // The chain scan may have credited it while the report failed.
                const { state } = this.#snapshot;
                if (
                    state.status === "ready" &&
                    state.deposits.some((d) => d.txHash.toLowerCase() === txHash.toLowerCase())
                ) {
                    this.#notify({ kind: "credited", amount: value }, CREDITED_NOTICE_MS);
                    return;
                }
                // A transaction the server can't see yet may still land, and is credited when it does: it stays counted, and is asked about again
                if (result.error.code === "tx_not_found" && notFound++ < NOT_FOUND_RETRIES) {
                    this.#notify({ kind: "confirming", amount: value, message: result.error.message });
                    await pause(Math.min(MAX_RETRY_MS, 1_000 * 2 ** attempt));
                    if (this.#socket !== socket) return;
                    continue;
                }
                if (!REPORT_RETRYABLE.has(result.error.code)) {
                    this.#dispatch({ type: "reverted", txHash });
                    this.#notify({ kind: "reverted", message: result.error.message });
                    return;
                }
                await pause(Math.min(MAX_RETRY_MS, 1_000 * 2 ** attempt));
                if (this.#socket !== socket) return;
            }
        } finally {
            this.#confirming.delete(key);
        }
    }

    /** Resolves true once `socket` is bound to the account, or false once the client has moved on from it */
    async #untilBound(socket: AppSocket) {
        while (this.#socket === socket && this.#bound !== socket) {
            await new Promise<void>((resolve) => this.#bindWaiters.add(resolve));
        }
        return this.#socket === socket;
    }

    #releaseBindWaiters() {
        const waiting = [...this.#bindWaiters];
        this.#bindWaiters.clear();
        for (const resolve of waiting) resolve();
    }

    /**
     * Asks the server for fresh balances, silently. Nothing is sent while the view is under 30 s old,
     * unless one of `wallets` has no rows in it yet.
     */
    refreshBalances(wallets: string[] = []) {
        const socket = this.#socket;
        if (!socket || this.#snapshot.state.status !== "ready") return;
        if (!needsRefresh(this.#snapshot.balances, wallets, Date.now())) return;
        socket.emit("balances:refresh", {}, (answer) => {
            // A refusal (rate limited, not bound yet) leaves the balances as they were; the console says why
            if (answer && !answer.ok) console.warn(`Balances weren't refreshed: ${answer.error.message}`);
        });
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
        else {
            const why = result?.error.message ?? this.#noAnswer(this.#socket, CONNECT_TIMEOUT_MS).message;
            if (!this.#snapshot.notice) {
                this.#notify({ kind: "reverted", message: `Couldn't load older deposits: ${why}` }, TRADE_NOTICE_MS);
            }
        }
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
