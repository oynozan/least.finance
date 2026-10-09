import type { Logger } from "pino";
import type { Address } from "viem";
import type { AccountService } from "./accounts/accounts.ts";
import type { Identity, IdentityProvider } from "./auth/identity.ts";
import type { AccountDoc } from "./db/mongo.ts";
import type { DepositService } from "./deposits/deposits.ts";
import { accountView } from "./deposits/views.ts";
import { AppError } from "./errors.ts";
import type { DepositRules, WalletSession } from "./protocol.ts";

type Deps = {
    logger: Logger;
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
        const checked = await this.#authorize(identity, address);
        if ("account" in checked) return checked.account;
        return this.#deps.accounts.open(checked.wallet, identity.userId);
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
        const checked = await this.#authorize(identity, address);
        const account = "account" in checked ? checked.account : await this.#deps.accounts.find(checked.wallet);
        if (!account) throw new AppError("wallet_not_connected", "Connect this wallet first.");
        return account;
    }

    /**
     * Asks Privy whether the user controls the wallet. When Privy can't answer
     * (it's down, or rejects the server's credentials), a wallet this user has
     * connected before was proven then, so its account carries on; only a
     * wallet new to the user has to wait for Privy.
     */
    async #authorize(identity: Identity, address: string): Promise<{ wallet: Address } | { account: AccountDoc }> {
        try {
            return { wallet: await this.#deps.identity.authorizeWallet(identity, address) };
        } catch (error) {
            if (!(error instanceof AppError) || error.code !== "unavailable") throw error;
            const account = await this.#deps.accounts.find(address);
            if (!account || account.privyUserId !== identity.userId) throw error;
            this.#deps.logger.warn(
                { userId: identity.userId, wallet: account.wallet },
                "Privy couldn't answer; went by the wallet's earlier verification",
            );
            return { account };
        }
    }
}
