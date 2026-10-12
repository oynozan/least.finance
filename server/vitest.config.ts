import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        include: ["test/unit/**/*.test.ts", "test/integration/**/*.test.ts"],
        globalSetup: ["test/support/global-setup.ts"],
        testTimeout: 30_000,
        hookTimeout: 60_000,
        // Every file shares one Mongo and one chain, so a loaded run can take well over the 1 s default
        expect: { poll: { timeout: 10_000 } },
    },
});
