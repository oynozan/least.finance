import { describe, expect, test } from "vitest";
import { createSolanaSignatureStatus } from "../../src/swaps/solana-status.ts";

const answer = (body: unknown, ok = true) =>
    (async () => ({ ok, status: ok ? 200 : 500, json: async () => body })) as never;

describe("Solana signature status", () => {
    test("asks with history search and reads the error", async () => {
        const bodies: unknown[] = [];
        const send = (async (_url: string, init: { body: string }) => {
            bodies.push(JSON.parse(init.body));
            return {
                ok: true,
                status: 200,
                json: async () => ({ result: { value: [{ err: { InstructionError: [0, "x"] } }] } }),
            };
        }) as never;
        expect(await createSolanaSignatureStatus(["http://a"], { fetch: send })("sig")).toEqual({ failed: true });
        expect(bodies[0]).toMatchObject({
            method: "getSignatureStatuses",
            params: [["sig"], { searchTransactionHistory: true }],
        });
    });

    test("a landed signature without an error has not failed, an unknown one has no verdict", async () => {
        expect(
            await createSolanaSignatureStatus(["http://a"], { fetch: answer({ result: { value: [{ err: null }] } }) })(
                "s",
            ),
        ).toEqual({ failed: false });
        expect(
            await createSolanaSignatureStatus(["http://a"], { fetch: answer({ result: { value: [null] } }) })("s"),
        ).toBeNull();
    });

    test("falls through to the next RPC and throws when none answers", async () => {
        const send = (async (url: string) => {
            if (url === "http://bad") return { ok: false, status: 500, json: async () => ({}) };
            return { ok: true, status: 200, json: async () => ({ result: { value: [{ err: null }] } }) };
        }) as never;
        expect(await createSolanaSignatureStatus(["http://bad", "http://good"], { fetch: send })("s")).toEqual({
            failed: false,
        });
        await expect(createSolanaSignatureStatus(["http://bad"], { fetch: send })("s")).rejects.toThrow();
    });
});
