import { defineConfig, devices } from "@playwright/test";
import { MOCK_APP_ID } from "./e2e/privy-mock";

const PORT = 3100;

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
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1388, height: 736 } },
    },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `npm run build && npm run start -- --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    // Privy's backend is mocked in the tests (e2e/privy-mock.ts), so the
    // build uses a placeholder app ID rather than a real one.
    env: { NEXT_PUBLIC_PRIVY_APP_ID: MOCK_APP_ID },
  },
});
