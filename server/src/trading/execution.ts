import type { Logger } from "pino";
import type { PublicClient } from "viem";
import type { Keyring } from "../accounts/keyring.ts";
import type { Config } from "../config.ts";
import type { SolanaRpc } from "../crosschain/solana.ts";
import type { Database } from "../db/mongo.ts";
import type { EvmNetworkId } from "../swaps/clients.ts";
import type { Lifi } from "../swaps/lifi.ts";
import { CoinSender } from "./coin-sender.ts";
import type { CoinWithdrawalDoc, HedgeDoc } from "./docs.ts";
import { TradeHedger } from "./hedger.ts";
import { createInventoryChain } from "./inventory-chain.ts";
import { createSolanaSender, jsonRpcSend } from "./solana-sender.ts";

export type TradingExecution = {
    /** Null while its switch is off. */
    hedger: TradeHedger | null;
    sender: CoinSender | null;
    start(): void;
    stop(): Promise<void>;
};

/** The workers that make traded coins real, each behind its config switch; the caller starts and stops them with the server. */
export function createTradingExecution(deps: {
    config: Pick<Config, "TRADE_HEDGING" | "COIN_WITHDRAWALS" | "LIFI_INTEGRATOR" | "SOLANA_RPC_URLS">;
    keyring: Keyring;
    database: Pick<Database, "client" | "collections">;
    lifi: Pick<Lifi, "quote" | "status">;
    clients: Record<EvmNetworkId, PublicClient>;
    solana: Pick<SolanaRpc, "getLatestBlockhash" | "getSignatureStatuses">;
    logger: Logger;
    /** Called when a withdrawal reaches `sent` or `failed`; `refunded` is true when its units went back to the holding. */
    onWithdrawal?: (withdrawal: CoinWithdrawalDoc, refunded: boolean) => void;
    onHedge?: (hedge: HedgeDoc) => void;
}): TradingExecution {
    const { config, keyring, database, logger } = deps;
    const account = keyring.inventoryEvm();
    // One chain object, so the hedger and the sender never hand out the same nonce
    const chain = createInventoryChain({ account, clients: deps.clients });

    const hedger =
        config.TRADE_HEDGING === "on"
            ? new TradeHedger({
                  client: database.client,
                  collections: database.collections,
                  lifi: deps.lifi,
                  chain,
                  inventory: account.address,
                  treasury: keyring.operator().address,
                  integrator: config.LIFI_INTEGRATOR,
                  logger: logger.child({ component: "hedger" }),
                  onChange: deps.onHedge,
              })
            : null;

    const solana = createSolanaSender({
        seed: keyring.inventorySolana().seed,
        rpc: deps.solana,
        send: jsonRpcSend(config.SOLANA_RPC_URLS),
    });
    const sender =
        config.COIN_WITHDRAWALS === "on"
            ? new CoinSender({
                  client: database.client,
                  collections: database.collections,
                  chain,
                  solana,
                  logger: logger.child({ component: "coin-sender" }),
                  onChange: deps.onWithdrawal,
              })
            : null;

    return {
        hedger,
        sender,
        start() {
            sender?.start();
            hedger?.start();
        },
        async stop() {
            await Promise.all([hedger?.stop(), sender?.stop()]);
        },
    };
}
