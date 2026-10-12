import type { Page, Route } from "@playwright/test";
import { getAddressEncoder, type Address } from "@solana/kit";
import { chainRpc, randomAddress, signUp } from "./backend";

/** Ethereum addresses start 0x; anything else a test signs in with is a Solana one. */
const isSolana = (address: string) => !address.startsWith("0x");

/**
 * Stands in for Privy's backend (auth.privy.io), which tests can't reach:
 * the app config the modal is built from, and a SIWE login that succeeds
 * for the injected wallet installed by `installWallet`. The access token it
 * hands out is a real one from the test backend, so the app's server
 * accepts it.
 */

const wallets = new WeakMap<Page, string>();

/**
 * The wallet a page signs in with: a fresh one per test, so tests running
 * side by side on one backend each have an account of their own. Lowercase,
 * as a mixed-case address must carry a valid EIP-55 checksum.
 */
/** Signs `page` in with a wallet another page already uses, as a second tab or a later visit would. Call it first. */
export function useWallet(page: Page, address: string) {
    // A Solana address is case-sensitive.
    wallets.set(page, isSolana(address) ? address : address.toLowerCase());
}

export function addressOf(page: Page) {
    let address = wallets.get(page);
    if (!address) {
        address = randomAddress();
        wallets.set(page, address);
    }
    return address;
}

/** Privy only checks the length (25 characters). */
export const MOCK_APP_ID = "cmtestapp0000000000000000";

const appConfig = {
    id: MOCK_APP_ID,
    name: "Least Finance",
    logo_url: null,
    accent_color: "#68d670",
    show_wallet_login_first: true,
    wallet_auth: true,
    email_auth: false,
    sms_auth: false,
    google_oauth: false,
    twitter_oauth: false,
    discord_oauth: false,
    github_oauth: false,
    apple_oauth: false,
    linkedin_oauth: false,
    spotify_oauth: false,
    instagram_oauth: false,
    tiktok_oauth: false,
    line_oauth: false,
    twitch_oauth: false,
    farcaster_auth: false,
    passkey_auth: false,
    telegram_auth: false,
    solana_wallet_auth: true,
    passkeys_for_signup_enabled: false,
    disable_plus_emails: false,
    require_users_accept_terms: false,
    terms_and_conditions_url: null,
    privacy_policy_url: null,
    custom_jwt_auth: false,
    wallet_connect_cloud_project_id: null,
    embedded_wallet_config: {
        create_on_login: "off",
        ethereum: { create_on_login: "off" },
        solana: { create_on_login: "off" },
        require_user_password_on_create: false,
        user_owned_recovery_options: ["user-passcode"],
        mode: "user-controlled-server-wallets-only",
    },
    enforce_wallet_uis: false,
    mfa_methods: [],
    captcha_enabled: false,
    enabled_captcha_provider: null,
    allowlist_enabled: false,
    allowlist_config: {},
    legacy_wallet_ui_config: false,
    custom_oauth_providers: [],
    max_linked_wallets_per_user: null,
};

const now = () => Math.floor(Date.now() / 1000);

/** A wallet linked to the mocked user; later links carry a later verification time, as Privy's do. */
type Linked = { address: string; verifiedAt: number };

const linkedAccount = ({ address, verifiedAt }: Linked) =>
    isSolana(address)
        ? {
              type: "wallet",
              address,
              chain_type: "solana",
              wallet_client: "unknown",
              wallet_client_type: "phantom",
              connector_type: "solana_adapter",
              verified_at: verifiedAt,
              first_verified_at: verifiedAt,
              latest_verified_at: verifiedAt,
          }
        : {
              type: "wallet",
              address,
              chain_type: "ethereum",
              chain_id: "eip155:1",
              wallet_client: "unknown",
              wallet_client_type: "metamask",
              connector_type: "injected",
              verified_at: verifiedAt,
              first_verified_at: verifiedAt,
              latest_verified_at: verifiedAt,
          };

const user = (id: string, linked: Linked[]) => ({
    id,
    created_at: now() - 86_400,
    linked_accounts: linked.map(linkedAccount),
    mfa_methods: [],
    has_accepted_terms: true,
    is_guest: false,
});

/** Signs the page's wallet up with the test backend and answers Privy's requests as that user, who already has `alsoLinked` linked. */
export async function mockPrivy(page: Page, alsoLinked: string[] = []) {
    const address = addressOf(page);
    const { userId, token } = await signUp(address, undefined, alsoLinked);
    // Wallets the person has linked since signing in, as /siwe/link and /siws/link add them.
    const linked: Linked[] = [address, ...alsoLinked].map((wallet) => ({ address: wallet, verifiedAt: now() - 3600 }));
    // The address the latest SIWE or SIWS init was for: the wallet a link is about to verify.
    let initiated = address;
    await page.route(/https:\/\/auth\.privy\.io\/.*/, async (route: Route) => {
        const url = new URL(route.request().url());
        const path = url.pathname;
        // Privy sends credentials, so CORS needs the exact origin, not "*".
        const origin = (await route.request().headerValue("origin")) ?? "*";
        const json = (body: unknown, status = 200) =>
            route.fulfill({
                status,
                contentType: "application/json",
                headers: {
                    "access-control-allow-origin": origin,
                    "access-control-allow-credentials": "true",
                    "access-control-allow-headers": "*",
                    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
                },
                body: JSON.stringify(body),
            });

        if (route.request().method() === "OPTIONS") return json({});
        const app = path.match(/^\/api\/v1\/apps\/([^/]+)$/);
        if (app) return json({ ...appConfig, id: app[1] });
        if (path.endsWith("/siwe/init") || path.endsWith("/siws/init")) {
            const body = route.request().postDataJSON() as { address?: string } | null;
            // The wallet sends a checksummed address; the mock keeps Ethereum ones lowercase.
            initiated =
                body?.address && !isSolana(body.address) ? body.address.toLowerCase() : (body?.address ?? address);
        }
        if (path.endsWith("/siwe/init"))
            return json({
                nonce: "mocknonce123",
                address: initiated,
                expires_at: new Date(Date.now() + 600_000).toISOString(),
            });
        if (path.endsWith("/siws/init")) return json({ nonce: "mocknonce123" });
        if (path.endsWith("/siwe/link") || path.endsWith("/siws/link")) {
            // The link response is the updated user itself.
            linked.push({ address: initiated, verifiedAt: now() });
            return json(user(userId, linked));
        }
        const session = () => ({
            user: user(userId, linked),
            token,
            privy_access_token: token,
            refresh_token: "refresh",
            identity_token: null,
            session_update_action: "set",
            is_new_user: false,
        });
        // Privy refreshes the session after a link, and again on a reload.
        if (
            path.endsWith("/sessions") &&
            (route.request().postDataJSON() as { refresh_token?: string } | null)?.refresh_token === "refresh"
        )
            return json(session());
        if (path.endsWith("/siwe/authenticate") || path.endsWith("/siws/authenticate")) return json(session());
        if (path.endsWith("/sessions")) return json({ error: "No session" }, 401);
        if (path.endsWith("/users/me")) return json({ user: user(userId, linked) });
        // Analytics and anything else: accept and ignore.
        return json({});
    });
    // Third-party wallet registries and RPCs are unreachable too; answer
    // empty rather than fail, so nothing surfaces as a console error.
    await page.route(/^https:\/\/[^/]*(walletconnect|web3modal|reown|infura|alchemy)\./, (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            headers: { "access-control-allow-origin": "*" },
            body: JSON.stringify({ data: [], listings: {}, count: 0 }),
        }),
    );
}

/**
 * Installs a Phantom-like Wallet Standard wallet for the page's Solana
 * address. It registers when the page loads and again whenever the app asks
 * for wallets, so it is found whichever side comes up first.
 */
export async function installSolanaWallet(page: Page, address: string) {
    const publicKey = Array.from(getAddressEncoder().encode(address as Address));
    await page.addInitScript(
        ({ address, publicKey }) => {
            const chains = ["solana:mainnet"];
            const account = {
                address,
                publicKey: new Uint8Array(publicKey),
                chains,
                features: ["solana:signMessage"],
            };
            const wallet = {
                version: "1.0.0",
                name: "Phantom",
                icon: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%23ab9ff2'/></svg>",
                chains,
                accounts: [] as (typeof account)[],
                features: {
                    "standard:connect": {
                        version: "1.0.0",
                        connect: async () => {
                            wallet.accounts = [account];
                            return { accounts: wallet.accounts };
                        },
                    },
                    "standard:events": { version: "1.0.0", on: () => () => {} },
                    "solana:signMessage": {
                        version: "1.0.0",
                        signMessage: async (...inputs: { message: Uint8Array }[]) =>
                            inputs.map(({ message }) => ({ signedMessage: message, signature: new Uint8Array(64) })),
                    },
                },
            };
            const register = () =>
                window.dispatchEvent(
                    new CustomEvent("wallet-standard:register-wallet", {
                        detail: (api: { register: (wallet: unknown) => void }) => api.register(wallet),
                    }),
                );
            window.addEventListener("wallet-standard:app-ready", register);
            register();
        },
        { address, publicKey },
    );
}

/** Arc's primary RPC and the two providers the app falls back to. */
export const ARC_RPC = /^https:\/\/rpc\.(blockdaemon\.|drpc\.)?mainnet\.arc\.io\//;
export const ARC_PRIMARY_RPC = /^https:\/\/rpc\.mainnet\.arc\.io\//;

const USDC = "0x3600000000000000000000000000000000000000";

/** Stands in for Arc's RPC, where only USDC's `balanceOf` the page's wallet reads as `usdc`. */
export async function mockArcRpc(
    page: Page,
    usdc = 12_480.52,
    owner = addressOf(page),
    others: Record<string, number> = {},
) {
    // Each owner's `balanceOf` call data, lowercase, to its USDC.
    const balances = new Map(
        Object.entries({ ...others, [owner]: usdc }).map(([who, amount]) => [
            `0x70a08231${who.slice(2).padStart(64, "0")}`.toLowerCase(),
            amount,
        ]),
    );
    const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
    const answer = ({ id, method, params }: { id: number; method: string; params?: unknown[] }) => {
        const call = params?.[0] as { to?: string; data?: string } | undefined;
        const result =
            method === "eth_chainId"
                ? "0x13b2"
                : method === "eth_call"
                  ? word(
                        call?.to?.toLowerCase() === USDC && balances.has(call.data?.toLowerCase() ?? "")
                            ? BigInt(Math.round(balances.get(call.data!.toLowerCase())! * 1e6))
                            : BigInt(0),
                    )
                  : null;
        return { jsonrpc: "2.0", id, result };
    };
    await page.route(ARC_RPC, async (route) => {
        const request = route.request();
        const body = request.method() === "POST" ? request.postDataJSON() : null;
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            headers: {
                "access-control-allow-origin": "*",
                "access-control-allow-headers": "content-type",
                "access-control-allow-methods": "POST, OPTIONS",
            },
            body: JSON.stringify(Array.isArray(body) ? body.map(answer) : body ? answer(body) : {}),
        });
    });
}

type WalletRequest = { method: string; params?: unknown[] };

// Each evaluate callback casts window itself, as only the callback's source reaches the page.
type WalletWindow = {
    ethereum: { request: (request: WalletRequest) => Promise<unknown> };
    walletRequests: WalletRequest[];
    rejectChainSwitches?: number;
    /** What the wallet does with the next network switch: fail without a code, or claim success and stay put. */
    nextSwitch?: "fail" | "ignore";
    /** What the wallet does with the next transaction it's asked to send. */
    nextSend?: "reject" | "drop";
    useChain: (chainId: string) => void;
    lock: () => void;
    sendToChain: (
        method: string,
        params: unknown[],
        chainId: number,
    ) => Promise<{ result?: unknown; error?: { message: string } }>;
};

/** Every request the dapp has sent the wallet, oldest first. */
export const walletRequests = (page: Page) => page.evaluate(() => (window as unknown as WalletWindow).walletRequests);

export const walletChainId = (page: Page) =>
    page.evaluate(() => (window as unknown as WalletWindow).ethereum.request({ method: "eth_chainId" }));

/** The user declines the next network switch the dapp asks for. */
export const rejectNextChainSwitch = (page: Page) =>
    page.evaluate(() => {
        (window as unknown as WalletWindow).rejectChainSwitches = 1;
    });

/** The next network switch fails with an error that carries no code. */
export const failNextChainSwitch = (page: Page) =>
    page.evaluate(() => {
        (window as unknown as WalletWindow).nextSwitch = "fail";
    });

/** The next network switch answers as if it worked, but the wallet stays where it is. */
export const ignoreNextChainSwitch = (page: Page) =>
    page.evaluate(() => {
        (window as unknown as WalletWindow).nextSwitch = "ignore";
    });

/** The user declines the next transaction in their wallet. */
export const rejectNextSend = (page: Page) =>
    page.evaluate(() => {
        (window as unknown as WalletWindow).nextSend = "reject";
    });

/** The wallet hands back a hash for the next transaction, but it never reaches the chain (as when the fee is too low). */
export const dropNextSend = (page: Page) =>
    page.evaluate(() => {
        (window as unknown as WalletWindow).nextSend = "drop";
    });

/** The user picks a network in the wallet itself, one it may not have known before. */
export const moveWalletTo = (page: Page, chainId: string) =>
    page.evaluate((chainId) => (window as unknown as WalletWindow).useChain(chainId), chainId);

/** The wallet locks: it stops sharing accounts, while the Privy session stays. */
export const lockWallet = (page: Page) => page.evaluate(() => (window as unknown as WalletWindow).lock());

/**
 * Installs a MetaMask-like EIP-1193 wallet that signs anything and starts on
 * Ethereum, unaware of Arc. Transactions it sends land on the test backend's
 * chain, where the page's wallet is funded.
 */
export async function installWallet(page: Page, address = addressOf(page)) {
    await page.exposeFunction("sendToChain", (method: string, params: unknown[], chainId: number) =>
        chainRpc(method, params, chainId),
    );
    await page.addInitScript((address) => {
        let connected = false;
        const account = address;
        let chainId = "0x1";
        const knownChains = new Set([chainId]);
        const testChains = new Set(["0x1", "0x38", "0x13b2"]);
        const state = window as unknown as WalletWindow;
        state.walletRequests = [];
        const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
        const emit = (event: string, ...args: unknown[]) => listeners[event]?.forEach((fn) => fn(...args));
        const fail = (code: number, message: string) => Object.assign(new Error(message), { code });
        state.useChain = (next) => {
            chainId = next;
            knownChains.add(next);
            emit("chainChanged", next);
        };
        state.lock = () => {
            connected = false;
            emit("accountsChanged", []);
        };
        const provider = {
            isMetaMask: true,
            request: async ({ method, params }: WalletRequest) => {
                state.walletRequests.push({ method, params });
                const target = (params?.[0] as { chainId?: string } | undefined)?.chainId?.toLowerCase();
                switch (method) {
                    case "eth_requestAccounts":
                    case "wallet_requestPermissions":
                        if (!connected) {
                            connected = true;
                            setTimeout(() => emit("accountsChanged", [account]));
                        }
                        return method === "eth_requestAccounts"
                            ? [account]
                            : [
                                  {
                                      parentCapability: "eth_accounts",
                                      caveats: [{ type: "restrictReturnedAccounts", value: [account] }],
                                  },
                              ];
                    case "wallet_getPermissions":
                        return connected ? [{ parentCapability: "eth_accounts" }] : [];
                    case "eth_accounts":
                        return connected ? [account] : [];
                    case "eth_chainId":
                        return chainId;
                    case "net_version":
                        return String(parseInt(chainId, 16));
                    case "personal_sign":
                    case "eth_signTypedData_v4":
                        return `0x${"ab".repeat(65)}`;
                    case "wallet_switchEthereumChain":
                        // The prompt takes a moment, as a real wallet's does.
                        await new Promise((resolve) => setTimeout(resolve, 150));
                        if (state.rejectChainSwitches) {
                            state.rejectChainSwitches--;
                            throw fail(4001, "User rejected the request.");
                        }
                        if (state.nextSwitch) {
                            const behavior = state.nextSwitch;
                            state.nextSwitch = undefined;
                            if (behavior === "fail") throw new Error("This wallet can't switch networks right now.");
                            return null;
                        }
                        if (!target || !knownChains.has(target)) throw fail(4902, `Unrecognized chain ID "${target}".`);
                        if (target !== chainId) {
                            chainId = target;
                            setTimeout(() => emit("chainChanged", chainId));
                        }
                        return null;
                    case "wallet_addEthereumChain":
                        if (target) knownChains.add(target);
                        return null;
                    case "eth_sendTransaction": {
                        const behavior = state.nextSend;
                        state.nextSend = undefined;
                        if (behavior === "reject") throw fail(4001, "User rejected the request.");
                        // Only Ethereum, BNB Chain and Arc are on the test backend.
                        if (!testChains.has(chainId))
                            throw fail(-32603, `The wallet is on chain ${chainId}, which the tests don't run.`);
                        if (behavior === "drop") {
                            const bytes = crypto.getRandomValues(new Uint8Array(32));
                            return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
                        }
                        const tx = { ...(params?.[0] as { chainId?: string }), from: account };
                        // Like real wallets, refuse a transaction meant for another chain.
                        if (tx.chainId && tx.chainId.toLowerCase() !== chainId)
                            throw fail(-32602, `Expected chain ${tx.chainId}.`);
                        const { result, error } = await state.sendToChain(method, [tx], parseInt(chainId, 16));
                        if (error) throw fail(-32603, error.message);
                        return result;
                    }
                    case "eth_getTransactionReceipt": {
                        if (!testChains.has(chainId)) return null;
                        const { result, error } = await state.sendToChain(method, params ?? [], parseInt(chainId, 16));
                        if (error) throw fail(-32603, error.message);
                        return result;
                    }
                    default:
                        return null;
                }
            },
            on: (event: string, fn: (...args: unknown[]) => void) => {
                (listeners[event] ??= []).push(fn);
            },
            removeListener: (event: string, fn: (...args: unknown[]) => void) => {
                listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn);
            },
        };
        Object.defineProperty(window, "ethereum", { value: provider, configurable: true });
        const info = {
            uuid: "00000000-0000-4000-8000-000000000000",
            name: "MetaMask",
            icon: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%23f6851b'/></svg>",
            rdns: "io.metamask",
        };
        const announce = () =>
            window.dispatchEvent(
                new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }),
            );
        window.addEventListener("eip6963:requestProvider", announce);
        announce();
    }, address);
}
