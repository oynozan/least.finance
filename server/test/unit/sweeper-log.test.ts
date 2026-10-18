import { pino } from "pino";
import { expect, test } from "vitest";
import { Sweeper } from "../../src/withdrawals/sweeper.ts";

function sweeperWith(client: object) {
    const lines: Record<string, unknown>[] = [];
    const logger = pino({ level: "info" }, { write: (line: string) => void lines.push(JSON.parse(line)) });
    const sweeper = new Sweeper({
        client: client as never,
        keyring: {
            signerAt: (index: number) => ({ address: `0x${index}` }),
            operator: () => ({ address: "0xT" }),
        } as never,
        collections: { counters: { findOne: async () => ({ seq: 3 }) } } as never,
        bus: { on() {}, off() {} } as never,
        logger,
    });
    return { sweeper, lines };
}

test("a pass where every sweep fails writes one summary line, not one per address", async () => {
    const down = new Error("fetch failed");
    const { sweeper, lines } = sweeperWith({
        getBalance: async () => {
            throw down;
        },
        getGasPrice: async () => 1n,
    });

    await sweeper.sweepAll();

    const failures = lines.filter((line) => line.event === "sweep.failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
        level: 40,
        msg: "3 of 3 deposit sweeps failed",
        failed: 3,
        total: 3,
        depositIndexes: [1, 2, 3],
    });
    expect(failures[0]!.err).toMatchObject({ message: "fetch failed" });
});

test("a pass where nothing fails writes nothing", async () => {
    const { sweeper, lines } = sweeperWith({ getBalance: async () => 0n, getGasPrice: async () => 1n });
    await sweeper.sweepAll();
    expect(lines).toEqual([]);
});
