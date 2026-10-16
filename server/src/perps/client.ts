import type { HDAccount } from "viem/accounts";
import type { Level } from "../predictions/trader.ts";

export type PerpMeta = {
    assets: Array<{
        asset: string;
        index: number;
        szDecimals: number;
        maxLeverage: number;
        marginTables: Array<{ lowerBound: string; maxLeverage: number }>;
        onlyIsolated: boolean;
        markPx: number;
        oraclePx: number;
        funding: number;
        /** What the market traded over the last 24 hours, in dollars; 0 when Hyperliquid doesn't say. */
        dayNtlVlm: number;
    }>;
};

export type AccountState = {
    withdrawableE6: bigint;
    accountValueE6: bigint;
    positions: Array<{
        asset: string;
        sizeCoin: string;
        side: "long" | "short";
        entryPx: string;
        leverage: number;
        liquidationPx: string | null;
        unrealizedPnlE6: bigint;
        cumFundingE6: bigint;
        marginUsedE6: bigint;
    }>;
};

export type Fill = {
    tid: number;
    oid: number;
    cloid: string | null;
    asset: string;
    sizeCoin: string;
    px: string;
    feeE6: bigint;
    dir: string;
    liquidation: boolean;
    time: number;
};

export type OrderResult =
    | { kind: "filled"; totalSz: string; avgPx: string }
    | { kind: "resting"; oid: number }
    | { kind: "rejected"; message: string }
    | { kind: "unknown" };

export type OrderStatus =
    | { kind: "filled"; totalSz: string; avgPx: string }
    | { kind: "open" }
    | { kind: "canceled" }
    | { kind: "rejected"; message: string }
    | { kind: "missing" };

export type UsdSendResult = { kind: "ok" } | { kind: "duplicate" } | { kind: "rejected"; message: string };

/** A USDC transfer between two Hyperliquid accounts, from the ledger of either one. */
export type Transfer = { from: string; to: string; amountE6: bigint; time: number };

/** `expiresAfter` is a millisecond time after which Hyperliquid refuses the order. */
export type PerpOrder = {
    asset: string;
    isBuy: boolean;
    px: string;
    sz: string;
    reduceOnly: boolean;
    cloid: string;
    expiresAfter?: number;
};

/** Hyperliquid as the perps service sees it; the signer of a call is the account whose funds or position it moves. */
export interface HyperliquidClient {
    meta(): Promise<PerpMeta>;
    /** Both sides best first, as Hyperliquid sends them. */
    book(asset: string): Promise<{ bids: Level[]; asks: Level[] }>;
    /** Null when the account doesn't exist yet. */
    state(address: string): Promise<AccountState | null>;
    userFees(address: string): Promise<{ takerRate: number }>;
    fills(address: string, sinceMs: number): Promise<Fill[]>;
    orderStatus(address: string, cloid: string): Promise<OrderStatus>;
    /** The USDC sends in an account's non-funding ledger since a time, lowercase addresses. */
    transfers(address: string, sinceMs: number): Promise<Transfer[]>;
    usdSend(from: HDAccount, to: string, amountE6: bigint, nonce: number): Promise<UsdSendResult>;
    updateLeverage(signer: HDAccount, asset: string, leverage: number): Promise<void>;
    order(signer: HDAccount, o: PerpOrder): Promise<OrderResult>;
}

class TimedOut extends Error {}

function bounded<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: NodeJS.Timeout;
    const late = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TimedOut(`${what} timed out after ${ms} ms`)), ms);
    });
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** The client with every call bounded (a timed-out call may still complete); an order that doesn't answer in time is `unknown`, which leaves it posted for the tracker. */
export function withPerpTimeouts(client: HyperliquidClient, ms: number): HyperliquidClient {
    return {
        meta: () => bounded(client.meta(), ms, "meta"),
        book: (asset) => bounded(client.book(asset), ms, "book"),
        state: (address) => bounded(client.state(address), ms, "state"),
        userFees: (address) => bounded(client.userFees(address), ms, "userFees"),
        fills: (address, sinceMs) => bounded(client.fills(address, sinceMs), ms, "fills"),
        orderStatus: (address, cloid) => bounded(client.orderStatus(address, cloid), ms, "orderStatus"),
        transfers: (address, sinceMs) => bounded(client.transfers(address, sinceMs), ms, "transfers"),
        usdSend: (from, to, amountE6, nonce) => bounded(client.usdSend(from, to, amountE6, nonce), ms, "usdSend"),
        updateLeverage: (signer, asset, leverage) =>
            bounded(client.updateLeverage(signer, asset, leverage), ms, "updateLeverage"),
        order: (signer, o) =>
            bounded(client.order(signer, o), ms, "order").catch((error: unknown): OrderResult => {
                if (error instanceof TimedOut) return { kind: "unknown" };
                throw error;
            }),
    };
}

const lastNonce = new Map<string, number>();

/** A millisecond nonce, strictly increasing per signer within this process. */
export function nextNonce(signer: string): number {
    const key = signer.toLowerCase();
    const nonce = Math.max(Date.now(), (lastNonce.get(key) ?? 0) + 1);
    lastNonce.set(key, nonce);
    return nonce;
}
