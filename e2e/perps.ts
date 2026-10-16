import { expect, type Page } from "@playwright/test";
import { liquidatePerp, nextPerpOrder } from "./backend";

export const trade = (page: Page) => page.getByRole("region", { name: "Trade" });
export const sidebar = (page: Page) => page.locator("#wallet-sidebar");
export const walletButton = (page: Page) => page.getByRole("button", { name: /^(Wallet|Connect wallet)/ }).last();
export const balanceButton = (page: Page) => sidebar(page).getByRole("button", { name: /^Balance/ });
export const status = (page: Page) => sidebar(page).getByRole("status");
export const reviewPanel = (page: Page) => page.getByRole("complementary", { name: "Review" });
export const reviewButton = (page: Page) =>
    page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: "Review" });
const picker = (page: Page) => page.locator("[data-floating-dialog]:not([data-closing])");

/** The sidebar's rows for the person's open positions, newest last. */
export const positionRows = (page: Page) =>
    sidebar(page).getByRole("list", { name: "Open positions" }).getByRole("listitem");

/** Signs in with the injected wallet, then folds the sidebar the sign-in opened. */
export async function connect(page: Page) {
    await walletButton(page).click();
    await page.locator("#privy-modal-content").getByRole("button", { name: "MetaMask" }).click();
    await expect(sidebar(page)).toHaveAttribute("data-open", "true", { timeout: 10_000 });
    await expect(walletButton(page)).toBeFocused();
    await expect(balanceButton(page)).not.toHaveAccessibleName(/loading/, { timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expect(sidebar(page)).toHaveAttribute("data-open", "false");
}

/** Opens the sidebar. */
export async function openSidebar(page: Page) {
    await walletButton(page).click();
    await expect(sidebar(page)).toHaveAttribute("data-open", "true");
}

async function choose(page: Page, from: string, option: string | RegExp) {
    await trade(page).locator(from).getByRole("button").click();
    await expect(picker(page)).toBeVisible();
    await picker(page).getByRole("option", { name: option }).click();
    await expect(picker(page)).toBeHidden();
}

/** Builds "Long|Short <asset> at <leverage>x with <collateral> USD" in the sentence; a verb switch brings values of its own, so all are set. */
export async function openPerp(
    page: Page,
    o: { side: "Long" | "Short"; asset?: string; leverage?: number; collateral?: string },
) {
    await trade(page)
        .getByRole("button", { name: /^(Swap|Long|Short)$/ })
        .click();
    await expect(picker(page)).toBeVisible();
    await picker(page)
        .getByRole("option", { name: new RegExp(`^${o.side}`) })
        .click();
    await expect(picker(page)).toBeHidden();
    await choose(page, '[data-slot="asset"]', new RegExp(`^${o.asset ?? "BTC"}$`));
    await choose(page, '[data-slot="leverage"]', new RegExp(`^${o.leverage ?? 5}x`));
    await trade(page).getByRole("button", { name: /USD$/ }).click();
    await picker(page)
        .getByRole("textbox")
        .fill(o.collateral ?? "100");
    await picker(page).getByRole("textbox").press("Enter");
    await expect(picker(page)).toBeHidden();
    await expect(trade(page).getByRole("button", { name: `${o.collateral ?? "100"} USD` })).toBeVisible();
}

/** Opens the review of the sentence and confirms it; resolves once the done step shows. */
export async function confirmPerp(page: Page) {
    await reviewButton(page).click();
    // The button waits for the server's quote.
    const confirm = reviewPanel(page).getByRole("button", { name: /^Confirm/ });
    await expect(confirm).not.toHaveAttribute("aria-disabled", "true");
    await confirm.click();
    // Answered: a refusal stays in the review, an accepted order hands over to the wallet.
    await expect(
        sidebar(page)
            .getByRole("button", { name: "Done" })
            .or(page.getByRole("complementary", { name: "Wallet" })),
    ).toBeVisible();
}

/** Controls over the fake Hyperliquid's next order; they are global, so specs using them run one at a time. */
export const perpControl = {
    /** The next order is never answered and never applied. */
    holdNext: () => nextPerpOrder("hold"),
    /** The next order is applied, but its reply is lost, so only the tracker finds the fill. */
    dropNext: () => nextPerpOrder("drop"),
    /** The next order is refused with this message. */
    rejectNext: (message: string) => nextPerpOrder({ reject: message }),
    /** Has the person who owns `address` liquidated on `asset`. */
    liquidate: (address: string, asset: string) => liquidatePerp(address, asset),
};
