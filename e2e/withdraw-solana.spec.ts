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

test("pressing Withdraw below the Solana minimum sends nothing and marks the field invalid", async ({ page }) => {
    const sent: string[] = [];
    page.on("websocket", (ws) => ws.on("framesent", (frame) => sent.push(String(frame.payload))));
    await signIn(page);
    await openAndFill(page, "0.5");
    await expect(sidebar(page).locator("#withdraw-hint")).toHaveText("The smallest withdrawal to Solana is $1.00.");
    await expect(amountField(page)).toHaveAttribute("aria-invalid", "true");
    // The button reads aria-disabled below the minimum, which a real press still reaches.
    await withdrawButton(page).click({ force: true });
    await expect(amountField(page)).toHaveAttribute("aria-invalid", "true");
    await expect(amountField(page)).toHaveValue("0.5");
    expect(sent.filter((frame) => frame.includes("withdraw:create") || frame.includes("withdraw:quote"))).toEqual([]);
});

test("a changed fee re-quotes, shows the new line and sends only when Withdraw is pressed again", async ({ page }) => {
    // The first withdraw:create is answered quote_changed here and the quotes after the first read a dearer fee.
    const creates: string[] = [];
    const quoteIds: string[] = [];
    let refused = false;
    await page.routeWebSocket(/socket\.io/, (ws) => {
        const server = ws.connectToServer();
        ws.onMessage((message) => {
            const text = String(message);
            const frame = /^42(\d+)\["(withdraw:[a-z]+)"/.exec(text);
            if (frame?.[2] === "withdraw:quote") quoteIds.push(frame[1]!);
            if (frame?.[2] === "withdraw:create") {
                creates.push(text);
                if (!refused) {
                    refused = true;
                    const error = { code: "quote_changed", message: "The fee is now 0.4 USDC. Nothing was taken." };
                    ws.send(`43${frame[1]}[${JSON.stringify({ ok: false, error })}]`);
                    return;
                }
            }
            server.send(message);
        });
        server.onMessage((message) => {
            const text = String(message);
            const ack = /^43(\d+)\[([\s\S]*)\]$/.exec(text);
            if (ack && quoteIds.indexOf(ack[1]!) > 0) {
                const body = JSON.parse(ack[2]!);
                body.data = { ...body.data, fee: "0.4", receive: "49.6" };
                ws.send(`43${ack[1]}[${JSON.stringify(body)}]`);
            } else ws.send(message);
        });
    });
    await signIn(page);
    await openAndFill(page, "50");
    await expect(sidebar(page).locator("#withdraw-quote")).toContainText(FEE_LINE, { timeout: 15_000 });
    await withdrawButton(page).click();
    await expect(sidebar(page).locator("#withdraw-hint")).toHaveText(
        "The fee changed. Check the new amount and press Withdraw again.",
    );
    await expect(sidebar(page).locator("#withdraw-quote")).toContainText("Fee 0.40 USDC · you receive 49.60 USDC", {
        timeout: 15_000,
    });
    // Nothing more went out on its own, and the form is still open with the amount.
    await page.waitForTimeout(1_000);
    expect(creates).toHaveLength(1);
    await expect(amountField(page)).toHaveValue("50");
    await withdrawButton(page).click();
    await expect(balanceButton(page)).toHaveAccessibleName("Balance $150.00, show deposits");
    expect(creates).toHaveLength(2);
    expect(creates[0]).toContain('"reviewedFee":"0.286"');
    expect(creates[1]).toContain('"reviewedFee":"0.4"');
});
