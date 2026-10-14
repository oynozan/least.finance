/**
 * One-time setup of the pool's Polymarket deposit wallet: deploys it, approves Polymarket's contracts to
 * trade with it, and syncs the CLOB's view of its pUSD. It's safe to run again, and prints no secrets.
 *
 * Run it from server/ with `node --env-file=.env scripts/polymarket-setup.ts`, then fund the printed wallet with pUSD.
 */
import { AssetType } from "@polymarket/client";
import { updateBalanceAllowance } from "@polymarket/client/actions";
import { loadConfig } from "../src/config.ts";
import { createPolymarketClient } from "../src/predictions/polymarket-trader.ts";

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
