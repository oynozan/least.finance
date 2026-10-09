import { isAddress, isHex, zeroAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { ARC_CHAIN_ID } from "../../chain/arc.ts";
import { COINS, toArcWei, type Coin } from "../catalog.ts";
import type { BridgeProvider, BridgeStage, BridgeStatus, Quote, QuoteRequest, SourceTx } from "./types.ts";

const ARC_USDC_ERC20 = "0x3600000000000000000000000000000000000000";
const STATUS_TIMEOUT_MS = 10_000;

const address = z.custom<Address>((value) => typeof value === "string" && isAddress(value, { strict: false }));
const hex = z.custom<Hex>((value) => typeof value === "string" && isHex(value));
const units = z.string().regex(/^\d+$/).transform(BigInt);

// A step of any other kind (a signature, say) is one the app can't take, so it fails the parse
const transactionStep = z.object({
    kind: z.literal("transaction"),
    requestId: z.string(),
    items: z.array(
        z.object({
            data: z.object({ chainId: z.number().int(), to: address, data: hex, value: units.optional() }),
        }),
    ),
});

const quoteResponse = z.object({
    steps: z.tuple([transactionStep], transactionStep),
    details: z.object({
        recipient: address,
        timeEstimate: z.number(),
        currencyIn: z.object({ currency: z.object({ chainId: z.number().int(), address }), amount: units }),
        currencyOut: z.object({ currency: z.object({ address, decimals: z.number().int() }), amount: units }),
    }),
});

const statusResponse = z.object({ status: z.string(), txHashes: z.array(hex).optional() });

// Relay's own words for how far a request has got
const STAGES = new Map<string, BridgeStage>([
    ["waiting", "waiting"],
    ["depositing", "pending"],
    ["pending", "pending"],
    ["submitted", "pending"],
    ["delayed", "pending"],
    ["success", "filled"],
    ["refund", "refunded"],
    ["failure", "failed"],
]);

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function createRelay(options: { apiKey?: string; fetch?: typeof fetch; baseUrl?: string } = {}): BridgeProvider {
    const { apiKey, fetch: call = fetch, baseUrl = "https://api.relay.link" } = options;
    const keyHeader: Record<string, string> = apiKey ? { "x-api-key": apiKey } : {};

    return {
        name: "relay",

        supports: (coin: Coin) => coin.chain !== "arc",

        async quote(request: QuoteRequest, signal: AbortSignal): Promise<Quote> {
            const { coin, amount, sender, recipient, refundTo } = request;
            const response = await call(`${baseUrl}/quote/v2`, {
                method: "POST",
                headers: { "content-type": "application/json", ...keyHeader },
                body: JSON.stringify({
                    user: sender,
                    recipient,
                    refundTo,
                    originChainId: coin.chainId,
                    destinationChainId: ARC_CHAIN_ID,
                    originCurrency: coin.token ?? zeroAddress,
                    destinationCurrency: ARC_USDC_ERC20,
                    amount: String(amount),
                    tradeType: "EXACT_INPUT",
                }),
                signal,
            });
            if (!response.ok) throw new Error(`Relay answered ${response.status} to a quote`);
            const { steps, details } = quoteResponse.parse(await response.json());

            const { currencyIn, currencyOut } = details;
            const quoted = COINS.find(
                (candidate) =>
                    candidate.chainId === currencyIn.currency.chainId &&
                    sameAddress(candidate.token ?? zeroAddress, currencyIn.currency.address),
            );
            if (!quoted) throw new Error(`Relay quoted a coin the app doesn't carry: ${currencyIn.currency.address}`);

            const txs: SourceTx[] = steps.flatMap((step) =>
                step.items.map(({ data }) => ({
                    chainId: data.chainId,
                    to: data.to,
                    data: data.data,
                    value: data.value ?? 0n,
                })),
            );
            return {
                provider: "relay",
                ref: steps[0].requestId,
                coin: quoted.key,
                amountIn: currencyIn.amount,
                usdcOut: toArcWei(currencyOut.amount, currencyOut.currency.decimals),
                etaSeconds: details.timeEstimate,
                destinationToken: currencyOut.currency.address,
                recipient: details.recipient,
                refundTo,
                txs,
            };
        },

        async status({ ref }): Promise<BridgeStatus> {
            const response = await call(`${baseUrl}/intents/status/v3?${new URLSearchParams({ requestId: ref })}`, {
                headers: keyHeader,
                signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
            });
            if (!response.ok) throw new Error(`Relay answered ${response.status} to a status`);
            const { status, txHashes } = statusResponse.parse(await response.json());

            const stage = STAGES.get(status);
            if (!stage) throw new Error(`Relay gave a status the app doesn't know: ${status}`);
            const fillTxHash = txHashes?.[0];
            return stage === "filled" && fillTxHash ? { stage, fillTxHash } : { stage };
        },
    };
}
