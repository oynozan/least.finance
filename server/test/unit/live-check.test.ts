import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

test("the live check refuses to run without --yes-spend-real-money", () => {
    const run = spawnSync(process.execPath, ["scripts/polymarket-live-check.ts"], { encoding: "utf8", env: {} });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("--yes-spend-real-money");
});
