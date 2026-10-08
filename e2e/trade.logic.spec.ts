import { expect, test } from "@playwright/test";
import {
  initialState,
  reduce,
  resolve,
  sanitizeDecimal,
  canonicalDecimal,
  schema,
  VERB,
  type SentenceAction,
  type SentenceState,
} from "@/lib/sentence";
import { CATALOG, MOCK_HOLDINGS } from "@/lib/trade/catalog";
import type { TradeCtx, TradeTerms } from "@/lib/trade/context";
import { TRADE } from "@/lib/trade/registry";

const connected: TradeCtx = { catalog: CATALOG, holdings: MOCK_HOLDINGS };
const disconnected: TradeCtx = { catalog: CATALOG, holdings: null };

function run(verb: string, actions: SentenceAction[] = [], ctx = connected) {
  let state: SentenceState<TradeTerms> = initialState(TRADE, verb, ctx);
  for (const action of actions) state = reduce(TRADE, state, action, ctx);
  return { state, view: resolve(TRADE, state, ctx) };
}
const slot = (slot: string, value: string): SentenceAction => ({ type: "slot", slot, value });
const verb = (verbId: string): SentenceAction => ({ type: "verb", verbId });

test.describe("sentences", () => {
  test("each verb starts with the sentence from the brief", () => {
    expect(run("swap").view.text).toBe("I want to Swap my ETH to SOL for 10 USD.");
    expect(run("buy").view.text).toBe("I want to Buy SOL for 10 USD.");
    expect(run("sell").view.text).toBe("I want to Sell my SOL for 10 USD.");
    expect(run("long").view.text).toBe("I want to Long BTC at 5x leverage with 100 USD.");
    expect(run("short").view.text).toBe("I want to Short BTC at 5x leverage with 100 USD.");
    expect(run("predict").view.text).toBe("I want to Predict YES on Will BTC reach $150K? with 10 USD.");
  });

  test("a complete sentence produces its normalized intent", () => {
    expect(run("swap").view.intent).toEqual({ type: "swap", fromToken: "ETH", toToken: "SOL", amountUSD: "10" });
    expect(run("sell").view.intent).toEqual({ type: "spot", side: "sell", token: "SOL", amountUSD: "10" });
    expect(run("short").view.intent).toEqual({
      type: "perp",
      side: "short",
      asset: "BTC",
      leverage: 5,
      collateralUSD: "100",
    });
    expect(run("predict").view.intent).toEqual({
      type: "prediction",
      marketId: "btc-150k-2026",
      outcomeId: "yes",
      amountUSD: "10",
    });
  });

  test("keys stay stable so persisting pills and words can glide", () => {
    const swap = run("swap").view.parts;
    const buy = run("swap", [verb("buy")]).view.parts;
    expect(swap.map((p) => p.key)).toEqual([
      "w:i:0", "w:want:0", "w:to:0", "verb", "w:my:0", "swap:fromToken", "w:to:1", "term:token", "w:for:0", "term:amountUSD",
    ]);
    expect(buy.map((p) => p.key)).toEqual(["w:i:0", "w:want:0", "w:to:0", "verb", "term:token", "w:for:0", "term:amountUSD"]);
    // The period rides on the last pill, so it can never wrap onto its own line.
    expect(swap.at(-1)).toMatchObject({ key: "term:amountUSD", glue: "." });
  });
});

test.describe("switching verbs", () => {
  test("the amount and the coin carry over", () => {
    const { view } = run("swap", [slot("amountUSD", "25"), slot("toToken", "LINK"), verb("buy")]);
    expect(view.text).toBe("I want to Buy LINK for 25 USD.");
    expect(run("swap", [slot("toToken", "LINK"), verb("long")]).view.text).toBe(
      "I want to Long LINK at 5x leverage with 10 USD.",
    );
  });

  test("a coin the next operation can't use is not carried", () => {
    // AVAX has no perp market: Long keeps its own default market.
    const { view } = run("swap", [slot("toToken", "AVAX"), verb("long")]);
    expect(view.slots.asset.kind === "choice" && view.slots.asset.value).toBe("BTC");
    // USDC can't be bought with USDC: Buy keeps its own coin.
    expect(run("swap", [slot("toToken", "USDC"), verb("buy")]).view.text).toBe("I want to Buy SOL for 10 USD.");
  });

  test("operation-only choices are kept when coming back", () => {
    const { view } = run("long", [slot("leverage", "3"), verb("swap"), verb("long")]);
    expect(view.text).toBe("I want to Long BTC at 3x leverage with 100 USD.");
  });

  test("arriving at Swap with its source coin never swaps a coin into itself", () => {
    const { view } = run("buy", [slot("token", "ETH"), verb("swap")]);
    expect(view.intent).toMatchObject({ type: "swap", toToken: "ETH" });
    expect(view.intent).not.toMatchObject({ fromToken: "ETH" });
  });
});

test.describe("preventing invalid sentences", () => {
  test("picking the other side's coin flips the swap", () => {
    expect(run("swap", [slot("toToken", "ETH")]).view.text).toBe("I want to Swap my SOL to ETH for 10 USD.");
    expect(run("swap", [slot("fromToken", "SOL")]).view.text).toBe("I want to Swap my SOL to ETH for 10 USD.");
  });

  test("disabled, unknown and verb-fixed values are ignored", () => {
    const start = run("sell").state;
    // The wallet holds no AVAX, so it can't be sold.
    expect(reduce(TRADE, start, slot("token", "AVAX"), connected)).toBe(start);
    expect(reduce(TRADE, start, slot("side", "buy"), connected)).toBe(start);
    expect(reduce(TRADE, start, slot("nope", "1"), connected)).toBe(start);
    // The stablecoin isn't offered for spot trades at all.
    expect(reduce(TRADE, start, slot("token", "USDC"), connected)).toBe(start);
  });

  test("a market with a lower cap pulls the leverage down", () => {
    const { view } = run("long", [slot("leverage", "50"), slot("asset", "SOL")]);
    expect(view.text).toBe("I want to Long SOL at 20x leverage with 100 USD.");
    expect(view.issues).toEqual([]);
    expect(view.intent).toMatchObject({ leverage: 20 });
  });

  test("leverage can be typed, within the market's cap", () => {
    expect(run("long", [slot("leverage", "7")]).view.text).toBe("I want to Long BTC at 7x leverage with 100 USD.");
    expect(run("long", [slot("leverage", "12.5x")]).view.intent).toMatchObject({ leverage: 12.5 });
    // Over BTC's 50x, or not a number: ignored.
    const start = run("long").state;
    expect(reduce(TRADE, start, slot("leverage", "70"), connected)).toBe(start);
    expect(reduce(TRADE, start, slot("leverage", "lots"), connected)).toBe(start);
    // A typed 30x on BTC drops to SOL's 20x cap.
    expect(run("long", [slot("leverage", "30"), slot("asset", "SOL")]).view.text).toBe(
      "I want to Long SOL at 20x leverage with 100 USD.",
    );
  });

  test("a new question keeps your side", () => {
    const { view } = run("predict", [slot("outcomeId", "no"), slot("marketId", "eth-5k-2026")]);
    expect(view.intent).toMatchObject({ marketId: "eth-5k-2026", outcomeId: "no" });
  });
});

test.describe("amounts", () => {
  test("typing is cleaned up, not blocked", () => {
    expect(sanitizeDecimal("1a2.3.4", 2)).toBe("12.34");
    expect(sanitizeDecimal("$1,250.009", 2)).toBe("1250.00");
    expect(sanitizeDecimal("10,5", 2)).toBe("10.5");
    expect(sanitizeDecimal("007", 2)).toBe("7");
    expect(sanitizeDecimal(".", 2)).toBe("0.");
    expect(sanitizeDecimal("10.", 2)).toBe("10.");
    expect(canonicalDecimal("010.")).toBe("10");
    expect(canonicalDecimal(".50")).toBe("0.5");
    expect(run("buy", [slot("amountUSD", "12.50")]).view.intent).toMatchObject({ amountUSD: "12.5" });
  });

  test("an empty amount is incomplete, a small one is an error", () => {
    const empty = run("buy", [slot("amountUSD", "")]).view;
    expect(empty.blocking).toMatchObject({ severity: "incomplete", cta: "Enter an amount" });
    expect(empty.intent).toBeNull();
    expect(run("buy", [slot("amountUSD", "0.5")]).view.blocking).toMatchObject({ code: "min", cta: "Minimum $1" });
    expect(run("long", [slot("collateralUSD", "5")]).view.blocking).toMatchObject({
      message: "Positions start at $10.",
    });
  });

  test("balances cap amounts only once a wallet is connected", () => {
    // 1.25 ETH at $3,210.40 is $4,013.
    const over = [slot("amountUSD", "5000")];
    expect(run("swap", over).view.blocking).toMatchObject({ code: "max", cta: "Not enough ETH" });
    expect(run("swap", over, disconnected).view.blocking).toBeUndefined();
    expect(run("buy", [slot("amountUSD", "3000")]).view.blocking).toMatchObject({ cta: "Not enough USDC" });
    // Disconnected, every coin can be picked.
    expect(run("sell", [slot("token", "AVAX")], disconnected).view.text).toBe("I want to Sell my AVAX for 10 USD.");
  });
});

test.describe("the schema", () => {
  test("rejects a verb defined twice", () => {
    const { operation, registry } = schema<{ amountUSD: string }, null>();
    const op = (id: string) =>
      operation({
        id,
        verbs: [{ id: "go", label: "Go", hint: "", group: "", fixed: {}, cta: () => "" }],
        slots: {},
        defaults: () => ({}),
        template: () => [VERB],
        toIntent: () => id,
        preview: () => ({ rows: [] }),
      });
    expect(() => registry([op("a"), op("b")], { lead: "I want to" })).toThrow(/defined twice/);
  });
});
