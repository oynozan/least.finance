import { expect, test, type Page } from "@playwright/test";
import { seedDeposits } from "./backend";
import { addressOf, installWallet, mockArcRpc, mockPrivy } from "./privy-mock";

const dock = (page: Page) => page.getByRole("navigation", { name: "Pages" });
const tile = (page: Page, name: string) => dock(page).getByRole("link", { name, exact: true });
// The one up top: it comes after the page's content, which may have a Connect button of its own.
const walletButton = (page: Page) => page.getByRole("button", { name: /^(Wallet|Connect wallet)/ }).last();
const sidebar = (page: Page) => page.locator("#wallet-sidebar");
// The sidebar has a Balance section of its own.
const balance = (page: Page) => page.getByRole("main").getByRole("region", { name: /^Balance/ });
const chart = (page: Page) => page.getByRole("slider", { name: "Balance by day" });
const activity = (page: Page) => page.getByRole("region", { name: "Activity" });
const rows = (page: Page) => activity(page).locator("tbody tr");

async function shoot(page: Page, name: string) {
    await page.waitForTimeout(900);
    await page.screenshot({ path: `e2e/screenshots/${test.info().project.name}-pnl-${name}.png` });
}

/** Signs in from the wallet button up top, then folds the sidebar the sign-in opened. */
async function connect(page: Page) {
    await walletButton(page).click();
    await page.locator("#privy-modal-content").getByRole("button", { name: "MetaMask" }).click();
    await expect(sidebar(page)).toHaveAttribute("data-open", "true", { timeout: 10_000 });
    await expect(sidebar(page).getByRole("button", { name: /^Balance/ })).not.toHaveAccessibleName(/loading/, {
        timeout: 10_000,
    });
    await page.keyboard.press("Escape");
    await expect(sidebar(page)).toHaveAttribute("data-open", "false");
}

test.beforeEach(async ({ page }) => {
    await mockPrivy(page);
    await mockArcRpc(page);
    await installWallet(page);
});

test("the wallet sits on top and the dock at the bottom, on every page", async ({ page }) => {
    await page.goto("/");
    const viewport = page.viewportSize()!;
    for (const path of ["/", "/pnl"]) {
        if (path === "/pnl") {
            await tile(page, "PnL").click();
            await expect(page).toHaveURL(/\/pnl$/);
        }
        const [wallet, nav] = await Promise.all([walletButton(page).boundingBox(), dock(page).boundingBox()]);
        expect(wallet!.y).toBeLessThan(80);
        expect(Math.abs(wallet!.x + wallet!.width / 2 - viewport.width / 2)).toBeLessThan(2);
        expect(viewport.height - (nav!.y + nav!.height)).toBeLessThan(60);
        expect(Math.abs(nav!.x + nav!.width / 2 - viewport.width / 2)).toBeLessThan(2);
        await expect(tile(page, path === "/" ? "Trade" : "PnL")).toHaveAttribute("aria-current", "page");
    }
    await expect(tile(page, "Trade")).not.toHaveAttribute("aria-current");
    // Back to trading through the dock.
    await tile(page, "Trade").click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("region", { name: "Trade" })).toBeVisible();
});

test("dock tiles swell toward the pointer and name themselves", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover only");
    await page.goto("/");
    const size = async (name: string) => (await tile(page, name).boundingBox())!.width;
    expect(await size("Trade")).toBeCloseTo(48, 0);
    await tile(page, "PnL").hover();
    await expect.poll(() => size("PnL")).toBeGreaterThan(64);
    // Its neighbor swells too, but less.
    const neighbor = await size("Trade");
    expect(neighbor).toBeGreaterThan(48);
    expect(neighbor).toBeLessThan(await size("PnL"));
    await expect(dock(page).getByText("PnL", { exact: true })).toBeVisible();
    await shoot(page, "1-dock-hover");

    await page.mouse.move(10, 10);
    await expect.poll(() => size("PnL")).toBeLessThan(49);
    await expect(dock(page).getByText("PnL", { exact: true })).toBeHidden();
});

test("Review sits in the dock on the trade page only", async ({ page }) => {
    await page.goto("/");
    await connect(page);
    await expect(dock(page).getByRole("button", { name: "Review" })).toBeVisible();
    await tile(page, "PnL").click();
    await expect(page).toHaveURL(/\/pnl$/);
    await expect(dock(page).getByRole("button", { name: "Review" })).toHaveCount(0);
    await tile(page, "Trade").click();
    await expect(dock(page).getByRole("button", { name: "Review" })).toBeVisible();
});

test("the PnL page asks for a wallet until one is connected", async ({ page }) => {
    await page.goto("/pnl");
    await expect(page.getByText("Connect a wallet to see your balance and PnL.")).toBeVisible();
    await expect(balance(page)).toHaveCount(0);
    await page.getByRole("main").getByRole("button", { name: "Connect wallet" }).click();
    await expect(page.locator("#privy-modal-content")).toBeVisible();
});

test("the balance is charted by day, and every operation is listed", async ({ page, isMobile }) => {
    // Seeded before connecting, so the session loads it.
    await seedDeposits(addressOf(page), [{ amount: "500", daysAgo: 3 }]);
    await page.goto("/pnl");
    await connect(page);
    await expect(balance(page)).toBeVisible();
    await expect(balance(page).getByRole("heading")).toHaveText("Balance");
    await expect(balance(page)).toContainText(/PnL over 30 days/);

    // A bar a day, and arrowing through them rolls the figures to that day.
    await expect(chart(page)).toHaveAttribute("aria-valuemax", "30");
    await chart(page).focus();
    await page.keyboard.press("ArrowLeft");
    await expect(balance(page).getByRole("heading")).toHaveText(/^Balance on \w{3} \d{1,2}$/);
    await expect(chart(page)).toHaveAttribute("aria-valuenow", "29");
    await page.keyboard.press("Home");
    await expect(chart(page)).toHaveAttribute("aria-valuenow", "1");
    await expect(balance(page)).toContainText("PnL that day");

    // Ranges change the number of days.
    await balance(page).getByRole("radio", { name: "7D" }).click();
    await expect(chart(page)).toHaveAttribute("aria-valuemax", "7");
    await expect(balance(page)).toContainText("PnL over 7 days");

    // The deposit is in the table with the trades, newest first.
    const deposit = rows(page).filter({ hasText: "Deposit" });
    await expect(deposit).toHaveCount(1);
    await expect(deposit).toContainText("+$500.00");
    await expect(rows(page).filter({ hasText: "Swap ETH to SOL" }).first()).toBeVisible();
    if (!isMobile) await expect(activity(page).getByRole("columnheader", { name: "Result" })).toBeVisible();
    await shoot(page, "2-page");

    await activity(page).getByRole("radio", { name: "Deposits" }).click();
    await expect(rows(page)).toHaveCount(1);
    await activity(page).getByRole("radio", { name: "Trades" }).click();
    await expect(rows(page).filter({ hasText: "Deposit" })).toHaveCount(0);
    expect(await rows(page).count()).toBeGreaterThan(10);
});

test("a trade confirmed in Review is listed as not sent", async ({ page }) => {
    await page.goto("/");
    await connect(page);
    await dock(page).getByRole("button", { name: "Review" }).click();
    await sidebar(page).getByRole("button", { name: "Confirm swap" }).click();
    await sidebar(page).getByRole("button", { name: "Done" }).click();
    await expect(sidebar(page)).toHaveAttribute("data-open", "false");

    await tile(page, "PnL").click();
    const first = rows(page).first();
    await expect(first).toContainText("Swap ETH to SOL");
    await expect(first).toContainText("Not sent");
});

test("phones fit the PnL page without scrolling sideways", async ({ page, isMobile }) => {
    test.skip(!isMobile, "phone layout");
    await page.goto("/pnl");
    await connect(page);
    await expect(rows(page).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await shoot(page, "3-phone");
});
