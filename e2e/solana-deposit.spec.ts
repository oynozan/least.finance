import { expect, test, type Page } from "@playwright/test";
import { getBase58Decoder } from "@solana/kit";
import { advanceBridge, fundSource, landSolanaSignature, randomSolanaAddress } from "./backend";
import { installSolanaWallet, mockPrivy, pickWallet, SOLANA_SIGNATURE_BYTE, solanaSent } from "./privy-mock";

const SIGNATURE = getBase58Decoder().decode(new Uint8Array(64).fill(SOLANA_SIGNATURE_BYTE));

const sidebarOf = (page: Page) => page.getByRole("complementary", { name: "Wallet" });
const coinsOf = (page: Page) => sidebarOf(page).getByRole("list", { name: "Coins to deposit" });
const depositOf = (page: Page) => sidebarOf(page).getByRole("button", { name: "Deposit", exact: true });
const amountOf = (page: Page) => sidebarOf(page).getByRole("textbox", { name: "Deposit amount" });
const hintOf = (page: Page) => sidebarOf(page).locator("#deposit-hint");
const statusOf = (page: Page) => sidebarOf(page).getByRole("status");
const balanceOf = (page: Page) => sidebarOf(page).getByRole("button", { name: /^Balance/ });
const stepOf = (page: Page, name: string) => statusOf(page).getByRole("listitem").filter({ hasText: name });

/** Signs in with a fresh Solana wallet holding 2 SOL and picks its SOL row. */
async function signInAndPick(page: Page) {
    test.setTimeout(90_000);
    const address = randomSolanaAddress();
    await fundSource(address, "solana:SOL", "2");
    pickWallet(page, address);
    await installSolanaWallet(page, address);
    await mockPrivy(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await page.locator("#privy-modal-content").getByRole("button", { name: "Phantom" }).click();
    await expect(sidebarOf(page)).toHaveAttribute("data-open", "true", { timeout: 10_000 });
    await expect(balanceOf(page)).toHaveAccessibleName(/^Balance \$/, { timeout: 20_000 });
    await depositOf(page).click();
    return address;
}

test("Solana rows are open and a Solana deposit shows what it's worth", async ({ page }) => {
    await signInAndPick(page);
    const row = coinsOf(page).getByRole("button", { name: /^SOL on Solana, 2 SOL/ });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toBeEnabled();
    await expect(sidebarOf(page).getByText("Not open yet")).toHaveCount(0);

    await row.click();
    await amountOf(page).fill("1");
    // At the catalog price, worked out as it's typed (the fake prices SOL at $147.20)
    await expect(hintOf(page)).toHaveText("≈ $147.20");
    await expect(hintOf(page)).not.toHaveAttribute("data-tone", "error");
});

test("confirming shows sent, in a block, bridging, delivered, and the explorer link is a Solana explorer", async ({
    page,
}) => {
    const address = await signInAndPick(page);
    await coinsOf(page)
        .getByRole("button", { name: /^SOL on Solana, 2 SOL/ })
        .click({ timeout: 20_000 });
    await amountOf(page).fill("1");
    await expect(hintOf(page)).toHaveText("≈ $147.20");
    // The Solana wallet can sign a moment after sign-in; until then Deposit waits
    await expect(depositOf(page)).not.toHaveAttribute("aria-disabled", { timeout: 20_000 });
    await depositOf(page).click();

    await expect(stepOf(page, "Sending")).toHaveAttribute("data-step", "active", { timeout: 20_000 });
    expect(await solanaSent(page)).toHaveLength(1);
    const link = statusOf(page).getByRole("link", { name: /Solscan/ });
    await expect(link).toHaveAttribute("href", `https://solscan.io/tx/${SIGNATURE}`);

    await landSolanaSignature(SIGNATURE);
    await expect(stepOf(page, "In a block")).toHaveAttribute("data-step", "done", { timeout: 20_000 });
    await expect(stepOf(page, "Bridging to Arc")).toHaveAttribute("data-step", "active");

    await advanceBridge(address, "filled");
    await expect(stepOf(page, "Added")).toHaveAttribute("data-step", "done", { timeout: 20_000 });
    await expect(balanceOf(page)).toHaveAccessibleName("Balance $150.00, show deposits", { timeout: 20_000 });
});
