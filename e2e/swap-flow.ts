import { expect, type Page } from "@playwright/test";

export const trade = (page: Page) => page.getByRole("region", { name: "Trade" });
// Privy keeps a dialog of its own in the page; ours are marked.
export const picker = (page: Page) => page.locator("[data-floating-dialog]:not([data-closing])");
export const sidebar = (page: Page) => page.locator("#wallet-sidebar");
export const reviewPanel = (page: Page) => page.getByRole("complementary", { name: "Review" });
export const reviewButton = (page: Page) =>
    page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: "Review" });
const walletButton = (page: Page) => page.getByRole("button", { name: /^(Wallet|Connect wallet)/ }).last();
const balanceButton = (page: Page) => sidebar(page).getByRole("button", { name: /^Balance/ });
const amountPill = (page: Page) => trade(page).getByRole("button", { name: /USD$/ });

/** Signs the e2e wallet in, which holds 1 ETH on the Ethereum chain, and folds the sidebar away. */
export async function connect(page: Page) {
    await walletButton(page).click();
    await page.locator("#privy-modal-content").getByRole("button", { name: "MetaMask" }).click();
    await expect(sidebar(page)).toHaveAttribute("data-open", "true", { timeout: 10_000 });
    await expect(walletButton(page)).toBeFocused();
    await expect(balanceButton(page)).not.toHaveAccessibleName(/loading/, { timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expect(sidebar(page)).toHaveAttribute("data-open", "false");
}

/** Picks a coin in a pill's picker, then its network at the second step. */
export async function pickCoin(page: Page, part: string, coin: string, network: string) {
    await trade(page).locator(`[data-part="${part}"]`).getByRole("button").click();
    await picker(page).getByRole("option", { name: coin, exact: true }).click();
    await expect(picker(page)).toHaveAccessibleName("On which network?");
    // The wallet's amounts are in once the row carries them, so a pay row isn't disabled by an unread network.
    await picker(page).getByRole("option").filter({ hasText: network }).first().click();
    await expect(picker(page)).toBeHidden();
}

/** Types an amount into the amount's dropdown, then closes it with Enter. */
export async function setAmount(page: Page, value: string) {
    await amountPill(page).click();
    await picker(page).getByRole("textbox").fill(value);
    await picker(page).getByRole("textbox").press("Enter");
    await expect(picker(page)).toBeHidden();
}

/** Signs in and sets "Swap my ETH to USDC", both on Ethereum, ready to review. */
export async function ethToUsdc(page: Page) {
    await page.goto("/");
    await connect(page);
    await pickCoin(page, "term:token", "USDC", "Ethereum");
}

/** Opens the review and waits for LI.FI's quote to show in it. */
export async function openReview(page: Page) {
    await reviewButton(page).click();
    await expect(reviewPanel(page)).toBeVisible();
}
