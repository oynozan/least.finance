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
import { CATALOG, MOCK_HOLDINGS, type Catalog } from "@/lib/trade/catalog";
import { toPredictionMarket } from "@/lib/trade/markets";
import type { MarketView, QuoteView } from "@/server/src/protocol";
import { heldOn, heldTotal, type TradeCtx, type TradeTerms, type WalletHoldings } from "@/lib/trade/context";
import { networkName } from "@/lib/trade/networks";
import { NETWORKS } from "@/server/src/swaps/coins";
import {
    buyPayNetwork,
    defaultPayNetwork,
    defaultReceiveNetwork,
    networkChoices,
    usdcCap,
} from "@/lib/trade/operations/shared";
import { quoteRows } from "@/lib/trade/prediction-quote";
import { TRADE } from "@/lib/trade/registry";
import {
    balanceHistory,
    confirmedActivity,
    daysSince,
    depositActivity,
    mockTrades,
    predictionActivity,
} from "@/lib/trade/activity";
import type { PositionView } from "@/server/src/protocol";

const connected: TradeCtx = { catalog: CATALOG, holdings: MOCK_HOLDINGS };
const disconnected: TradeCtx = { catalog: CATALOG, holdings: null };
const withWallet = (wallet: WalletHoldings | null): TradeCtx => ({ catalog: CATALOG, holdings: null, wallet });

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
        expect(run("buy").view.text).toBe("I want to Buy 10 USD of SOL.");
        expect(run("sell").view.text).toBe("I want to Sell 10 USD of my SOL.");
        expect(run("long").view.text).toBe("I want to Long BTC at 5x leverage with 100 USD.");
        expect(run("short").view.text).toBe("I want to Short BTC at 5x leverage with 100 USD.");
        expect(run("predict").view.text).toBe("I want to Predict YES on Will BTC reach $150K? with 10 USD.");
    });

    test("a complete sentence produces its normalized intent", () => {
        expect(run("swap").view.intent).toEqual({
            type: "swap",
            fromToken: "ETH",
            fromNetwork: "ethereum",
            toToken: "SOL",
            toNetwork: "solana",
            amountUSD: "10",
        });
        expect(run("sell").view.intent).toEqual({
            type: "spot",
            side: "sell",
            token: "SOL",
            network: "solana",
            amountUSD: "10",
        });
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
            "w:i:0",
            "w:want:0",
            "w:to:0",
            "verb",
            "w:my:0",
            "swap:fromToken",
            "w:to:1",
            "term:token",
            "w:for:0",
            "term:amountUSD",
        ]);
        expect(buy.map((p) => p.key)).toEqual([
            "w:i:0",
            "w:want:0",
            "w:to:0",
            "verb",
            "term:amountUSD",
            "w:of:0",
            "term:token",
        ]);
        // The period rides on the last pill, so it can never wrap onto its own line.
        expect(swap.at(-1)).toMatchObject({ key: "term:amountUSD", glue: "." });
    });
});

test.describe("switching verbs", () => {
    test("the amount and the coin carry over", () => {
        const { view } = run("swap", [slot("amountUSD", "25"), slot("toToken", "LINK"), verb("buy")]);
        expect(view.text).toBe("I want to Buy 25 USD of LINK.");
        expect(run("swap", [slot("toToken", "LINK"), verb("long")]).view.text).toBe(
            "I want to Long LINK at 5x leverage with 10 USD.",
        );
    });

    test("a coin the next operation can't use is not carried", () => {
        // AVAX has no perp market: Long keeps its own default market.
        const { view } = run("swap", [slot("toToken", "AVAX"), verb("long")]);
        expect(view.slots.asset.kind === "choice" && view.slots.asset.value).toBe("BTC");
        // USDC can't be bought with USDC: Buy keeps its own coin.
        expect(run("swap", [slot("toToken", "USDC"), verb("buy")]).view.text).toBe("I want to Buy 10 USD of SOL.");
    });

    test("operation-only choices are kept when coming back", () => {
        const { view } = run("long", [slot("leverage", "3"), verb("swap"), verb("long")]);
        expect(view.text).toBe("I want to Long BTC at 3x leverage with 100 USD.");
    });

    test("arriving at Swap with its source coin never swaps a coin into itself", () => {
        const { view } = run("buy", [slot("token", "ETH"), verb("swap")]);
        expect(view.intent).toMatchObject({ type: "swap", toToken: "ETH", toNetwork: "ethereum" });
        expect(view.intent).not.toMatchObject({ fromToken: "ETH" });
    });
});

test.describe("preventing invalid sentences", () => {
    test("picking the other side's coin flips the swap when both sides would be identical", () => {
        expect(run("swap", [slot("fromToken", "SOL")]).view.text).toBe("I want to Swap my SOL to ETH for 10 USD.");
        // BNB lives on one network, so receiving it while paying it is the same pair
        const wallet = withWallet({ BNB: { bnb: 2 }, SOL: { solana: 5 } });
        const bnb = run("swap", [slot("fromToken", "BNB"), slot("toToken", "BNB")], wallet).view;
        expect(bnb.intent).toMatchObject({ fromToken: "SOL", toToken: "BNB", toNetwork: "bnb" });
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

test.describe("networks", () => {
    const toNetworks = (view: ReturnType<typeof run>["view"], id: string) => {
        const host = view.slots[id];
        if (host.kind !== "choice" || !host.then) throw new Error(`${id} has no companion`);
        return host.then;
    };

    test("defaults: ETH pays from Ethereum and SOL arrives on Solana, not as Wormhole SOL", () => {
        const swap = { fromToken: "ETH", fromNetwork: "ethereum", toToken: "SOL", toNetwork: "solana" };
        expect(run("swap").view.intent).toMatchObject(swap);
        expect(run("swap", [], disconnected).view.intent).toMatchObject(swap);
        expect(run("swap", [], withWallet({ ETH: { ethereum: 1 } })).view.intent).toMatchObject(swap);
        expect(run("buy").view.intent).toMatchObject({ token: "SOL", network: "solana" });
    });

    test("the pay side defaults to where the wallet holds the most, else the home network", () => {
        const wallet = withWallet({ ETH: { base: 0.5, arbitrum: 0.2 } });
        expect(defaultPayNetwork(wallet, "ETH")).toBe("base");
        expect(run("swap", [], wallet).view.intent).toMatchObject({ fromNetwork: "base" });
        expect(defaultPayNetwork(withWallet({}), "ETH")).toBe("ethereum");
        expect(defaultPayNetwork(withWallet(null), "USDC")).toBe("arc");
        expect(defaultPayNetwork(disconnected, "BNB")).toBe("bnb");
    });

    test("the receive side defaults to the pay network unless the coin is wrapped there", () => {
        const eth = (network: "ethereum" | "arbitrum" | "base") => ({ token: "ETH", network });
        expect(defaultReceiveNetwork(connected, "USDC", eth("base"))).toBe("base");
        expect(defaultReceiveNetwork(connected, "SOL", eth("base"))).toBe("solana");
        expect(defaultReceiveNetwork(connected, "SOL", eth("ethereum"))).toBe("solana");
        expect(defaultReceiveNetwork(connected, "BTC")).toBe("ethereum");
        // The coin being paid starts at home, or on its first other entry when home is the pay network
        expect(defaultReceiveNetwork(connected, "ETH", eth("arbitrum"))).toBe("ethereum");
        expect(defaultReceiveNetwork(connected, "ETH", eth("ethereum"))).toBe("arbitrum");
        expect(defaultReceiveNetwork(connected, "USDC", { token: "USDC", network: "arc" })).toBe("ethereum");
    });

    test("the same coin on another network is a bridge, not a flip", () => {
        const { view } = run("swap", [slot("toToken", "ETH")]);
        expect(view.text).toBe("I want to Swap my ETH to ETH for 10 USD.");
        expect(view.intent).toMatchObject({
            fromToken: "ETH",
            fromNetwork: "ethereum",
            toToken: "ETH",
            toNetwork: "arbitrum",
        });
    });

    test("a coin pick that makes both sides identical flips them", () => {
        const { view } = run("swap", [slot("fromToken", "SOL")]);
        expect(view.intent).toMatchObject({
            fromToken: "SOL",
            fromNetwork: "solana",
            toToken: "ETH",
            toNetwork: "ethereum",
        });
        // The other side takes the previous network too, not a default
        const base = withWallet({ ETH: { base: 1 }, SOL: { solana: 5 } });
        const flipped = run("swap", [slot("toToken", "SOL"), slot("fromToken", "SOL")], base).view;
        expect(flipped.intent).toMatchObject({ toToken: "ETH", toNetwork: "base" });
    });

    test("the row that would make both sides identical is disabled", () => {
        const { state, view } = run("swap", [slot("toToken", "ETH")]);
        const rows = toNetworks(view, "toToken").choicesFor("ETH");
        expect(rows.find((c) => c.value === "ethereum")).toMatchObject({ disabled: "Same as the other side" });
        expect(rows.find((c) => c.value === "arbitrum")?.disabled).toBeUndefined();
        expect(reduce(TRADE, state, slot("toNetwork", "ethereum"), connected)).toBe(state);
        expect(reduce(TRADE, state, slot("toNetwork", "base"), connected)).not.toBe(state);
        // The pay side sees the same conflict from the other end, and an empty row says so first
        const funded = withWallet({ ETH: { ethereum: 1, arbitrum: 1, base: 0 } });
        const bridge = run("swap", [slot("toToken", "ETH")], funded).view;
        const pay = toNetworks(bridge, "fromToken").choicesFor("ETH");
        expect(pay.find((c) => c.value === "arbitrum")).toMatchObject({ disabled: "Same as the other side" });
        expect(pay.find((c) => c.value === "base")).toMatchObject({ disabled: "Nothing here" });
    });

    test("a coin on one network commits with that network", () => {
        const { view } = run("swap", [slot("toToken", "BNB")]);
        expect(view.intent).toMatchObject({ toToken: "BNB", toNetwork: "bnb" });
        expect(
            toNetworks(view, "toToken")
                .choicesFor("BNB")
                .map((c) => c.value),
        ).toEqual(["bnb"]);
    });

    test("network rows carry the label, the wallet's amount and the badge", () => {
        const wallet = withWallet({ ETH: { ethereum: 1.5, base: 0.25 } });
        const rows = networkChoices(wallet, "ETH", "pay");
        expect(rows.map((c) => c.value)).toEqual([
            "ethereum",
            "arbitrum",
            "base",
            "optimism",
            "polygon",
            "bnb",
            "avalanche",
            "arc",
            "solana",
        ]);
        expect(rows[0]).toMatchObject({
            label: "Ethereum",
            detail: "1.5 ETH",
            subdetail: "$4,815.60",
            icon: { set: "coin", id: "ETH", badge: { set: "network", id: "ethereum" } },
        });
        expect(rows[0].description).toBeUndefined();
        expect(rows.find((c) => c.value === "polygon")).toMatchObject({
            label: "Polygon",
            description: "WETH",
            disabled: "Nothing here",
        });
        expect(rows.find((c) => c.value === "solana")?.description).toBe("Wormhole ETH");
        // Receiving is never blocked by an empty row, and nothing known shows no amount
        const receive = networkChoices(wallet, "ETH", "receive");
        expect(receive.every((c) => !c.disabled)).toBe(true);
        expect(receive.find((c) => c.value === "polygon")?.detail).toBeUndefined();
        expect(networkChoices(withWallet(null), "ETH", "pay")[0].detail).toBeUndefined();
        expect(networkName("bnb")).toBe("BNB Chain");
    });

    test("the cap is the wallet's dollars on that network, minus gas for native coins", () => {
        const wallet = withWallet({ ETH: { base: 0.5 } });
        const view = run("swap", [slot("amountUSD", "5000")], wallet).view;
        expect(view.blocking).toMatchObject({
            code: "max",
            message: "That's more than your $1,604.56 of ETH on Base.",
            cta: "Not enough ETH",
        });
        // A token has no gas reserve, and an empty network says so
        const link = run(
            "sell",
            [slot("token", "LINK"), slot("amountUSD", "5000")],
            withWallet({ LINK: { base: 10 } }),
        );
        expect(link.view.blocking).toMatchObject({ message: "That's more than your $184.50 of LINK on Base." });
        const none = withWallet({ ETH: { base: 0.0001 } });
        expect(run("swap", [slot("amountUSD", "5")], none).view.blocking).toMatchObject({
            message: "You don't hold any ETH on Base.",
        });
    });

    test("nothing loaded means no cap and no disabled networks", () => {
        const loading = withWallet(null);
        expect(heldOn(loading, "ETH", "ethereum")).toBeNull();
        expect(heldTotal(loading, "ETH")).toBeNull();
        const view = run("swap", [slot("amountUSD", "5000")], loading).view;
        expect(view.blocking).toBeUndefined();
        expect(networkChoices(loading, "ETH", "pay").some((c) => c.disabled)).toBe(false);
        expect(run("sell", [slot("token", "AVAX")], loading).view.text).toBe("I want to Sell 10 USD of my AVAX.");
        expect(usdcCap(loading)).toBeUndefined();
    });

    test("demo holdings sit on each coin's home network", () => {
        expect(heldOn(connected, "ETH", "ethereum")).toBe(1.25);
        expect(heldOn(connected, "ETH", "base")).toBe(0);
        expect(heldOn(connected, "SOL", "solana")).toBe(42);
        expect(heldOn(connected, "USDC", "arc")).toBe(2_400);
        expect(heldTotal(connected, "DOGE")).toBe(5_000);
        expect(heldOn(disconnected, "ETH", "ethereum")).toBeNull();
        expect(heldTotal(disconnected, "ETH")).toBeNull();
        const over = run("swap", [slot("amountUSD", "5000")]).view;
        expect(over.blocking).toMatchObject({ message: "That's more than your $4,013.00 of ETH on Ethereum." });
    });

    test("a real wallet's rows replace the demo holdings and sum across networks", () => {
        const wallet = withWallet({ ETH: { ethereum: 1, base: 2 } });
        expect(heldTotal(wallet, "ETH")).toBe(3);
        expect(heldTotal(wallet, "SOL")).toBe(0);
        expect(heldOn(wallet, "ETH", "polygon")).toBe(0);
    });

    test("Buy pays from the coin's network when its USDC covers it, else where USDC is largest", () => {
        const wallet = withWallet({ USDC: { base: 500, polygon: 50, arc: 900 } });
        expect(buyPayNetwork(wallet, "base", 100)).toBe("base");
        expect(buyPayNetwork(wallet, "base", 600)).toBe("arc");
        expect(buyPayNetwork(wallet, "polygon", 100)).toBe("arc");
        expect(buyPayNetwork(wallet, "ethereum", 1)).toBe("arc");
        expect(buyPayNetwork(withWallet(null), "base", 10)).toBeNull();
        expect(buyPayNetwork(disconnected, "base", 10)).toBeNull();
        const paid = (ctx: TradeCtx, actions: SentenceAction[]) =>
            run("buy", actions, ctx).view.preview.rows.find((r) => r.id === "from")?.value;
        expect(paid(wallet, [slot("token", "LINK"), slot("amountUSD", "20")])).toBe("USDC on Arc");
        expect(paid(withWallet({ USDC: { ethereum: 500 } }), [slot("token", "LINK")])).toBe("USDC on Ethereum");
        expect(paid(withWallet(null), [])).toBe("USDC");
    });

    test("Buy's cap is the largest USDC balance on one network", () => {
        const wallet = withWallet({ USDC: { base: 500, polygon: 300 } });
        expect(usdcCap(wallet)).toMatchObject({ value: 500, cta: "Not enough USDC" });
        expect(usdcCap(wallet)?.message).toContain("Base");
        const view = run("buy", [slot("amountUSD", "600")], wallet).view;
        expect(view.blocking).toMatchObject({ code: "max", cta: "Not enough USDC" });
        expect(run("buy", [slot("amountUSD", "400")], wallet).view.blocking).toBeUndefined();
        expect(usdcCap(withWallet({ USDC: { base: 0 } }))?.message).toBe("You don't hold any USDC.");
    });

    test("Sell receives USDC on the coin's own network", () => {
        const wallet = withWallet({ ETH: { base: 1 } });
        const rows = run("sell", [slot("token", "ETH")], wallet).view.preview.rows;
        expect(rows.find((r) => r.id === "to")).toMatchObject({ label: "Received on", value: "USDC on Base" });
    });

    test("Swap previews its route", () => {
        expect(run("swap").view.preview.rows.find((r) => r.id === "route")).toMatchObject({
            label: "Route",
            value: "Ethereum → Solana",
        });
    });

    test("coin and network carry from Swap to Buy together", () => {
        const wallet = withWallet({ ETH: { ethereum: 1 }, USDC: { base: 100 } });
        const bought = run("swap", [slot("toToken", "BTC"), slot("toNetwork", "base"), verb("buy")], wallet).view;
        expect(bought.text).toBe("I want to Buy 10 USD of BTC.");
        expect(bought.intent).toMatchObject({ type: "spot", token: "BTC", network: "base" });
        // And back again, a Swap that keeps the pair it carries
        const back = run("buy", [slot("token", "LINK"), slot("network", "arbitrum"), verb("swap")], wallet).view;
        expect(back.intent).toMatchObject({ toToken: "LINK", toNetwork: "arbitrum" });
    });

    test("a carried network the wallet holds nothing on falls back to the default", () => {
        const wallet = withWallet({ ETH: { ethereum: 1 } });
        const sold = run("swap", [slot("toToken", "ETH"), slot("toNetwork", "arbitrum"), verb("sell")], wallet).view;
        expect(sold.slots.token.kind === "choice" && sold.slots.token.value).toBe("ETH");
        expect(toNetworks(sold, "token").value).toBe("ethereum");
        expect(sold.intent).toMatchObject({ side: "sell", token: "ETH", network: "ethereum" });
    });

    test("a coin pick resets the network to that coin's default", () => {
        const wallet = withWallet({ ETH: { base: 1 }, LINK: { polygon: 3 }, USDC: { base: 100 } });
        const picked = run("sell", [slot("token", "ETH"), slot("token", "LINK")], wallet).view;
        expect(picked.intent).toMatchObject({ token: "LINK", network: "polygon" });
        // A picked network sticks until the coin changes
        const net = run("buy", [slot("token", "LINK"), slot("network", "base")], wallet).view;
        expect(net.intent).toMatchObject({ token: "LINK", network: "base" });
    });

    test("a wrapped network that arrives without its coin is dropped for the default", () => {
        // The carried Ethereum belongs to USDC, and SOL there is only Wormhole SOL
        const usdc = run("swap", [slot("toToken", "USDC"), verb("buy")]).view;
        expect(usdc.intent).toMatchObject({ token: "SOL", network: "solana" });
        // Long has no network, so the Solana left behind would make ETH Wormhole ETH
        const long = run("swap", [verb("long"), slot("asset", "ETH"), verb("buy")]).view;
        expect(long.intent).toMatchObject({ token: "ETH", network: "ethereum" });
    });

    test("a bridge survives a round trip through another verb", () => {
        const { view } = run("swap", [slot("toToken", "ETH"), verb("buy"), verb("swap")]);
        expect(view.intent).toMatchObject({
            fromToken: "ETH",
            fromNetwork: "ethereum",
            toToken: "ETH",
            toNetwork: "arbitrum",
        });
    });

    test("any run of picks and verb changes leaves each side on a row its coin offers", () => {
        const wallets: TradeCtx[] = [
            connected,
            disconnected,
            withWallet(null),
            withWallet({}),
            withWallet({
                ETH: { ethereum: 1, base: 2 },
                SOL: { solana: 3 },
                USDC: { base: 500 },
                LINK: { polygon: 4 },
            }),
        ];
        const coins = CATALOG.tokens.map((t) => t.symbol);
        const networks = NETWORKS.map((n) => n.id);
        const verbs = ["swap", "buy", "sell", "long", "short", "predict"];
        const sides = [
            ["swap", "swap", "fromToken", "fromNetwork", "pay"],
            ["swap", "swap", "toToken", "toNetwork", "receive"],
            ["spot", "buy", "token", "network", "receive"],
            ["spot", "sell", "token", "network", "pay"],
        ] as const;
        let seed = 7;
        const next = (n: number) => {
            seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
            return Math.floor((seed / 4_294_967_296) * n);
        };
        const problems: string[] = [];
        for (let round = 0; round < 300; round++) {
            const ctx = wallets[next(wallets.length)];
            let state = initialState(TRADE, ["swap", "buy", "sell"][next(3)], ctx);
            for (let step = 0; step < 12; step++) {
                const kind = next(4);
                state = reduce(
                    TRADE,
                    state,
                    kind === 0
                        ? verb(verbs[next(verbs.length)])
                        : kind === 1
                          ? slot(["fromToken", "toToken", "token"][next(3)], coins[next(coins.length)])
                          : kind === 2
                            ? slot(["fromNetwork", "toNetwork", "network"][next(3)], networks[next(networks.length)])
                            : slot("amountUSD", String(next(5000))),
                    ctx,
                );
                for (const [op, verbId, coin, network, side] of sides) {
                    const draft = state.drafts[op];
                    if (!draft || state.verbId !== verbId) continue;
                    const rows = networkChoices(ctx, draft[coin], side);
                    const row = rows.find((c) => c.value === draft[network]);
                    if (rows.length && !row)
                        problems.push(`${round}.${step} ${coin}=${draft[coin]} on ${draft[network]}`);
                    if (row?.disabled && rows.some((c) => !c.disabled))
                        problems.push(`${round}.${step} ${row.disabled}`);
                    const identical = draft.fromToken === draft.toToken && draft.fromNetwork === draft.toNetwork;
                    if (op === "swap" && identical) problems.push(`${round}.${step} identical pairs`);
                }
            }
        }
        expect(problems).toEqual([]);
    });

    test("a network that is not one of the coin's, or a missing one, is ignored", () => {
        const start = run("buy", [slot("token", "BTC")]).state;
        expect(reduce(TRADE, start, slot("network", "solana"), connected)).toBe(start);
        expect(reduce(TRADE, start, slot("network", "mars"), connected)).toBe(start);
    });

    test("a companion left empty blocks with its own copy", () => {
        const { state } = run("buy");
        const draft = { ...state.drafts.spot!, network: "" };
        const view = resolve(TRADE, { ...state, drafts: { ...state.drafts, spot: draft } }, connected);
        expect(view.blocking).toMatchObject({ message: "Pick a network.", cta: "Pick a network" });
        expect(view.intent).toBeNull();
    });

    test("the sentence stays three pills with bare symbols", () => {
        const { view } = run("swap", [slot("toToken", "BTC")]);
        expect(view.text).toBe("I want to Swap my ETH to BTC for 10 USD.");
        expect(view.parts.filter((p) => p.kind === "slot").map((p) => p.key)).toEqual([
            "swap:fromToken",
            "term:token",
            "term:amountUSD",
        ]);
        // The pill's badge is the companion's own icon, the coin with its network badge
        const from = view.slots.fromToken;
        expect(from.kind === "choice" && from.selected?.icon).toMatchObject({
            set: "coin",
            id: "ETH",
            badge: { set: "coin", id: "ETH", badge: { set: "network", id: "ethereum" } },
        });
        expect(toNetworks(view, "fromToken")).toMatchObject({
            id: "fromNetwork",
            prompt: "On which network?",
            hint: "Network you pay from",
        });
        expect(toNetworks(view, "toToken")).toMatchObject({ id: "toNetwork", hint: "Network you receive on" });
        expect(toNetworks(run("buy").view, "token")).toMatchObject({ id: "network", hint: "Network of the coin" });
    });
});

test.describe("live prediction markets", () => {
    const outcome = (tokenId: string, label: string, buyPrice: number, chance: number, minUSD = 1) => ({
        tokenId,
        label,
        buyPrice,
        sellPrice: buyPrice - 0.01,
        minShares: 5,
        chance,
        tone: "neutral" as const,
        minUSD,
        image: null,
    });
    const fed: MarketView = {
        id: "900",
        title: "Fed Decision in October?",
        image: null,
        endDate: "2026-10-29T18:00:00Z",
        volume24hUSD: 5,
        outcomes: [outcome("fed-nochange", "No change", 0.9, 0.89), outcome("fed-cut", "25 bps decrease", 0.08, 0.07)],
    };
    const rain: MarketView = {
        id: "901",
        title: "Will it rain?",
        image: null,
        endDate: "2026-10-30T18:00:00Z",
        volume24hUSD: 4,
        outcomes: [
            { ...outcome("rain-yes", "YES", 0.3, 0.3, 4.2), tone: "gain" },
            { ...outcome("rain-no", "NO", 0.71, 0.7), tone: "loss" },
        ],
    };
    const now = new Date(2026, 9, 12);
    const known = new Map([fed, rain].map((m) => [m.id, toPredictionMarket(m, now)]));
    const live = (listed: MarketView[]): TradeCtx => ({
        catalog: {
            ...CATALOG,
            markets: listed.map((m) => known.get(m.id)!),
            findMarket: (id) => known.get(id),
        } satisfies Catalog,
        holdings: MOCK_HOLDINGS,
    });

    test("a question without outcomes doesn't break the list", () => {
        const empty: MarketView = { ...fed, id: "902", outcomes: [] };
        known.set("902", toPredictionMarket(empty, now));
        const ctx = live([rain, empty]);
        expect(() => run("predict", [], ctx).view.text).not.toThrow();
    });

    test("a multi-outcome event reads Predict [top option] on [title]", () => {
        expect(run("predict", [], live([fed, rain])).view.text).toBe(
            "I want to Predict No change on Fed Decision in October? with 10 USD.",
        );
    });

    test("a new question keeps YES, and asks for an outcome when it has none", () => {
        const ctx = live([rain, fed]);
        expect(run("predict", [slot("marketId", "901")], ctx).view.intent).toMatchObject({ outcomeId: "rain-yes" });
        const moved = run("predict", [slot("marketId", "900")], ctx).view;
        expect(moved.intent).toBeNull();
        expect(moved.blocking).toMatchObject({ message: "Pick an outcome for this question.", cta: "Pick an outcome" });
    });

    test("the amount's minimum is the outcome's minUSD", () => {
        const view = run("predict", [slot("amountUSD", "3")], live([rain, fed])).view;
        expect(view.blocking).toMatchObject({ message: "The minimum is $4.20." });
    });

    test("quoteRows reads the quote", () => {
        const quote: QuoteView = {
            eventId: "901",
            tokenId: "rain-yes",
            side: "buy",
            amountUSD: "10",
            shares: "32.258064",
            avgPrice: 0.31,
            worstPrice: 0.33,
            feeUSD: "0.12",
            payoutUSD: "32.258064",
            minUSD: 1,
        };
        const rows = quoteRows(quote, "YES", "NO", 0.3);
        expect(rows.map((r) => r.id)).toEqual(["shares", "win", "lose", "fee", "odds"]);
        expect(rows[0]).toMatchObject({ label: "You buy", value: "32.258064 shares at 31\u00a2", primary: true });
        expect(rows[1]).toMatchObject({
            label: "If YES",
            value: "you get $32.26 (+$22.26)",
            tone: "gain",
            primary: true,
        });
        expect(rows[2]).toMatchObject({ label: "If NO", value: "you lose $10.00", tone: "loss" });
        expect(rows[3]).toMatchObject({ label: "Polymarket's fee", value: "$0.12" });
        expect(rows[4]).toMatchObject({ label: "Market odds", value: "30% chance" });
        expect(quoteRows(quote, "YES")[2]).toMatchObject({ label: "Otherwise" });
    });

    test("the amount is capped by maxOrderUSD with the limit message when live", () => {
        const capped = (maxOrderUSD: number | null): TradeCtx => ({ ...live([rain]), maxOrderUSD });
        const over = run("predict", [slot("amountUSD", "50")], capped(20)).view;
        expect(over.blocking).toMatchObject({
            message: "Predictions are limited to $20 right now.",
            cta: "Over the limit",
        });
        expect(run("predict", [slot("amountUSD", "20")], capped(20)).view.blocking).toBeUndefined();
        // Trading off, or not signed in: the balance alone caps it.
        expect(run("predict", [slot("amountUSD", "50")], capped(null)).view.blocking).toBeUndefined();
        expect(run("predict", [slot("amountUSD", "50")], live([rain])).view.blocking).toBeUndefined();
        // The smaller of the two wins.
        const poor = { ...capped(500), holdings: { ...MOCK_HOLDINGS, USDC: 30 } };
        expect(run("predict", [slot("amountUSD", "50")], poor).view.blocking).toMatchObject({ cta: "Not enough USDC" });
    });

    test("a picked question that isn't listed still resolves", () => {
        const { state } = run("predict", [slot("marketId", "900"), slot("outcomeId", "fed-cut")], live([rain, fed]));
        // The list moves on without it.
        const view = resolve(TRADE, state, live([rain]));
        expect(view.text).toBe("I want to Predict 25 bps decrease on Fed Decision in October? with 10 USD.");
        expect(view.intent).toMatchObject({ marketId: "900", outcomeId: "fed-cut" });
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
        expect(run("sell", [slot("token", "AVAX")], disconnected).view.text).toBe("I want to Sell 10 USD of my AVAX.");
    });
});

test.describe("the amount's dropdown", () => {
    const amount = (view: ReturnType<typeof run>["view"], id = "amountUSD") => {
        const slot = view.slots[id];
        if (slot.kind !== "number") throw new Error(`${id} isn't a number slot`);
        return slot;
    };

    test("the slider spans the bounds, or the spec's range where a wallet doesn't cap it", () => {
        expect(amount(run("swap", [], disconnected).view).range).toEqual({ min: 1, max: 10_000, capped: false });
        expect(amount(run("buy", [], disconnected).view).range).toEqual({ min: 1, max: 10_000, capped: false });
        // Connected, the top is what the wallet holds of the coin being paid with.
        const swap = amount(run("swap").view).range!;
        expect(swap.capped).toBe(true);
        expect(swap.max).toBeCloseTo(MOCK_HOLDINGS.ETH * CATALOG.tokens.find((t) => t.symbol === "ETH")!.priceUSD, 6);
        // Positions start at $10, and the bottom says so.
        expect(amount(run("long", [], disconnected).view, "collateralUSD").range).toMatchObject({ min: 10 });
    });

    test("each operation says what the amount comes to", () => {
        expect(amount(run("swap").view).summary).toBe("You get ≈ 0.06773 SOL");
        expect(amount(run("buy").view).summary).toBe("You get ≈ 0.06793 SOL");
        expect(amount(run("sell").view).summary).toBe("You sell ≈ 0.06793 SOL");
        expect(amount(run("long").view, "collateralUSD").summary).toBe("A $500 position");
        expect(amount(run("predict").view).summary).toBe("Pays $26.32 if YES");
        // Nothing to say about an empty amount.
        expect(amount(run("swap", [slot("amountUSD", "")]).view).summary).toBeUndefined();
    });
});

test.describe("balance history", () => {
    const now = new Date(2026, 9, 9, 15, 0);
    const at = (daysAgo: number, hour = 12) => new Date(2026, 9, 9 - daysAgo, hour);

    test("a bar a day, ending today, with deposits apart from PnL", () => {
        const activity = [
            depositActivity({ key: "a", amountUSD: 500, at: at(10) }),
            depositActivity({ key: "b", amountUSD: 100, at: at(2) }),
            ...mockTrades(now).filter((a) => a.kind === "close"),
        ];
        const days = balanceHistory(activity, 7, now);
        expect(days).toHaveLength(7);
        expect(days.at(-1)!.day).toEqual(new Date(2026, 9, 9));
        // Everything before the first day is carried in.
        const before = activity.filter((a) => a.at < days[0].day).reduce((sum, a) => sum + a.change, 0);
        expect(days[0].balance).toBeCloseTo(before + days[0].pnl + days[0].deposited, 6);
        const twoDaysAgo = days.at(-3)!;
        expect(twoDaysAgo.deposited).toBe(100);
        // The balance ends at the sum of every change.
        expect(days.at(-1)!.balance).toBeCloseTo(
            activity.reduce((sum, a) => sum + a.change, 0),
            6,
        );
    });

    test("fees alone don't count as a day's realized PnL", () => {
        const trades = mockTrades(now);
        const days = balanceHistory(trades, 30, now);
        const feeOnly = days.filter((d) => d.pnl !== 0 && d.realized === 0);
        expect(feeOnly.length).toBeGreaterThan(0);
        for (const d of feeOnly) expect(d.pnl).toBeLessThan(0);
        expect(daysSince(trades, now)).toBe(30);
    });

    const position = (over: Partial<PositionView>): PositionView => ({
        id: "p1",
        eventId: "e1",
        marketId: "m1",
        tokenId: "t1",
        question: "Will it rain?",
        outcome: "Yes",
        shares: "20",
        costUSD: "10",
        state: "open",
        proceedsUSD: null,
        payoutUSD: null,
        openedAt: at(3).toISOString(),
        settledAt: null,
        updatedAt: at(3).toISOString(),
        ...over,
    });

    test("a won position adds its realized gain to the day it settled, and the bar is a gain", () => {
        const rows = predictionActivity(position({ state: "won", payoutUSD: "20", settledAt: at(1).toISOString() }));
        expect(rows.map((r) => r.id)).toEqual(["prediction:p1:open", "prediction:p1:settle"]);
        expect(rows[0]).toMatchObject({ kind: "predict", title: "Yes on Will it rain?", amountUSD: 10, change: 0 });
        expect(rows[1]).toMatchObject({
            kind: "close",
            title: "Won Yes on Will it rain?",
            change: 10,
            symbols: ["USDC"],
        });
        const days = balanceHistory([depositActivity({ key: "d", amountUSD: 100, at: at(5) }), ...rows], 7, now);
        const day = days.at(-2)!;
        expect(day.realized).toBe(10);
        expect(day.pnl).toBe(10);
        expect(days.at(-3)!.realized).toBe(0);
        expect(days.at(-1)!.balance).toBe(110);
    });

    test("a position settled 10 days ago still counts in the 30-day chart", () => {
        const rows = predictionActivity(
            position({
                state: "won",
                payoutUSD: "20",
                openedAt: at(12).toISOString(),
                settledAt: at(10).toISOString(),
            }),
        );
        const days = balanceHistory([depositActivity({ key: "d", amountUSD: 100, at: at(20) }), ...rows], 30, now);
        expect(days.at(-11)!.realized).toBe(10);
        expect(days.at(-1)!.balance).toBe(110);
    });

    test("a lost position is a realized loss", () => {
        const rows = predictionActivity(position({ state: "lost", settledAt: at(1).toISOString() }));
        expect(rows[1]).toMatchObject({ kind: "close", title: "Lost Yes on Will it rain?", change: -10 });
        expect(balanceHistory(rows, 7, now).at(-2)!.realized).toBe(-10);
    });

    test("a sold position realizes proceeds less cost", () => {
        const rows = predictionActivity(
            position({ state: "closed", proceedsUSD: "12.5", settledAt: at(1).toISOString() }),
        );
        expect(rows[1]).toMatchObject({ kind: "close", title: "Sold Yes on Will it rain?", change: 2.5 });
    });

    test("a buy changes nothing until it settles", () => {
        for (const state of ["open", "closing"] as const) {
            const rows = predictionActivity(position({ state }));
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ id: "prediction:p1:open", change: 0 });
        }
        const days = balanceHistory(predictionActivity(position({})), 7, now);
        expect(days.every((d) => d.realized === 0 && d.balance === 0)).toBe(true);
        expect(predictionActivity(position({}), true)[0]!.pending).toBe(true);
    });

    test("a trade confirmed in Review is listed but moves nothing", () => {
        const confirmed = confirmedActivity(
            { type: "perp", side: "long", asset: "BTC", leverage: 5, collateralUSD: "100" },
            now,
            "c",
        );
        expect(confirmed).toMatchObject({
            title: "Long BTC 5x",
            detail: "A $500 position",
            change: 0,
            simulated: true,
        });
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
