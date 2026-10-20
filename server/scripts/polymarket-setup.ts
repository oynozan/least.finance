/**
 * One-time setup of the pool's Polymarket deposit wallet: deploys it, approves Polymarket's contracts to
 * trade with it (the neg-risk adapter too, which the SDK leaves out), and syncs the CLOB's view of its pUSD.
 * It's safe to run again: it sends only the approvals still missing, and prints no secrets.
 *
 * Run it from server/ with `node --env-file=.env scripts/polymarket-setup.ts`, then fund the printed wallet with pUSD.
 */
import { AssetType } from "@polymarket/client";
import { updateBalanceAllowance } from "@polymarket/client/actions";
import { createPublicClient, erc1155Abi, erc20Abi, http, maxUint256, type Address } from "viem";
import { polygon } from "viem/chains";
import { loadConfig } from "../src/config.ts";
import { createPolymarketClient } from "../src/predictions/polymarket-trader.ts";
import { POLYGON } from "../src/predictions/pool-moves.ts";

const config = loadConfig();
const missing = (
    [
        "POLYMARKET_POOL_KEY",
        "POLYMARKET_BUILDER_API_KEY",
        "POLYMARKET_BUILDER_API_SECRET",
        "POLYMARKET_BUILDER_API_PASSPHRASE",
    ] as const
).filter((name) => !config[name]);
if (missing.length > 0) {
    console.error(`Set ${missing.join(", ")} in the environment first.`);
    process.exit(1);
}

const client = await createPolymarketClient(config);
// The pool key's own deposit wallet, which the SDK derives when no wallet is pinned
const derived = (await createPolymarketClient(config, undefined, { ignorePinnedWallet: true })).account.wallet;
await client.setupTradingApprovals();

// The SDK's approvals leave out the neg-risk adapter, but the CLOB checks the pool's pUSD allowance to it before a
// neg-risk buy and its position approval before a neg-risk sell, so every multi-outcome market refuses orders without them
const { pusd: collateralToken, conditionalTokens, negRiskAdapter } = POLYGON;
const wallet = client.account.wallet as Address;
const chain = createPublicClient({ chain: polygon, transport: http(config.POLYGON_RPC_URL) });
const [allowance, operator] = await Promise.all([
    chain.readContract({
        address: collateralToken,
        abi: erc20Abi,
        functionName: "allowance",
        args: [wallet, negRiskAdapter],
    }),
    chain.readContract({
        address: conditionalTokens,
        abi: erc1155Abi,
        functionName: "isApprovedForAll",
        args: [wallet, negRiskAdapter],
    }),
]);
if (allowance < maxUint256) {
    await (
        await client.approveErc20({ amount: "max", spenderAddress: negRiskAdapter, tokenAddress: collateralToken })
    ).wait();
    console.log("Approved the neg-risk adapter to spend the pool's pUSD.");
}
if (!operator) {
    await (
        await client.approveErc1155ForAll({ operatorAddress: negRiskAdapter, tokenAddress: conditionalTokens })
    ).wait();
    console.log("Approved the neg-risk adapter to move the pool's positions.");
}

// Refreshes the CLOB's cached balance and allowances, so it sees the approvals above
const { balance } = await updateBalanceAllowance(client, { assetType: AssetType.COLLATERAL });

const pusd = BigInt(balance);
const dollars = `${pusd / 1_000_000n}.${(pusd % 1_000_000n).toString().padStart(6, "0")}`;
console.log(`Deposit wallet: ${client.account.wallet}`);
console.log(`Derived wallet: ${derived}`);
if (derived.toLowerCase() !== client.account.wallet.toLowerCase()) {
    console.log("Warning: the deposit wallet in the config is not the wallet the pool key controls.");
}
console.log(`pUSD balance:   ${dollars}`);
if (pusd === 0n) console.log("Fund this wallet with pUSD before turning PREDICTIONS_TRADING on.");
