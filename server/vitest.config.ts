import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        include: ["test/unit/**/*.test.ts", "test/integration/**/*.test.ts"],
        globalSetup: ["test/support/global-setup.ts"],
        testTimeout: 30_000,
        hookTimeout: 60_000,
    },
});
