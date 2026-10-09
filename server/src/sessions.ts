import type { AccountService } from "./accounts/accounts.ts";
import type { Identity, IdentityProvider } from "./auth/identity.ts";
import type { AccountDoc } from "./db/mongo.ts";
import type { DepositService } from "./deposits/deposits.ts";
import { accountView } from "./deposits/views.ts";
import { AppError } from "./errors.ts";
import type { DepositRules, WalletSession } from "./protocol.ts";

type Deps = {
    identity: IdentityProvider;
    accounts: AccountService;
    deposits: DepositService;
    rules: DepositRules;
};

/** Connecting a wallet, the same over HTTP and sockets. */
export class Sessions {
    readonly #deps: Deps;

    constructor(deps: Deps) {
        this.#deps = deps;
    }

    /** Checks the wallet belongs to the user and opens its account, without reading it back yet. */
    async open(identity: Identity, address: string): Promise<AccountDoc> {
        const wallet = await this.#deps.identity.authorizeWallet(identity, address);
        return this.#deps.accounts.open(wallet, identity.userId);
    }

    /** The account as it stands now, and its first page of deposits. */
    async describe(account: AccountDoc): Promise<WalletSession> {
        const current = (await this.#deps.accounts.findById(account._id)) ?? account;
        return {
            account: accountView(current),
            deposits: await this.#deps.deposits.list(current),
            rules: this.#deps.rules,
        };
    }

    /** An account the user already connected; for requests that don't open one. */
    async existing(identity: Identity, address: string): Promise<AccountDoc> {
        const wallet = await this.#deps.identity.authorizeWallet(identity, address);
        const account = await this.#deps.accounts.find(wallet);
        if (!account) throw new AppError("wallet_not_connected", "Connect this wallet first.");
        return account;
    }
}
