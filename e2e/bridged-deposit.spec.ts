import { expect, test } from "@playwright/test";
import { chainRpc, fundSource, randomAddress, randomSolanaAddress } from "./backend";
import { installSolanaWallet, mockPrivy, useWallet } from "./privy-mock";

const BNB_USDT = "0x55d398326f99059fF775485246999027B3197955";

test("the test backend funds wallets on Ethereum, BNB Chain and Solana", async ({ page }) => {
    const wallet = randomAddress();
    await fundSource(wallet, "bnb:USDT", "250");
    const call = { to: BNB_USDT, data: `0x70a08231${wallet.slice(2).padStart(64, "0")}` };
    const { result } = await chainRpc("eth_call", [call, "latest"], 56);
    expect(BigInt(result as string)).toBe(BigInt("250000000000000000000"));

    const solana = randomSolanaAddress();
    await fundSource(solana, "solana:SOL", "2");
    useWallet(page, solana);
    await installSolanaWallet(page, solana);
    await mockPrivy(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await page.locator("#privy-modal-content").getByRole("button", { name: "Phantom" }).click();
    const sidebar = page.getByRole("complementary", { name: "Wallet" });
    await expect(sidebar).toHaveAttribute("data-open", "true", { timeout: 10_000 });
    await sidebar.getByRole("button", { name: "Deposit", exact: true }).click();
    await expect(
        sidebar.getByRole("list", { name: "Coins to deposit" }).getByRole("button", { name: /^SOL on Solana, 2 SOL/ }),
    ).toBeVisible({ timeout: 20_000 });
});
