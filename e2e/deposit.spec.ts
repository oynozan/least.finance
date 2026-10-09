import { expect, test, type Page } from "@playwright/test";
import { parseGwei, parseUnits } from "viem";
import { accountOf } from "./backend";
import { addressOf, installWallet, mockArcRpc, mockPrivy, walletRequests } from "./privy-mock";

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Wallet" });
const modal = (page: Page) => page.locator("#privy-modal-content");
const balanceButton = (page: Page) => sidebar(page).getByRole("button", { name: /^Balance/ });
const depositButton = (page: Page) => sidebar(page).getByRole("button", { name: "Deposit", exact: true });
const amountField = (page: Page) => sidebar(page).getByRole("textbox", { name: "Deposit amount" });
const status = (page: Page) => sidebar(page).getByRole("status");

async function connect(page: Page) {
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await modal(page).getByRole("button", { name: "MetaMask" }).click();
    await expect(balanceButton(page)).toHaveAccessibleName("Balance $0.00, show deposits");
}

test.beforeEach(async ({ page }) => {
    await mockPrivy(page);
    await mockArcRpc(page);
    await installWallet(page);
    await page.goto("/");
});

test("a deposit counts at once, then the server confirms it", async ({ page }) => {
    await connect(page);
    await depositButton(page).click();
    await amountField(page).fill("25");
    await depositButton(page).click();

    await expect(balanceButton(page)).toHaveAccessibleName("Balance $25.00, show deposits");
    await expect(status(page)).toHaveText("Deposited $25.00");

    const account = await accountOf(addressOf(page));
    expect(account?.balance).toBe("25");
    const sent = (await walletRequests(page)).find((r) => r.method === "eth_sendTransaction");
    const tx = sent?.params?.[0] as { to: string; value: string; maxFeePerGas: string };
    expect(tx.to.toLowerCase()).toBe(account!.depositAddress.toLowerCase());
    expect(BigInt(tx.value)).toBe(parseUnits("25", 18));
    expect(BigInt(tx.maxFeePerGas)).toBeGreaterThanOrEqual(parseGwei("20"));
});
