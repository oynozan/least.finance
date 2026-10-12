import type { Logger } from "pino";
import type { AccountService } from "./accounts/accounts.ts";
import type { IdentityProvider } from "./auth/identity.ts";
import type { WalletBalances } from "./balances/wallet-balances.ts";
import type { Config } from "./config.ts";
import type { Database } from "./db/mongo.ts";
import type { DepositService } from "./deposits/deposits.ts";
import type { DepositWatcher } from "./deposits/watcher.ts";
import type { DepositOrders } from "./crosschain/orders.ts";
import type { Bus } from "./events.ts";
import type { Sessions } from "./sessions.ts";

/** Everything the HTTP and socket layers call into. */
export type Services = {
    config: Config;
    logger: Logger;
    database: Database;
    bus: Bus;
    identity: IdentityProvider;
    accounts: AccountService;
    deposits: DepositService;
    sessions: Sessions;
    watcher: DepositWatcher;
    balances: WalletBalances;
    orders: DepositOrders;
};
