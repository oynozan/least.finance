import type { Page, Route } from "@playwright/test";

/**
 * Stands in for Privy's backend (auth.privy.io), which tests can't reach:
 * the app config the modal is built from, and a SIWE login that succeeds
 * for the injected wallet installed by `installWallet`.
 */
// Lowercase: a mixed-case address must carry a valid EIP-55 checksum.
export const ADDRESS = "0x7a3f9e2bc41d8e5a06f1c2d9b84e3a7c5d12ef90";

/** Privy only checks the length (25 characters). */
export const MOCK_APP_ID = "cmtestapp0000000000000000";

const appConfig = {
  id: MOCK_APP_ID,
  name: "Trade Everything",
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
  solana_wallet_auth: false,
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

const user = () => ({
  id: "did:privy:cmtestuser0000000000000",
  created_at: now() - 86_400,
  linked_accounts: [
    {
      type: "wallet",
      address: ADDRESS,
      chain_type: "ethereum",
      chain_id: "eip155:1",
      wallet_client: "unknown",
      wallet_client_type: "metamask",
      connector_type: "injected",
      verified_at: now(),
      first_verified_at: now(),
      latest_verified_at: now(),
    },
  ],
  mfa_methods: [],
  has_accepted_terms: true,
  is_guest: false,
});

// An unsigned JWT is enough: the SDK only decodes it to read the expiry.
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = () =>
  `${b64({ alg: "ES256", typ: "JWT" })}.${b64({
    sid: "session",
    sub: "did:privy:cmtestuser0000000000000",
    iss: "privy.io",
    aud: MOCK_APP_ID,
    iat: now(),
    exp: now() + 3600,
  })}.signature`;

export async function mockPrivy(page: Page) {
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
    if (path.endsWith("/siwe/init"))
      return json({ nonce: "mocknonce123", address: ADDRESS, expires_at: new Date(Date.now() + 600_000).toISOString() });
    if (path.endsWith("/siwe/authenticate"))
      return json({
        user: user(),
        token: token(),
        privy_access_token: token(),
        refresh_token: "refresh",
        identity_token: null,
        session_update_action: "set",
        is_new_user: false,
      });
    if (path.endsWith("/sessions")) return json({ error: "No session" }, 401);
    if (path.endsWith("/users/me")) return json({ user: user() });
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

/** Installs a MetaMask-like EIP-1193 wallet that signs anything. */
export async function installWallet(page: Page) {
  await page.addInitScript((address) => {
    let connected = false;
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const emit = (event: string, ...args: unknown[]) => listeners[event]?.forEach((fn) => fn(...args));
    const provider = {
      isMetaMask: true,
      request: async ({ method }: { method: string }) => {
        switch (method) {
          case "eth_requestAccounts":
          case "wallet_requestPermissions":
            if (!connected) {
              connected = true;
              setTimeout(() => emit("accountsChanged", [address]));
            }
            return method === "eth_requestAccounts"
              ? [address]
              : [{ parentCapability: "eth_accounts", caveats: [{ type: "restrictReturnedAccounts", value: [address] }] }];
          case "wallet_getPermissions":
            return connected ? [{ parentCapability: "eth_accounts" }] : [];
          case "eth_accounts":
            return connected ? [address] : [];
          case "eth_chainId":
            return "0x1";
          case "net_version":
            return "1";
          case "personal_sign":
          case "eth_signTypedData_v4":
            return `0x${"ab".repeat(65)}`;
          case "wallet_switchEthereumChain":
          case "wallet_addEthereumChain":
            return null;
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
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  }, ADDRESS);
}
