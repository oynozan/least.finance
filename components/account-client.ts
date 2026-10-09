import { io, type Socket } from "socket.io-client";
import { parseGwei, toHex } from "viem";
import {
    accountReducer,
    initialAccountState,
    toWei,
    type AccountAction,
    type AccountState,
    type ApiError,
    type Hex,
} from "@/lib/account/state";
import type { ClientToServerEvents, ServerToClientEvents } from "@/server/src/protocol";

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

export type AccountSnapshot = { state: AccountState; notice: DepositNotice | null };

/** EIP-1193's code for a request the user turned down in their wallet. */
const USER_REJECTED = 4001;
/** Arc drops transactions offering under 20 gwei, so this leaves room for the base fee to rise. */
const MAX_FEE_PER_GAS = parseGwei("40");
const PRIORITY_FEE_PER_GAS = parseGwei("1");
/** The server waits up to 30s for a transaction to land; this covers that and the round trip. */
const REPORT_TIMEOUT_MS = 45_000;
const CONNECT_TIMEOUT_MS = 15_000;
const CREDITED_NOTICE_MS = 5_000;
const MAX_RETRY_MS = 30_000;

const UNREACHABLE: ApiError = { code: "unavailable", message: "Couldn't reach the server. Retrying…" };
/** Failures worth asking again about; the rest (a wallet that isn't the user's, say) won't change by retrying. */
const RETRYABLE = new Set<ApiError["code"]>(["unavailable", "internal", "rate_limited"]);

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The signed-in wallet's account on the server, kept live over a socket.
 * Deposits are optimistic: one counts the moment the wallet sends it, and
 * comes back out if the server can't confirm it.
 */
export class AccountClient {
    readonly #url: string;
    #snapshot: AccountSnapshot = { state: initialAccountState, notice: null };
    readonly #listeners = new Set<() => void>();
    #socket: AppSocket | null = null;
    #wallet: string | null = null;
    #retry: ReturnType<typeof setTimeout> | undefined;
    #noticeTimer: ReturnType<typeof setTimeout> | undefined;
    #attempt = 0;
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

    /** Binds to `wallet`, using the Privy access token for every (re)connect. A no-op if already bound to it. */
    connect(wallet: string, accessToken: () => Promise<string | null>) {
        const key = wallet.toLowerCase();
        if (this.#socket && this.#wallet === key) return;
        this.disconnect();
        this.#wallet = key;
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
            void this.#bind(socket, wallet);
        });
        socket.on("deposit:credited", ({ deposit, account }) => {
            this.#dispatch({ type: "credited", deposit, account });
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

    /** Binds the socket to the wallet's account, asking again while the server can't answer. */
    async #bind(socket: AppSocket, wallet: string) {
        for (let attempt = 0; ; attempt++) {
            const result = await socket
                .timeout(CONNECT_TIMEOUT_MS)
                .emitWithAck("wallet:connect", { address: wallet })
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
        this.#socket?.removeAllListeners();
        this.#socket?.disconnect();
        this.#socket = null;
        this.#wallet = null;
        this.#attempt = 0;
        this.#confirming.clear();
        if (this.#snapshot.state.status !== "idle" || this.#snapshot.notice) {
            this.#snapshot = { state: initialAccountState, notice: null };
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
        void this.#confirm(socket, txHash, value);
        return "sent";
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
