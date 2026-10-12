import { expect, test, type Page } from "@playwright/test";
import { randomAddress, randomSolanaAddress } from "./backend";
import {
    ARC_RPC,
    installSolanaWallet,
    installWallet,
    mockArcRpc,
    mockPrivy,
    pickWallet,
    pickWallet as signInAs,
    walletRequests,
} from "./privy-mock";

test("signing in with a Solana wallet opens the account, with Solana in the header", async ({ page }) => {
    const address = randomSolanaAddress();
    pickWallet(page, address);
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

/** From Deposit's list, links the page's MetaMask. */
async function connectEvmFromDeposit(page: Page) {
    await sidebarOf(page).getByRole("button", { name: "Deposit", exact: true }).click();
    await sidebarOf(page).getByRole("button", { name: "Connect an EVM wallet" }).click();
    await modalOf(page).getByRole("button", { name: "MetaMask" }).click();
}

/** Opens Deposit's list and picks USDC on Arc. */
async function pickUsdcOnArc(page: Page) {
    await sidebarOf(page).getByRole("button", { name: "Deposit", exact: true }).click();
    await sidebarOf(page)
        .getByRole("button", { name: /^USDC on Arc/ })
        .click();
}

test("a Solana-first user connects an EVM wallet from Deposit, then deposits", async ({ page }) => {
    await signInWithSolana(page);
    const header = sidebarOf(page).locator("header").first();
    await expect(header.getByRole("img", { name: "Solana" })).toBeVisible();

    await connectEvmFromDeposit(page);

    await expect(header.getByRole("img", { name: "Ethereum" })).toBeVisible({ timeout: 10_000 });
    await pickUsdcOnArc(page);
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

/** Overwrites the wallet the app remembers as active, the way the app stores it. */
const remember = (page: Page, wallet: { kind: "evm" | "solana"; address: string }) =>
    page.evaluate((wallet) => {
        const key = Object.keys(localStorage).find((k) => k.startsWith("active-wallet:"));
        localStorage.setItem(key!, JSON.stringify(wallet));
        // The page only hears of changes from other tabs; tell it about this one.
        window.dispatchEvent(new Event("storage"));
    }, wallet);

test("the remembered wallet wins over the most recently linked one", async ({ page }) => {
    const { address, evm } = await signInWithSolana(page);
    await connectEvmFromDeposit(page);
    const header = sidebarOf(page).locator("header").first();
    // The EVM wallet is now both the latest linked and the active one.
    await expect(header.getByRole("img", { name: "Ethereum" })).toBeVisible({ timeout: 10_000 });

    await remember(page, { kind: "solana", address });
    await page.reload();

    await expect(header.getByRole("img", { name: "Solana" })).toBeVisible({ timeout: 20_000 });
    await expect(header).toContainText(`${address.slice(0, 6)}…${address.slice(-4)}`);
    await expect(header).not.toContainText(evm.slice(0, 6));
});

test("a remembered wallet that is no longer linked falls back to the first linked one", async ({ page }) => {
    const { address, evm } = await signInWithSolana(page);
    await connectEvmFromDeposit(page);
    await expect(sidebarOf(page).locator("header").first().getByRole("img", { name: "Ethereum" })).toBeVisible({
        timeout: 10_000,
    });
    const stranger = randomAddress();
    await remember(page, { kind: "evm", address: stranger });

    await page.reload();
    const header = sidebarOf(page).locator("header").first();
    await expect(header).toContainText(`${address.slice(0, 6)}…${address.slice(-4)}`, { timeout: 20_000 });
    await expect(header).not.toContainText(stranger.slice(0, 6));
    await expect(header).not.toContainText(evm.slice(0, 6));
    await expect(header.getByRole("img", { name: "Solana" })).toBeVisible();
});

test("dismissing the link modal changes nothing", async ({ page }) => {
    await signInWithSolana(page);
    const sidebar = sidebarOf(page);
    await sidebar.getByRole("button", { name: "Deposit", exact: true }).click();
    await sidebar.getByRole("button", { name: "Connect an EVM wallet" }).click();
    await expect(modalOf(page).getByRole("button", { name: "MetaMask" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(modalOf(page)).toHaveCount(0);

    await expect(sidebar.locator("header").first().getByRole("img", { name: "Solana" })).toBeVisible();
    await expect(sidebar.getByRole("status")).toHaveText("");
});

test("a both-wallets user active on Solana deposits from their EVM wallet, with its balance shown", async ({
    page,
}) => {
    test.setTimeout(60_000);
    const { address, evm } = await signInWithSolana(page);
    await connectEvmFromDeposit(page);
    const header = sidebarOf(page).locator("header").first();
    await expect(header.getByRole("img", { name: "Ethereum" })).toBeVisible({ timeout: 10_000 });
    // No reload: the mock MetaMask forgets its connection on one, and the deposit needs it.
    await remember(page, { kind: "solana", address });
    await expect(header.getByRole("img", { name: "Solana" })).toBeVisible({ timeout: 20_000 });

    const sidebar = sidebarOf(page);
    await pickUsdcOnArc(page);
    const amount = sidebar.getByRole("textbox", { name: "Deposit amount" });
    await expect(amount).toBeFocused();
    await expect(sidebar.locator("#deposit-wallet")).toHaveText("In your wallet: $100.00", { timeout: 20_000 });
    await sidebar.getByRole("button", { name: "Max" }).click();
    await expect(amount).not.toHaveValue("");
    await sidebar.getByRole("button", { name: "Deposit", exact: true }).click();

    await expect
        .poll(async () => (await walletRequests(page)).filter((r) => r.method === "eth_sendTransaction").length)
        .toBe(1);
    const sent = (await walletRequests(page)).find((r) => r.method === "eth_sendTransaction");
    expect(((sent?.params?.[0] as { from?: string }).from ?? "").toLowerCase()).toBe(evm.toLowerCase());
});
