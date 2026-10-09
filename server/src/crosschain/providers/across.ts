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

// Approvals carry a null value and a token swap leaves it out, so both mean nothing to send along
const transaction = z.object({ chainId: z.number().int(), to: address, data: hex, value: units.nullish() });

const quoteResponse = z.object({
    id: z.string(),
    inputToken: z.object({ chainId: z.number().int(), address }),
    outputToken: z.object({ address, decimals: z.number().int() }),
    inputAmount: units,
    expectedOutputAmount: units,
    expectedFillTime: z.number(),
    approvalTxns: z.array(transaction).nullable(),
    swapTx: transaction,
});

const statusResponse = z.object({ status: z.string(), fillTx: hex.nullish() });

// Across's own words for how far a deposit has got
const STAGES = new Map<string, BridgeStage>([
    ["pending", "pending"],
    ["filled", "filled"],
    ["refunded", "refunded"],
    ["expired", "failed"],
]);

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function createAcross(
    options: { integratorId?: string; fetch?: typeof fetch; baseUrl?: string } = {},
): BridgeProvider {
    const { integratorId, fetch: call = fetch, baseUrl = "https://app.across.to" } = options;

    return {
        name: "across",

        supports: (coin: Coin) => coin.chain !== "arc",

        async quote(request: QuoteRequest, signal: AbortSignal): Promise<Quote> {
            const { coin, amount, sender, recipient, refundTo } = request;
            const query = new URLSearchParams({
                tradeType: "exactInput",
                amount: String(amount),
                inputToken: coin.token ?? zeroAddress,
                outputToken: ARC_USDC_ERC20,
                originChainId: String(coin.chainId),
                destinationChainId: String(ARC_CHAIN_ID),
                depositor: sender,
                recipient,
                refundAddress: refundTo,
            });
            if (integratorId) query.set("integratorId", integratorId);
            const response = await call(`${baseUrl}/api/swap/approval?${query}`, { signal });
            if (!response.ok) throw new Error(`Across answered ${response.status} to a quote`);
            const quote = quoteResponse.parse(await response.json());
            const { inputToken, outputToken, swapTx } = quote;

            const quoted = COINS.find(
                (candidate) =>
                    candidate.chainId === inputToken.chainId &&
                    sameAddress(candidate.token ?? zeroAddress, inputToken.address),
            );
            if (!quoted) throw new Error(`Across quoted a coin the app doesn't carry: ${inputToken.address}`);
            // The response never says who is paid, so the transaction itself has to name the recipient
            if (!swapTx.data.toLowerCase().includes(recipient.slice(2).toLowerCase())) {
                throw new Error("Across's transaction doesn't carry the requested recipient");
            }

            const toSourceTx = ({ chainId, to, data, value }: z.output<typeof transaction>): SourceTx => ({
                chainId,
                to,
                data,
                value: value ?? 0n,
            });
            return {
                provider: "across",
                ref: quote.id,
                coin: quoted.key,
                amountIn: quote.inputAmount,
                usdcOut: toArcWei(quote.expectedOutputAmount, outputToken.decimals),
                etaSeconds: quote.expectedFillTime,
                destinationToken: outputToken.address,
                recipient,
                refundTo,
                txs: [...(quote.approvalTxns ?? []), swapTx].map(toSourceTx),
            };
        },

        async status(_quote, sourceTxHash, coin): Promise<BridgeStatus> {
            if (!sourceTxHash) return { stage: "waiting" };
            const query = new URLSearchParams({ originChainId: String(coin.chainId), depositTxHash: sourceTxHash });
            const response = await call(`${baseUrl}/api/deposit/status?${query}`, {
                signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
            });
            // Its indexer takes a few seconds to see a new deposit
            if (response.status === 404 && (await notYetIndexed(response))) return { stage: "waiting" };
            if (!response.ok) throw new Error(`Across answered ${response.status} to a status`);
            const { status, fillTx } = statusResponse.parse(await response.json());

            const stage = STAGES.get(status);
            if (!stage) throw new Error(`Across gave a status the app doesn't know: ${status}`);
            return stage === "filled" && fillTx ? { stage, fillTxHash: fillTx } : { stage };
        },
    };
}

async function notYetIndexed(response: Response): Promise<boolean> {
    const body: unknown = await response.json().catch(() => null);
    return z.object({ error: z.literal("DepositNotFoundException") }).safeParse(body).success;
}
