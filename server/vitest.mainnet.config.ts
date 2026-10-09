import { defineConfig } from "vitest/config";

/** Runs against Arc Mainnet itself: real RPCs, real transactions. */
export default defineConfig({
    test: {
        environment: "node",
        include: ["test/mainnet/**/*.test.ts"],
        globalSetup: ["test/support/global-setup.ts"],
        testTimeout: 120_000,
        hookTimeout: 120_000,
        fileParallelism: false,
    },
});
