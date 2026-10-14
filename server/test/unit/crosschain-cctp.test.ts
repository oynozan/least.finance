import { createHash } from "node:crypto";
import { base58 } from "@scure/base";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { coinByKey } from "../../src/crosschain/catalog.ts";
import { createIris } from "../../src/crosschain/iris.ts";
import { checkQuote } from "../../src/crosschain/quotes.ts";
import { createCctp } from "../../src/crosschain/providers/cctp.ts";
import type { QuoteRequest } from "../../src/crosschain/providers/types.ts";
import { startFakeIris, type FakeIris } from "../support/fake-iris.ts";

const WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const DEPOSIT_ADDRESS = "0x00000000000000000000000000000000000de905";
const TOKEN_MESSENGER_MINTER = "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe";
const SIGNATURE = base58.encode(new Uint8Array(64).fill(7));
const FORWARD_HOOK = "636374702d666f72776172640000000000000000000000000000000000000000";

const USDC = coinByKey("solana:USDC");
const REQUEST: QuoteRequest = {
    coin: USDC,
    amount: 10_000_000n,
    sender: WALLET,
    recipient: DEPOSIT_ADDRESS,
    refundTo: WALLET,
};

let fake: FakeIris;
beforeAll(async () => {
    fake = await startFakeIris();
});
afterAll(() => fake.stop());

const logger = { error: vi.fn() };
const rentCalls: number[] = [];
const rpc = {
    getMinimumBalanceForRentExemption: async (bytes: number) => {
        rentCalls.push(bytes);
        return BigInt(bytes + 128) * 6960n;
    },
};
const cctp = () => createCctp({ iris: createIris({ baseUrl: fake.url }), rpc, arcDomain: 26, solanaDomain: 5, logger });
const signal = new AbortController().signal;

test("supports only solana:USDC", () => {
    const provider = cctp();
    expect(provider.name).toBe("cctp");
    expect(provider.supports(coinByKey("solana:USDC"))).toBe(true);
    for (const key of ["solana:SOL", "ethereum:USDC", "bnb:USDT", "arc:USDC"]) {
        expect(provider.supports(coinByKey(key))).toBe(false);
    }
});

test("quote usdcOut is the amount less the Iris fee, ref is the order id until a burn exists", async () => {
    fake.setDepositFee({ med: 15_638, high: 15_763 });
    const quote = await cctp().quote(REQUEST, signal);
    expect(fake.requests().at(-1)).toBe("/v2/burn/USDC/fees/5/26?forward=true");
    expect(quote).toMatchObject({
        provider: "cctp",
        coin: "solana:USDC",
        amountIn: 10_000_000n,
        usdcOut: 10n ** 19n - 15_638n * 10n ** 12n,
        recipient: DEPOSIT_ADDRESS,
        refundTo: WALLET,
    });
    // Without a burn there is no signature to look up, so the ref is only a token for this quote.
    expect(quote.ref).toMatch(/^cctp-[0-9a-f-]{36}$/);
    expect((await cctp().quote(REQUEST, signal)).ref).not.toBe(quote.ref);
});

test("an amount the high fee tier eats is refused", async () => {
    fake.setDepositFee({ med: 15_638, high: 15_763 });
    await expect(cctp().quote({ ...REQUEST, amount: 15_763n }, signal)).rejects.toMatchObject({ code: "bad_request" });
    await expect(cctp().quote({ ...REQUEST, amount: 15_764n }, signal)).resolves.toBeTruthy();
});

test("the transaction burns with destination domain 26, a left-padded 32-byte mintRecipient equal to the Arc deposit address, forwarding hook data and the quoted maxFee", async () => {
    fake.setDepositFee({ med: 15_638, high: 15_763 });
    const { txs } = await cctp().quote(REQUEST, signal);
    expect(txs).toHaveLength(1);
    const [tx] = txs;
    if (tx?.kind !== "solana") throw new Error("not a Solana transaction");
    expect(tx.lookupTables).toEqual([]);
    expect(tx.instructions).toHaveLength(1);
    const [ix] = tx.instructions;
    expect(ix!.programId).toBe(TOKEN_MESSENGER_MINTER);

    const data = Buffer.from(ix!.data.slice(2), "hex");
    const discriminator = createHash("sha256").update("global:deposit_for_burn_with_hook").digest().subarray(0, 8);
    expect(data.subarray(0, 8)).toEqual(discriminator);
    expect(data.readBigUInt64LE(8)).toBe(10_000_000n);
    expect(data.readUInt32LE(16)).toBe(26);
    expect(data.subarray(20, 52).toString("hex")).toBe(`${"00".repeat(12)}${DEPOSIT_ADDRESS.slice(2)}`);
    expect(data.subarray(52, 84)).toEqual(Buffer.alloc(32));
    expect(data.readBigUInt64LE(84)).toBe(15_763n);
    expect(data.readUInt32LE(92)).toBe(2000);
    expect(data.readUInt32LE(96)).toBe(32);
    expect(data.subarray(100).toString("hex")).toBe(FORWARD_HOOK);

    // The accounts, in the program's order, with the owner paying for the event account.
    expect(ix!.keys).toHaveLength(18);
    expect(ix!.keys[0]).toEqual({ pubkey: WALLET, isSigner: true, isWritable: false });
    expect(ix!.keys[1]).toEqual({ pubkey: WALLET, isSigner: true, isWritable: true });
    expect(ix!.keys[3]).toMatchObject({ isWritable: true, isSigner: false });
    expect(ix!.keys[10]).toEqual({
        pubkey: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        isSigner: false,
        isWritable: true,
    });
    // The message account is a fresh signer the app swaps for a key of its own.
    expect(ix!.keys[11]).toEqual({ pubkey: "11111111111111111111111111111111", isSigner: true, isWritable: true });
    expect(ix!.keys.slice(12, 16).map((k) => k.pubkey)).toEqual([
        "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC",
        TOKEN_MESSENGER_MINTER,
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        "11111111111111111111111111111111",
    ]);
    expect(ix!.keys[17]!.pubkey).toBe(TOKEN_MESSENGER_MINTER);
});

test("status: no message is waiting; complete with forwardTxHash is filled; the tracker doesn't poll faster than its own schedule", async () => {
    const provider = cctp();
    const quote = { ref: "cctp-x" };
    const before = fake.requests().length;

    expect(await provider.status(quote, null, USDC)).toEqual({ stage: "waiting" });
    expect(fake.requests().length).toBe(before);

    expect(await provider.status(quote, SIGNATURE, USDC)).toEqual({ stage: "pending" });
    expect(fake.requests().at(-1)).toBe(`/v2/messages/5?transactionHash=${SIGNATURE}`);

    fake.setPending(SIGNATURE);
    expect(await provider.status(quote, SIGNATURE, USDC)).toEqual({ stage: "pending" });

    const mint = `0x${"cd".repeat(32)}`;
    fake.setForwarded(SIGNATURE, mint);
    expect(await provider.status(quote, SIGNATURE, USDC)).toEqual({ stage: "filled", fillTxHash: mint });

    // One request per call: the provider adds no polling of its own.
    expect(fake.requests().length).toBe(before + 3);
});

test("a burned message that never mints is logged at error with the signature and the order expires", async () => {
    const provider = cctp();
    const failed = base58.encode(new Uint8Array(64).fill(9));
    fake.setForwardFailed(failed);
    logger.error.mockClear();
    expect(await provider.status({ ref: "cctp-y" }, failed, USDC)).toEqual({ stage: "pending" });
    expect(await provider.status({ ref: "cctp-y" }, failed, USDC)).toEqual({ stage: "pending" });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith({ signature: failed }, expect.stringContaining("never minted"));
});

test("checkQuote lets a CCTP quote call only the CCTP program, whatever the allowlist says", async () => {
    const quote = await cctp().quote(REQUEST, signal);
    expect(checkQuote(quote, REQUEST, [])).toBe(true);
    const [tx] = quote.txs;
    if (tx?.kind !== "solana") throw new Error("not a Solana transaction");
    const foreign = { ...quote, txs: [{ ...tx, instructions: [{ ...tx.instructions[0]!, programId: WALLET }] }] };
    expect(checkQuote(foreign, REQUEST, [WALLET])).toBe(false);
});

test("checkQuote refuses a burn with another mintRecipient, domain or amount, or any other instruction", async () => {
    const quote = await cctp().quote(REQUEST, signal);
    const [tx] = quote.txs;
    if (tx?.kind !== "solana") throw new Error("not a Solana transaction");
    const [burn] = tx.instructions;
    const changed = (patch: (data: Buffer) => void) => {
        const data = Buffer.from(burn!.data.slice(2), "hex");
        patch(data);
        return { ...quote, txs: [{ ...tx, instructions: [{ ...burn!, data: `0x${data.toString("hex")}` as const }] }] };
    };

    expect(
        checkQuote(
            changed(() => undefined),
            REQUEST,
            [],
        ),
    ).toBe(true);
    expect(
        checkQuote(
            changed((d) => d.write("ff".repeat(20), 32, "hex")),
            REQUEST,
            [],
        ),
    ).toBe(false);
    expect(
        checkQuote(
            changed((d) => d.fill(0, 20, 52)),
            REQUEST,
            [],
        ),
    ).toBe(false);
    expect(
        checkQuote(
            changed((d) => d.writeUInt32LE(0, 16)),
            REQUEST,
            [],
        ),
    ).toBe(false);
    expect(
        checkQuote(
            changed((d) => d.writeBigUInt64LE(10_000_001n, 8)),
            REQUEST,
            [],
        ),
    ).toBe(false);
    expect(
        checkQuote(
            changed((d) => d.writeBigUInt64LE(9_999_999n, 8)),
            REQUEST,
            [],
        ),
    ).toBe(false);
    expect(
        checkQuote(
            changed((d) => d.fill(1, 0, 8)),
            REQUEST,
            [],
        ),
    ).toBe(false);
    const other = { ...quote, txs: [{ ...tx, instructions: [burn!, burn!] }] };
    expect(checkQuote(other, REQUEST, [])).toBe(false);
});

test("the quote states the SOL it needs: the message account's rent, held by Circle, plus the network fee", async () => {
    rentCalls.length = 0;
    const provider = cctp();
    const first = await provider.quote(REQUEST, signal);
    await provider.quote(REQUEST, signal);

    // 8-byte discriminator + 45 fields - 1 + a 148-byte message header + a 228-byte burn body + 32 bytes of hook data.
    expect(rentCalls).toEqual([460]);
    expect(first.sol).toEqual({ held: 588n * 6960n, needed: 588n * 6960n + 10_000n });
});
