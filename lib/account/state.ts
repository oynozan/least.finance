import { formatUnits, parseUnits } from "viem";
import type {
    AccountView,
    ApiError,
    DepositOrderView,
    DepositOrigin,
    DepositQuoteView,
    DepositReceipt,
    DepositRules,
    DepositView,
    Hex,
    PositionSettled,
    PerpOrderView,
    PerpPositionView,
    PerpUpdate,
    PerpsView,
    PositionView,
    PositionsView,
    PredictionFailure,
    PredictionOrderView,
    PredictionPlaced,
    PredictionUpdate,
    QuoteView,
    SourceTxView,
    WalletSession,
    WithdrawLimits,
    WithdrawalView,
} from "@/server/src/protocol";

export type {
    AccountView,
    ApiError,
    DepositOrderView,
    DepositOrigin,
    DepositQuoteView,
    DepositReceipt,
    DepositRules,
    DepositView,
    Hex,
    PositionSettled,
    PerpOrderView,
    PerpPositionView,
    PerpUpdate,
    PerpsView,
    PositionView,
    PositionsView,
    PredictionFailure,
    PredictionOrderView,
    PredictionPlaced,
    PredictionUpdate,
    QuoteView,
    SourceTxView,
    WalletSession,
    WithdrawLimits,
    WithdrawalView,
};

/** Arc's native USDC, which the server's amounts keep in full. */
export const USDC_DECIMALS = 18;

/** A deposit the wallet has sent and the server hasn't confirmed yet. */
export type PendingDeposit = {
    txHash: Hex;
    /** Wei. */
    amount: bigint;
    /** When the wallet handed back the transaction, in ms. */
    sentAt: number;
};

/** A prediction buy the server has accepted but not yet shown back, counted against the balance meanwhile. */
export type OptimisticBuy = {
    requestId: string;
    side: "buy";
    eventId: string;
    tokenId: string;
    question: string;
    outcome: string;
    /** Wei. */
    amountWei: bigint;
    /** The quote's estimate. */
    shares: string;
    at: number;
    /** The socket connection it was sent on; a later snapshot without it means it never arrived. */
    connection: number;
};

/** A sale sent but not yet filled: its estimated proceeds count toward the balance and its position is out of the list. */
export type OptimisticSell = {
    requestId: string;
    side: "sell";
    positionId: string;
    /** Wei, the estimate from the quoted sell price. */
    proceedsWei: bigint;
    at: number;
    connection: number;
};

/** A withdrawal the server hasn't answered yet, counted against the balance meanwhile. */
export type PendingWithdrawal = {
    requestId: string;
    /** Wei. */
    amount: bigint;
    to: string;
    at: number;
};

export type OptimisticTrade = OptimisticBuy | OptimisticSell;

/** A perp open the client has accepted: its collateral is counted against the balance until the server's order shows it. */
export type OptimisticPerp = {
    requestId: string;
    /** Wei. */
    collateralWei: bigint;
    /** The socket connection it was sent on; a later snapshot without it means it never arrived. */
    connection: number;
};

/** The id of the position shown while its open is in flight. */
export const pendingPerpId = (requestId: string) => `pending:${requestId}`;

/** The row of an open still in flight when the page loaded, which has no quote to show. */
const pendingPerpOf = (order: PerpOrderView): PerpPositionView => ({
    id: pendingPerpId(order.requestId),
    asset: order.asset,
    side: order.side,
    leverage: order.leverage,
    sizeCoin: order.requestedSizeCoin,
    entryPx: null,
    collateralUSD: order.collateralUSD,
    liquidationPx: null,
    markPx: null,
    unrealizedPnlUSD: "0",
    cumFundingUSD: "0",
    state: "open",
    proceedsUSD: null,
    notice: null,
    openedAt: order.createdAt,
    settledAt: null,
    updatedAt: order.updatedAt,
});

const IN_FLIGHT_PERP = new Set(["placing", "funding", "posted", "sweeping"]);

export const isPendingPerp = (position: { id: string }) => position.id.startsWith("pending:");

export type AccountState =
    | { status: "idle" }
    | { status: "connecting" }
    | { status: "failed"; error: ApiError }
    | {
          status: "ready";
          account: AccountView;
          /** Wei, as the server last reported it. */
          balance: bigint;
          /** Newest first, as credited. */
          deposits: DepositView[];
          /** Cursor for older deposits, null once they're all here. */
          next: string | null;
          rules: DepositRules;
          /** Which Solana flows the server has switched on. */
          solana: WalletSession["solana"];
          /** Newest first; shown and counted until the server settles them. */
          pending: PendingDeposit[];
          /** Bridge orders still open, newest first. */
          orders: DepositOrderView[];
          /** The server's view of the account's predictions. */
          predictions: PositionsView;
          /** Newest first; counted against the balance until the server's order shows up. */
          optimistic: OptimisticTrade[];
          /** The server's view of the account's perp positions and in-flight orders; a pending open's position is in it too. */
          perps: PerpsView;
          /** Newest first; perp opens accepted here and not yet settled by the server. */
          optimisticPerps: OptimisticPerp[];
          /** Newest first, as the server last said. */
          withdrawals: WithdrawalView[];
          /** Newest first; counted against the balance until the server's view of the request arrives. */
          pendingWithdrawals: PendingWithdrawal[];
      };

export type AccountAction =
    | { type: "reset" }
    | { type: "connecting" }
    | { type: "failed"; error: ApiError }
    | { type: "session"; session: WalletSession }
    /** A bridge order opened or moved on; an expired one leaves the list. */
    | { type: "order"; order: DepositOrderView }
    | { type: "credited"; deposit: DepositView; account: AccountView }
    | { type: "older"; deposits: DepositView[]; next: string | null }
    | { type: "sent"; txHash: Hex; amount: bigint; sentAt: number }
    | { type: "settled"; receipt: DepositReceipt }
    /** The server couldn't confirm the deposit, so it comes back out of the balance. */
    | { type: "reverted"; txHash: Hex }
    | { type: "predict"; trade: OptimisticTrade }
    /** The server turned the order down, or it never got there. */
    | { type: "predict-failed"; requestId: string }
    | { type: "placed"; order: PredictionOrderView; account: AccountView }
    | { type: "prediction"; update: PredictionUpdate }
    | { type: "positions"; positions: PositionsView; connection: number }
    | { type: "perp"; update: PerpUpdate }
    | { type: "perpsSnapshot"; perps: PerpsView; connection: number }
    /** A perp open is on its way: its collateral leaves the shown balance and `position` stands in until the fill. */
    | { type: "perpAccepted"; requestId: string; position: PerpPositionView; collateralWei: bigint; connection: number }
    /** The server turned the open down, or it never got there. */
    | { type: "perpFailed"; requestId: string }
    /** A position was paid or lost when its market resolved. */
    | { type: "position-settled"; position: PositionView; account: AccountView }
    | { type: "withdraw"; withdrawal: PendingWithdrawal }
    /** The server turned the withdrawal down. */
    | { type: "withdraw-refused"; requestId: string }
    /** The view comes with the account that has its debit or refund in. */
    | { type: "withdrawal"; withdrawal: WithdrawalView; account: AccountView };

export const initialAccountState: AccountState = { status: "idle" };

export const toWei = (usdc: string) => parseUnits(usdc, USDC_DECIMALS);
export const toUsdc = (wei: bigint) => Number(formatUnits(wei, USDC_DECIMALS));

export function accountReducer(state: AccountState, action: AccountAction): AccountState {
    switch (action.type) {
        case "reset":
            return initialAccountState;
        case "connecting":
            // A reconnect keeps what's showing; only a first connect has nothing to show.
            return state.status === "ready" ? state : { status: "connecting" };
        case "failed":
            return state.status === "ready" ? state : { status: "failed", error: action.error };
        case "session": {
            const { account, deposits, rules } = action.session;
            // Deposits sent before a reconnect stay pending until the server has them.
            const pending = state.status === "ready" ? state.pending : [];
            return settle({
                status: "ready",
                account,
                balance: toWei(account.balance),
                deposits: deposits.items,
                next: deposits.next,
                rules,
                solana: action.session.solana,
                pending,
                orders: sortOrders(action.session.orders),
                // Positions follow as their own push after the session.
                predictions: state.status === "ready" ? state.predictions : { positions: [], orders: [] },
                optimistic: state.status === "ready" ? state.optimistic : [],
                perps: state.status === "ready" ? state.perps : { positions: [], orders: [] },
                optimisticPerps: state.status === "ready" ? state.optimisticPerps : [],
                withdrawals: action.session.withdrawals,
                pendingWithdrawals: (state.status === "ready" ? state.pendingWithdrawals : []).filter(
                    (p) => !action.session.withdrawals.some((w) => w.requestId === p.requestId),
                ),
            });
        }
        case "order": {
            if (state.status !== "ready") return state;
            // An older version of an order that is already showing, such as a late acknowledgement, is dropped.
            const held = state.orders.find((o) => o.id === action.order.id);
            if (held && held.updatedAt > action.order.updatedAt) return state;
            const rest = state.orders.filter((o) => o.id !== action.order.id);
            const orders = sortOrders(action.order.state === "expired" ? rest : [action.order, ...rest]);
            return { ...state, orders, deposits: withOrigins(state.deposits, orders) };
        }
        case "credited":
            if (state.status !== "ready") return state;
            return settle(withAccount(withOrders(mergeDeposits(state, [action.deposit])), action.account));
        case "older":
            if (state.status !== "ready") return state;
            return { ...mergeDeposits(state, action.deposits), next: action.next };
        case "sent":
            if (state.status !== "ready") return state;
            if (state.pending.some((p) => p.txHash === action.txHash)) return state;
            if (state.deposits.some((d) => d.txHash === action.txHash)) return state;
            return {
                ...state,
                pending: [{ txHash: action.txHash, amount: action.amount, sentAt: action.sentAt }, ...state.pending],
            };
        case "settled":
            if (state.status !== "ready") return state;
            return settle(withAccount(mergeDeposits(state, action.receipt.deposits), action.receipt.account));
        case "reverted":
            if (state.status !== "ready") return state;
            return { ...state, pending: state.pending.filter((p) => p.txHash !== action.txHash) };
        case "predict":
            if (state.status !== "ready") return state;
            if (state.optimistic.some((t) => t.requestId === action.trade.requestId)) return state;
            return { ...state, optimistic: [action.trade, ...state.optimistic] };
        case "predict-failed":
            if (state.status !== "ready") return state;
            return { ...state, optimistic: state.optimistic.filter((t) => t.requestId !== action.requestId) };
        case "placed": {
            if (state.status !== "ready") return state;
            // The ack already has the amount taken, so the optimistic entry gives way to the account
            const next = withAccount(state, action.account);
            const found = state.optimistic.find((t) => t.requestId === action.order.requestId);
            const trade = found?.side === "buy" ? found : undefined;
            // Still the estimate until the fill says how many shares
            const order =
                trade && action.order.shares === null ? { ...action.order, shares: trade.shares } : action.order;
            return {
                ...next,
                predictions: { ...next.predictions, orders: keepNewer(next.predictions.orders, order) },
                optimistic: next.optimistic.filter((t) => t.requestId !== action.order.requestId),
            };
        }
        case "prediction": {
            if (state.status !== "ready") return state;
            const { update } = action;
            const held = state.predictions.orders.find((o) => o.id === update.order.id);
            const stale = !!held && held.updatedAt > update.order.updatedAt;
            const next = withAccount(state, update.account);
            return {
                ...next,
                predictions: stale
                    ? next.predictions
                    : {
                          orders: upsert(next.predictions.orders, update.order),
                          positions: update.position
                              ? keepNewerPosition(next.predictions.positions, update.position)
                              : next.predictions.positions,
                      },
                optimistic: next.optimistic.filter((t) => t.requestId !== update.requestId),
            };
        }
        case "positions": {
            if (state.status !== "ready") return state;
            const known = new Set(action.positions.orders.map((o) => o.requestId));
            return {
                ...state,
                predictions: mergeSnapshot(state.predictions, action.positions),
                optimistic: state.optimistic.filter((t) => {
                    if (t.connection < action.connection) return false;
                    // A sale the server is working on still owes its proceeds until it settles
                    return t.side === "sell" || !known.has(t.requestId);
                }),
            };
        }
        case "perpAccepted": {
            if (state.status !== "ready") return state;
            if (state.optimisticPerps.some((t) => t.requestId === action.requestId)) return state;
            const entry = {
                requestId: action.requestId,
                collateralWei: action.collateralWei,
                connection: action.connection,
            };
            return {
                ...state,
                optimisticPerps: [entry, ...state.optimisticPerps],
                perps: { ...state.perps, positions: [action.position, ...state.perps.positions] },
            };
        }
        case "perpFailed":
            if (state.status !== "ready") return state;
            return dropPendingPerp(state, action.requestId);
        case "perp": {
            if (state.status !== "ready") return state;
            const { order, position } = action.update;
            const next = withAccount(state, action.update.account);
            const held = state.perps.orders.find((o) => o.id === order.id);
            if (held && held.updatedAt > order.updatedAt) return next;
            const settled = order.state === "filled" || order.state === "rejected" || order.state === "done";
            // The fill takes the pending position's place in the list.
            const pendingId = pendingPerpId(order.requestId);
            let positions = next.perps.positions;
            if (position) {
                const at = positions.findIndex((p) => p.id === pendingId);
                const rest = positions.filter((p) => p.id !== pendingId);
                const added = keepNewerPerp(rest, position);
                positions =
                    at >= 0 && added.length === rest.length + 1
                        ? [...added.slice(1, at + 1), added[0]!, ...added.slice(at + 1)]
                        : added;
            }
            const withUpdate: Ready = { ...next, perps: { orders: upsert(next.perps.orders, order), positions } };
            return settled ? dropPendingPerp(withUpdate, order.requestId, !!position) : withUpdate;
        }
        case "perpsSnapshot": {
            if (state.status !== "ready") return state;
            const known = new Set(action.perps.orders.map((o) => o.requestId));
            const optimisticPerps = state.optimisticPerps.filter(
                (t) => t.connection >= action.connection || known.has(t.requestId),
            );
            const orders = mergePerpOrders(state.perps.orders, action.perps.orders);
            const pendingIds = new Set(optimisticPerps.map((t) => pendingPerpId(t.requestId)));
            const heldPositions = new Map(state.perps.positions.map((p) => [p.id, p]));
            const positions = action.perps.positions.map((p) => {
                const heldOne = heldPositions.get(p.id);
                return heldOne && heldOne.updatedAt > p.updatedAt ? heldOne : p;
            });
            // A push can be newer than the read, so a position its order names stays.
            const named = new Set(orders.filter((o) => !action.perps.orders.includes(o)).map((o) => o.positionId));
            const shown = new Set(positions.map((p) => p.id));
            const kept = state.perps.positions.filter(
                (p) => !shown.has(p.id) && (pendingIds.has(p.id) || named.has(p.id)),
            );
            // An open still in flight after a reload has no row yet, so one is rebuilt from the order.
            const have = new Set([...kept, ...positions].map((p) => p.id));
            const rebuilt = orders
                .filter(
                    (o) =>
                        o.kind === "open" &&
                        !o.positionId &&
                        IN_FLIGHT_PERP.has(o.state) &&
                        !have.has(pendingPerpId(o.requestId)),
                )
                .map(pendingPerpOf);
            return { ...state, optimisticPerps, perps: { orders, positions: [...rebuilt, ...kept, ...positions] } };
        }
        case "withdraw":
            if (state.status !== "ready") return state;
            if (state.pendingWithdrawals.some((p) => p.requestId === action.withdrawal.requestId)) return state;
            if (state.withdrawals.some((w) => w.requestId === action.withdrawal.requestId)) return state;
            return { ...state, pendingWithdrawals: [action.withdrawal, ...state.pendingWithdrawals] };
        case "withdraw-refused":
            if (state.status !== "ready") return state;
            return {
                ...state,
                pendingWithdrawals: state.pendingWithdrawals.filter((p) => p.requestId !== action.requestId),
            };
        case "withdrawal": {
            if (state.status !== "ready") return state;
            const { withdrawal } = action;
            const held = state.withdrawals.find((w) => w.id === withdrawal.id);
            const pendingWithdrawals = state.pendingWithdrawals.filter((p) => p.requestId !== withdrawal.requestId);
            const next = withAccount({ ...state, pendingWithdrawals }, action.account);
            if (held && held.updatedAt > withdrawal.updatedAt) return next;
            return {
                ...next,
                withdrawals: [withdrawal, ...state.withdrawals.filter((w) => w.id !== withdrawal.id)].sort(newestFirst),
            };
        }
        case "position-settled": {
            if (state.status !== "ready") return state;
            const next = withAccount(state, action.account);
            return {
                ...next,
                predictions: {
                    ...next.predictions,
                    positions: keepNewerPosition(next.predictions.positions, action.position),
                },
            };
        }
    }
}

type Ready = Extract<AccountState, { status: "ready" }>;

/** Replaces the entry with the same id, or adds it on top. */
const upsert = <T extends { id: string }>(items: T[], item: T): T[] => [item, ...items.filter((i) => i.id !== item.id)];

/** Adds the perp position, unless the one held is newer. */
const keepNewerPerp = (positions: PerpPositionView[], position: PerpPositionView): PerpPositionView[] => {
    const held = positions.find((p) => p.id === position.id);
    return held && held.updatedAt > position.updatedAt ? positions : upsert(positions, position);
};

/** The snapshot's in-flight orders, with settled ones a push brought kept, and a newer held version winning. */
function mergePerpOrders(held: PerpOrderView[], snapshot: PerpOrderView[]): PerpOrderView[] {
    const heldById = new Map(held.map((o) => [o.id, o]));
    const orders = snapshot.map((o) => {
        const known = heldById.get(o.id);
        return known && known.updatedAt > o.updatedAt ? known : o;
    });
    const kept = new Set(orders.map((o) => o.id));
    // Settled orders aren't in a snapshot
    for (const o of held)
        if (!kept.has(o.id) && (o.state === "filled" || o.state === "rejected" || o.state === "done")) orders.push(o);
    return orders;
}

/** Takes the pending open away with its position; `keepPosition` leaves a real position of the same request alone. */
function dropPendingPerp(state: Ready, requestId: string, keepPosition = false): Ready {
    const pendingId = pendingPerpId(requestId);
    return {
        ...state,
        optimisticPerps: state.optimisticPerps.filter((t) => t.requestId !== requestId),
        perps: keepPosition
            ? state.perps
            : { ...state.perps, positions: state.perps.positions.filter((p) => p.id !== pendingId) },
    };
}

/** Newest created first. */
const newestFirst = (a: WithdrawalView, b: WithdrawalView) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;

/** Adds the order, unless the one held is newer. */
const keepNewer = (orders: PredictionOrderView[], order: PredictionOrderView): PredictionOrderView[] => {
    const held = orders.find((o) => o.id === order.id);
    return held && held.updatedAt > order.updatedAt ? orders : upsert(orders, order);
};

/** Adds the position, unless the one held is newer. */
const keepNewerPosition = (positions: PositionView[], position: PositionView): PositionView[] => {
    const held = positions.find((p) => p.id === position.id);
    return held && held.updatedAt > position.updatedAt ? positions : upsert(positions, position);
};

/** The snapshot, except where a push already showed something newer: an older read can't undo a settled order. */
function mergeSnapshot(held: PositionsView, snapshot: PositionsView): PositionsView {
    const heldOrders = new Map(held.orders.map((o) => [o.id, o]));
    const orders = snapshot.orders.map((o) => {
        const known = heldOrders.get(o.id);
        return known && known.updatedAt > o.updatedAt ? known : o;
    });
    const kept = new Set(orders.map((o) => o.id));
    // Settled orders aren't in a snapshot, so those a push brought stay
    for (const o of held.orders) if (!kept.has(o.id) && (o.state === "filled" || o.state === "failed")) orders.push(o);

    const heldPositions = new Map(held.positions.map((p) => [p.id, p]));
    const positions = snapshot.positions.map((p) => {
        const known = heldPositions.get(p.id);
        return known && known.updatedAt > p.updatedAt ? known : p;
    });
    const shown = new Set(positions.map((p) => p.id));
    const newer = new Set(orders.filter((o) => heldOrders.get(o.id) === o).map((o) => o.positionId));
    for (const p of held.positions) if (!shown.has(p.id) && newer.has(p.id)) positions.push(p);
    return { orders, positions };
}

const sortOrders = (orders: DepositOrderView[]) =>
    orders
        .filter((o) => o.state !== "expired")
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

/** A delivered order's deposit is credited before the order is linked to it, so the link is made here too. */
function withOrigins(deposits: DepositView[], orders: DepositOrderView[]): DepositView[] {
    return deposits.map((deposit) => {
        if (deposit.origin) return deposit;
        const order = orders.find((o) => o.state === "delivered" && o.depositId === deposit.id);
        const txHash = order?.sourceTxHashes.at(-1);
        return order && txHash ? { ...deposit, origin: { coin: order.coin, amount: order.amount, txHash } } : deposit;
    });
}

const withOrders = (state: Ready): Ready => ({ ...state, deposits: withOrigins(state.deposits, state.orders) });

/** Takes the server's account unless a newer version is already showing; pushes can arrive out of order. */
function withAccount(state: Ready, account: AccountView): Ready {
    if (account.version < state.account.version) return state;
    return { ...state, account, balance: toWei(account.balance) };
}

/** Adds deposits by id, keeping newest first. */
function mergeDeposits(state: Ready, incoming: DepositView[]): Ready {
    const byId = new Map(state.deposits.map((d) => [d.id, d]));
    for (const deposit of incoming) byId.set(deposit.id, deposit);
    const deposits = [...byId.values()].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return { ...state, deposits };
}

/** Drops pending deposits the server has credited. */
function settle(state: Ready): Ready {
    if (state.pending.length === 0) return state;
    const credited = new Set(state.deposits.map((d) => d.txHash.toLowerCase()));
    const pending = state.pending.filter((p) => !credited.has(p.txHash.toLowerCase()));
    return pending.length === state.pending.length ? state : { ...state, pending };
}

/** The balance to show: the server's, plus whatever is still on its way. */
export function optimisticBalance(state: AccountState): bigint | null {
    if (state.status !== "ready") return null;
    const placed = new Set(state.predictions.orders.map((o) => o.requestId));
    const settled = new Set(
        state.predictions.orders.filter((o) => o.state === "filled" || o.state === "failed").map((o) => o.requestId),
    );
    // A buy the server has is already debited in `account.balance`; a sale is credited only when it fills.
    // A withdrawal the server has is already debited (or refunded) in `account.balance`; only unanswered ones are owed.
    const owed = state.pendingWithdrawals.reduce((sum, p) => sum + p.amount, BigInt(0));
    const afterDeposits = state.pending.reduce((sum, p) => sum + p.amount, state.balance - owed);
    const afterTrades = state.optimistic.reduce((sum, t) => {
        if (t.side === "sell") return settled.has(t.requestId) ? sum : sum + t.proceedsWei;
        return placed.has(t.requestId) ? sum : sum - t.amountWei;
    }, afterDeposits);
    // A perp open the server has is already debited in `account.balance`, and a close is credited only when it settles.
    const opened = new Set(state.perps.orders.map((o) => o.requestId));
    return state.optimisticPerps.reduce(
        (sum, t) => (opened.has(t.requestId) ? sum : sum - t.collateralWei),
        afterTrades,
    );
}

export type HistoryRow = {
    /**
     * The transaction hash, so a pending row keeps its identity once it's
     * credited; a transaction that credited more than once adds the log index.
     */
    key: string;
    /** Wei. */
    amount: bigint;
    at: Date;
    pending: boolean;
    /** The coin a bridged deposit came from. */
    origin?: DepositOrigin;
};

/** Pending deposits on top, then credited ones, newest first. */
export function historyRows(state: AccountState): HistoryRow[] {
    if (state.status !== "ready") return [];
    const perTx = new Map<string, number>();
    for (const d of state.deposits) perTx.set(d.txHash, (perTx.get(d.txHash) ?? 0) + 1);
    return [
        ...state.pending.map((p) => ({ key: p.txHash, amount: p.amount, at: new Date(p.sentAt), pending: true })),
        ...state.deposits.map((d) => ({
            key: (perTx.get(d.txHash) ?? 0) > 1 ? `${d.txHash}:${d.logIndex}` : d.txHash,
            amount: toWei(d.amount),
            at: new Date(d.creditedAt),
            pending: false,
            origin: d.origin,
        })),
    ];
}
