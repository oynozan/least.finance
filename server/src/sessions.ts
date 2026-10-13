import type { DepositOrders } from "./crosschain/orders.ts";
import { orderView } from "./crosschain/views.ts";
import type { AccountService } from "./accounts/accounts.ts";
import type { Identity } from "./auth/identity.ts";
import type { AccountDoc } from "./db/mongo.ts";
import type { DepositService } from "./deposits/deposits.ts";
import { accountView } from "./deposits/views.ts";
import { withdrawalView } from "./withdrawals/views.ts";
import type { Withdrawals } from "./withdrawals/withdrawals.ts";
import { AppError } from "./errors.ts";
import type { DepositRules, WalletSession } from "./protocol.ts";

type Deps = {
    accounts: AccountService;
    deposits: DepositService;
    orders: DepositOrders;
    withdrawals: Withdrawals;
    rules: DepositRules;
};

/** Opening a person's account, the same over HTTP and sockets. */
export class Sessions {
    readonly #deps: Deps;

    constructor(deps: Deps) {
        this.#deps = deps;
    }

    /** Opens the user's account, without reading it back yet. */
    open(identity: Identity): Promise<AccountDoc> {
        return this.#deps.accounts.open(identity.userId);
    }

    /** The account as it stands now, and its first page of deposits. */
    async describe(account: AccountDoc): Promise<WalletSession> {
        const current = (await this.#deps.accounts.findById(account._id)) ?? account;
        return {
            account: accountView(current),
            deposits: await this.#deps.deposits.list(current),
            rules: this.#deps.rules,
            orders: (await this.#deps.orders.open(current._id)).map(orderView),
            withdrawals: (await this.#deps.withdrawals.recent(current._id)).map(withdrawalView),
        };
    }

    /** The user's account, for requests that don't open one. */
    async existing(identity: Identity): Promise<AccountDoc> {
        const account = await this.#deps.accounts.find(identity.userId);
        if (!account) throw new AppError("wallet_not_connected", "Open your account first.");
        return account;
    }
}
