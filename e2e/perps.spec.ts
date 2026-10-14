import { expect, test, type Page } from "@playwright/test";
import { seedDeposits } from "./backend";
import {
    balanceButton,
    confirmPerp,
    connect,
    openPerp,
    openSidebar,
    perpControl,
    positionRows,
    reviewButton,
    reviewPanel,
    sidebar,
    status,
    walletButton,
} from "./perps";
import { addressOf, installWallet, mockArcRpc, mockPrivy } from "./privy-mock";

// The fake Hyperliquid's next-order switch is global, so these run one at a time, and on one project only.
test.describe.configure({ mode: "serial", timeout: 90_000 });
test.skip(({ isMobile }) => isMobile, "the fake's order controls are shared by both projects");

const balanceName = (usd: string) => `Balance $${usd}, show deposits`;
const long = (page: Page) => positionRows(page).filter({ hasText: "Long BTC at 5x" });
const dock = (page: Page) => page.getByRole("navigation", { name: "Pages" });

/** Confirms the open review, folds it and opens the wallet. */
async function confirmAndOpen(page: Page) {
    await confirmPerp(page);
    await reviewPanel(page).getByRole("button", { name: "Done" }).click();
    await expect(sidebar(page)).toHaveAttribute("data-open", "false");
    await openSidebar(page);
}

/** Opens a $100 5x Long on BTC that the fake fills, and leaves the sidebar open on its row. */
async function openFilled(page: Page) {
    await openPerp(page, { side: "Long" });
    await confirmAndOpen(page);
    await expect(long(page)).toContainText("entry $");
}

test.beforeEach(async ({ page }) => {
    await mockPrivy(page);
    await mockArcRpc(page);
    await installWallet(page);
    await seedDeposits(addressOf(page), [{ amount: "500", daysAgo: 0 }]);
});

test("Long and Short review shows the quote rows and a liquidation price", async ({ page }) => {
    await page.goto("/");
    await connect(page);
    const price = (text: string) => Number(/\$([\d,]+(?:\.\d+)?)/.exec(text)![1]!.replaceAll(",", ""));
    const rows = reviewPanel(page).getByRole("region", { name: "Details" });

    await openPerp(page, { side: "Long" });
    await reviewButton(page).click();
    for (const label of [
        "Position",
        "Entry price (about)",
        "Liquidation price (about)",
        "Fees",
        "Funding",
        "Most you can lose",
    ]) {
        await expect(rows).toContainText(label);
    }
    await expect(rows).toContainText("before funding");
    const entry = rows.getByText(/^\$[\d,.]+$/).first();
    await expect(entry).toBeVisible();
    const longText = (await rows.innerText()).replaceAll("\n", " ");
    const longEntry = price(/Entry price \(about\)\s*(\$[\d,.]+)/.exec(longText)![1]!);
    const longLiquidation = price(/Liquidation price \(about\)\s*(\$[\d,.]+)/.exec(longText)![1]!);
    expect(longLiquidation).toBeLessThan(longEntry);

    await reviewButton(page).click();
    await openPerp(page, { side: "Short" });
    await reviewButton(page).click();
    await expect(rows).toContainText("Liquidation price (about)");
    const shortText = (await rows.innerText()).replaceAll("\n", " ");
    const shortEntry = price(/Entry price \(about\)\s*(\$[\d,.]+)/.exec(shortText)![1]!);
    const shortLiquidation = price(/Liquidation price \(about\)\s*(\$[\d,.]+)/.exec(shortText)![1]!);
    expect(shortLiquidation).toBeGreaterThan(shortEntry);
});

test("confirm lowers the balance and adds the position at once while the fake holds the order", async ({ page }) => {
    await perpControl.holdNext();
    await page.goto("/");
    await connect(page);
    await openPerp(page, { side: "Long" });
    await confirmPerp(page);
    await expect(reviewPanel(page)).toContainText("Position opened.");
    await reviewPanel(page).getByRole("button", { name: "Done" }).click();
    await openSidebar(page);

    await expect(balanceButton(page)).toHaveAccessibleName(balanceName("400.00"));
    await expect(long(page)).toHaveCount(1);
    await expect(long(page)).toContainText("Pending");
    await expect(long(page)).toContainText("$500 position");
    await expect(status(page)).toHaveText("");
    // Nothing to close until it fills.
    const close = long(page).getByRole("button", { name: "Close Long BTC at 5x" });
    await expect(close).toHaveAttribute("aria-disabled", "true");
    await expect(close).toHaveAccessibleDescription("Closing opens when the position is filled.");
});

test("the real fill replaces the numbers in place", async ({ page }) => {
    await perpControl.dropNext();
    await page.goto("/");
    await connect(page);
    await openPerp(page, { side: "Long" });
    await confirmAndOpen(page);
    await expect(long(page)).toContainText("Pending");
    // Until the fill, the row carries the quote's estimates.
    const estimate = await long(page).locator("span").nth(1).innerText();
    expect(estimate).toMatch(/entry \$[\d,.]+, liquidates near/);

    // The tracker finds the fill by its client order id.
    await expect(long(page)).not.toContainText("Pending", { timeout: 30_000 });
    await expect(long(page)).toHaveCount(1);
    await expect(long(page)).toContainText(/entry \$[\d,]+/);
    await expect(long(page)).toContainText(/liquidates near \$[\d,]+/);
    expect(await long(page).locator("span").nth(1).innerText()).not.toBe(estimate);
    // What the fill didn't use of the collateral comes back.
    await expect(balanceButton(page)).toHaveAccessibleName(/^Balance \$400\.\d\d, show deposits$/);
});

test("a rejection removes the position and shows the message", async ({ page }) => {
    await perpControl.rejectNext("Insufficient margin to place order.");
    await page.goto("/");
    await connect(page);
    await openPerp(page, { side: "Long" });
    await confirmPerp(page);

    const line = "This position couldn't be opened right now. Nothing was spent.";
    await expect(reviewPanel(page)).toContainText(line);
    await expect(reviewPanel(page).getByText("Position opened.")).toHaveCount(0);
    await reviewPanel(page).getByRole("button", { name: "Done" }).click();
    await openSidebar(page);
    await expect(status(page)).toHaveText(line);
    await expect(long(page)).toHaveCount(0);
    await expect(balanceButton(page)).toHaveAccessibleName(balanceName("500.00"));
});

test("a reload while held keeps the position", async ({ page }) => {
    await perpControl.holdNext();
    await page.goto("/");
    await connect(page);
    await openPerp(page, { side: "Long" });
    await confirmAndOpen(page);
    await expect(long(page)).toContainText("Pending");

    await page.reload();
    await openSidebar(page);
    await expect(long(page)).toHaveCount(1);
    await expect(long(page)).toContainText("Pending");
    await expect(balanceButton(page)).toHaveAccessibleName(balanceName("400.00"));
});

test("close raises the balance at once and restores the position when the fake rejects it", async ({
    page,
    isMobile,
}) => {
    await page.goto("/");
    await connect(page);
    await openFilled(page);

    await perpControl.rejectNext("Order could not be placed.");
    if (isMobile) await long(page).tap();
    else await long(page).hover();
    await long(page).getByRole("button", { name: "Close Long BTC at 5x" }).click();
    // The balance counts the proceeds before the exchange answers, then the refusal takes them back.
    await expect(status(page)).toHaveText(/Couldn.t close right now\. Your position is still open\./);
    await expect(long(page)).toHaveCount(1);
    await expect(long(page)).toContainText(/entry \$/);
    await expect(balanceButton(page)).toHaveAccessibleName(/^Balance \$400\.\d\d, show deposits$/);

    await long(page).hover();
    await long(page).getByRole("button", { name: "Close Long BTC at 5x" }).click();
    await expect(balanceButton(page)).toHaveAccessibleName(/^Balance \$(49\d|500)\.\d\d, show deposits$/);
    await expect(long(page)).toContainText("Closed");
});

test("a liquidation shows Liquidated in the sidebar and the PnL feed", async ({ page }) => {
    await page.goto("/");
    await connect(page);
    await openFilled(page);

    await perpControl.liquidate(addressOf(page), "BTC");
    await expect(long(page)).toContainText("Liquidated", { timeout: 45_000 });
    await expect(status(page)).toContainText("Your BTC long was liquidated.");
    await page.keyboard.press("Escape");

    await dock(page).getByRole("link", { name: "PnL", exact: true }).click();
    const feed = page.getByRole("region", { name: "Activity" }).locator("tbody tr");
    await expect(feed.filter({ hasText: "Liquidated Long BTC at 5x" })).toHaveCount(1);
    await expect(feed.filter({ hasText: "Long BTC at 5x" })).toHaveCount(2);
});

test("Review is blocked with trading off, and with a position already open on that asset", async ({ page }) => {
    // Trading off is the server's markets answering with no order limit.
    await page.route("**/perps/markets", async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as Record<string, unknown>;
        await route.fulfill({ response, json: { ...body, maxOrderUSD: null } });
    });
    await page.goto("/");
    await connect(page);
    await openPerp(page, { side: "Long" });
    await expect(reviewButton(page)).toHaveAttribute("aria-disabled", "true");
    await expect(reviewButton(page)).toHaveAccessibleDescription("Long and short aren't available right now.");
    await page.unroute("**/perps/markets");

    // The reload keeps the sign-in, and brings the real markets back.
    await page.reload();
    await expect(walletButton(page)).toContainText("0x");
    await openPerp(page, { side: "Long" });
    await expect(reviewButton(page)).not.toHaveAttribute("aria-disabled", "true");
    await confirmAndOpen(page);
    await expect(long(page)).toContainText("entry $");
    await page.keyboard.press("Escape");
    await expect(sidebar(page)).toHaveAttribute("data-open", "false");

    await openPerp(page, { side: "Short" });
    await expect(reviewButton(page)).toHaveAttribute("aria-disabled", "true");
    await expect(reviewButton(page)).toHaveAccessibleDescription("You already hold a BTC position. Close it first.");
    expect(await walletButton(page).isVisible()).toBe(true);
});
