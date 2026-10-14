import { expect, test, type Page } from "@playwright/test";
import { failNextBurn, forwardWithdrawal, fundTreasury, randomSolanaAddress, seedDeposits } from "./backend";
import { installSolanaWallet, mockPrivy, pickWallet } from "./privy-mock";

// The treasury is shared by the whole backend, so these run one at a time and only on desktop.
test.describe.configure({ mode: "serial" });
test.skip(({ isMobile }) => isMobile, "shares the treasury with the desktop run");

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Wallet" });
const balanceButton = (page: Page) => sidebar(page).getByRole("button", { name: /^Balance/ });
const withdrawButton = (page: Page) => sidebar(page).getByRole("button", { name: "Withdraw", exact: true });
const amountField = (page: Page) => sidebar(page).getByRole("textbox", { name: "Withdraw amount" });
const history = (page: Page) => sidebar(page).getByRole("list", { name: "History" });
const status = (page: Page) => sidebar(page).getByRole("status");
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const FEE_LINE = "Fee 0.29 USDC · you receive 49.71 USDC";

test.beforeEach(async () => {
    test.setTimeout(90_000);
    await fundTreasury("100000");
});

/** Signs in with a fresh Phantom wallet and no EVM wallet, whose account holds 200 USDC. */
async function signIn(page: Page) {
    const address = randomSolanaAddress();
    pickWallet(page, address);
    await installSolanaWallet(page, address);
    await mockPrivy(page);
    await seedDeposits(address, [{ amount: "200", daysAgo: 1 }]);
    await page.goto("/");
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await page.locator("#privy-modal-content").getByRole("button", { name: "Phantom" }).click();
    await expect(sidebar(page)).toHaveAttribute("data-open", "true", { timeout: 10_000 });
    await expect(balanceButton(page)).toHaveAccessibleName("Balance $200.00, show deposits", { timeout: 20_000 });
    return address;
}

async function openAndFill(page: Page, amount: string) {
    await withdrawButton(page).click();
    await amountField(page).fill(amount);
}

async function showHistory(page: Page) {
    await balanceButton(page).hover();
    await expect(history(page)).toBeVisible();
}

test("a Solana-only person withdraws with no EVM wallet", async ({ page }) => {
    await signIn(page);
    await openAndFill(page, "50");
    await expect(sidebar(page).getByRole("button", { name: "Connect an EVM wallet" })).toHaveCount(0);
    await expect(sidebar(page).locator("#withdraw-quote")).toContainText(FEE_LINE, { timeout: 15_000 });
    await withdrawButton(page).click();
    await expect(balanceButton(page)).toHaveAccessibleName("Balance $150.00, show deposits");
    await expect(amountField(page)).toHaveCount(0);
});

test("the balance drops at once and the row goes Sending, Sending to Solana, Sent", async ({ page }) => {
    // Holds the server's pushes so each step can be seen.
    await page.routeWebSocket(/socket\.io/, (ws) => {
        const server = ws.connectToServer();
        ws.onMessage((message) => server.send(message));
        server.onMessage((message) => {
            if (String(message).includes("withdrawal:update")) setTimeout(() => ws.send(message), 2_500);
            else ws.send(message);
        });
    });
    const address = await signIn(page);
    await openAndFill(page, "50");
    await expect(sidebar(page).locator("#withdraw-quote")).toContainText(FEE_LINE, { timeout: 15_000 });
    await withdrawButton(page).click();
    await expect(balanceButton(page)).toHaveAccessibleName("Balance $150.00, show deposits");

    await showHistory(page);
    const row = history(page)
        .getByRole("listitem")
        .filter({ hasText: `−$50.00 to ${short(address)}` });
    await expect(row).toContainText("Sending");
    await expect(row).toContainText("Sending to Solana", { timeout: 20_000 });

    // Circle reports the mint, once the burn has a hash to look up.
    await expect(async () => forwardWithdrawal(address, "5".repeat(88))).toPass({ timeout: 20_000 });
    await expect(row).toContainText(/now|\d+m ago/, { timeout: 30_000 });
    await expect(row).not.toContainText("Sending");
    await expect(balanceButton(page)).toHaveAccessibleName("Balance $150.00, show deposits");
});

test("a failed burn puts the balance back with 'Didn't go through. Your balance is back.'", async ({ page }) => {
    await signIn(page);
    await failNextBurn();
    await openAndFill(page, "50");
    await expect(sidebar(page).locator("#withdraw-quote")).toContainText(FEE_LINE, { timeout: 15_000 });
    await withdrawButton(page).click();
    await expect(status(page)).toHaveText("Didn't go through. Your balance is back.", { timeout: 30_000 });
    await expect(balanceButton(page)).toHaveAccessibleName("Balance $200.00, show deposits");
});

test("the setup line shows for a wallet with no USDC account", async ({ page }) => {
    await signIn(page);
    await openAndFill(page, "10");
    const quote = sidebar(page).locator("#withdraw-quote");
    await expect(quote).toContainText("Fee 0.29 USDC · you receive 9.71 USDC", { timeout: 15_000 });
    await expect(quote).toContainText("Includes 0.16 USDC to set up your USDC account.");
    // Below the Solana minimum the field says so and sends nothing.
    await amountField(page).fill("0.5");
    await expect(sidebar(page).locator("#withdraw-hint")).toHaveText("The smallest withdrawal to Solana is $1.00.");
    await expect(quote).toHaveCount(0);
});
