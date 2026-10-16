import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import {
    getAddressDecoder,
    getCompiledTransactionMessageDecoder,
    getTransactionDecoder,
    decompileTransactionMessage,
    type Address,
    type Instruction,
} from "@solana/kit";
import { Server } from "socket.io";
import { AccountClient, NEEDS_SOL, type SolanaSigner } from "@/components/account-client";
import { isDepositOpen } from "@/lib/account/balances";
import { buildDepositTransaction, signWithFreshKeys, withFreshSigners } from "@/lib/account/solana-tx";
import type { BalancesView, CoinBalance, SolanaInstruction } from "@/server/src/protocol";

const key = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n)) as string;
const PAYER = key(1);
const PROGRAM = key(2);
const TABLE = key(3);
const TABLED = key(4);
const BLOCKHASH = { blockhash: key(9), lastValidBlockHeight: 1234 };
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const CCTP_PROGRAM = "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe";

const deposit: SolanaInstruction = {
    programId: PROGRAM,
    keys: [
        { pubkey: PAYER, isSigner: true, isWritable: true },
        { pubkey: TABLED, isSigner: false, isWritable: true },
    ],
    data: "0xdeadbeef",
};
const limit: SolanaInstruction = { programId: COMPUTE_BUDGET, keys: [], data: "0x02c0270900" };
const price: SolanaInstruction = { programId: COMPUTE_BUDGET, keys: [], data: "0x03e803000000000000" };

const build = (instructions: SolanaInstruction[]) =>
    buildDepositTransaction({
        payer: PAYER,
        blockhash: BLOCKHASH,
        instructions,
        lookupTables: [{ address: TABLE, addresses: [TABLED, key(5)] }],
    });

function decode(bytes: Uint8Array) {
    const transaction = getTransactionDecoder().decode(bytes);
    const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    const message = decompileTransactionMessage(compiled, {
        addressesByLookupTableAddress: { [TABLE as Address]: [TABLED as Address, key(5) as Address] },
    });
    const instructions = message.instructions as readonly Instruction[];
    const lookups = (compiled as { addressTableLookups?: { lookupTableAddress: string }[] }).addressTableLookups;
    return { compiled, message, instructions, lookups };
}

test.describe("the deposit transaction", () => {
    test("the built message's fee payer is the wallet and its lifetime is the given blockhash", () => {
        const { compiled, message } = decode(build([limit, deposit]));
        expect(compiled.version).toBe(0);
        expect(compiled.staticAccounts[0]).toBe(PAYER);
        expect(message.feePayer.address).toBe(PAYER);
        expect(compiled.lifetimeToken).toBe(BLOCKHASH.blockhash);
    });

    test("instructions come out in the given order, compressed against the given tables", () => {
        const { compiled, instructions, lookups } = decode(build([limit, deposit, price]));
        expect(instructions.map((i) => i.programAddress)).toEqual([COMPUTE_BUDGET, PROGRAM, COMPUTE_BUDGET]);
        expect(instructions[1]!.accounts?.map((a) => a.address)).toEqual([PAYER, TABLED]);
        expect(Array.from(instructions[1]!.data!)).toEqual([0xde, 0xad, 0xbe, 0xef]);
        expect(lookups?.map((t) => t.lookupTableAddress)).toEqual([TABLE]);
        expect(compiled.staticAccounts).not.toContain(TABLED);
    });

    test("a compute-unit-limit instruction is added only when the quote has none", () => {
        const limits = (instructions: SolanaInstruction[]) =>
            decode(build(instructions)).instructions.filter(
                (i) => i.programAddress === COMPUTE_BUDGET && i.data?.[0] === 2,
            );
        expect(limits([deposit])).toHaveLength(1);
        expect(limits([limit, deposit])).toHaveLength(1);
        // A price instruction alone is not a limit.
        expect(limits([price, deposit])).toHaveLength(1);
        expect(decode(build([price, deposit])).instructions).toHaveLength(3);
        expect(decode(build([limit, deposit])).instructions).toHaveLength(2);
    });
});

test.describe("one-off signers", () => {
    const placeholder = "11111111111111111111111111111111";
    const burn: SolanaInstruction = {
        programId: CCTP_PROGRAM,
        keys: [
            { pubkey: PAYER, isSigner: true, isWritable: false },
            { pubkey: placeholder, isSigner: true, isWritable: true },
            { pubkey: placeholder, isSigner: false, isWritable: false },
        ],
        data: "0x01",
    };

    test("the placeholder signer gets a new address; the payer and a non-signer placeholder are kept", async () => {
        const { instructions, keyPairs } = await withFreshSigners([burn]);
        const keys = instructions[0]!.keys;
        expect(keyPairs).toHaveLength(1);
        expect(keys[0]!.pubkey).toBe(PAYER);
        expect(keys[1]!.pubkey).not.toBe(placeholder);
        expect(keys[2]!.pubkey).toBe(placeholder);
    });

    test("the built transaction carries the one-off key's signature and leaves the wallet's empty", async () => {
        const { instructions, keyPairs } = await withFreshSigners([burn]);
        const bytes = await signWithFreshKeys(build(instructions), keyPairs);
        const transaction = getTransactionDecoder().decode(bytes);
        const fresh = instructions[0]!.keys[1]!.pubkey as Address;
        expect(transaction.signatures[PAYER as Address]).toBeNull();
        expect(transaction.signatures[fresh]).not.toBeNull();
    });

    test("a placeholder signer in another program's instruction is kept, never swapped for a new key", async () => {
        const relay = { ...burn, programId: PROGRAM };
        const { instructions, keyPairs } = await withFreshSigners([relay]);
        expect(keyPairs).toEqual([]);
        expect(instructions).toEqual([relay]);
    });

    test("without placeholders nothing changes", async () => {
        const { instructions, keyPairs } = await withFreshSigners([deposit]);
        expect(keyPairs).toEqual([]);
        expect(instructions).toEqual([deposit]);
    });
});

const SOL_ROW = (amount: string): CoinBalance => ({
    coin: "solana:SOL",
    chain: "solana",
    chainId: null,
    chainName: "Solana",
    symbol: "SOL",
    decimals: 9,
    wallet: PAYER,
    amount,
    spendable: amount,
    usd: Number(amount) * 150,
});

/** A socket.io server standing in for ours: it opens the account, serves one Solana order and records what it is told. */
async function fakeServer(rows: CoinBalance[], sol?: { needed: string; held: string }) {
    const http = createServer();
    const io = new Server(http);
    const events: { name: string; payload: unknown }[] = [];
    io.on("connection", (socket) => {
        socket.onAny((name, payload) => events.push({ name, payload }));
        socket.on("account:open", (_p, ack) =>
            ack({
                ok: true,
                data: {
                    account: { depositAddress: "0x00000000000000000000000000000000000000b2", balance: "0", version: 1 },
                    deposits: { items: [], next: null },
                    rules: { chainId: 5042, minDeposit: "0.01" },
                    orders: [],
                    withdrawals: [],
                    solana: { deposits: true, withdrawals: false },
                },
            }),
        );
        socket.on("deposit:quote", (_p, ack) =>
            ack({
                ok: true,
                data: {
                    coin: "solana:USDC",
                    amount: "5",
                    usdcOut: "4.98",
                    etaSeconds: 1200,
                    provider: "cctp",
                    ...(sol ? { sol } : {}),
                },
            }),
        );
        socket.on("deposit:order", (_p, ack) =>
            ack({
                ok: true,
                data: {
                    order: {
                        id: "a".repeat(24),
                        coin: "solana:SOL",
                        amount: "1",
                        wallet: PAYER,
                        usdcOut: "149000000000000000000",
                        etaSeconds: 5,
                        state: "created",
                        sourceTxHashes: [],
                        depositId: null,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                    },
                    txs: [
                        {
                            kind: "solana",
                            instructions: [deposit],
                            lookupTables: [{ address: TABLE, addresses: [TABLED, key(5)] }],
                        },
                    ],
                },
            }),
        );
        socket.on("solana:blockhash", (_p, ack) => ack({ ok: true, data: BLOCKHASH }));
        socket.on("deposit:source", ({ orderId }, ack) => ack({ ok: true, data: { id: orderId, state: "sent" } }));
        const view: BalancesView = { readAt: new Date().toISOString(), rows };
        socket.emit("balances", view);
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const client = new AccountClient(`http://127.0.0.1:${(http.address() as AddressInfo).port}`);
    client.connect("user", async () => "token");
    await expect.poll(() => client.getSnapshot().state.status).toBe("ready");
    await expect.poll(() => client.getSnapshot().balances !== null).toBe(true);
    return {
        client,
        events,
        stop: async () => {
            client.disconnect();
            await io.close();
        },
    };
}

const signer = (send: SolanaSigner | undefined) => send;
const wallet = (
    signAndSend: (bytes: Uint8Array) => Promise<string>,
    solBalance: bigint | null = BigInt(1_000_000_000),
) => ({
    address: PAYER,
    signer: signer({ address: PAYER, signAndSend }),
    solBalance,
});

test.describe("solanaDeposit", () => {
    test("a rejected wallet prompt is 'cancelled'", async () => {
        const stack = await fakeServer([SOL_ROW("2")]);
        try {
            const result = await stack.client.solanaDeposit(
                "solana:SOL",
                "1",
                wallet(async () => {
                    throw Object.assign(new Error("User rejected the request."), { code: 4001 });
                }),
            );
            expect(result).toBe("cancelled");
            expect(stack.events.some((e) => e.name === "deposit:source")).toBe(false);
        } finally {
            await stack.stop();
        }
    });

    test("a wallet with 0 SOL gets 'You need a little SOL to send from Solana.' and no order is opened", async () => {
        const stack = await fakeServer([SOL_ROW("0")]);
        try {
            let prompted = false;
            const result = await stack.client.solanaDeposit(
                "solana:USDC",
                "5",
                wallet(async () => {
                    prompted = true;
                    return "sig";
                }, BigInt(0)),
            );
            expect(result).toBe("needs_sol");
            expect(NEEDS_SOL).toBe("You need a little SOL to send from Solana.");
            expect(prompted).toBe(false);
            expect(stack.events.some((e) => e.name === "deposit:order")).toBe(false);
        } finally {
            await stack.stop();
        }
    });

    test("a wallet holding less SOL than the quote needs is told before any order opens", async () => {
        const stack = await fakeServer([SOL_ROW("0.001")], { needed: "4102480", held: "4092480" });
        try {
            let prompted = false;
            const send = async () => {
                prompted = true;
                return "sig";
            };
            const result = await stack.client.solanaDeposit("solana:USDC", "5", wallet(send, BigInt(4_102_479)));
            expect(result).toBe("needs_sol");
            expect(prompted).toBe(false);
            expect(stack.events.some((e) => e.name === "deposit:order")).toBe(false);

            const enough = await stack.client.solanaDeposit("solana:USDC", "5", wallet(send, BigInt(4_102_480)));
            expect(enough).toBe("sent");
            expect(prompted).toBe(true);
        } finally {
            await stack.stop();
        }
    });

    test("the signature is reported with deposit:source and the shown balance drops", async () => {
        const stack = await fakeServer([SOL_ROW("2")]);
        try {
            let signed: Uint8Array | undefined;
            const result = await stack.client.solanaDeposit(
                "solana:SOL",
                "1",
                wallet(async (bytes) => {
                    signed = bytes;
                    return "5".repeat(64);
                }),
            );
            expect(result).toBe("sent");
            // The blockhash was asked for after the order and before the prompt.
            const names = stack.events
                .map((e) => e.name)
                .filter((n) => n.startsWith("deposit:") || n === "solana:blockhash");
            expect(names).toEqual(["deposit:quote", "deposit:order", "solana:blockhash", "deposit:source"]);
            expect(stack.events.find((e) => e.name === "deposit:source")!.payload).toEqual({
                orderId: "a".repeat(24),
                txHashes: ["5".repeat(64)],
            });
            expect(decode(signed!).compiled.lifetimeToken).toBe(BLOCKHASH.blockhash);
            const row = stack.client.getSnapshot().balances!.rows.find((r) => r.coin === "solana:SOL")!;
            expect(row.amount).toBe("1");
        } finally {
            await stack.stop();
        }
    });
});

test("isOpen follows the session switch: Solana rows are open when deposits are on, and stay under 'Not open yet' when off", () => {
    const solana = SOL_ROW("1");
    const arc = { ...solana, coin: "arc:USDC", chain: "arc" as const };
    expect(isDepositOpen(solana, true)).toBe(true);
    expect(isDepositOpen(solana, false)).toBe(false);
    expect(isDepositOpen(arc, false)).toBe(true);
});
