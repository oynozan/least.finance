import { defineConfig, devices } from "@playwright/test";
import { MOCK_APP_ID } from "./e2e/privy-mock";

// Overridable so a run can stay clear of another one on the same machine.
const PORT = Number(process.env.E2E_PORT ?? 3100);
const API_PORT = Number(process.env.E2E_API_PORT ?? 4100);
const CONTROL_PORT = Number(process.env.E2E_CONTROL_PORT ?? 4101);

// Logic tests exercise lib/ directly: no browser, no server.
const LOGIC = /\.logic\.spec\.ts$/;
const logicOnly = !!process.env.LOGIC_ONLY;

export default defineConfig({
    testDir: "./e2e",
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    reporter: [["list"], ["html", { open: "never" }]],
    use: {
        baseURL: `http://localhost:${PORT}`,
        trace: "retain-on-failure",
        // Runs on the installed Google Chrome, or on the Chromium binary at
        // PLAYWRIGHT_CHROMIUM_PATH when set (e.g. in CI containers).
        ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
            ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } }
            : { channel: "chrome" }),
    },
    projects: [
        { name: "logic", testMatch: LOGIC },
        {
            name: "desktop",
            testIgnore: LOGIC,
            use: { ...devices["Desktop Chrome"], viewport: { width: 1388, height: 736 } },
        },
        { name: "mobile", testIgnore: LOGIC, use: { ...devices["Pixel 7"] } },
    ],
    webServer: logicOnly
        ? undefined
        : [
              {
                  // The real deposit server, on a local chain and a fake Privy (server/test/e2e/serve.ts).
                  command: "node server/test/e2e/serve.ts",
                  url: `http://127.0.0.1:${CONTROL_PORT}/health`,
                  reuseExistingServer: !process.env.CI,
                  timeout: 120_000,
                  env: {
                      E2E_API_PORT: String(API_PORT),
                      E2E_CONTROL_PORT: String(CONTROL_PORT),
                      E2E_WEB_ORIGINS: `http://localhost:${PORT}`,
                      E2E_PRIVY_APP_ID: MOCK_APP_ID,
                  },
              },
              {
                  command: `npm run build && npm run start -- --port ${PORT}`,
                  url: `http://localhost:${PORT}`,
                  reuseExistingServer: !process.env.CI,
                  timeout: 180_000,
                  // Privy's backend is mocked in the tests (e2e/privy-mock.ts), so the
                  // build uses a placeholder app ID rather than a real one.
                  env: { NEXT_PUBLIC_PRIVY_APP_ID: MOCK_APP_ID, NEXT_PUBLIC_API_URL: `http://localhost:${API_PORT}` },
              },
          ],
});
