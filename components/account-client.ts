import { io, type Socket } from "socket.io-client";
import { parseGwei, toHex } from "viem";
import {
    accountReducer,
    initialAccountState,
    toWei,
    type AccountAction,
    type AccountState,
    type ApiError,
    type DepositQuoteView,
    type Hex,
    type PredictionFailure,
    type QuoteView,
} from "@/lib/account/state";
import { dropAfterSend, loadCachedBalances, needsRefresh, saveCachedBalances } from "@/lib/account/balances";
import type { BalancesView, ClientToServerEvents, ServerToClientEvents } from "@/server/src/protocol";

type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** The minimal EIP-1193 surface a deposit needs from the wallet. */
export type WalletProvider = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

/** Where a deposit stands, as the sidebar tells it. */
export type DepositNotice =
    /** Sent from the wallet; the server is confirming it. */
    | { kind: "confirming"; amount: bigint }
    | { kind: "credited"; amount: bigint }
    /** The server couldn't confirm it, so it came back out of the balance. */
    | { kind: "reverted"; message: string };

/** How the wallet took a deposit: turned down, failed to send, or sent (and now being confirmed). */
export type DepositResult = "cancelled" | "failed" | "sent" | "switch_failed" | "wrong_network";

/** What a bridged deposit needs from the wallet: its provider, its address, and a move to the source chain. */
export type BridgeWallet = {
    provider: WalletProvider;
    from: string;
    ensure(chainId: number): Promise<"ready" | "declined" | "switch_failed" | "wrong_network">;
};

export type AccountSnapshot = {
    state: AccountState;
    notice: DepositNotice | null;
    balances: BalancesView | null;
    /** Why the last prediction didn't go through, or that it couldn't be sent. */
    tradeNotice: { message: string } | null;
};

/** What the person is told when a placed prediction fails on the server. */
const FAILURE_COPY: Record<PredictionFailure, string> = {
    price_moved: "The price moved, so your prediction didn't go through. Nothing was spent.",
    market_closed: "This market just closed. Nothing was spent.",
    unavailable: "Polymarket isn't answering. Nothing was spent.",
    rejected: "Your prediction didn't go through. Nothing was spent.",
};
const OFFLINE_COPY = "You're offline. Nothing was spent.";

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
        tradeNotice: null,
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
            if (order.state === "failed") this.#tradeNotice(FAILURE_COPY[order.reason ?? "rejected"]);
        });
        socket.on("positions", (positions) => {
            this.#dispatch({ type: "positions", positions, connection: this.#connection });
        });
        socket.on("balances", (view) => {
            if (this.#userId) saveCachedBalances(this.#userId, view);
            this.#snapshot = { ...this.#snapshot, balances: view };
            this.#emit();
        });
        socket.on("disconnect", (reason) => {
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
                // Deposits still pending from before a reconnect are reported again.
                const { state } = this.#snapshot;
                if (state.status === "ready") {
                    for (const p of state.pending) void this.#confirm(socket, p.txHash, p.amount);
                }
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
        const { state, notice, balances, tradeNotice } = this.#snapshot;
        if (state.status !== "idle" || notice || balances || tradeNotice) {
            this.#snapshot = { state: initialAccountState, notice: null, balances: null, tradeNotice: null };
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
    }): { requestId: string } {
        const requestId = crypto.randomUUID();
        const socket = this.#socket;
        this.#tradeNotice(null);
        if (this.#snapshot.state.status !== "ready" || !socket?.connected) {
            this.#tradeNotice(OFFLINE_COPY);
            return { requestId };
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
                if (this.#socket !== socket || !result || result.ok) return;
                this.#dispatch({ type: "predict-failed", requestId });
                this.#tradeNotice(result.error.message);
            });
        return { requestId };
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
            if (!opened?.ok || this.#socket !== socket) return "failed";
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
