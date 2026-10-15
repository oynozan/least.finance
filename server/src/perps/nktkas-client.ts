import { ApiRequestError, ExchangeClient, HttpTransport, InfoClient, ValidationError } from "@nktkas/hyperliquid";
import { formatUnits, parseUnits } from "viem";
import type { HDAccount } from "viem/accounts";
import type {
    AccountState,
    Fill,
    HyperliquidClient,
    OrderResult,
    OrderStatus,
    PerpMeta,
    Transfer,
    UsdSendResult,
} from "./client.ts";

const stripZeros = (value: string) => (value.includes(".") ? value.replace(/\.?0+$/, "") : value);

const DUPLICATE_NONCE = /duplicate.*nonce|nonce.*(already|duplicate|used)/i;

/** A decimal string as 6-decimal units, cut (never rounded up) past the sixth decimal. */
const toE6 = (value: string): bigint => {
    const [whole = "0", fraction = ""] = value.split(".");
    return parseUnits(`${whole}.${fraction.slice(0, 6)}`, 6);
};

/** Every Hyperliquid call goes through this adapter; it is the only file that imports the SDK. */
export function createNktkasClient(o: { url: string; timeoutMs?: number }): HyperliquidClient {
    const transport = new HttpTransport({
        apiUrl: o.url,
        isTestnet: new URL(o.url).hostname.includes("testnet"),
        ...(o.timeoutMs === undefined ? {} : { timeout: o.timeoutMs }),
    });
    const info = new InfoClient({ transport });
    let indexes: Map<string, number> | null = null;

    const metaAndCtxs = () => info.metaAndAssetCtxs();

    async function assetIndex(asset: string): Promise<number> {
        const known = indexes?.get(asset);
        if (known !== undefined) return known;
        const [meta] = await metaAndCtxs();
        indexes = new Map(meta.universe.map((entry, index) => [entry.name, index]));
        const index = indexes.get(asset);
        if (index === undefined) throw new Error(`Hyperliquid has no ${asset} market`);
        return index;
    }

    const exchangeFor = (signer: HDAccount, nonce?: number) =>
        new ExchangeClient({
            transport,
            wallet: signer,
            ...(nonce === undefined ? {} : { nonceManager: () => nonce }),
        });

    /** The message of a rejected exchange call: the first per-order error, else the top-level one. */
    function rejection(error: ApiRequestError): string {
        const response = error.response as { response?: unknown } | undefined;
        const statuses = (response as { response?: { data?: { statuses?: unknown[] } } } | undefined)?.response?.data
            ?.statuses;
        const first = statuses?.find(
            (s): s is { error: string } => typeof (s as { error?: unknown })?.error === "string",
        );
        if (first) return first.error;
        return typeof response?.response === "string" ? response.response : error.message;
    }

    type RawFill = Awaited<ReturnType<InfoClient["userFills"]>>[number];
    const toFill = (f: RawFill): Fill => ({
        tid: f.tid,
        oid: f.oid,
        cloid: f.cloid ?? null,
        asset: f.coin,
        sizeCoin: f.sz,
        px: f.px,
        feeE6: toE6(f.fee),
        dir: f.dir,
        liquidation: f.liquidation !== undefined,
        time: f.time,
    });

    return {
        async meta(): Promise<PerpMeta> {
            const [meta, ctxs] = await metaAndCtxs();
            const tables = new Map(meta.marginTables.map(([id, table]) => [id, table.marginTiers]));
            indexes = new Map(meta.universe.map((entry, index) => [entry.name, index]));
            return {
                assets: meta.universe.flatMap((entry, index) => {
                    const ctx = ctxs[index];
                    if (!ctx || entry.isDelisted) return [];
                    return [
                        {
                            asset: entry.name,
                            index,
                            szDecimals: entry.szDecimals,
                            maxLeverage: entry.maxLeverage,
                            marginTables: (tables.get(entry.marginTableId) ?? []).map((tier) => ({
                                lowerBound: tier.lowerBound,
                                maxLeverage: tier.maxLeverage,
                            })),
                            onlyIsolated: entry.onlyIsolated === true,
                            markPx: Number(ctx.markPx),
                            oraclePx: Number(ctx.oraclePx),
                            funding: Number(ctx.funding),
                        },
                    ];
                }),
            };
        },

        async book(asset) {
            const book = await info.l2Book({ coin: asset });
            const levels = (side: { px: string; sz: string }[] | undefined) =>
                (side ?? []).map((level) => ({ price: Number(level.px), size: Number(level.sz) }));
            return { bids: levels(book?.levels[0]), asks: levels(book?.levels[1]) };
        },

        async state(address): Promise<AccountState | null> {
            const raw = await info.clearinghouseState({ user: address as `0x${string}` });
            const accountValueE6 = toE6(raw.marginSummary.accountValue);
            const withdrawableE6 = toE6(raw.withdrawable);
            if (raw.assetPositions.length === 0 && accountValueE6 === 0n && withdrawableE6 === 0n) return null;
            return {
                withdrawableE6,
                accountValueE6,
                positions: raw.assetPositions.map(({ position: p }) => ({
                    asset: p.coin,
                    sizeCoin: p.szi.replace(/^-/, ""),
                    side: p.szi.startsWith("-") ? "short" : "long",
                    entryPx: p.entryPx,
                    leverage: p.leverage.value,
                    liquidationPx: p.liquidationPx,
                    unrealizedPnlE6: toE6(p.unrealizedPnl),
                    cumFundingE6: toE6(p.cumFunding.sinceOpen),
                    marginUsedE6: toE6(p.marginUsed),
                })),
            };
        },

        async userFees(address) {
            const fees = await info.userFees({ user: address as `0x${string}` });
            return { takerRate: Number(fees.userCrossRate) };
        },

        async fills(address, sinceMs) {
            const raw = await info.userFillsByTime({ user: address as `0x${string}`, startTime: sinceMs });
            return raw.map(toFill).sort((a, b) => a.time - b.time || a.tid - b.tid);
        },

        async orderStatus(address, cloid): Promise<OrderStatus> {
            const raw = await info.orderStatus({ user: address as `0x${string}`, oid: cloid as `0x${string}` });
            if (raw.status === "unknownOid") return { kind: "missing" };
            const { status, order } = raw.order;
            if (status === "open") return { kind: "open" };
            const fills = (await info.userFills({ user: address as `0x${string}` })).filter((f) => f.oid === order.oid);
            if (fills.length > 0) {
                const total = fills.reduce((sum, f) => sum + Number(f.sz), 0);
                const notional = fills.reduce((sum, f) => sum + Number(f.px) * Number(f.sz), 0);
                const decimals = Math.max(...fills.map((f) => f.sz.split(".")[1]?.length ?? 0));
                return {
                    kind: "filled",
                    totalSz: stripZeros(total.toFixed(decimals)),
                    avgPx: String(notional / total),
                };
            }
            if (status === "filled") return { kind: "filled", totalSz: order.origSz, avgPx: order.limitPx };
            if (status.endsWith("Rejected")) return { kind: "rejected", message: status };
            return { kind: "canceled" };
        },

        async transfers(address, sinceMs): Promise<Transfer[]> {
            const raw = await info.userNonFundingLedgerUpdates({ user: address as `0x${string}`, startTime: sinceMs });
            return raw.flatMap(({ time, delta }) => {
                // A usdSend, which is what this code signs, is recorded as an internalTransfer; a sendAsset leaves a send
                if (delta.type !== "internalTransfer" && !(delta.type === "send" && delta.token === "USDC")) return [];
                const amount = delta.type === "send" ? delta.amount : delta.usdc;
                return [
                    {
                        from: delta.user.toLowerCase(),
                        to: delta.destination.toLowerCase(),
                        amountE6: toE6(amount),
                        time,
                    },
                ];
            });
        },

        async usdSend(from, to, amountE6, nonce): Promise<UsdSendResult> {
            try {
                await exchangeFor(from, nonce).usdSend({
                    destination: to as `0x${string}`,
                    amount: formatUnits(amountE6, 6),
                });
                return { kind: "ok" };
            } catch (error) {
                if (!(error instanceof ApiRequestError)) throw error;
                const message = rejection(error);
                return DUPLICATE_NONCE.test(message) ? { kind: "duplicate" } : { kind: "rejected", message };
            }
        },

        async updateLeverage(signer, asset, leverage) {
            await exchangeFor(signer).updateLeverage({ asset: await assetIndex(asset), isCross: false, leverage });
        },

        async order(signer, o): Promise<OrderResult> {
            const a = await assetIndex(o.asset);
            try {
                const result = await exchangeFor(signer).order(
                    {
                        orders: [
                            {
                                a,
                                b: o.isBuy,
                                p: o.px,
                                s: o.sz,
                                r: o.reduceOnly,
                                t: { limit: { tif: "Ioc" } },
                                c: o.cloid as `0x${string}`,
                            },
                        ],
                        grouping: "na",
                    },
                    o.expiresAfter === undefined ? undefined : { expiresAfter: o.expiresAfter },
                );
                const status = result.response.data.statuses[0];
                if (typeof status === "object" && "filled" in status) {
                    return { kind: "filled", totalSz: status.filled.totalSz, avgPx: status.filled.avgPx };
                }
                if (typeof status === "object" && "resting" in status) {
                    return { kind: "resting", oid: status.resting.oid };
                }
                return { kind: "unknown" };
            } catch (error) {
                if (error instanceof ApiRequestError) return { kind: "rejected", message: rejection(error) };
                if (error instanceof ValidationError) throw error;
                return { kind: "unknown" };
            }
        },
    };
}

/** A signed withdrawal of the signer's perps dollars to an EVM address through Circle's forwarding data; used only by the operator's rebalance script. */
export async function sendToEvmWithData(o: {
    url: string;
    signer: HDAccount;
    to: string;
    amountE6: bigint;
    destinationChainId: number;
    gasLimit: number;
    data: string;
    nonce: number;
}): Promise<void> {
    const transport = new HttpTransport({
        apiUrl: o.url,
        isTestnet: new URL(o.url).hostname.includes("testnet"),
    });
    await new ExchangeClient({ transport, wallet: o.signer, nonceManager: () => o.nonce }).sendToEvmWithData({
        token: "USDC",
        amount: formatUnits(o.amountE6, 6),
        sourceDex: "",
        destinationRecipient: o.to,
        addressEncoding: "hex",
        destinationChainId: o.destinationChainId,
        gasLimit: o.gasLimit,
        data: o.data,
    });
}
