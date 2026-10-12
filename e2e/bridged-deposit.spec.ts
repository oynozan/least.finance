import { expect, test, type Page } from "@playwright/test";
import { advanceBridge, chainRpc, fundSource, randomAddress, randomSolanaAddress } from "./backend";
import {
    addressOf,
    installSolanaWallet,
    installWallet,
    mockArcRpc,
    mockPrivy,
    moveWalletTo,
    useWallet,
    walletRequests,
} from "./privy-mock";

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

const sidebarOf = (page: Page) => page.getByRole("complementary", { name: "Wallet" });
const coinsOf = (page: Page) => sidebarOf(page).getByRole("list", { name: "Coins to deposit" });
const depositOf = (page: Page) => sidebarOf(page).getByRole("button", { name: "Deposit", exact: true });
const amountOf = (page: Page) => sidebarOf(page).getByRole("textbox", { name: "Deposit amount" });
const hintOf = (page: Page) => sidebarOf(page).locator("#deposit-hint");
const statusOf = (page: Page) => sidebarOf(page).getByRole("status");
const balanceOf = (page: Page) => sidebarOf(page).getByRole("button", { name: /^Balance/ });
const stepOf = (page: Page, name: string) => statusOf(page).getByRole("listitem").filter({ hasText: name });

const LOSS = "rgb(255, 107, 91)";

/** Signs in with the page's wallet, which the backend funds with 1 ETH and 1 BNB; `funds` adds more. */
async function signIn(page: Page, funds: Record<string, string> = {}) {
    test.setTimeout(90_000);
    await mockPrivy(page);
    await installWallet(page);
    await mockArcRpc(page, 0);
    for (const [coin, amount] of Object.entries(funds)) await fundSource(addressOf(page), coin, amount);
    await page.goto("/");
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await page.locator("#privy-modal-content").getByRole("button", { name: "MetaMask" }).click();
    await expect(sidebarOf(page)).toHaveAttribute("data-open", "true", { timeout: 10_000 });
    await expect(balanceOf(page)).toHaveAccessibleName(/^Balance \$/, { timeout: 20_000 });
}

/** Picks a coin row and types an amount, with the wallet on Arc so the deposit has to move it. */
async function fill(page: Page, row: RegExp, amount: string) {
    await depositOf(page).click();
    await coinsOf(page).getByRole("button", { name: row }).click();
    await amountOf(page).fill(amount);
}

const sends = async (page: Page) => (await walletRequests(page)).filter((r) => r.method === "eth_sendTransaction");

test("a bridged deposit shows each step and lands in the balance", async ({ page, isMobile }) => {
    await signIn(page);
    await moveWalletTo(page, "0x13b2");
    await fill(page, /^ETH on Ethereum/, "0.1");
    await expect(hintOf(page)).toHaveText("≈ $300.00 in about 2 s");

    await depositOf(page).click();
    await expect
        .poll(async () => (await walletRequests(page)).some((r) => r.method === "wallet_switchEthereumChain"))
        .toBe(true);
    const switches = (await walletRequests(page)).filter((r) => r.method === "wallet_switchEthereumChain");
    expect((switches.at(-1)?.params?.[0] as { chainId: string }).chainId).toBe("0x1");
    await expect(stepOf(page, "In a block")).toHaveAttribute("data-step", "done", { timeout: 20_000 });
    await expect(depositOf(page)).toHaveAttribute("data-phase", "running");

    await advanceBridge(addressOf(page), "pending");
    await expect(stepOf(page, "Bridging to Arc")).toHaveAttribute("data-step", "active", { timeout: 20_000 });
    await expect(stepOf(page, "Bridging to Arc")).toContainText("about 2 s");

    await advanceBridge(addressOf(page), "filled");
    await expect(stepOf(page, "Added")).toHaveAttribute("data-step", "done", { timeout: 20_000 });
    await expect(depositOf(page)).toHaveAttribute("data-phase", "done");
    await expect(balanceOf(page)).toHaveAccessibleName("Balance $300.00, show deposits", { timeout: 20_000 });

    if (isMobile) await balanceOf(page).tap();
    else await balanceOf(page).hover();
    await expect(sidebarOf(page).getByRole("list", { name: "Deposits" })).toContainText(
        "+$300.00 · 0.1 ETH on Ethereum",
    );
});

test("a USDT deposit from BNB Chain approves, then sends", async ({ page }) => {
    await signIn(page, { "bnb:USDT": "250" });
    await fill(page, /^USDT on BNB Chain/, "100");
    await depositOf(page).click();

    await expect(stepOf(page, "In a block")).toHaveAttribute("data-step", "done", { timeout: 20_000 });
    const sent = await sends(page);
    expect(sent).toHaveLength(2);
    for (const request of sent) expect((request.params?.[0] as { chainId: string }).chainId).toBe("0x38");
    expect((sent[0]!.params?.[0] as { to: string }).to.toLowerCase()).toBe(BNB_USDT.toLowerCase());
});

test("a refunded bridge says so and adds nothing", async ({ page }) => {
    await signIn(page);
    await fill(page, /^ETH on Ethereum/, "0.1");
    await depositOf(page).click();
    await expect(stepOf(page, "In a block")).toHaveAttribute("data-step", "done", { timeout: 20_000 });

    await advanceBridge(addressOf(page), "refunded");
    await expect(statusOf(page)).toHaveText("Refunded to your wallet", { timeout: 20_000 });
    await expect(depositOf(page)).toHaveAttribute("data-phase", "error");
    await expect(balanceOf(page)).toHaveAccessibleName("Balance $0.00, show deposits");
});

test("turning down the second wallet prompt cancels quietly", async ({ page }) => {
    await signIn(page, { "bnb:USDT": "250" });
    // The wallet takes the approval and turns down the deposit that follows it.
    await page.evaluate(() => {
        const wallet = (window as unknown as { ethereum: { request: (r: { method: string }) => Promise<unknown> } })
            .ethereum;
        const request = wallet.request.bind(wallet);
        let sent = 0;
        wallet.request = async (args) => {
            if (args.method === "eth_sendTransaction" && ++sent === 2)
                throw Object.assign(new Error("User rejected the request."), { code: 4001 });
            return request(args);
        };
    });
    await fill(page, /^USDT on BNB Chain/, "100");
    await depositOf(page).click();

    await expect(depositOf(page), "the form is ready again").toBeVisible({ timeout: 20_000 });
    await expect(amountOf(page), "the amount stays, ready to try again").toHaveValue("100");
    await expect(statusOf(page)).toHaveText("");
    await expect(hintOf(page)).not.toContainText("couldn't");
    expect(await sends(page)).toHaveLength(1);
    await sidebarOf(page).getByRole("button", { name: "Cancel deposit" }).click();
    await expect(depositOf(page)).toHaveAttribute("data-phase", "idle");
    await expect(statusOf(page)).toHaveText("");
});

test("a reload mid-deposit picks the progress back up", async ({ page }) => {
    await signIn(page);
    await fill(page, /^ETH on Ethereum/, "0.1");
    await depositOf(page).click();
    await expect(stepOf(page, "In a block")).toHaveAttribute("data-step", "done", { timeout: 20_000 });

    await page.reload();
    await page.getByRole("button", { name: /^Wallet 0x/ }).click();
    await expect(depositOf(page)).toHaveAttribute("data-phase", "running", { timeout: 20_000 });
    await expect(stepOf(page, "In a block")).toHaveAttribute("data-step", "done");

    await advanceBridge(addressOf(page), "filled");
    await expect(stepOf(page, "Added")).toHaveAttribute("data-step", "done", { timeout: 20_000 });
    await expect(balanceOf(page)).toHaveAccessibleName("Balance $300.00, show deposits", { timeout: 20_000 });
});

test("more than the coin's balance turns the amount red and shakes it", async ({ page }) => {
    await signIn(page);
    await fill(page, /^ETH on Ethereum/, "");
    const shaking = amountOf(page).evaluate(
        (input) =>
            new Promise<boolean>((resolve) => {
                const field = input.closest("label")!;
                const start = performance.now();
                const check = () => {
                    if (new DOMMatrix(getComputedStyle(field).transform).m41 !== 0) return resolve(true);
                    if (performance.now() - start > 500) return resolve(false);
                    requestAnimationFrame(check);
                };
                check();
            }),
    );
    await amountOf(page).fill("2");
    expect(await shaking).toBe(true);
    await expect(amountOf(page)).toHaveCSS("color", LOSS);
    await expect(amountOf(page)).toHaveAccessibleDescription("That's more than your wallet holds, after gas.");
    await expect(depositOf(page)).toHaveAttribute("aria-disabled", "true");

    await amountOf(page).fill("0.5");
    await expect(amountOf(page)).not.toHaveCSS("color", LOSS);
    await expect(depositOf(page)).not.toHaveAttribute("aria-disabled");
});

test("the sent coin's balance drops at once", async ({ page }) => {
    await signIn(page);
    await depositOf(page).click();
    await expect(coinsOf(page).getByRole("button", { name: /^ETH on Ethereum, 1 ETH/ })).toBeVisible({
        timeout: 20_000,
    });
    await coinsOf(page)
        .getByRole("button", { name: /^ETH on Ethereum/ })
        .click();
    await amountOf(page).fill("0.1");
    await depositOf(page).click();
    await expect(amountOf(page)).toHaveCount(0, { timeout: 20_000 });

    await depositOf(page).click();
    await expect(coinsOf(page).getByRole("button", { name: /^ETH on Ethereum, 0\.9 ETH/ })).toBeVisible();
});
