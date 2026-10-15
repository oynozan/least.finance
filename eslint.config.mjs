import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
    ...nextVitals,
    ...nextTs,
    // Override default ignores of eslint-config-next.
    globalIgnores([
        // Default ignores of eslint-config-next:
        ".next/**",
        "out/**",
        "build/**",
        "next-env.d.ts",
        // Playwright output.
        "playwright-report/**",
        "test-results/**",
        // Other branches' worktrees and local agent tooling, both gitignored.
        ".worktrees/**",
        ".superpowers/**",
    ]),
    {
        // pm2 reads its ecosystem file as CommonJS.
        files: ["**/*.cjs"],
        rules: { "@typescript-eslint/no-require-imports": "off" },
    },
    {
        // Server tests read loosely typed JSON responses all over.
        files: ["server/test/**/*.ts"],
        rules: { "@typescript-eslint/no-explicit-any": "off" },
    },
]);

export default eslintConfig;
