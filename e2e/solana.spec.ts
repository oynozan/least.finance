import { expect, test } from "@playwright/test";
import { randomSolanaAddress } from "./backend";
import { ARC_RPC, installSolanaWallet, mockPrivy, useWallet } from "./privy-mock";

test("signing in with a Solana wallet opens the account, with Solana in the header", async ({ page }) => {
    const address = randomSolanaAddress();
    useWallet(page, address);
    const arcRequests: string[] = [];
    await page.route(ARC_RPC, (route) => {
        arcRequests.push(route.request().postData() ?? "");
        return route.fulfill({
            status: 200,
            contentType: "application/json",
            headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" }),
        });
    });
    await installSolanaWallet(page, address);
    await mockPrivy(page);
    await page.goto("/");

    await page.getByRole("button", { name: "Connect wallet" }).click();
    await page.locator("#privy-modal-content").getByRole("button", { name: "Phantom" }).click();

    const sidebar = page.getByRole("complementary", { name: "Wallet" });
    await expect(sidebar).toHaveAttribute("data-open", "true", { timeout: 10_000 });
    // The account is bound once its balance has loaded.
    await expect(sidebar.getByRole("button", { name: /^Balance/ })).toHaveAccessibleName(/^Balance \$/, { timeout: 20_000 });

    const header = sidebar.locator("header").first();
    await expect(header.getByRole("img", { name: "Solana" })).toBeVisible();
    await expect(header).toContainText(`${address.slice(0, 6)}…${address.slice(-4)}`);
    expect(arcRequests.filter((body) => body.includes("0x70a08231"))).toEqual([]);
});
