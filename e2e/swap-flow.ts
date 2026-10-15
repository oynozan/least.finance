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

/** Picks a coin in a pill's picker; a coin has no network step. */
export async function pickCoin(page: Page, part: string, coin: string) {
    await trade(page).locator(`[data-part="${part}"]`).getByRole("button").click();
    await picker(page).getByRole("option", { name: coin, exact: true }).click();
    await expect(picker(page)).toBeHidden();
}

/** Types an amount into the amount's dropdown, then closes it with Enter. */
export async function setAmount(page: Page, value: string) {
    await amountPill(page).click();
    await picker(page).getByRole("textbox").fill(value);
    await picker(page).getByRole("textbox").press("Enter");
    await expect(picker(page)).toBeHidden();
}
