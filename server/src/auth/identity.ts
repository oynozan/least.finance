import { APIError, PrivyClient } from "@privy-io/node";
import { createRemoteJWKSet, errors, importSPKI, jwtVerify, type CryptoKey, type JWTVerifyGetKey } from "jose";
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

/**
 * Whether Privy's API answered the server's last request: "rejected" means
 * it refused the app ID and secret, which only a configuration fix cures.
 */
export type PrivyApiState = "unchecked" | "ok" | "rejected" | "unreachable";

export interface IdentityProvider {
    /** Checks a Privy access token locally (no request to Privy once the key is known). */
    verify(token: string): Promise<Identity>;
    /**
     * Confirms the user controls `address`: Privy only links a wallet after it
     * signs in with Ethereum (SIWE), so a linked wallet is a proven one, and
     * the app never asks for a signature of its own.
     */
    authorizeWallet(identity: Identity, address: string): Promise<Address>;
    /** Asks Privy's API once whether it accepts the server's credentials. Never throws. */
    checkApi(): Promise<PrivyApiState>;
    /** The outcome of the last request to Privy's API. */
    apiState(): PrivyApiState;
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

const PRIVY_API = "https://api.privy.io";
/** No user has this ID: Privy answers 404 when it accepts the credentials, 401 when it doesn't. */
const PROBE_USER = "did:privy:credentialcheck0000000000";

const REJECTED_MESSAGE =
    "Privy rejected PRIVY_APP_ID / PRIVY_APP_SECRET. Wallets can't be checked until they're fixed (Privy dashboard → your app → Settings → Basics).";

/**
 * What a token itself got wrong. Anything else, such as Privy's key set
 * being unreachable, says nothing about the token, so it isn't a sign-out.
 */
const BAD_TOKEN = [
    errors.JWTExpired,
    errors.JWTClaimValidationFailed,
    errors.JWTInvalid,
    errors.JWSInvalid,
    errors.JWSSignatureVerificationFailed,
    errors.JOSEAlgNotAllowed,
    errors.JWKSNoMatchingKey,
    errors.JWKSMultipleMatchingKeys,
];

export class PrivyIdentity implements IdentityProvider {
    readonly #privy: PrivyClient;
    readonly #appId: string;
    readonly #key: CryptoKey | JWTVerifyGetKey;
    readonly #logger: Logger;
    readonly #wallets = new Map<string, Wallets>();
    readonly #fetching = new Map<string, Promise<Wallets>>();
    #api: PrivyApiState = "unchecked";

    /** Fails here, at startup, if the configured verification key isn't a valid ES256 public key. */
    static async create({ appId, appSecret, verificationKey, apiUrl, logger }: Options) {
        // The dashboard's verification key needs no request; otherwise Privy's key set, cached, as its SDK does.
        const key = verificationKey
            ? await importSPKI(verificationKey, "ES256").catch((error: unknown) => {
                  throw new Error("PRIVY_VERIFICATION_KEY isn't a valid ES256 public key (PEM).", { cause: error });
              })
            : createRemoteJWKSet(new URL(`${apiUrl ?? PRIVY_API}/v1/apps/${appId}/jwks.json`), {
                  cacheMaxAge: 60 * 60_000,
                  cooldownDuration: 30_000,
                  timeoutDuration: 5_000,
              });
        const privy = new PrivyClient({ appId, appSecret, apiUrl, timeout: 10_000, maxRetries: 1 });
        return new PrivyIdentity(privy, appId, key, logger);
    }

    private constructor(privy: PrivyClient, appId: string, key: CryptoKey | JWTVerifyGetKey, logger: Logger) {
        this.#privy = privy;
        this.#appId = appId;
        this.#key = key;
        this.#logger = logger;
    }

    /**
     * Verified here with jose rather than Privy's SDK, which reports a key set
     * it couldn't fetch as a bad token, and would sign everyone out whenever
     * Privy is slow.
     */
    async verify(token: string): Promise<Identity> {
        const options = {
            typ: "JWT",
            algorithms: ["ES256"],
            issuer: "privy.io",
            audience: this.#appId,
            requiredClaims: ["sub", "exp"],
        };
        try {
            const key = this.#key;
            const { payload } =
                typeof key === "function" ? await jwtVerify(token, key, options) : await jwtVerify(token, key, options);
            return { userId: payload.sub!, expiresAt: payload.exp! * 1000 };
        } catch (error) {
            if (BAD_TOKEN.some((type) => error instanceof type)) {
                throw new AppError("unauthorized", "Your session isn't valid. Sign in again.", { cause: error });
            }
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

    apiState() {
        return this.#api;
    }

    async checkApi(): Promise<PrivyApiState> {
        try {
            await this.#privy.users()._get(PROBE_USER, { maxRetries: 0 });
            this.#api = "ok";
        } catch (error) {
            this.#api = this.#classify(error);
            if (this.#api === "rejected") this.#logger.error(REJECTED_MESSAGE);
            else if (this.#api === "unreachable") this.#logger.warn({ err: error }, "Privy's API isn't answering");
        }
        return this.#api;
    }

    /** A 404 still means Privy accepted the credentials; 401 and 403 mean it didn't. */
    #classify(error: unknown): PrivyApiState {
        if (!(error instanceof APIError) || error.status === undefined) return "unreachable";
        if (error.status === 401 || error.status === 403) return "rejected";
        if (error.status === 404) return "ok";
        return "unreachable";
    }

    async #fetchWallets(userId: string): Promise<Wallets> {
        let user;
        try {
            user = await this.#privy.users()._get(userId);
            this.#api = "ok";
        } catch (error) {
            this.#api = this.#classify(error);
            if (this.#api === "ok") {
                throw new AppError("unauthorized", "Your account no longer exists. Sign in again.", { cause: error });
            }
            if (this.#api === "rejected") this.#logger.error(REJECTED_MESSAGE);
            else this.#logger.error({ err: error, userId }, "Couldn't load a Privy user");
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
