import { APIError, InvalidAuthTokenError, PrivyClient } from "@privy-io/node";
import type { Logger } from "pino";
import { getAddress, isAddress, type Address } from "viem";
import { AppError } from "../errors.ts";

/** Who a verified access token belongs to. */
export type Identity = {
    /** The Privy user's DID. */
    userId: string;
    /** When the token stops being valid, in ms since the epoch. */
    expiresAt: number;
};

export interface IdentityProvider {
    /** Checks a Privy access token locally (no request to Privy once the key is known). */
    verify(token: string): Promise<Identity>;
    /**
     * Confirms the user controls `address`: Privy only links a wallet after it
     * signs in with Ethereum (SIWE), so a linked wallet is a proven one, and
     * the app never asks for a signature of its own.
     */
    authorizeWallet(identity: Identity, address: string): Promise<Address>;
}

type Options = {
    appId: string;
    appSecret: string;
    verificationKey?: string;
    apiUrl?: string;
    logger: Logger;
};

/** A user's wallets are re-read from Privy at most this often. */
const WALLETS_TTL_MS = 60_000;
/** A wallet missing from a cached list triggers a re-read, at most this often, for one linked a moment ago. */
const RECHECK_AFTER_MS = 5_000;
const CACHE_LIMIT = 10_000;

type Wallets = { addresses: Set<string>; fetchedAt: number };

export class PrivyIdentity implements IdentityProvider {
    readonly #privy: PrivyClient;
    readonly #logger: Logger;
    readonly #wallets = new Map<string, Wallets>();
    readonly #fetching = new Map<string, Promise<Wallets>>();

    constructor({ appId, appSecret, verificationKey, apiUrl, logger }: Options) {
        this.#privy = new PrivyClient({
            appId,
            appSecret,
            apiUrl,
            jwtVerificationKey: verificationKey,
            timeout: 10_000,
            maxRetries: 1,
        });
        this.#logger = logger;
    }

    async verify(token: string): Promise<Identity> {
        try {
            const claims = await this.#privy.utils().auth().verifyAccessToken(token);
            return { userId: claims.user_id, expiresAt: claims.expiration * 1000 };
        } catch (error) {
            if (error instanceof InvalidAuthTokenError) {
                throw new AppError("unauthorized", "Your session isn't valid. Sign in again.", { cause: error });
            }
            // The verification key couldn't be fetched: Privy is unreachable, not the token bad.
            this.#logger.error({ err: error }, "Couldn't verify a Privy access token");
            throw new AppError("unavailable", "Couldn't check your session right now. Try again shortly.", {
                cause: error,
            });
        }
    }

    async authorizeWallet(identity: Identity, address: string): Promise<Address> {
        if (!isAddress(address, { strict: false })) throw new AppError("bad_request", "That isn't a wallet address.");
        const wanted = address.toLowerCase();

        let wallets = await this.#walletsOf(identity.userId, false);
        if (!wallets.addresses.has(wanted) && Date.now() - wallets.fetchedAt > RECHECK_AFTER_MS) {
            wallets = await this.#walletsOf(identity.userId, true);
        }
        if (!wallets.addresses.has(wanted)) {
            throw new AppError("forbidden", "That wallet isn't linked to your account.");
        }
        return getAddress(wanted);
    }

    async #walletsOf(userId: string, fresh: boolean): Promise<Wallets> {
        const cached = this.#wallets.get(userId);
        if (!fresh && cached && Date.now() - cached.fetchedAt < WALLETS_TTL_MS) return cached;

        const running = this.#fetching.get(userId);
        if (running) return running;
        const fetching = this.#fetchWallets(userId).finally(() => this.#fetching.delete(userId));
        this.#fetching.set(userId, fetching);
        return fetching;
    }

    async #fetchWallets(userId: string): Promise<Wallets> {
        let user;
        try {
            user = await this.#privy.users()._get(userId);
        } catch (error) {
            if (error instanceof APIError && error.status === 404) {
                throw new AppError("unauthorized", "Your account no longer exists. Sign in again.", { cause: error });
            }
            this.#logger.error({ err: error, userId }, "Couldn't load a Privy user");
            throw new AppError("unavailable", "Couldn't check your wallet right now. Try again shortly.", {
                cause: error,
            });
        }

        const addresses = new Set<string>();
        for (const account of user.linked_accounts) {
            // Ethereum wallets only, external or embedded; smart wallets have their own type.
            if (account.type === "wallet" && account.chain_type === "ethereum") {
                addresses.add(account.address.toLowerCase());
            }
        }
        const wallets = { addresses, fetchedAt: Date.now() };
        if (this.#wallets.size >= CACHE_LIMIT) this.#wallets.delete(this.#wallets.keys().next().value!);
        this.#wallets.set(userId, wallets);
        return wallets;
    }
}
