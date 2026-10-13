import { formatUnits, parseUnits } from "viem";
import { sameWallet } from "@/lib/account/balances";
import type { SwapHoldingRow, SwapHoldingsView, SwapNetworkId, SwapOrderView } from "@/server/src/protocol";

/** More fractional digits than any swap coin has, so amounts add and subtract exactly. */
const DECIMALS = 18;
const ZERO = BigInt(0);

/** The holdings row a swap paid from. */
export type Paid = { wallet: string; network: SwapNetworkId; symbol: string; amount: string };

/** What this client lowered for an order and where its proceeds land. */
export type Tracked = { paid: Paid; receiver: string; to: { network: SwapNetworkId; symbol: string } };

/** The orders this client has lowered a row for, by order ID. */
export type Tracking = Record<string, Tracked>;

const matches = (row: SwapHoldingRow, at: Pick<Paid, "wallet" | "network" | "symbol">) =>
    row.network === at.network && row.symbol === at.symbol && sameWallet(row.wallet, at.wallet);

const scaleUsd = (usd: number | null, from: string, to: string) => {
    if (usd === null) return null;
    const before = Number(from);
    return before > 0 ? (usd * Number(to)) / before : 0;
};

function move(view: SwapHoldingsView, at: Paid, sign: 1 | -1): SwapHoldingsView {
    const by = parseUnits(at.amount, DECIMALS);
    let found = false;
    const rows = view.rows.flatMap((row): SwapHoldingRow[] => {
        if (!matches(row, at)) return [row];
        found = true;
        const next = parseUnits(row.amount, DECIMALS) + (sign === 1 ? by : -by);
        if (next <= ZERO) return [];
        const amount = formatUnits(next, DECIMALS);
        return [{ ...row, amount, usd: scaleUsd(row.usd, row.amount, amount) }];
    });
    if (!found && sign === 1)
        rows.push({
            wallet: at.wallet,
            network: at.network,
            symbol: at.symbol,
            amount: formatUnits(by, DECIMALS),
            usd: null,
        });
    return { ...view, rows };
}

/** The view with the paid amount taken out of its row, until the next read corrects it. */
export const dropHolding = (view: SwapHoldingsView, paid: Paid) => move(view, paid, -1);

/** The view with an amount added to its row, or a row for it when the wallet held none. */
export const addHolding = (view: SwapHoldingsView, row: Paid) => move(view, row, 1);

export const trackOrder = (tracking: Tracking, orderId: string, tracked: Tracked): Tracking => ({
    ...tracking,
    [orderId]: tracked,
});

/** A symbol a row can carry; a token address (LI.FI's name for an unknown coin) is too long to be one. */
const isSymbol = (value: string) => /^[A-Za-z0-9._-]{1,12}$/.test(value);

/**
 * Settles the rows this client changed for an order: proceeds raise the received coin, a
 * refund or failure puts the paid amount back. Orders it never tracked change nothing.
 */
export function settleHoldings(
    view: SwapHoldingsView,
    tracking: Tracking,
    order: SwapOrderView,
): { view: SwapHoldingsView; tracking: Tracking } {
    const mine = tracking[order.id];
    if (!mine) return { view, tracking };
    const rest = Object.fromEntries(Object.entries(tracking).filter(([id]) => id !== order.id));
    if (order.state === "refunded" || order.state === "failed") {
        return { view: addHolding(view, mine.paid), tracking: rest };
    }
    if (order.state !== "done" && order.state !== "partial") return { view, tracking };
    const { received, receivedSymbol } = order.to;
    const symbol = order.state === "done" ? mine.to.symbol : (receivedSymbol ?? "");
    if (!received || !isSymbol(symbol)) return { view, tracking: rest };
    const raised = addHolding(view, { wallet: mine.receiver, network: order.to.network, symbol, amount: received });
    return { view: raised, tracking: rest };
}

export type Unreported = { orderId: string; txHashes: string[] };

const unreportedKey = (userId: string) => `swap-sent:${userId}`;

/** The hash lists kept for this person that the server hasn't acknowledged. */
export function loadUnreported(userId: string): Unreported[] {
    try {
        const raw = localStorage.getItem(unreportedKey(userId));
        const list: unknown = raw ? JSON.parse(raw) : [];
        return Array.isArray(list)
            ? list.filter(
                  (e): e is Unreported =>
                      typeof e?.orderId === "string" &&
                      Array.isArray(e.txHashes) &&
                      e.txHashes.every((h: unknown) => typeof h === "string"),
              )
            : [];
    } catch {
        return [];
    }
}

function save(userId: string, list: Unreported[]) {
    try {
        if (list.length) localStorage.setItem(unreportedKey(userId), JSON.stringify(list));
        else localStorage.removeItem(unreportedKey(userId));
    } catch {
        // Storage is blocked; the hashes are reported from memory while the page stays open.
    }
}

export function keepUnreported(userId: string, entry: Unreported): void {
    save(userId, [...loadUnreported(userId).filter((e) => e.orderId !== entry.orderId), entry]);
}

export function clearUnreported(userId: string, orderId: string): void {
    save(
        userId,
        loadUnreported(userId).filter((e) => e.orderId !== orderId),
    );
}

/** Reports each kept entry that isn't already being reported; `send` says whether the server took it, which clears it. */
export async function reportUnreported(
    userId: string,
    inFlight: Set<string>,
    send: (entry: Unreported) => Promise<boolean>,
): Promise<void> {
    await Promise.all(
        loadUnreported(userId).map(async (entry) => {
            if (inFlight.has(entry.orderId)) return;
            inFlight.add(entry.orderId);
            try {
                if (await send(entry)) clearUnreported(userId, entry.orderId);
            } finally {
                inFlight.delete(entry.orderId);
            }
        }),
    );
}
