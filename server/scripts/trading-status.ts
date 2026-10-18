/**
 * Prints the inventory wallets that hold traded coins and the native gas each holds. It only reads.
 *
 *   node --env-file=.env scripts/trading-status.ts
 */
import { formatUnits } from "viem";
import { createKeyring } from "../src/accounts/keyring.ts";
import { loadConfig } from "../src/config.ts";
import { createSolanaRpc } from "../src/crosschain/solana.ts";
import { createSwapClients, type EvmNetworkId } from "../src/swaps/clients.ts";
import { NETWORKS } from "../src/swaps/coins.ts";
import { describeError } from "./describe-error.ts";

const config = loadConfig();
const keyring = createKeyring(config.DEPOSIT_MNEMONIC);
const evm = keyring.inventoryEvm().address;
const solana = keyring.inventorySolana().address;

const clients = createSwapClients({
    ethereum: config.ETHEREUM_RPC_URLS,
    arbitrum: config.ARBITRUM_RPC_URLS,
    base: config.BASE_RPC_URLS,
    optimism: config.OPTIMISM_RPC_URLS,
    polygon: config.POLYGON_RPC_URLS,
    bnb: config.BNB_RPC_URLS,
    avalanche: config.AVALANCHE_RPC_URLS,
    arc: config.ARC_RPC_URLS,
});
const solanaRpc = createSolanaRpc(config.SOLANA_RPC_URLS);

console.log(`Inventory EVM address (every EVM network): ${evm}`);
console.log(`Inventory Solana address: ${solana}`);
console.log(`Arc treasury: ${keyring.operator().address}`);
console.log(`TRADE_HEDGING=${config.TRADE_HEDGING} COIN_WITHDRAWALS=${config.COIN_WITHDRAWALS}\n`);

const rows = await Promise.all(
    NETWORKS.map(async (network) => {
        try {
            if (network.kind === "solana") {
                return `${network.name.padEnd(12)} ${formatUnits(await solanaRpc.getBalance(solana), 9)} SOL`;
            }
            const client = clients[network.id as EvmNetworkId];
            const balance = await client.getBalance({ address: evm });
            const symbol = client.chain?.nativeCurrency.symbol ?? "";
            return `${network.name.padEnd(12)} ${formatUnits(balance, client.chain?.nativeCurrency.decimals ?? 18)} ${symbol}`;
        } catch (error) {
            return `${network.name.padEnd(12)} unreadable: ${describeError(error)}`;
        }
    }),
);
console.log("Native gas balances");
for (const row of rows) console.log(`  ${row}`);
