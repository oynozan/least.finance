import { MongoClient, ObjectId, type Collection } from "mongodb";
import { pino } from "pino";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from "vitest";
import type { Collections } from "../../src/db/mongo.ts";
import { CoinSender, type SolanaSender } from "../../src/trading/coin-sender.ts";
import type { CoinWithdrawalDoc, HoldingDoc } from "../../src/trading/docs.ts";
import { toUnitsDecimal } from "../../src/trading/units.ts";
import { coinWithdrawalView } from "../../src/trading/views.ts";
import { SolanaRefusal } from "../../src/trading/solana-sender.ts";
import { fakeInventoryChain, type FakeInventoryChain } from "../support/fake-inventory-chain.ts";

type Line = Record<string, any> & { level: number; msg: string };

let client: MongoClient;
let withdrawals: Collection<CoinWithdrawalDoc>;
let holdings: Collection<HoldingDoc>;
let chain: FakeInventoryChain;
let clock: number;
const lines: Line[] = [];
const logger = pino({ level: "info" }, { write: (chunk: string) => void lines.push(JSON.parse(chunk)) });
const accountId = new ObjectId();
const WALLET = privateKeyToAddress(generatePrivateKey());
const WARN = 40;
const ERROR = 50;

beforeAll(async () => {
    client = await new MongoClient(inject("mongoUri")).connect();
    const db = client.db(`coin-sender-failures-${Date.now()}`);
    withdrawals = db.collection("coin_withdrawals");
    holdings = db.collection("holdings");
});
afterAll(() => client?.close());
beforeEach(async () => {
    await Promise.all([withdrawals.deleteMany({}), holdings.deleteMany({})]);
    chain = fakeInventoryChain();
    clock = 1_800_000_000_000;
    lines.length = 0;
});

const sender = (extra: Partial<ConstructorParameters<typeof CoinSender>[0]> = {}) =>
    new CoinSender({
        client,
        collections: { coinWithdrawals: withdrawals, holdings } as Pick<Collections, "coinWithdrawals" | "holdings">,
        chain,
        logger,
        now: () => clock,
        ...extra,
    });

async function queue(symbol: string, units: string, network: string, to: string = WALLET) {
    const doc: CoinWithdrawalDoc = {
        _id: new ObjectId(),
        accountId,
        requestId: new ObjectId().toString(),
        symbol,
        units: toUnitsDecimal(BigInt(Math.round(Number(units) * 1e6)) * 10n ** 12n),
        network,
        to,
        state: "sending",
        txHash: null,
        nonce: null,
        reason: null,
        createdAt: new Date(clock),
        updatedAt: new Date(clock),
    };
    await withdrawals.insertOne(doc);
    return doc;
}

const reload = async (doc: CoinWithdrawalDoc) => (await withdrawals.findOne({ _id: doc._id }))!;

describe("a failed coin send keeps its reason", () => {
    test("a refusal stores a code, the network's words and a sentence, and the view and the log carry them", async () => {
        const doc = await queue("ETH", "0.5", "ethereum");
        chain.failNext("prepare", new Error("insufficient funds for gas * price + value"));

        await sender().tick();

        const failed = await reload(doc);
        expect(failed).toMatchObject({
            state: "failed",
            reason: "out_of_gas",
            detail: "insufficient funds for gas * price + value",
            message:
                "Our sending wallet is out of gas on Ethereum, so the send was refused. Your ETH is back in your holdings.",
        });
        expect(coinWithdrawalView(failed)).toMatchObject({ reason: "out_of_gas", message: failed.message });
        const failures = lines.filter((line) => line.event === "coin-send:failed");
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({
            level: ERROR,
            withdrawal: doc._id.toHexString(),
            account: accountId.toHexString(),
            symbol: "ETH",
            units: "0.5",
            network: "ethereum",
            to: WALLET,
            nonce: 0,
            reason: "out_of_gas",
            matched: "insufficient funds",
            upstream: "insufficient funds for gas * price + value",
            refunded: true,
        });
        expect(failures[0]!.err.message).toBe("insufficient funds for gas * price + value");
    });

    test("an unknown refusal keeps the network's words quoted, and a viem error gives its details, not its summary", async () => {
        const doc = await queue("ETH", "0.5", "ethereum");
        const viemLike = Object.assign(
            new Error('The contract function "transfer" reverted.\n\nURL: https://rpc.test/key-SECRET'),
            {
                shortMessage: "Execution reverted with reason: ERC20: transfer amount exceeds balance.",
                details: "execution reverted: ERC20: transfer amount exceeds balance",
            },
        );
        chain.failNext("prepare", viemLike);

        await sender().tick();

        const failed = await reload(doc);
        expect(failed.reason).toBe("inventory_short");
        expect(failed.message).toBe(
            "Our sending wallet doesn't hold enough ETH on Ethereum right now. Your ETH is back in your holdings.",
        );
        expect(failed.detail).toBe(
            "Execution reverted with reason: ERC20: transfer amount exceeds balance.: execution reverted: ERC20: transfer amount exceeds balance",
        );
        expect(JSON.stringify(failed)).not.toContain("SECRET");
        // Our own wallet being short is ours to fix
        expect(lines.find((line) => line.event === "coin-send:failed")).toMatchObject({ level: ERROR });
    });

    test("a refusal with words we don't know shows them quoted", async () => {
        const doc = await queue("ETH", "0.5", "ethereum");
        chain.failNext("prepare", new Error("replacement transaction underpriced: need 12 gwei"));

        await sender().tick();

        expect(await reload(doc)).toMatchObject({
            reason: "fee_too_low",
            message:
                'Ethereum refused the send\'s fee: "replacement transaction underpriced: need 12 gwei". Your ETH is back in your holdings.',
        });
    });

    test("a reverted transfer says where and which transaction", async () => {
        const doc = await queue("ETH", "0.5", "ethereum");
        await sender().tick();
        chain.mineAll("reverted");

        await sender().tick();

        const failed = await reload(doc);
        expect(failed.reason).toBe("reverted");
        expect(failed.message).toBe(
            `The transfer reverted on Ethereum (tx ${chain.prepared[0]!.tx.hash}). Your ETH is back in your holdings.`,
        );
    });

    test("a Solana send the cluster failed keeps its error, and one the preflight refused keeps its code", async () => {
        let status: Awaited<ReturnType<SolanaSender["status"]>> = null;
        const solana: SolanaSender = {
            prepare: async () => ({ signature: "sig-1", broadcast: async () => {} }),
            status: async () => status,
        };
        const failing = await queue("SOL", "1.5", "solana", "11111111111111111111111111111112");
        await sender({ solana }).tick();
        status = { state: "failed", err: { InstructionError: [0, { Custom: 1 }] } };

        await sender({ solana }).tick();

        const failed = await reload(failing);
        expect(failed.reason).toBe("solana_failed");
        expect(failed.message).toBe(
            'The transfer failed on Solana: {"InstructionError":[0,{"Custom":1}]} (tx sig-1). Your SOL is back in your holdings.',
        );

        const refusing = await queue("SOL", "2", "solana", "11111111111111111111111111111112");
        const refused: SolanaSender = {
            prepare: async () => ({
                signature: "sig-2",
                broadcast: async () => {
                    throw new SolanaRefusal("Transaction simulation failed", {
                        code: -32002,
                        data: { err: "InsufficientFundsForRent" },
                    });
                },
            }),
            status: async () => null,
        };
        await sender({ solana: refused }).tick();
        const second = await reload(refusing);
        expect(second).toMatchObject({
            reason: "rent",
            detail: 'Transaction simulation failed (code -32002, "InsufficientFundsForRent")',
        });
    });

    test("a coin we can't send is an error in the log, and the person gets it back", async () => {
        const doc = await queue("SOL", "1", "solana", "11111111111111111111111111111112");

        await sender({ solana: undefined }).tick();

        expect(await reload(doc)).toMatchObject({
            reason: "unsupported",
            message: "SOL can't be sent right now. Your SOL is back in your holdings.",
        });
        expect(lines.find((line) => line.event === "coin-send:failed")).toMatchObject({ level: ERROR });
    });
});

describe("a send that can't go yet", () => {
    test("stays sending, is logged once however many passes meet it, and shows the last error", async () => {
        const doc = await queue("ETH", "0.5", "ethereum");
        const worker = sender();
        for (let pass = 0; pass < 3; pass += 1) {
            chain.failNext("prepare", new Error("fetch failed: ECONNREFUSED"));
            await worker.tick();
        }

        const waiting = await reload(doc);
        expect(waiting).toMatchObject({
            state: "sending",
            detail: "fetch failed: ECONNREFUSED",
            message: "Still trying: fetch failed: ECONNREFUSED",
        });
        expect(coinWithdrawalView(waiting).message).toBe("Still trying: fetch failed: ECONNREFUSED");
        const retries = lines.filter((line) => line.event === "coin-send:retry");
        expect(retries).toHaveLength(1);
        expect(retries[0]).toMatchObject({
            level: WARN,
            withdrawal: doc._id.toHexString(),
            account: accountId.toHexString(),
            symbol: "ETH",
            network: "ethereum",
            nonce: 0,
            attempts: 0,
        });

        // It is logged again once the interval has passed, and as an error once it has been sending for long
        clock += 11 * 60_000;
        chain.failNext("prepare", new Error("fetch failed: ECONNREFUSED"));
        await worker.tick();
        const again = lines.filter((line) => line.event === "coin-send:retry");
        expect(again).toHaveLength(2);
        expect(again[1]).toMatchObject({ level: ERROR, repeatsLeftOut: 2 });

        // A send that goes through clears the message
        await worker.tick();
        chain.mineAll("success");
        await worker.tick();
        expect(await reload(doc)).toMatchObject({ state: "sent", detail: null, message: null });
    });

    test("a send that recovers drops the stale 'Still trying' reason", async () => {
        const doc = await queue("ETH", "0.5", "ethereum");
        const worker = sender();
        chain.failNext("prepare", new Error("fetch failed: ECONNREFUSED"));
        await worker.tick();
        expect(await reload(doc)).toMatchObject({ message: "Still trying: fetch failed: ECONNREFUSED" });

        clock += 5_000;
        await worker.tick();
        const recovered = await reload(doc);
        expect(recovered.state).toBe("sending");
        expect(recovered.txHash).not.toBeNull();
        expect(recovered.message).toBeNull();
        expect(recovered.detail).toBeNull();
        expect(coinWithdrawalView(recovered).message).toBeNull();
    });

    test("a send that never mines says so after its last resend, and is logged again every while", async () => {
        const doc = await queue("ETH", "0.5", "ethereum");
        const worker = sender({ resendAfterMs: 1_000 });
        for (let pass = 0; pass < 10; pass += 1) {
            await worker.tick();
            clock += 2_000;
        }
        const last = await reload(doc);
        expect(last.state).toBe("sending");
        expect(last.attempts).toHaveLength(10);
        expect(last.message ?? null).toBeNull();

        // Later passes have nothing left to send, so they say what is going on instead of staying silent
        await worker.tick();
        const waiting = await reload(doc);
        const ref = doc._id.toHexString().slice(-6);
        expect(waiting.message).toBe(
            `Still waiting for the network (tx ${last.txHash}). Contact support with ref ${ref}.`,
        );
        expect(coinWithdrawalView(waiting).message).toBe(waiting.message);
        const reminders = lines.filter((line) => line.event === "coin-send:unmined");
        expect(reminders).toHaveLength(1);
        expect(reminders[0]).toMatchObject({
            level: ERROR,
            withdrawal: doc._id.toHexString(),
            attempts: 10,
            hashes: expect.any(Array),
        });
        expect(reminders[0]!.ageMs).toBeGreaterThan(0);

        await worker.tick();
        await worker.tick();
        expect(lines.filter((line) => line.event === "coin-send:unmined")).toHaveLength(1);
        clock += 11 * 60_000;
        await worker.tick();
        expect(lines.filter((line) => line.event === "coin-send:unmined")).toHaveLength(2);
        expect(lines.filter((line) => line.event === "coin-send:unmined").at(-1)).toMatchObject({ repeatsLeftOut: 2 });
    });

    test("an error text that only carries a refusal word in its URL is not a refusal", async () => {
        const doc = await queue("ETH", "0.5", "ethereum");
        chain.failNext(
            "prepare",
            Object.assign(new Error("HTTP request failed.\n\nURL: https://rpc.test/insufficient-funds-gas-too-low"), {
                shortMessage: "HTTP request failed.",
            }),
        );

        await sender().tick();

        expect(await reload(doc)).toMatchObject({ state: "sending" });
    });
});
