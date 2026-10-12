import { pino } from "pino";
import { afterAll, beforeAll, expect, test } from "vitest";
import { PrivyIdentity } from "../../src/auth/identity.ts";
import { startFakePrivy, type FakePrivy } from "../support/fake-privy.ts";

const EVM = "0x52908400098527886E0F7030069857D2E4169EE7";
const SOLANA = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const USER = "did:privy:linkedwallets000000000";
const identity = { userId: USER, expiresAt: Date.now() + 60_000 };

let privy: FakePrivy;
let provider: PrivyIdentity;
beforeAll(async () => {
    privy = await startFakePrivy();
    provider = await PrivyIdentity.create({
        appId: privy.appId,
        appSecret: privy.appSecret,
        verificationKey: privy.verificationKey,
        apiUrl: privy.url,
        logger: pino({ level: "silent" }),
    });
    privy.setUser(USER, [
        { address: EVM.toLowerCase(), chain: "ethereum" },
        { address: SOLANA, chain: "solana" },
    ]);
});
afterAll(() => privy.stop());

test("both lists come back, and the Solana address keeps its case", async () => {
    expect(await provider.linkedWallets(identity)).toEqual({ evm: [EVM], solana: [SOLANA] });
});

test("a linked Solana address is authorized, exactly as given", async () => {
    expect(await provider.authorizeWallet(identity, SOLANA)).toBe(SOLANA);
    expect(await provider.authorizeWallet(identity, EVM.toLowerCase())).toBe(EVM);
});

test("the Solana address in another case is forbidden", async () => {
    await expect(provider.authorizeWallet(identity, SOLANA.toLowerCase())).rejects.toMatchObject({
        code: "forbidden",
    });
});

test("garbage is a bad request", async () => {
    await expect(provider.authorizeWallet(identity, "not a wallet")).rejects.toMatchObject({
        code: "bad_request",
        message: "That isn't a wallet address.",
    });
});

test("fresh sees a wallet linked after the first read", async () => {
    const other = "Fresh1111111111111111111111111111111111111111";
    privy.setUser(USER, [
        { address: EVM, chain: "ethereum" },
        { address: SOLANA, chain: "solana" },
        { address: other, chain: "solana" },
    ]);
    expect((await provider.linkedWallets(identity)).solana).toEqual([SOLANA]);
    expect((await provider.linkedWallets(identity, { fresh: true })).solana).toEqual([SOLANA, other]);
});
