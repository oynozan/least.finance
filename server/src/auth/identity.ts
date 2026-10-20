import { APIError, PrivyClient } from "@privy-io/node";
import { createRemoteJWKSet, errors, importSPKI, jwtVerify, type CryptoKey, type JWTVerifyGetKey } from "jose";
import type { Logger } from "pino";
import { getAddress, isAddress, type Address } from "viem";
import { AppError, newRef, shortOf } from "../errors.ts";
import { throttle } from "../log-throttle.ts";

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
     * Confirms the user controls `address` (EVM or Solana): Privy only links a
     * wallet after it signs in with it, so a linked wallet is a proven one, and
     * the app never asks for a signature of its own.
     */
    authorizeWallet(identity: Identity, address: string): Promise<string>;
    /** Every wallet linked to the user; `fresh` skips the cache. */
    linkedWallets(identity: Identity, options?: { fresh?: boolean }): Promise<{ evm: Address[]; solana: string[] }>;
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

/** EVM addresses are lowercased; Solana addresses are exactly as Privy has them. */
type Wallets = { evm: Set<string>; solana: Set<string>; fetchedAt: number };

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

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
    readonly #source: "pem" | "jwks";
    readonly #quiet = throttle(60_000);
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
        return new PrivyIdentity(privy, appId, key, logger, verificationKey ? "pem" : "jwks");
    }

    private constructor(
        privy: PrivyClient,
        appId: string,
        key: CryptoKey | JWTVerifyGetKey,
        logger: Logger,
        source: "pem" | "jwks",
    ) {
        this.#source = source;
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
            if (error instanceof errors.JWTExpired) {
                throw new AppError("unauthorized", "Your session expired. Sign in again.", {
                    cause: error,
                    detail: "token_expired",
                });
            }
            if (error instanceof errors.JWTClaimValidationFailed && (error.claim === "aud" || error.claim === "iss")) {
                // Every person is refused alike when the app ID is wrong, so the owner has to be told
                const held = this.#quiet(`claim:${error.claim}`);
                if (held) {
                    this.#logger.warn(
                        {
                            event: "auth.token_refused",
                            claim: error.claim,
                            reason: error.reason,
                            code: error.code,
                            held: held.held,
                        },
                        `A sign-in token was refused for its ${error.claim}; if every person is signed out, PRIVY_APP_ID doesn't match the web app's`,
                    );
                }
                throw new AppError(
                    "unauthorized",
                    "Your sign-in belongs to a different app than this server. Sign in again; if it keeps happening the owner must check PRIVY_APP_ID.",
                    { cause: error, detail: `claim_${error.claim}_${error.reason}`, logged: true },
                );
            }
            if (BAD_TOKEN.some((type) => error instanceof type)) {
                const code = (error as { code?: string }).code ?? "invalid";
                const held = this.#quiet(`token:${code}`);
                if (held) {
                    this.#logger.warn(
                        { event: "auth.token_refused", code, source: this.#source, held: held.held },
                        "A sign-in token was refused",
                    );
                }
                throw new AppError("unauthorized", "Your sign-in token isn't valid. Sign in again.", {
                    cause: error,
                    detail: code,
                    logged: true,
                });
            }
            const held = this.#quiet("keys");
            const ref = held ? newRef() : undefined;
            if (held) {
                this.#logger.warn(
                    { event: "auth.keys_unreachable", source: this.#source, ref, err: error, held: held.held },
                    "Couldn't check a sign-in token because the key source didn't answer",
                );
            }
            throw new AppError("unavailable", `The sign-in service didn't answer. Try again shortly${refOf(ref)}.`, {
                cause: error,
                detail: "keys_unreachable",
                logged: true,
            });
        }
    }

    async authorizeWallet(identity: Identity, address: string): Promise<string> {
        const isEvm = isAddress(address, { strict: false });
        if (!isEvm && !BASE58_ADDRESS.test(address)) {
            this.#logger.warn(
                { event: "auth.bad_address", accountId: identity.userId, length: address.length },
                "A request named something that isn't a wallet address",
            );
            throw new AppError("bad_request", "That isn't a wallet address.", { logged: true });
        }
        const has = (wallets: Wallets) =>
            isEvm ? wallets.evm.has(address.toLowerCase()) : wallets.solana.has(address);

        let wallets = await this.#walletsOf(identity.userId, false);
        if (!has(wallets) && Date.now() - wallets.fetchedAt > RECHECK_AFTER_MS) {
            wallets = await this.#walletsOf(identity.userId, true);
        }
        if (!has(wallets)) {
            this.#logger.warn(
                {
                    event: "auth.wallet_not_linked",
                    op: "wallet.authorize",
                    userId: identity.userId,
                    accountId: identity.userId,
                    address,
                    cacheAgeMs: Date.now() - wallets.fetchedAt,
                },
                "A wallet isn't linked to the account that asked to use it",
            );
            throw new AppError(
                "forbidden",
                `${shortOf(address)} isn't linked to your account yet. Wait a few seconds after linking it, then try again.`,
                { logged: true },
            );
        }
        return isEvm ? getAddress(address) : address;
    }

    async linkedWallets(identity: Identity, options: { fresh?: boolean } = {}) {
        const wallets = await this.#walletsOf(identity.userId, options.fresh ?? false);
        return { evm: [...wallets.evm].map((address) => getAddress(address)), solana: [...wallets.solana] };
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
            if (this.#api === "rejected")
                this.#logger.error({ event: "privy.check", status: statusOf(error) }, REJECTED_MESSAGE);
            else if (this.#api === "unreachable")
                this.#logger.warn({ err: error, event: "privy.check" }, "Privy's API isn't answering");
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
            if (this.#api !== "ok")
                this.#logger.warn({ event: "privy.user_read", was: this.#api }, "Privy's API answers again");
            this.#api = "ok";
        } catch (error) {
            const was = this.#api;
            this.#api = this.#classify(error);
            if (this.#api === "ok") {
                throw new AppError("unauthorized", "Your account no longer exists. Sign in again.", {
                    cause: error,
                    detail: "privy_404",
                });
            }
            const status = statusOf(error);
            // Every wallet read fails alike while this lasts, so a minute's worth is one line, and only it has a ref
            const held = this.#quiet(`wallets:${this.#api}`);
            const ref = held ? newRef() : undefined;
            if (held) {
                this.#logger.error(
                    {
                        event: "privy.user_read",
                        userId,
                        status,
                        body: error instanceof Error ? error.message.slice(0, 300) : String(error),
                        ref,
                        was,
                        held: held.held,
                    },
                    this.#api === "rejected"
                        ? `${REJECTED_MESSAGE} Privy answered ${status}`
                        : "Couldn't load a Privy user",
                );
            }
            throw new AppError(
                "unavailable",
                this.#api === "rejected"
                    ? `Wallet checks are down on our side${refOf(ref)}. Try again shortly.`
                    : `The wallet service didn't answer in 10 seconds${refOf(ref)}. Try again shortly.`,
                { cause: error, detail: `privy_${this.#api}_${status ?? "no_status"}`, logged: true },
            );
        }

        const evm = new Set<string>();
        const solana = new Set<string>();
        for (const account of user.linked_accounts) {
            // External or embedded wallets; smart wallets have their own type.
            if (account.type !== "wallet") continue;
            if (account.chain_type === "ethereum") evm.add(account.address.toLowerCase());
            else if (account.chain_type === "solana") solana.add(account.address);
        }
        const wallets = { evm, solana, fetchedAt: Date.now() };
        if (this.#wallets.size >= CACHE_LIMIT) this.#wallets.delete(this.#wallets.keys().next().value!);
        this.#wallets.set(userId, wallets);
        return wallets;
    }
}

const statusOf = (error: unknown) => (error instanceof APIError ? error.status : undefined);

/** " (ref 3f9a2c)" when the failure was logged under one, nothing when a repeat was held back. */
const refOf = (ref: string | undefined) => (ref ? ` (ref ${ref})` : "");
