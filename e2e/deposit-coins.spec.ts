import { expect, test, type Page } from "@playwright/test";
import { randomAddress, randomSolanaAddress, sendFromOutside } from "./backend";
import { addressOf, installSolanaWallet, installWallet, mockArcRpc, mockPrivy, useWallet } from "./privy-mock";

const sidebarOf = (page: Page) => page.getByRole("complementary", { name: "Wallet" });
const modalOf = (page: Page) => page.locator("#privy-modal-content");
const coinsOf = (page: Page) => sidebarOf(page).getByRole("list", { name: "Coins to deposit" });
const depositOf = (page: Page) => sidebarOf(page).getByRole("button", { name: "Deposit", exact: true });
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

async function waitForAccount(page: Page) {
    await expect(sidebarOf(page)).toHaveAttribute("data-open", "true", { timeout: 10_000 });
    await expect(sidebarOf(page).getByRole("button", { name: /^Balance/ })).toHaveAccessibleName(/^Balance \$/, {
        timeout: 20_000,
    });
}

/** Signs in with the page's MetaMask. */
async function signInWithEvm(page: Page, arcUsdc = 100) {
    await mockPrivy(page);
    await installWallet(page);
    await mockArcRpc(page, arcUsdc);
    await page.goto("/");
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await modalOf(page).getByRole("button", { name: "MetaMask" }).click();
    await waitForAccount(page);
}

async function signInWithSolana(page: Page) {
    const address = randomSolanaAddress();
    useWallet(page, address);
    await installSolanaWallet(page, address);
    await mockPrivy(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await modalOf(page).getByRole("button", { name: "Phantom" }).click();
    await waitForAccount(page);
}

/** The frames the page's sockets have sent that carry `text`. */
function sentFrames(page: Page, text: string) {
    const frames: string[] = [];
    page.on("websocket", (socket) =>
        socket.on("framesent", ({ payload }) => {
            if (String(payload).includes(text)) frames.push(String(payload));
        }),
    );
    return frames;
}

test("Deposit lists every supported coin, even at zero", async ({ page }) => {
    await signInWithEvm(page);
    await depositOf(page).click();

    const coins = coinsOf(page);
    await expect(coins.getByRole("button")).toHaveCount(8);
    await expect(coins.getByRole("button").last()).toHaveAccessibleName("Connect a Solana wallet");
    for (const name of [
        "ETH on Ethereum",
        "USDC on Ethereum",
        "USDT on Ethereum",
        "BNB on BNB Chain",
        "USDC on BNB Chain",
        "USDT on BNB Chain",
        "USDC on Arc",
    ])
        await expect(coins.getByRole("button", { name })).toBeVisible();

    const eth = coins.getByRole("button", { name: "ETH on Ethereum" });
    // Ethereum and BNB Chain rows are open; only Solana's wait (see the Solana-only test).
    await expect(eth).not.toHaveAttribute("aria-disabled");
    await expect(eth).not.toHaveAttribute("title");
    await expect(sidebarOf(page).getByText(/checking|loading/i)).toHaveCount(0);
});

test("USDC on Arc opens the amount field for that wallet", async ({ page }) => {
    await signInWithEvm(page, 100);
    await depositOf(page).click();
    await coinsOf(page)
        .getByRole("button", { name: /^USDC on Arc/ })
        .click();

    await expect(sidebarOf(page).getByRole("textbox", { name: "Deposit amount" })).toBeFocused();
    await expect(sidebarOf(page).locator("#deposit-wallet")).toHaveText("In your wallet: $100.00");
    await expect(coinsOf(page)).toHaveCount(0);
});

test("Escape closes the list and returns to the Deposit button", async ({ page }) => {
    await signInWithEvm(page);
    await depositOf(page).click();
    await expect(coinsOf(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(coinsOf(page)).toHaveCount(0);
    await expect(depositOf(page)).toBeVisible();
});

test("a Solana-only user sees SOL and USDC on Solana, plus Connect an EVM wallet", async ({ page }) => {
    await signInWithSolana(page);
    await depositOf(page).click();

    const coins = coinsOf(page);
    await expect(coins.getByRole("button")).toHaveCount(3);
    await expect(coins.getByRole("button", { name: "SOL on Solana" })).toHaveAttribute("aria-disabled", "true");
    await expect(coins.getByRole("button", { name: "USDC on Solana" })).toHaveAttribute(
        "title",
        "Deposits from Solana aren't open yet.",
    );
    await expect(coins.getByRole("button", { name: "Connect an EVM wallet" })).toBeVisible();
    await expect(coins.getByRole("button", { name: "ETH on Ethereum" })).toHaveCount(0);
});

test("a reload shows the cached balances before the push", async ({ page }) => {
    await signInWithEvm(page);
    await depositOf(page).click();
    const arc = coinsOf(page).getByRole("button", { name: /^USDC on Arc, 20,000 USDC/ });
    await expect(arc).toBeVisible({ timeout: 20_000 });

    // Hold the balances back, so only the cache can fill the list.
    await page.routeWebSocket(/socket\.io/, (ws) => {
        const server = ws.connectToServer();
        ws.onMessage((message) => server.send(message));
        server.onMessage((message) => {
            if (String(message).includes('"balances"')) setTimeout(() => ws.send(message), 15_000);
            else ws.send(message);
        });
    });
    await page.reload();
    await expect(sidebarOf(page).getByRole("button", { name: /^Balance/ })).toHaveAccessibleName(/^Balance \$/, {
        timeout: 20_000,
    });
    // The sidebar starts shut after a reload.
    await page.getByRole("button", { name: /^Wallet 0x/ }).click();
    await depositOf(page).click();

    await expect(coinsOf(page).getByRole("button", { name: /^USDC on Arc, 20,000 USDC/ })).toBeVisible({
        timeout: 3_000,
    });
});

test("a second Deposit click within 30 s sends nothing", async ({ page }) => {
    const refreshes = sentFrames(page, "balances:refresh");
    // The page's clock runs ahead by `skew`, without freezing its animations.
    await page.addInitScript(() => {
        const w = window as unknown as { skew: number };
        const now = Date.now.bind(Date);
        w.skew = 0;
        Date.now = () => now() + w.skew;
    });
    await signInWithEvm(page);
    const before = refreshes.length;

    await depositOf(page).click();
    await page.keyboard.press("Escape");
    await depositOf(page).click();
    await page.waitForTimeout(500);
    expect(refreshes, "inside 30 s").toHaveLength(before);

    await page.keyboard.press("Escape");
    await page.evaluate(() => ((window as unknown as { skew: number }).skew += 31_000));
    await depositOf(page).click();
    await expect.poll(() => refreshes.length, "after 30 s").toBe(before + 1);
});

test("two EVM wallets show the short address on their rows", async ({ page }) => {
    test.setTimeout(90_000);
    const second = randomAddress();
    await mockPrivy(page, [second]);
    await installWallet(page);
    const first = addressOf(page);
    await mockArcRpc(page, 100, first, { [second]: 250 });
    await sendFromOutside(second, "5");
    await page.goto("/");
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await modalOf(page).getByRole("button", { name: "MetaMask" }).click();
    await waitForAccount(page);

    await depositOf(page).click();
    const coins = coinsOf(page);
    await expect(coins.getByRole("button", { name: new RegExp(`^USDC on Arc.*${short(first)}$`, "i") })).toBeVisible();
    await expect(coins.getByRole("button", { name: new RegExp(`^USDC on Arc.*${short(second)}$`, "i") })).toBeVisible();
    await expect(
        coins.getByRole("button", { name: new RegExp(`^ETH on Ethereum.*${short(second)}$`, "i") }),
    ).toBeVisible();

    // Each row deposits from its own wallet and shows that wallet's balance.
    await coins.getByRole("button", { name: new RegExp(`^USDC on Arc.*${short(second)}$`, "i") }).click();
    await expect(sidebarOf(page).locator("#deposit-wallet")).toHaveText("In your wallet: $250.00", { timeout: 15_000 });
    await sidebarOf(page).getByRole("button", { name: "Cancel deposit" }).click();

    await depositOf(page).click();
    await coins.getByRole("button", { name: new RegExp(`^USDC on Arc.*${short(first)}$`, "i") }).click();
    await expect(sidebarOf(page).locator("#deposit-wallet")).toHaveText("In your wallet: $100.00", { timeout: 15_000 });
});
