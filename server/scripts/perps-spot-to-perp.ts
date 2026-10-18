/**
 * Moves the Hyperliquid master's USDC from its Spot balance to its Perps balance, where the float is read. A Send from
 * another Hyperliquid account lands in Spot, so run this after funding the master that way.
 *
 *   node --env-file=.env scripts/perps-spot-to-perp.ts [usd]
 */
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { createKeyring } from "../src/accounts/keyring.ts";
import { loadConfig } from "../src/config.ts";

const config = loadConfig();
const master = createKeyring(config.DEPOSIT_MNEMONIC).perpSignerAt(0);
const isTestnet = config.HYPERLIQUID_API_URL.includes("testnet");
const transport = new HttpTransport({ isTestnet });
const info = new InfoClient({ transport });

const spot = await info.spotClearinghouseState({ user: master.address });
const spotUsdc = Number(spot.balances.find((b) => b.coin === "USDC")?.total ?? "0");
const amount = process.argv[2] ? Number(process.argv[2]) : spotUsdc;
console.log(`Master ${master.address}: ${spotUsdc} USDC in Spot`);
if (!(amount > 0) || amount > spotUsdc) {
    console.log("Nothing to move.");
    process.exit(0);
}

await new ExchangeClient({ transport, wallet: master }).usdClassTransfer({ amount: String(amount), toPerp: true });
const perps = await info.clearinghouseState({ user: master.address });
console.log(`Moved ${amount} USDC to Perps; Perps withdrawable is now ${perps.withdrawable}`);
