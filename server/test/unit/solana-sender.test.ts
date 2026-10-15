import { base64 } from "@scure/base";
import { describe, expect, test } from "vitest";
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
        ).toBe("failed");
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
});
