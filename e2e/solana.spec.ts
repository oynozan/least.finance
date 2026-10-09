import { expect, test, type Page } from "@playwright/test";
import { randomAddress, randomSolanaAddress } from "./backend";
import {
    ARC_RPC,
    installSolanaWallet,
    installWallet,
    mockArcRpc,
    mockPrivy,
    useWallet,
    useWallet as signInAs,
} from "./privy-mock";

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
    await expect(sidebar.getByRole("button", { name: /^Balance/ })).toHaveAccessibleName(/^Balance \$/, {
        timeout: 20_000,
    });

    const header = sidebar.locator("header").first();
    await expect(header.getByRole("img", { name: "Solana" })).toBeVisible();
    await expect(header).toContainText(`${address.slice(0, 6)}…${address.slice(-4)}`);
    expect(arcRequests.filter((body) => body.includes("0x70a08231"))).toEqual([]);
});

const sidebarOf = (page: Page) => page.getByRole("complementary", { name: "Wallet" });
const modalOf = (page: Page) => page.locator("#privy-modal-content");

/** Signs in with Phantom; the page also has a MetaMask for `evm`, which the account hasn't linked yet. */
async function signInWithSolana(page: Page) {
    const address = randomSolanaAddress();
    const evm = randomAddress();
    signInAs(page, address);
    await installSolanaWallet(page, address);
    await installWallet(page, evm);
    await mockPrivy(page);
    await mockArcRpc(page, 100, evm);
    await page.goto("/");
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await modalOf(page).getByRole("button", { name: "Phantom" }).click();
    const sidebar = sidebarOf(page);
    await expect(sidebar).toHaveAttribute("data-open", "true", { timeout: 10_000 });
    await expect(sidebar.getByRole("button", { name: /^Balance/ })).toHaveAccessibleName(/^Balance \$/, {
        timeout: 20_000,
    });
    return { address, evm };
}

/** From Deposit, links the page's MetaMask. */
async function connectEvmFromDeposit(page: Page) {
    await sidebarOf(page).getByRole("button", { name: "Deposit", exact: true }).click();
    await modalOf(page).getByRole("button", { name: "MetaMask" }).click();
}

test("a Solana-first user connects an EVM wallet from Deposit, then deposits", async ({ page }) => {
    await signInWithSolana(page);
    const header = sidebarOf(page).locator("header").first();
    await expect(header.getByRole("img", { name: "Solana" })).toBeVisible();

    await connectEvmFromDeposit(page);

    await expect(header.getByRole("img", { name: "Ethereum" })).toBeVisible({ timeout: 10_000 });
    await sidebarOf(page).getByRole("button", { name: "Deposit", exact: true }).click();
    await expect(sidebarOf(page).getByRole("textbox", { name: "Deposit amount" })).toBeFocused();
});

test("the linked wallet is still the one in use after a reload", async ({ page }) => {
    const { evm } = await signInWithSolana(page);
    await connectEvmFromDeposit(page);
    const header = sidebarOf(page).locator("header").first();
    await expect(header.getByRole("img", { name: "Ethereum" })).toBeVisible({ timeout: 10_000 });

    await page.reload();
    await expect(sidebarOf(page).getByRole("button", { name: /^Balance/ })).toHaveAccessibleName(/^Balance \$/, {
        timeout: 20_000,
    });
    // The mock MetaMask forgets its connection on reload, so the network is unknown; the address says which wallet it is.
    await expect(header).toContainText(`${evm.slice(0, 6)}…${evm.slice(-4)}`);
    await expect(header.getByRole("img", { name: "Solana" })).toHaveCount(0);
});

test("a remembered wallet that is no longer linked falls back to a linked one", async ({ page }) => {
    const { address, evm } = await signInWithSolana(page);
    await connectEvmFromDeposit(page);
    await expect(sidebarOf(page).locator("header").first().getByRole("img", { name: "Ethereum" })).toBeVisible({
        timeout: 10_000,
    });
    const stranger = randomAddress();
    await page.evaluate((stranger) => {
        const key = Object.keys(localStorage).find((k) => k.startsWith("active-wallet:"));
        localStorage.setItem(key!, JSON.stringify({ kind: "evm", address: stranger }));
    }, stranger);

    await page.reload();
    const header = sidebarOf(page).locator("header").first();
    await expect(header).toContainText(new RegExp(`${address.slice(0, 6)}|${evm.slice(0, 6)}`), { timeout: 20_000 });
    await expect(header).not.toContainText(stranger.slice(0, 6));
});

test("dismissing the link modal changes nothing", async ({ page }) => {
    await signInWithSolana(page);
    const sidebar = sidebarOf(page);
    const deposit = sidebar.getByRole("button", { name: "Deposit", exact: true });
    const title = "Deposits need an EVM wallet for now. Connect one.";
    await expect(deposit).toHaveAttribute("title", title);

    await deposit.click();
    await expect(modalOf(page).getByRole("button", { name: "MetaMask" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(modalOf(page)).toHaveCount(0);

    await expect(sidebar.locator("header").first().getByRole("img", { name: "Solana" })).toBeVisible();
    await expect(sidebar.getByRole("status")).toHaveText("");
    await expect(deposit).toHaveAttribute("title", title);
});
