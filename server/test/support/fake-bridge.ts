import { randomBytes } from "node:crypto";
import { createTestClient, encodeFunctionData, erc20Abi, http, parseUnits, publicActions, walletActions } from "viem";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { arcChain } from "../../src/chain/arc.ts";
import { ARC_USDC_TOKENS, type Coin } from "../../src/crosschain/catalog.ts";
import type {
    BridgeProvider,
    BridgeStage,
    BridgeStatus,
    Quote,
    QuoteRequest,
    SourceTx,
} from "../../src/crosschain/providers/types.ts";

/** Where the fake bridge's source transactions go: an address with no code, so they succeed. */
export const FAKE_BRIDGE_ADDRESS = "0x000000000000000000000000000000000000bEEF";

const ETA_SECONDS = 2;
/** Rates are cut to millionths of a dollar, so a bigint can carry them. */
const RATE_SCALE = 1_000_000;
/** Held by a solver on top of what it pays out, for gas. */
const SOLVER_GAS_MARGIN = parseUnits("10", 18);

type Issued = { quote: Quote; stage: BridgeStage; fillTxHash?: Hex; failNext: boolean };

/**
 * A bridge a test steps by hand. It quotes at fixed rates, takes the user's transactions to a dead end, and
 * pays out on Arc only when `advance` says "filled", from a solver it funds on the Arc chain itself. Each fill
 * has a solver of its own, so fills sent at the same time can't tangle over a nonce.
 */
export class FakeBridge implements BridgeProvider {
    readonly name = "fake";
    readonly #rates: Record<string, number>;
    readonly #arc;
    readonly #issued = new Map<string, Issued>();

    constructor({ arcRpcUrl, rates }: { arcRpcUrl: string; rates: Record<string, number> }) {
        this.#rates = rates;
        this.#arc = createTestClient({
            mode: "anvil",
            chain: arcChain([arcRpcUrl]),
            transport: http(arcRpcUrl),
            pollingInterval: 50,
        })
            .extend(publicActions)
            .extend(walletActions);
    }

    /** Every quote it issued, newest last. */
    get refs(): string[] {
        return [...this.#issued.keys()];
    }

    supports(coin: Coin): boolean {
        return (coin.chain === "ethereum" || coin.chain === "bnb") && this.#rates[coin.symbol] !== undefined;
    }

    async quote(request: QuoteRequest, _signal?: AbortSignal): Promise<Quote> {
        const { coin, amount } = request;
        const rate = this.#rates[coin.symbol];
        if (coin.chainId === null || coin.chain === "arc" || rate === undefined)
            throw new Error(`The fake bridge has no route for ${coin.key}`);

        const ref: Hex = `0x${randomBytes(16).toString("hex")}`;
        const deposit: SourceTx = {
            chainId: coin.chainId,
            to: FAKE_BRIDGE_ADDRESS,
            data: ref,
            value: coin.token ? 0n : amount,
        };
        const approval: SourceTx[] = coin.token
            ? [
                  {
                      chainId: coin.chainId,
                      to: coin.token,
                      data: encodeFunctionData({
                          abi: erc20Abi,
                          functionName: "approve",
                          args: [FAKE_BRIDGE_ADDRESS, amount],
                      }),
                      value: 0n,
                  },
              ]
            : [];
        const quote: Quote = {
            provider: this.name,
            ref,
            coin: coin.key,
            amountIn: amount,
            usdcOut:
                (amount * BigInt(Math.round(rate * RATE_SCALE)) * 10n ** 18n) /
                (10n ** BigInt(coin.decimals) * BigInt(RATE_SCALE)),
            etaSeconds: ETA_SECONDS,
            destinationToken: ARC_USDC_TOKENS[0]!,
            recipient: request.recipient,
            refundTo: request.refundTo,
            txs: [...approval, deposit],
        };
        this.#issued.set(ref, { quote, stage: "waiting", failNext: false });
        return quote;
    }

    /** Where the quote stands, with or without the source hash. */
    async status({ ref }: { ref: string }, _sourceTxHash?: Hex | null, _coin?: Coin): Promise<BridgeStatus> {
        const issued = this.#known(ref);
        if (issued.failNext) {
            issued.failNext = false;
            throw new Error(`The fake bridge was told to fail the status of ${ref}`);
        }
        return issued.fillTxHash ? { stage: issued.stage, fillTxHash: issued.fillTxHash } : { stage: issued.stage };
    }

    /** Moves a quote to `stage`. "filled" sends the quoted USDC on Arc to its recipient first. */
    async advance(ref: string, stage: "pending" | "filled" | "refunded" | "failed"): Promise<void> {
        const issued = this.#known(ref);
        if (stage === "filled") issued.fillTxHash = await this.#fill(issued.quote);
        issued.stage = stage;
    }

    /** Makes the next `status` call for `ref` throw. */
    failNextStatus(ref: string): void {
        this.#known(ref).failNext = true;
    }

    #known(ref: string): Issued {
        const issued = this.#issued.get(ref);
        if (!issued) throw new Error(`The fake bridge issued no quote ${ref}`);
        return issued;
    }

    async #fill({ recipient, usdcOut }: Quote): Promise<Hex> {
        const solver: Address = privateKeyToAddress(generatePrivateKey());
        await this.#arc.setBalance({ address: solver, value: usdcOut + SOLVER_GAS_MARGIN });
        await this.#arc.impersonateAccount({ address: solver });
        const hash = await this.#arc.sendTransaction({
            account: solver,
            to: recipient,
            value: usdcOut,
            chain: this.#arc.chain,
        });
        await this.#arc.waitForTransactionReceipt({ hash });
        return hash;
    }
}
