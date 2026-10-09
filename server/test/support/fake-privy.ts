import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, exportSPKI, generateKeyPair, SignJWT, type CryptoKey } from "jose";

/**
 * Stands in for Privy's API so the real `@privy-io/node` client runs against
 * it: it serves users by DID and signs access tokens the way Privy does
 * (ES256, issuer privy.io, audience the app ID).
 */
export type FakePrivy = {
    url: string;
    appId: string;
    appSecret: string;
    /** The SPKI PEM the server verifies tokens with. */
    verificationKey: string;
    /** Creates or replaces a user and the Ethereum wallets linked to it. */
    setUser(userId: string, wallets: string[]): void;
    deleteUser(userId: string): void;
    token(userId: string, options?: { expiresInSeconds?: number; appId?: string; issuer?: string }): Promise<string>;
    /** GET /v1/users/:id requests served so far. */
    userLookups: number;
    /** Makes the next `count` user lookups fail with this status. */
    failLookups(count: number, status: number): void;
    stop(): Promise<void>;
};

export async function startFakePrivy(appId = "test-app-id"): Promise<FakePrivy> {
    const appSecret = "test-app-secret";
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    const verificationKey = await exportSPKI(publicKey);
    const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "ES256", use: "sig" };
    const users = new Map<string, string[]>();
    let failing = { count: 0, status: 500 };

    const server = createServer((req, res) => {
        const send = (status: number, body: unknown) =>
            res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
        const url = new URL(req.url ?? "/", "http://localhost");

        if (url.pathname === `/v1/apps/${appId}/jwks.json`) return send(200, { keys: [jwk] });

        const userPath = /^\/v1\/users\/([^/]+)$/.exec(url.pathname);
        if (req.method === "GET" && userPath) {
            fake.userLookups++;
            const expected = `Basic ${Buffer.from(`${appId}:${appSecret}`).toString("base64")}`;
            if (req.headers.authorization !== expected) return send(401, { error: "Invalid app credentials" });
            if (failing.count > 0) {
                failing.count--;
                return send(failing.status, { error: "Unavailable" });
            }
            const userId = decodeURIComponent(userPath[1]!);
            const wallets = users.get(userId);
            if (!wallets) return send(404, { error: "User not found" });
            return send(200, userJson(userId, wallets));
        }
        send(404, { error: "Not found" });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const fake: FakePrivy = {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        appId,
        appSecret,
        verificationKey,
        setUser: (userId, wallets) => users.set(userId, wallets),
        deleteUser: (userId) => users.delete(userId),
        token: (userId, options = {}) => sign(privateKey, userId, options.appId ?? appId, options),
        userLookups: 0,
        failLookups: (count, status) => {
            failing = { count, status };
        },
        stop: () =>
            new Promise((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
    return fake;
}

function sign(
    key: CryptoKey,
    userId: string,
    appId: string,
    { expiresInSeconds = 3600, issuer = "privy.io" }: { expiresInSeconds?: number; issuer?: string },
) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ sid: `session-${userId}` })
        .setProtectedHeader({ alg: "ES256", typ: "JWT" })
        .setIssuer(issuer)
        .setAudience(appId)
        .setSubject(userId)
        .setIssuedAt(now)
        .setExpirationTime(now + expiresInSeconds)
        .sign(key);
}

/** The shape Privy's GET /v1/users/:id returns, with external Ethereum wallets linked. */
function userJson(userId: string, wallets: string[]) {
    const now = Math.floor(Date.now() / 1000);
    return {
        id: userId,
        created_at: now,
        has_accepted_terms: false,
        is_guest: false,
        mfa_methods: [],
        linked_accounts: [
            ...wallets.map((address) => ({
                type: "wallet",
                chain_type: "ethereum",
                address,
                wallet_client: "unknown",
                wallet_client_type: "metamask",
                connector_type: "injected",
                verified_at: now,
                first_verified_at: now,
                latest_verified_at: now,
            })),
            // Not a wallet, so never a match.
            {
                type: "email",
                address: "someone@example.com",
                verified_at: now,
                first_verified_at: now,
                latest_verified_at: now,
            },
        ],
    };
}
