import { VERB, canonicalDecimal, type Choice } from "@/lib/sentence";
import { LEVERAGE_STEPS } from "../catalog";
import { operation, priceOf, token, type TradeCtx } from "../context";
import { formatPercent, formatUsd, formatUsdShort } from "../format";
import type { TransactionIntent } from "../intent";
import { minimum, spendCap, usdAmount } from "./shared";

type Side = "long" | "short";
type Values = { asset: string; leverage: string; collateralUSD: string };
type Fixed = { side: Side };

const OPEN_FEE_RATE = 0.0005;
/** Leverage at or above this is shown in the loss tone in the picker. */
const RISKY_LEVERAGE = 20;

const market = (ctx: TradeCtx, asset: string) => ctx.catalog.perps.find((m) => m.asset === asset);

/** How far the price can move against the position before liquidation. */
function liquidationDistance(ctx: TradeCtx, asset: string, leverage: number) {
  return Math.max(1 / leverage - (market(ctx, asset)?.maintenanceMargin ?? 0), 0);
}

/** Leverage never goes above the market's cap. */
function clampLeverage(ctx: TradeCtx, asset: string, leverage: string) {
  const max = market(ctx, asset)?.maxLeverage ?? 1;
  return Number(leverage) <= max ? leverage : String(max);
}

/** "7", "7x", "12.5" -> a leverage the market allows, in steps of 0.1. */
function parseLeverage(ctx: TradeCtx, asset: string, text: string) {
  const match = /^\s*(\d{1,3}(?:\.\d)?)\s*x?\s*$/i.exec(text);
  if (!match) return null;
  const leverage = Number(match[1]);
  const max = market(ctx, asset)?.maxLeverage ?? 1;
  return leverage >= 1 && leverage <= max ? String(leverage) : null;
}

function leverageChoice(ctx: TradeCtx, v: Values & Fixed, leverage: number): Choice {
  const move = v.side === "long" ? "drop" : "rise";
  return {
    value: String(leverage),
    label: `${leverage}x`,
    detail: `liquidated on a ${formatPercent(liquidationDistance(ctx, v.asset, leverage))} ${move}`,
    tone: leverage >= RISKY_LEVERAGE ? "loss" : undefined,
  };
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
      choices: (_v: Values & Fixed, ctx) =>
        ctx.catalog.perps.map((m): Choice => ({
          value: m.asset,
          label: m.asset,
          description: token(ctx, m.asset)?.name,
          detail: `${formatUsd(priceOf(ctx, m.asset))} · up to ${m.maxLeverage}x`,
          icon: { set: "coin", id: m.asset },
        })),
    },
    leverage: {
      kind: "choice",
      prompt: "How much leverage?",
      hint: "Leverage",
      missing: { message: "Pick the leverage.", cta: "Pick leverage" },
      choices: (v: Values & Fixed, ctx) => {
        const max = market(ctx, v.asset)?.maxLeverage ?? 1;
        return LEVERAGE_STEPS.filter((step) => step <= max).map((step) => leverageChoice(ctx, v, step));
      },
      // Any leverage the market allows, not just the listed steps.
      custom: {
        placeholder: (v, ctx) => `Custom, 1 to ${market(ctx, v.asset)?.maxLeverage ?? 1}`,
        suffix: "x",
        parse: (text, v, ctx) => parseLeverage(ctx, v.asset, text),
        choice: (value, v, ctx) => leverageChoice(ctx, v, Number(value)),
      },
    },
    collateralUSD: {
      ...usdAmount((_v: Values & Fixed, ctx) => ({ min: { ...minimum(10), message: "Positions start at $10." }, max: spendCap(ctx) })),
      prompt: "How much collateral, in dollars?",
      hint: "Collateral in USD",
    },
  },
  defaults: () => ({ asset: "BTC", leverage: "5", collateralUSD: "100" }),
  template: () => [VERB, { slot: "asset" }, "at", { slot: "leverage" }, "leverage with", { slot: "collateralUSD" }, "."],
  // A market with a lower cap pulls the leverage down to fit.
  normalize: (next, _cause, _fixed, ctx) => {
    const leverage = clampLeverage(ctx, next.asset, next.leverage);
    return leverage === next.leverage ? next : { ...next, leverage };
  },
  toIntent: (v): Extract<TransactionIntent, { type: "perp" }> => ({
    type: "perp",
    side: v.side,
    asset: v.asset,
    leverage: Number(v.leverage),
    collateralUSD: canonicalDecimal(v.collateralUSD),
  }),
  preview: (v, ctx) => {
    const collateral = Number(v.collateralUSD) || 0;
    const leverage = Number(v.leverage) || 1;
    const size = collateral * leverage;
    const entry = priceOf(ctx, v.asset);
    const distance = liquidationDistance(ctx, v.asset, leverage);
    const liquidation = v.side === "long" ? entry * (1 - distance) : entry * (1 + distance);
    const move = v.side === "long" ? "falls" : "rises";
    return {
      rows: [
        {
          id: "size",
          label: "Position",
          value: collateral ? `${formatUsdShort(size)} (${leverage} × ${formatUsdShort(collateral)})` : "—",
          primary: true,
        },
        {
          id: "liquidation",
          label: "Liquidation",
          value: `≈ ${formatUsd(liquidation)}, if ${v.asset} ${move} ${formatPercent(distance)}`,
          tone: "loss",
          primary: true,
        },
        { id: "entry", label: "Entry price", value: `≈ ${formatUsd(entry)}` },
        { id: "risk", label: "Most you can lose", value: collateral ? formatUsd(collateral) : "—" },
        { id: "fee", label: "Open fee", value: collateral ? `≈ ${formatUsd(size * OPEN_FEE_RATE)}` : "—" },
      ],
    };
  },
});
