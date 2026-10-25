import { expect, test, type Page } from "@playwright/test";
import { seedDeposits } from "./backend";
import { addressOf, installWallet, mockArcRpc, mockPrivy } from "./privy-mock";
import { picker, reviewButton, reviewPanel, trade } from "./swap-flow";

// Each test signs in a wallet of its own, funded with 20 USDC in the account (no coins on a chain).
const sidebar = (page: Page) => page.locator("#wallet-sidebar");
const walletButton = (page: Page) => page.getByRole("button", { name: /^(Wallet|Connect wallet)/ }).last();
const balanceButton = (page: Page) => sidebar(page).getByRole("button", { name: /^Balance/ });
const holdings = (page: Page) => sidebar(page).getByRole("region", { name: "Holdings" });
const amountPill = (page: Page) => trade(page).getByRole("button", { name: /USD$/ });

type Wallet = { walletRequests: { method: string }[]; sentHashes: string[] };

/** Signs in with the injected wallet and leaves the sidebar open on the funded balance. */
async function signIn(page: Page) {
    await mockPrivy(page);
    await installWallet(page);
    await mockArcRpc(page, 100);
    await seedDeposits(addressOf(page), [{ amount: "20", daysAgo: 1 }]);
    await page.goto("/");
    await walletButton(page).click();
    await page.locator("#privy-modal-content").getByRole("button", { name: "MetaMask" }).click();
    await expect(sidebar(page)).toHaveAttribute("data-open", "true", { timeout: 10_000 });
    await expect(balanceButton(page)).toHaveAccessibleName("Balance $20.00, show deposits", { timeout: 20_000 });
}

const pickVerb = async (page: Page, from: string, verb: RegExp) => {
    await trade(page).getByRole("button", { name: from, exact: true }).click();
    await picker(page).getByRole("option", { name: verb }).click();
    await expect(picker(page)).toBeHidden();
};

async function pickCoin(page: Page, part: string, coin: string) {
    await trade(page).locator(`[data-part="${part}"]`).getByRole("button").click();
    await picker(page).getByRole("option", { name: coin, exact: true }).click();
    await expect(picker(page)).toBeHidden();
}

async function setAmount(page: Page, value: string) {
    await amountPill(page).click();
    await picker(page).getByRole("textbox").fill(value);
    await picker(page).getByRole("textbox").press("Enter");
    await expect(picker(page)).toBeHidden();
}

/** Confirms the review that is open and waits for the wallet, which a filled trade hands over to on its own. */
async function confirm(page: Page) {
    await reviewButton(page).click();
    await expect(reviewPanel(page)).toContainText("Instant");
    await reviewPanel(page)
        .getByRole("button", { name: /^Confirm/ })
        .click();
    await expect(page.getByRole("complementary", { name: "Wallet" })).toBeVisible({ timeout: 15_000 });
}

/** The sidebar, opened from the wallet button when it is folded. */
async function openSidebar(page: Page) {
    if ((await sidebar(page).getAttribute("data-open")) !== "true") await walletButton(page).click();
    await expect(sidebar(page)).toHaveAttribute("data-open", "true");
}

test("Buy, Sell and Swap run from the balance with no wallet popup, and Send is refused while off", async ({
    page,
    isMobile,
}) => {
    test.setTimeout(120_000);
    await signIn(page);
    await page.keyboard.press("Escape");
    await expect(sidebar(page)).toHaveAttribute("data-open", "false");

    // Buy $1 of BNB
    await pickVerb(page, "Swap", /^Buy/);
    await pickCoin(page, "term:token", "BNB");
    await setAmount(page, "1");
    await confirm(page);
    await openSidebar(page);
    // The dollar left the cash for 0.0016616 BNB, which the total counts at BNB's $600: $19.997 reads $20.00
    await expect(balanceButton(page)).toHaveAccessibleName("Balance $20.00, $19.00 cash, show deposits", {
        timeout: 15_000,
    });
    await expect(holdings(page).getByText(/BNB$/).first()).toBeVisible();
    // $1 at BNB's ask of $601.80 buys 0.0016616 BNB
    await expect(holdings(page)).toContainText("0.001662 BNB");
    await page.keyboard.press("Escape");

    // Sell half a dollar of it back
    await pickVerb(page, "Buy", /^Sell/);
    await setAmount(page, "0.5");
    await confirm(page);
    await openSidebar(page);
    await expect(balanceButton(page)).toHaveAccessibleName("Balance $20.00, $19.50 cash, show deposits", {
        timeout: 15_000,
    });
    // 0.00083333 BNB sold at the bid of $598.20 pays $0.4985, so $19.4985 of cash rounds to $19.50, and 0.00082835 BNB is left
    await expect(holdings(page)).toContainText("0.0008284 BNB");
    await page.keyboard.press("Escape");

    // Swap what is left to ETH
    await pickVerb(page, "Sell", /^Swap/);
    await pickCoin(page, "swap:fromToken", "BNB");
    await pickCoin(page, "term:token", "ETH");
    await setAmount(page, "0.25");
    await confirm(page);
    await openSidebar(page);
    await expect(holdings(page)).toContainText("ETH", { timeout: 15_000 });
    // A swap leaves the cash alone; the total moves only by the swap's spread
    await expect(balanceButton(page)).toHaveAccessibleName(
        /^Balance \$(19\.9\d|20\.00), \$19\.50 cash, show deposits$/,
    );

    // None of it asked the wallet to sign or send anything
    expect(await page.evaluate(() => (window as unknown as Wallet).sentHashes)).toEqual([]);
    const asked = await page.evaluate(() => (window as unknown as Wallet).walletRequests.map((r) => r.method));
    expect(asked.filter((m) => m === "eth_sendTransaction" || m.startsWith("eth_signTypedData"))).toEqual([]);

    // Send is refused while coin withdrawals are off, and the units come back to the holding
    const held = (await holdings(page).textContent())!.match(/[\d.,]+ ETH/)![0];
    // Send slides in on hover, or a tap on touch, as Close does on a position.
    const eth = holdings(page).getByRole("listitem").filter({ hasText: /ETH/ });
    if (isMobile) await eth.tap();
    else await eth.hover();
    await holdings(page).getByRole("button", { name: "Send ETH" }).click();
    await holdings(page)
        .getByRole("textbox", { name: /^Amount of ETH to send/ })
        .fill("0.0001");
    await holdings(page).getByRole("button", { name: "Send ETH" }).last().click();
    await expect(holdings(page)).not.toContainText("Sending", { timeout: 15_000 });
    await expect(holdings(page)).toContainText(held);
});
