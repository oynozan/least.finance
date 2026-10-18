import { expect, test } from "vitest";
import { createSolanaRpc } from "../../src/crosschain/solana.ts";
import { checkRecipient, solanaBytes32, usdcAccountOf } from "../../src/withdrawals/solana-recipient.ts";
import { startFakeSolanaRpc } from "../support/fake-solana-rpc.ts";

const WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
// Computed outside the code under test (Python base58 and a SHA-256 program-derived address).
const WALLET_BYTES = "0x6752055c20b3e9d8746656ddf73855507f87ab6d87523e4c76a7fa36096a99eb";
const WALLET_USDC = "C4PRXFV6Gf5mytVZb6RoeLsG8CjcFWzR2EJ3dvwPTUJH";
const SYSTEM = "11111111111111111111111111111111";

test("solanaBytes32 matches a known vector", () => {
    expect(solanaBytes32(WALLET)).toBe(WALLET_BYTES);
    expect(() => solanaBytes32("1111")).toThrow();
});

test("a letter outside base58 is a refusal the person can read, not an internal error", () => {
    expect(() => solanaBytes32("0OIl".repeat(8))).toThrowError(
        expect.objectContaining({ code: "bad_request", message: "That isn't a wallet address." }),
    );
});

test("a Solana network that doesn't answer is told as that, with nothing taken", async () => {
    const rpc = createSolanaRpc(["http://127.0.0.1:1"]);
    await expect(checkRecipient(rpc, WALLET)).rejects.toMatchObject({
        code: "unavailable",
        message: "Couldn't check that Solana wallet right now: the Solana network didn't answer. Nothing was taken.",
        logged: true,
    });
});

test("the USDC account is derived, never the wallet", async () => {
    const derived = await usdcAccountOf(WALLET);
    expect(derived).toBe(WALLET_USDC);
    expect(derived).not.toBe(WALLET);
});

async function withRpc<T>(
    run: (rpc: ReturnType<typeof createSolanaRpc>, fake: Awaited<ReturnType<typeof startFakeSolanaRpc>>) => Promise<T>,
) {
    const fake = await startFakeSolanaRpc();
    try {
        return await run(createSolanaRpc([fake.url]), fake);
    } finally {
        await fake.stop();
    }
}

test("a missing wallet account is accepted with setup true when the USDC account is also missing", async () => {
    await withRpc(async (rpc) => {
        expect(await checkRecipient(rpc, WALLET)).toEqual({ usdcAccount: WALLET_USDC, setup: true });
    });
});

test("a wallet owned by a program is refused", async () => {
    await withRpc(async (rpc, fake) => {
        fake.setAccount(WALLET, { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", lamports: 1n });
        await expect(checkRecipient(rpc, WALLET)).rejects.toMatchObject({
            code: "bad_request",
            logged: true,
            message:
                "That Solana address belongs to a program, not a wallet, so it can't receive USDC. Use your wallet's own address.",
        });
    });
});

test("an existing USDC account gives setup false", async () => {
    await withRpc(async (rpc, fake) => {
        fake.setAccount(WALLET, { owner: SYSTEM, lamports: 1n });
        fake.setAccount(WALLET_USDC, { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", lamports: 2_039_280n });
        expect(await checkRecipient(rpc, WALLET)).toEqual({ usdcAccount: WALLET_USDC, setup: false });
    });
});
