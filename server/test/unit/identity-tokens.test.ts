import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { pino } from "pino";
import { beforeAll, expect, test } from "vitest";
import { PrivyIdentity } from "../../src/auth/identity.ts";
import { AppError } from "../../src/errors.ts";

type Line = Record<string, any>;
const lines: Line[] = [];
const logger = pino({ level: "info" }, { write: (chunk: string) => void lines.push(JSON.parse(chunk)) });

let identity: PrivyIdentity;
let privateKey: CryptoKey;
beforeAll(async () => {
    const pair = await generateKeyPair("ES256");
    privateKey = pair.privateKey as CryptoKey;
    identity = await PrivyIdentity.create({
        appId: "app-1",
        appSecret: "secret",
        verificationKey: await exportSPKI(pair.publicKey),
        logger,
    });
});

const sign = (claims: { aud?: string; exp?: string }) =>
    new SignJWT({})
        .setProtectedHeader({ alg: "ES256", typ: "JWT" })
        .setSubject("did:privy:u1")
        .setIssuer("privy.io")
        .setAudience(claims.aud ?? "app-1")
        .setExpirationTime(claims.exp ?? "1h")
        .sign(privateKey);

const refusal = async (token: string) => {
    const error = await identity.verify(token).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
};

test("an expired token says the session expired", async () => {
    const error = await refusal(await sign({ exp: "-1m" }));
    expect(error).toMatchObject({
        code: "unauthorized",
        message: "Your session expired. Sign in again.",
        detail: "token_expired",
    });
});

test("a token for another app says so and the log names the claim", async () => {
    lines.length = 0;
    const error = await refusal(await sign({ aud: "other-app" }));
    expect(error.message).toContain("different app than this server");
    expect(error.message).toContain("PRIVY_APP_ID");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 40, event: "auth.token_refused", claim: "aud" });
    expect(JSON.stringify(lines[0])).not.toContain("eyJ");
});

test("a token that isn't a token says it isn't valid, and is logged once with its error code", async () => {
    lines.length = 0;
    const first = await refusal("not.a.jwt");
    await refusal("not.a.jwt");
    expect(first.message).toBe("Your sign-in token isn't valid. Sign in again.");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: "auth.token_refused", source: "pem" });
    expect(typeof lines[0]!.code).toBe("string");
});
