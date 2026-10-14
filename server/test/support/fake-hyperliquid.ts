import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createL1ActionHash } from "@nktkas/hyperliquid/signing";
import { parseUnits, recoverTypedDataAddress, serializeSignature } from "viem";
import recorded from "../fixtures/hyperliquid/meta.json" with { type: "json" };

type Json = Record<string, unknown>;

export type FakeBook = {
    bids: { price: number; size: number }[];
    asks: { price: number; size: number }[];
};

export type NextOrder = "fill" | { partial: string } | { reject: string } | "hold" | "drop";

export type FakeUsdSend = { from: string; to: string; amountE6: bigint; nonce: number };

/** How a numbered usdSend goes wrong: refused, never answered or applied, or applied only after a delay (its reply is late too). */
export type UsdSendShape = "refuse" | "lose" | { late: number };
export type FakeOrder = {
    signer: string;
    asset: string;
    isBuy: boolean;
    px: string;
    sz: string;
    reduceOnly: boolean;
    cloid: string | null;
    /** The time after which the signed order is void, when it carries one. */
    expiresAfter: number | null;
};
export type FakeAccountView = {
    freeE6: bigint;
    positions: { asset: string; szi: number; entryPx: number; marginE6: bigint; leverage: number }[];
};

type Position = { szi: number; entryPx: number; marginE6: bigint; leverage: number };
type Account = { freeE6: bigint; positions: Map<string, Position>; leverage: Map<string, number> };
type FillRecord = {
    coin: string;
    px: string;
    sz: string;
    side: "B" | "A";
    time: number;
    startPosition: string;
    dir: string;
    closedPnl: string;
    hash: string;
    oid: number;
    crossed: boolean;
    fee: string;
    tid: number;
    cloid?: string;
    feeToken: "USDC";
    liquidation?: { liquidatedUser: string; markPx: string; method: "market" };
};
type OrderRecord = {
    oid: number;
    status: string;
    coin: string;
    isBuy: boolean;
    limitPx: string;
    origSz: string;
    cloid: string | null;
    reduceOnly: boolean;
    time: number;
};

export type FakeHyperliquid = {
    url: string;
    /** Every request served, as "info <type>" or "exchange <action type>". */
    requests: string[];
    usdSends: FakeUsdSend[];
    orders: FakeOrder[];
    setMark(asset: string, px: number): void;
    /** Both sides best first. */
    setBook(asset: string, book: FakeBook): void;
    fund(address: string, usdE6: bigint): void;
    /** Shapes the next order: filled, partly filled, rejected, never answered ("hold"), or applied with its reply dropped ("drop"). */
    nextOrder(next: NextOrder): void;
    liquidate(address: string, asset: string): void;
    failUsdSend(on: boolean): void;
    /** Shapes the nth usdSend from now (1 is the next one). */
    nextUsdSend(nth: number, shape: UsdSendShape): void;
    /** Whether a refused usdSend still uses up its nonce, so a later send with it answers "Duplicate nonce". */
    refusalConsumesNonce(on: boolean): void;
    /** Answers orderStatus with an unknown order while on, though the order and its fills exist. */
    hideOrderStatus(on: boolean): void;
    /** Removes a position with no fill, as if the account state were read empty. */
    vanish(address: string, asset: string): void;
    /** Whether the 1 USDC activation of a new address is paid by the sender on top of the amount (the default) or comes out of the amount. */
    activationFrom(source: "sender" | "amount"): void;
    account(address: string): FakeAccountView | undefined;
    /** Clears accounts, marks, books, orders and switches back to the defaults. */
    reset(): void;
    stop(): Promise<void>;
};

const TAKER_RATE = 0.00045;
const ACTIVATION_E6 = 1_000_000n;
const ZERO = "0x0000000000000000000000000000000000000000";
type Ctx = { markPx: string } & Json;
const [META, CTXS] = recorded as unknown as [{ universe: { name: string; maxLeverage: number }[] } & Json, Ctx[]];
const UNIVERSE = META.universe;
const NAMES = UNIVERSE.map((entry) => entry.name);

const readBody = async (request: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
};

const fmt = (value: number) => (Number.isInteger(value) ? value.toFixed(1) : String(value));
const usd = (e6: bigint) => {
    const sign = e6 < 0n ? "-" : "";
    const abs = e6 < 0n ? -e6 : e6;
    return `${sign}${abs / 1_000_000n}.${(abs % 1_000_000n).toString().padStart(6, "0")}`;
};
const toE6 = (value: number) => BigInt(Math.round(value * 1_000_000));

type Signature = { r: `0x${string}`; s: `0x${string}`; v: number };

/** Who signed an L1 action (order, updateLeverage). */
const l1Signer = async (body: Json): Promise<string> => {
    const connectionId = createL1ActionHash({
        action: body.action as Json,
        nonce: body.nonce as number,
        ...(body.vaultAddress ? { vaultAddress: body.vaultAddress as `0x${string}` } : {}),
        ...(body.expiresAfter !== undefined ? { expiresAfter: body.expiresAfter as number } : {}),
    });
    const sig = body.signature as Signature;
    return (
        await recoverTypedDataAddress({
            domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: ZERO },
            types: {
                Agent: [
                    { name: "source", type: "string" },
                    { name: "connectionId", type: "bytes32" },
                ],
            },
            primaryType: "Agent",
            message: { source: "a", connectionId },
            signature: serializeSignature({ r: sig.r, s: sig.s, v: BigInt(sig.v) }),
        })
    ).toLowerCase();
};

/** Who signed a usdSend. */
const userSigner = async (body: Json): Promise<string> => {
    const action = body.action as Json;
    const sig = body.signature as Signature;
    return (
        await recoverTypedDataAddress({
            domain: {
                name: "HyperliquidSignTransaction",
                version: "1",
                chainId: parseInt(action.signatureChainId as string),
                verifyingContract: ZERO,
            },
            types: {
                "HyperliquidTransaction:UsdSend": [
                    { name: "hyperliquidChain", type: "string" },
                    { name: "destination", type: "string" },
                    { name: "amount", type: "string" },
                    { name: "time", type: "uint64" },
                ],
            },
            primaryType: "HyperliquidTransaction:UsdSend",
            message: {
                hyperliquidChain: action.hyperliquidChain as string,
                destination: action.destination as string,
                amount: action.amount as string,
                time: BigInt(action.time as number),
            },
            signature: serializeSignature({ r: sig.r, s: sig.s, v: BigInt(sig.v) }),
        })
    ).toLowerCase();
};

/** Stands in for Hyperliquid's /info and /exchange, speaking the wire format the SDK sends. */
export async function startFakeHyperliquid(): Promise<FakeHyperliquid> {
    const requests: string[] = [];
    const usdSends: FakeUsdSend[] = [];
    const transferLog: { from: string; to: string; amountE6: bigint; time: number }[] = [];
    const orders: FakeOrder[] = [];
    const accounts = new Map<string, Account>();
    const fills = new Map<string, FillRecord[]>();
    const statuses = new Map<string, OrderRecord>();
    const marks = new Map<string, number>();
    const books = new Map<string, FakeBook>();
    const seenNonces = new Map<string, Set<number>>();
    let next: NextOrder | undefined;
    let usdSendFails = false;
    let usdSendCount = 0;
    const usdSendPlan = new Map<number, UsdSendShape>();
    let refusalUsesNonce = false;
    let statusHidden = false;
    let activation: "sender" | "amount" = "sender";
    let oid = 1000;
    let tid = 5000;

    const markOf = (asset: string) => marks.get(asset) ?? Number(CTXS[NAMES.indexOf(asset)]?.markPx);
    const send = (response: ServerResponse, body: unknown) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
    };
    const accountOf = (address: string): Account => {
        const key = address.toLowerCase();
        let account = accounts.get(key);
        if (!account) {
            account = { freeE6: 0n, positions: new Map(), leverage: new Map() };
            accounts.set(key, account);
        }
        return account;
    };
    const unrealizedE6 = (asset: string, p: Position) => toE6((markOf(asset) - p.entryPx) * p.szi);
    const liquidationOf = (asset: string, p: Position) => {
        const maxLeverage = UNIVERSE[NAMES.indexOf(asset)]!.maxLeverage;
        const shift = 1 / p.leverage - 1 / (2 * maxLeverage);
        return p.szi > 0 ? p.entryPx * (1 - shift) : p.entryPx * (1 + shift);
    };

    const stateOf = (address: string) => {
        const account = accounts.get(address.toLowerCase());
        const rows = [...(account?.positions ?? [])];
        const free = account?.freeE6 ?? 0n;
        const margin = rows.reduce((sum, [, p]) => sum + p.marginE6, 0n);
        const value = rows.reduce((sum, [asset, p]) => sum + p.marginE6 + unrealizedE6(asset, p), free);
        return {
            marginSummary: {
                accountValue: usd(value),
                totalNtlPos: usd(rows.reduce((sum, [asset, p]) => sum + toE6(Math.abs(p.szi) * markOf(asset)), 0n)),
                totalRawUsd: usd(free),
                totalMarginUsed: usd(margin),
            },
            crossMarginSummary: { accountValue: "0.0", totalNtlPos: "0.0", totalRawUsd: "0.0", totalMarginUsed: "0.0" },
            crossMaintenanceMarginUsed: "0.0",
            withdrawable: usd(free),
            assetPositions: rows.map(([asset, p]) => ({
                type: "oneWay",
                position: {
                    coin: asset,
                    szi: fmt(p.szi),
                    leverage: {
                        type: "isolated",
                        value: p.leverage,
                        rawUsd: usd(-toE6(Math.abs(p.szi) * p.entryPx) + p.marginE6),
                    },
                    entryPx: fmt(p.entryPx),
                    positionValue: fmt(Math.abs(p.szi) * markOf(asset)),
                    unrealizedPnl: usd(unrealizedE6(asset, p)),
                    returnOnEquity: "0.0",
                    liquidationPx: String(liquidationOf(asset, p)),
                    marginUsed: usd(p.marginE6),
                    maxLeverage: UNIVERSE[NAMES.indexOf(asset)]!.maxLeverage,
                    cumFunding: { allTime: "0.0", sinceOpen: "0.0", sinceChange: "0.0" },
                },
            })),
            time: Date.now(),
        };
    };

    const record = (address: string, fill: Omit<FillRecord, "tid" | "time" | "hash" | "crossed" | "feeToken">) => {
        const list = fills.get(address) ?? [];
        list.push({
            ...fill,
            tid: ++tid,
            time: Date.now(),
            hash: `0x${"0".repeat(64)}`,
            crossed: true,
            feeToken: "USDC",
        });
        fills.set(address, list);
    };

    /** Applies an order at the mark; returns the per-order status the exchange answers with. */
    function placeOrder(signer: string, o: Json, forced: NextOrder | undefined) {
        const asset = NAMES[o.a as number]!;
        const isBuy = o.b as boolean;
        const reduceOnly = o.r as boolean;
        const limit = Number(o.p);
        const cloid = (o.c as string | undefined) ?? null;
        const account = accounts.get(signer);
        const mark = markOf(asset);
        if (typeof forced === "object" && "reject" in forced) return { error: forced.reject };
        if (!account) return { error: "Cannot place order: the account does not exist." };
        if (!(isBuy ? mark <= limit : mark >= limit)) {
            return { error: `Order could not immediately match against any resting orders. asset=${o.a as number}` };
        }
        let size = typeof forced === "object" && "partial" in forced ? Number(forced.partial) : Number(o.s);
        const position = account.positions.get(asset);
        const closing = position !== undefined && position.szi > 0 !== isBuy;
        if (reduceOnly && !closing) return { error: "Reduce only order would increase position." };
        if (position && !closing && !reduceOnly && position.szi > 0 !== isBuy)
            return { error: "Position flips are not supported." };
        const notional = size * mark;
        const feeE6 = toE6(notional * TAKER_RATE);
        let dir: string;
        let closedPnl = 0n;
        const startPosition = position?.szi ?? 0;
        if (closing) {
            size = Math.min(size, Math.abs(position.szi));
            const fraction = size / Math.abs(position.szi);
            const released = (position.marginE6 * BigInt(Math.round(fraction * 1e9))) / 1_000_000_000n;
            closedPnl = toE6((mark - position.entryPx) * size * Math.sign(position.szi));
            account.freeE6 += released + closedPnl - feeE6;
            dir = position.szi > 0 ? "Close Long" : "Close Short";
            if (size >= Math.abs(position.szi) - 1e-12) account.positions.delete(asset);
            else {
                position.szi -= Math.sign(position.szi) * size;
                position.marginE6 -= released;
            }
        } else {
            const leverage = account.leverage.get(asset) ?? UNIVERSE[NAMES.indexOf(asset)]!.maxLeverage;
            const marginE6 = (toE6(notional) + BigInt(leverage) - 1n) / BigInt(leverage);
            if (account.freeE6 < marginE6 + feeE6)
                return { error: `Insufficient margin to place order. asset=${o.a as number}` };
            account.freeE6 -= marginE6 + feeE6;
            const signed = isBuy ? size : -size;
            if (position) {
                const total = Math.abs(position.szi) + size;
                position.entryPx = (position.entryPx * Math.abs(position.szi) + mark * size) / total;
                position.szi += signed;
                position.marginE6 += marginE6;
            } else account.positions.set(asset, { szi: signed, entryPx: mark, marginE6, leverage });
            dir = isBuy ? "Open Long" : "Open Short";
        }
        const id = ++oid;
        const partial = typeof forced === "object" && "partial" in forced;
        statuses.set(cloid ?? `oid:${id}`, {
            oid: id,
            status: partial ? "canceled" : "filled",
            coin: asset,
            isBuy,
            limitPx: String(o.p),
            origSz: String(o.s),
            cloid,
            reduceOnly,
            time: Date.now(),
        });
        record(signer, {
            coin: asset,
            px: fmt(mark),
            sz: fmt(size),
            side: isBuy ? "B" : "A",
            startPosition: fmt(startPosition),
            dir,
            closedPnl: usd(closedPnl),
            oid: id,
            fee: usd(feeE6),
            ...(cloid ? { cloid } : {}),
        });
        return { filled: { totalSz: fmt(size), avgPx: fmt(mark), oid: id, ...(cloid ? { cloid } : {}) } };
    }

    async function exchange(body: Json, response: ServerResponse) {
        const action = body.action as Json;
        requests.push(`exchange ${action.type as string}`);
        if (action.type === "usdSend") {
            const from = await userSigner(body);
            const to = (action.destination as string).toLowerCase();
            const amountE6 = parseUnits(action.amount as string, 6);
            const nonce = body.nonce as number;
            const shape = usdSendPlan.get(++usdSendCount);
            if (shape === "lose") return;
            if (typeof shape === "object") await new Promise((resolve) => setTimeout(resolve, shape.late));
            const seen = seenNonces.get(from) ?? new Set<number>();
            const refuse = (message: string) => {
                if (refusalUsesNonce) {
                    seen.add(nonce);
                    seenNonces.set(from, seen);
                }
                return send(response, { status: "err", response: message });
            };
            if (usdSendFails || shape === "refuse") return refuse("usdSend is failing.");
            if (seen.has(nonce)) return send(response, { status: "err", response: "Duplicate nonce." });
            const sender = accounts.get(from);
            const fresh = !accounts.has(to);
            const debit = amountE6 + (fresh && activation === "sender" ? ACTIVATION_E6 : 0n);
            const credit = amountE6 - (fresh && activation === "amount" ? ACTIVATION_E6 : 0n);
            if (!sender || sender.freeE6 < debit || credit < 0n) return refuse("Insufficient balance for withdrawal.");
            seen.add(nonce);
            seenNonces.set(from, seen);
            sender.freeE6 -= debit;
            accountOf(to).freeE6 += credit;
            usdSends.push({ from, to, amountE6, nonce });
            transferLog.push({ from, to, amountE6, time: Date.now() });
            return send(response, { status: "ok", response: { type: "default" } });
        }
        const signer = await l1Signer(body);
        if (action.type === "updateLeverage") {
            accountOf(signer).leverage.set(NAMES[action.asset as number]!, action.leverage as number);
            return send(response, { status: "ok", response: { type: "default" } });
        }
        if (action.type === "order") {
            const forced = next;
            next = undefined;
            if (forced === "hold") return;
            if (typeof body.expiresAfter === "number" && Date.now() > body.expiresAfter)
                return send(response, { status: "err", response: "Order action expired." });
            const [order] = action.orders as Json[];
            const status = placeOrder(signer, order!, forced);
            orders.push({
                signer,
                asset: NAMES[order!.a as number]!,
                isBuy: order!.b as boolean,
                px: order!.p as string,
                sz: order!.s as string,
                reduceOnly: order!.r as boolean,
                cloid: (order!.c as string | undefined) ?? null,
                expiresAfter: typeof body.expiresAfter === "number" ? body.expiresAfter : null,
            });
            if (forced === "drop") return;
            return send(response, { status: "ok", response: { type: "order", data: { statuses: [status] } } });
        }
        return send(response, { status: "err", response: `Unsupported action ${action.type as string}` });
    }

    function info(body: Json, response: ServerResponse) {
        const type = body.type as string;
        requests.push(`info ${type}`);
        const user = String(body.user ?? "").toLowerCase();
        if (type === "meta") return send(response, META);
        if (type === "metaAndAssetCtxs") {
            const ctxs = CTXS.map((ctx, i) => ({ ...ctx, markPx: fmt(markOf(NAMES[i]!)) }));
            return send(response, [META, ctxs]);
        }
        if (type === "l2Book") {
            const coin = body.coin as string;
            const mark = markOf(coin);
            const book = books.get(coin) ?? {
                bids: [{ price: mark * 0.9999, size: 1000 }],
                asks: [{ price: mark * 1.0001, size: 1000 }],
            };
            const level = (l: { price: number; size: number }) => ({ px: String(l.price), sz: String(l.size), n: 1 });
            return send(response, { coin, time: Date.now(), levels: [book.bids.map(level), book.asks.map(level)] });
        }
        if (type === "clearinghouseState") return send(response, stateOf(user));
        if (type === "userFees") {
            return send(response, {
                dailyUserVlm: [],
                feeSchedule: {
                    cross: "0.00045",
                    add: "0.00015",
                    spotCross: "0.0007",
                    spotAdd: "0.0004",
                    tiers: { vip: [], mm: [] },
                },
                userCrossRate: String(TAKER_RATE),
                userAddRate: "0.00015",
                userSpotCrossRate: "0.0007",
                userSpotAddRate: "0.0004",
                activeReferralDiscount: "0.0",
            });
        }
        if (type === "userFills" || type === "userFillsByTime") {
            const since = type === "userFillsByTime" ? (body.startTime as number) : 0;
            return send(
                response,
                (fills.get(user) ?? []).filter((f) => f.time >= since),
            );
        }
        if (type === "userNonFundingLedgerUpdates") {
            const since = (body.startTime as number | undefined) ?? 0;
            return send(
                response,
                transferLog
                    .filter((t) => t.time >= since && (t.from === user || t.to === user))
                    .map((t) => ({
                        time: t.time,
                        hash: `0x${"0".repeat(64)}`,
                        delta: {
                            type: "send",
                            user: t.from,
                            destination: t.to,
                            sourceDex: "",
                            destinationDex: "",
                            token: "USDC",
                            amount: usd(t.amountE6),
                            usdcValue: usd(t.amountE6),
                            fee: "0.0",
                            nativeTokenFee: "0.0",
                            nonce: null,
                        },
                    })),
            );
        }
        if (type === "orderStatus") {
            const key = typeof body.oid === "string" ? body.oid : `oid:${String(body.oid)}`;
            const found = statuses.get(key) ?? [...statuses.values()].find((s) => `oid:${s.oid}` === key);
            if (!found || statusHidden) return send(response, { status: "unknownOid" });
            return send(response, {
                status: "order",
                order: {
                    order: {
                        coin: found.coin,
                        side: found.isBuy ? "B" : "A",
                        limitPx: found.limitPx,
                        sz: "0.0",
                        oid: found.oid,
                        timestamp: found.time,
                        triggerCondition: "N/A",
                        isTrigger: false,
                        triggerPx: "0.0",
                        children: [],
                        isPositionTpsl: false,
                        reduceOnly: found.reduceOnly,
                        orderType: "Limit",
                        origSz: found.origSz,
                        tif: "Ioc",
                        ...(found.cloid ? { cloid: found.cloid } : {}),
                    },
                    status: found.status,
                    statusTimestamp: found.time,
                },
            });
        }
        return send(response, { error: `Unsupported info type ${type}` });
    }

    const server = createServer(async (request, response) => {
        try {
            const body = JSON.parse(await readBody(request)) as Json;
            if (request.url === "/info") return info(body, response);
            if (request.url === "/exchange") return await exchange(body, response);
            response.writeHead(404).end();
        } catch (error) {
            response.writeHead(500).end(String(error));
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        requests,
        usdSends,
        orders,
        setMark: (asset, px) => void marks.set(asset, px),
        setBook: (asset, book) => void books.set(asset, book),
        fund: (address, usdE6) => void (accountOf(address).freeE6 += usdE6),
        nextOrder: (value) => void (next = value),
        liquidate(address, asset) {
            const key = address.toLowerCase();
            const position = accounts.get(key)?.positions.get(asset);
            if (!position) throw new Error(`${address} holds no ${asset} position`);
            accounts.get(key)!.positions.delete(asset);
            const long = position.szi > 0;
            record(key, {
                coin: asset,
                px: fmt(markOf(asset)),
                sz: fmt(Math.abs(position.szi)),
                side: long ? "A" : "B",
                startPosition: fmt(position.szi),
                dir: long ? "Liquidated Long" : "Liquidated Short",
                closedPnl: usd(-position.marginE6),
                oid: ++oid,
                fee: "0.0",
                liquidation: { liquidatedUser: key, markPx: fmt(markOf(asset)), method: "market" },
            });
        },
        failUsdSend: (on) => void (usdSendFails = on),
        nextUsdSend(nth, shape) {
            usdSendPlan.set(usdSendCount + nth, shape);
        },
        refusalConsumesNonce: (on) => void (refusalUsesNonce = on),
        hideOrderStatus: (on) => void (statusHidden = on),
        vanish(address, asset) {
            accounts.get(address.toLowerCase())?.positions.delete(asset);
        },
        activationFrom: (source) => void (activation = source),
        account(address) {
            const account = accounts.get(address.toLowerCase());
            if (!account) return undefined;
            return {
                freeE6: account.freeE6,
                positions: [...account.positions].map(([asset, p]) => ({ asset, ...p })),
            };
        },
        reset() {
            requests.length = 0;
            usdSends.length = 0;
            orders.length = 0;
            for (const map of [accounts, fills, statuses, marks, books, seenNonces]) map.clear();
            next = undefined;
            usdSendFails = false;
            usdSendCount = 0;
            usdSendPlan.clear();
            transferLog.length = 0;
            refusalUsesNonce = false;
            statusHidden = false;
            activation = "sender";
        },
        stop: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}
