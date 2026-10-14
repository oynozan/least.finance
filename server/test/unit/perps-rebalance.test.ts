import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import { requireTestnet } from "../../scripts/live-check-guards.ts";
import { buildHookData, markArrived, maxFeeOf, planRebalance, recordIfMined } from "../../scripts/perps-rebalance.ts";

test("planRebalance refuses to leave the treasury below the withdrawal need", () => {
    const base = { direction: "arc-to-hl" as const, amountE6: 100_000_000n };
    expect(planRebalance({ ...base, treasuryFreeE6: 500_000_000n, withdrawalNeedE6: 400_000_000n })).toEqual({
        ok: true,
    });
    expect(planRebalance({ ...base, treasuryFreeE6: 500_000_000n, withdrawalNeedE6: 400_000_001n })).toMatchObject({
        ok: false,
    });
    expect(planRebalance({ ...base, amountE6: 0n, treasuryFreeE6: 500_000_000n, withdrawalNeedE6: 0n })).toMatchObject({
        ok: false,
    });
    // Money coming back to Arc never leaves the treasury short
    expect(
        planRebalance({ direction: "hl-to-arc", amountE6: 100_000_000n, treasuryFreeE6: 0n, withdrawalNeedE6: 5n }),
    ).toEqual({ ok: true });
});

test("buildHookData names the master address", () => {
    const master = "0x00000000000000000000000000000000000a11ce";
    const data = buildHookData(master);
    // 24 bytes of "cctp-forward", 4 of version, 4 of length, 20 of address, 4 of dex
    expect(data).toHaveLength(2 + 2 * 56);
    expect(
        Buffer.from(data.slice(2, 2 + 48), "hex")
            .toString()
            .replace(/\0+$/, ""),
    ).toBe("cctp-forward");
    expect(data.slice(2 + 2 * 24, 2 + 2 * 28)).toBe("00000000");
    expect(data.slice(2 + 2 * 28, 2 + 2 * 32)).toBe("00000018");
    expect(data.slice(2 + 2 * 32, 2 + 2 * 52)).toBe(master.slice(2));
    expect(data.slice(2 + 2 * 52)).toBe("00000000");
});

test("the script refuses a mainnet URL for perps-check", () => {
    expect(() => requireTestnet("https://api.hyperliquid.xyz")).toThrow(/testnet/i);
    expect(() => requireTestnet("https://api.hyperliquid-testnet.xyz")).not.toThrow();
    const run = spawnSync(process.execPath, ["scripts/perps-check.ts"], {
        encoding: "utf8",
        env: { HYPERLIQUID_API_URL: "https://api.hyperliquid.xyz" },
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/testnet/i);
});

test("a reverted burn is not recorded as in flight", async () => {
    const rows: string[] = [];
    const record = async () => void rows.push("sent");
    expect(await recordIfMined("reverted", record)).toBe(false);
    expect(rows).toEqual([]);
    expect(await recordIfMined("success", record)).toBe(true);
    expect(rows).toEqual(["sent"]);
});

test("arrived marks a sent rebalance and only a sent one", async () => {
    const updates: unknown[] = [];
    const collection = {
        updateOne: async (filter: unknown, update: unknown) => {
            updates.push({ filter, update });
            return { modifiedCount: 1 };
        },
    };
    const id = "65f000000000000000000001";
    expect(await markArrived(collection as never, id)).toBe(true);
    expect(JSON.stringify(updates[0])).toContain('"state":"sent"');
    expect(JSON.stringify(updates[0])).toContain('"$set":{"state":"arrived"}');
    await expect(markArrived(collection as never, "nope")).rejects.toThrow(/id/i);
});

test("maxFeeOf reads whole numbers as units and fractions as dollars through feeUnits", () => {
    const row = (high: number | string, minimumFee?: number) => ({ forwardFee: { high }, minimumFee });
    // The protocol part is the basis points of the amount plus one unit
    expect(maxFeeOf(10_000_000n, row(150_000))).toBe(150_001n);
    expect(maxFeeOf(10_000_000n, row(0.15))).toBe(150_001n);
    expect(maxFeeOf(10_000_000n, row("0.15"))).toBe(150_001n);
    expect(maxFeeOf(10_000_000n, row(150_000, 1))).toBe(151_001n);
    // A fraction with float noise in its product is not pushed up a unit
    expect(maxFeeOf(10_000_000n, row(0.015626))).toBe(15_627n);
    expect(() => maxFeeOf(10_000_000n, {})).toThrow(/no forwarding fee/);
    expect(() => maxFeeOf(10_000_000n, row("abc"))).toThrow();
});
