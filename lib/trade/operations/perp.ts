import { VERB, canonicalDecimal, type Bound, type Choice, type Issue } from "@/lib/sentence";
import {
    PERP_FEE_USD,
    PERP_MIN_COLLATERAL_MESSAGE,
    PERP_MIN_COLLATERAL_USD,
    PERP_MIN_POSITION_MESSAGE,
    PERP_MIN_POSITION_USD,
} from "@/server/src/perps/fee";
import { LEVERAGE_STEPS } from "../catalog";
import { operation, priceOf, token, type TradeCtx } from "../context";
import { formatPrice, formatUsd, formatUsdShort } from "../format";
import type { TransactionIntent } from "../intent";
import { minimum, spendCap, usdAmount } from "./shared";

type Side = "long" | "short";
type Values = { asset: string; leverage: string; collateralUSD: string };
type Fixed = { side: Side };

/** Long and short can't open yet; the sentence still builds. Which of the three reasons it is decides what it says. */
function unavailable(ctx: TradeCtx): Issue<never> {
    const trading = ctx.perpTrading;
    const waiting = trading && !trading.loaded;
    return {
        code: "unavailable",
        severity: "error",
        message: !trading
            ? "Long and short aren't available right now."
            : !trading.loaded
              ? trading.error
                  ? `Couldn't reach the server to load the markets (${trading.error}).`
                  : "Checking whether Long and short are available…"
              : "Long and short are switched off for now.",
        cta: waiting && !trading.error ? "Checking…" : "Not available right now",
    };
}

/** A k-asset is priced and sized per thousand coins: kPEPE is "1,000 PEPE". */
const thousand = (asset: string) => (/^k[A-Z]/.test(asset) ? `1,000 ${asset.slice(1)}` : undefined);

const market = (ctx: TradeCtx, asset: string) => ctx.catalog.perps.find((m) => m.asset === asset);

/** Leverage never goes above the market's cap. */
function clampLeverage(ctx: TradeCtx, asset: string, leverage: string) {
    const max = market(ctx, asset)?.maxLeverage ?? 1;
    return Number(leverage) <= max ? leverage : String(max);
}

/** "7", "7x" -> a whole-number leverage the market allows */
function parseLeverage(ctx: TradeCtx, asset: string, text: string) {
    const match = /^\s*(\d{1,3})\s*x?\s*$/i.exec(text);
    if (!match) return null;
    const leverage = Number(match[1]);
    const max = market(ctx, asset)?.maxLeverage ?? 1;
    return leverage >= 1 && leverage <= max ? String(leverage) : null;
}

/** What the float can cover per order, once the server has answered */
function floatCap(ctx: TradeCtx): Bound | undefined {
    const max = ctx.perpTrading?.maxOrderUSD;
    if (typeof max !== "number") return undefined;
    return {
        value: max,
        message: `Long and short are limited to ${formatUsdShort(max)} right now.`,
        cta: "Over the limit",
    };
}

/** The tighter of the balance and the float's limit */
function collateralCap(ctx: TradeCtx): Bound | undefined {
    const caps = [spendCap(ctx), floatCap(ctx)].filter((cap) => cap !== undefined);
    return caps.reduce<Bound | undefined>((a, b) => (a && a.value <= b.value ? a : b), undefined);
}

function leverageChoice(leverage: number): Choice {
    return { value: String(leverage), label: `${leverage}x` };
}

const verb = (side: Side, label: string, hint: string) => ({
    id: side,
    label,
    hint,
    group: "Leverage",
    icon: { set: "verb", id: side },
    fixed: { side } as Fixed,
    cta: (v: Values & Fixed) => `Review ${v.leverage}x ${side}`,
});

/** "I want to [Long] [BTC] at [5x] leverage with [100 USD]." */
export const perp = operation({
    id: "perp",
    verbs: [
        verb("long", "Long", "Earn if the price goes up, with leverage"),
        verb("short", "Short", "Earn if the price goes down, with leverage"),
    ],
    slots: {
        asset: {
            kind: "choice",
            prompt: "Which market?",
            hint: "Market you trade",
            term: "token",
            missing: { message: "Pick a market.", cta: "Pick a market" },
            search: { placeholder: "Search markets", local: true },
            choices: (_v: Values & Fixed, ctx) =>
                ctx.catalog.perps.map((m): Choice => {
                    const price = m.markPx ?? priceOf(ctx, m.asset);
                    return {
                        value: m.asset,
                        label: m.asset,
                        description: token(ctx, m.asset)?.name ?? thousand(m.asset),
                        detail: `${price == null ? "—" : formatPrice(price)}, up to ${m.maxLeverage}x`,
                        icon: { set: "coin", id: m.asset },
                    };
                }),
        },
        leverage: {
            kind: "choice",
            prompt: "How much leverage?",
            hint: "Leverage",
            missing: { message: "Pick the leverage.", cta: "Pick leverage" },
            choices: (v: Values & Fixed, ctx) => {
                const max = market(ctx, v.asset)?.maxLeverage ?? 1;
                return LEVERAGE_STEPS.filter((step) => step <= max).map(leverageChoice);
            },
            // Any leverage the market allows, not just the listed steps.
            custom: {
                placeholder: (v, ctx) => `Custom, 1 to ${market(ctx, v.asset)?.maxLeverage ?? 1}`,
                suffix: "x",
                parse: (text, v, ctx) => parseLeverage(ctx, v.asset, text),
                choice: (value) => leverageChoice(Number(value)),
            },
        },
        collateralUSD: {
            ...usdAmount(
                (_v: Values & Fixed, ctx) => ({
                    min: { ...minimum(PERP_MIN_COLLATERAL_USD), message: PERP_MIN_COLLATERAL_MESSAGE },
                    max: collateralCap(ctx),
                }),
                (v) =>
                    `A ${formatUsdShort(Math.max(0, Number(v.collateralUSD) - PERP_FEE_USD) * (Number(v.leverage) || 1))} position`,
            ),
            prompt: "How much collateral, in dollars?",
            hint: "Collateral in USD",
        },
    },
    defaults: () => ({ asset: "BTC", leverage: "5", collateralUSD: "100" }),
    template: () => [
        VERB,
        { slot: "asset" },
        "at",
        { slot: "leverage" },
        "leverage with",
        { slot: "collateralUSD" },
        ".",
    ],
    // A market with a lower cap pulls the leverage down to fit.
    normalize: (next, _cause, _fixed, ctx) => {
        const leverage = clampLeverage(ctx, next.asset, next.leverage);
        return leverage === next.leverage ? next : { ...next, leverage };
    },
    check: (v, ctx) => {
        if (!(ctx.perpTrading?.loaded && ctx.perpTrading.maxOrderUSD !== null)) return [unavailable(ctx)];
        const collateral = Number(v.collateralUSD) || 0;
        const issues: Issue<keyof Values>[] = [];
        if (
            collateral >= PERP_MIN_COLLATERAL_USD &&
            (collateral - PERP_FEE_USD) * (Number(v.leverage) || 1) < PERP_MIN_POSITION_USD
        ) {
            issues.push({
                code: "below_minimum",
                severity: "error",
                message: PERP_MIN_POSITION_MESSAGE,
                cta: "Raise collateral or leverage",
            });
        }
        if (ctx.openPerps?.some((p) => p.asset === v.asset)) {
            issues.push({
                code: "position_open",
                severity: "error",
                message: `You already hold a ${v.asset} position. Close it first.`,
                cta: "Position already open",
            });
        }
        return issues;
    },
    toIntent: (v): Extract<TransactionIntent, { type: "perp" }> => ({
        type: "perp",
        side: v.side,
        asset: v.asset,
        leverage: Number(v.leverage),
        collateralUSD: canonicalDecimal(v.collateralUSD),
    }),
    // Only what the sentence itself says: no venue has quoted an entry, a fee or a liquidation price.
    preview: (v) => {
        const collateral = Number(v.collateralUSD) || 0;
        const leverage = Number(v.leverage) || 1;
        const invested = Math.max(0, collateral - PERP_FEE_USD);
        return {
            rows: [
                {
                    id: "size",
                    label: "Position",
                    value: collateral ? formatUsdShort(invested * leverage) : "—",
                    ...(collateral > 0 && { note: `${leverage} × ${formatUsdShort(invested)}` }),
                    primary: true,
                },
                { id: "risk", label: "Most you can lose", value: collateral ? formatUsd(collateral) : "—" },
            ],
        };
    },
});
