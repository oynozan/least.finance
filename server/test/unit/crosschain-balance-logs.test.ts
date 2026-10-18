import { pino } from "pino";
import type { PublicClient } from "viem";
import { expect, test } from "vitest";
import { readBalances } from "../../src/crosschain/balances.ts";
import type { SourceClients } from "../../src/crosschain/chains.ts";

const lines: Record<string, any>[] = [];
const logger = pino({ level: "info" }, { write: (chunk: string) => void lines.push(JSON.parse(chunk)) });

const dead = {
    getBalance: () => Promise.reject(new Error("fetch failed")),
    readContract: () => Promise.reject(new Error("fetch failed")),
} as unknown as PublicClient;

test("a dead RPC leaves null balances and one warning per chain naming the chain", async () => {
    const sources = { ethereum: dead, bnb: dead } as unknown as SourceClients;
    const prices = { usd: () => Promise.reject(new Error("LI.FI down")) };
    const owner = "0x1111111111111111111111111111111111111111" as const;

    const rows = await readBalances({ sources, arc: dead, prices, logger }, owner);
    await readBalances({ sources, arc: dead, prices, logger }, owner);

    expect(rows.every((row) => row.amount === null)).toBe(true);
    expect(rows.find((row) => row.chain === "ethereum")?.readError).toBe(
        "Ethereum didn't answer, so this balance isn't shown.",
    );
    const chains = lines.filter((line) => line.event === "balances.read").map((line) => line.chain);
    expect(chains.sort()).toEqual(["arc", "bnb", "ethereum"]);
    expect(lines.find((line) => line.event === "balances.read")).toMatchObject({
        level: 40,
        err: { message: "fetch failed" },
    });
    expect(lines.filter((line) => line.event === "balances.prices")).toHaveLength(1);
});
