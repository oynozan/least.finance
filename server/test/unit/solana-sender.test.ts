import { base64 } from "@scure/base";
import { describe, expect, test, vi } from "vitest";
import { createKeyring } from "../../src/accounts/keyring.ts";
import { refused } from "../../src/trading/send-errors.ts";
import { SolanaRefusal, createSolanaSender, jsonRpcSend } from "../../src/trading/solana-sender.ts";
import { solanaFeePayer } from "../../src/swaps/solana-tx.ts";

const keyring = createKeyring("test test test test test test test test test test test junk");
const inventory = keyring.inventorySolana();
const RECIPIENT = "11111111111111111111111111111112";

const rpc = (status: unknown = null) => ({
    getLatestBlockhash: async () => ({
        blockhash: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
        lastValidBlockHeight: 100,
    }),
    getSignatureStatuses: async () => [status as never],
});

describe("Solana sender", () => {
    test("signs a transfer from the inventory wallet and hands out its signature before sending", async () => {
        const sent: string[] = [];
        const sender = createSolanaSender({
            seed: inventory.seed,
            rpc: rpc(),
            send: async (wire) => void sent.push(wire),
        });
        const prepared = await sender.prepare(RECIPIENT, 1_500_000_000n);
        expect(sent).toHaveLength(0);
        await prepared.broadcast();
        expect(sent).toHaveLength(1);

        const bytes = base64.decode(sent[0]!);
        expect(solanaFeePayer(sent[0]!)).toBe(inventory.address);
        // One signature of 64 bytes leads the wire transaction
        expect(bytes[0]).toBe(1);
        // The transfer's data: instruction 2 then the lamports, little-endian
        const lamports = Buffer.from(
            new Uint8Array(12).map((_, at) =>
                at === 0 ? 2 : at >= 4 ? Number((1_500_000_000n >> BigInt((at - 4) * 8)) & 0xffn) : 0,
            ),
        );
        expect(Buffer.from(bytes).includes(lamports)).toBe(true);
        expect(prepared.signature.length).toBeGreaterThan(80);
    });

    test("reads the signature's status", async () => {
        const make = (status: unknown) =>
            createSolanaSender({ seed: inventory.seed, rpc: rpc(status), send: async () => {} });
        expect(await make(null).status("s")).toBeNull();
        expect(await make({ confirmationStatus: "processed", err: null }).status("s")).toBeNull();
        expect(await make({ confirmationStatus: "confirmed", err: null }).status("s")).toBe("confirmed");
        expect(await make({ confirmationStatus: "finalized", err: null }).status("s")).toBe("confirmed");
        expect(
            await make({ confirmationStatus: "confirmed", err: { InstructionError: [0, "Custom"] } }).status("s"),
        ).toEqual({ state: "failed", err: { InstructionError: [0, "Custom"] } });
    });

    test("a preflight rejection is a refusal and an unreachable node is not", async () => {
        const rejecting = jsonRpcSend(
            ["http://x"],
            async () => new Response(JSON.stringify({ error: { message: "Transaction simulation failed" } })),
        );
        const error = await rejecting("wire").catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(SolanaRefusal);
        expect(refused(error)).toBe(true);

        const down = jsonRpcSend(["http://x"], async () => {
            throw new TypeError("fetch failed");
        });
        const unreachable = await down("wire").catch((caught: unknown) => caught);
        expect(refused(unreachable)).toBe(false);
    });

    test("a refusal keeps the cluster's code and error, and a total failure names each provider by number, never its URL", async () => {
        const rejecting = jsonRpcSend(
            ["http://x"],
            async () =>
                new Response(
                    JSON.stringify({
                        error: {
                            message: "Transaction simulation failed",
                            code: -32002,
                            data: { err: "InsufficientFundsForRent" },
                        },
                    }),
                ),
        );
        expect(await rejecting("wire").catch((caught: unknown) => caught)).toMatchObject({
            code: -32002,
            data: { err: "InsufficientFundsForRent" },
        });

        const warn = vi.fn();
        const answers = [new Response("busy", { status: 429 }), undefined];
        const down = jsonRpcSend(
            ["http://one.test/key-SECRET", "http://two.test/key-SECRET"],
            async () => {
                const next = answers.shift();
                if (next) return next;
                throw new DOMException("The operation timed out", "TimeoutError");
            },
            { warn },
        );
        const error = (await down("wire").catch((caught: unknown) => caught)) as Error;
        expect(error.message).toBe("RPC #1: HTTP 429; RPC #2: timed out");
        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn.mock.calls[0]?.[0]).toMatchObject({ provider: 1, providers: 2 });
        expect(warn.mock.calls[0]?.[1]).toBe("Solana RPC #1 didn't take the transaction: HTTP 429");
        expect(JSON.stringify(warn.mock.calls.map((call) => call[1]))).not.toContain("SECRET");
    });
});
