import { expect, test, type Page } from "@playwright/test";
import { chainRpc, failNextPayout, fundTreasury, randomAddress, randomSolanaAddress, seedDeposits } from "./backend";
import { addressOf, installSolanaWallet, installWallet, mockArcRpc, mockPrivy, pickWallet } from "./privy-mock";

// The treasury and the next payout are shared by the whole backend: these run one at a time, and only on desktop,
// so the phone project can't withdraw in between. Touch is covered by the deposit history's tests.
test.describe.configure({ mode: "serial" });
test.skip(({ isMobile }) => isMobile, "shares the treasury with the desktop run");

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Wallet" });
const modal = (page: Page) => page.locator("#privy-modal-content");
const balanceButton = (page: Page) => sidebar(page).getByRole("button", { name: /^Balance/ });
const withdrawButton = (page: Page) => sidebar(page).getByRole("button", { name: "Withdraw", exact: true });
const amountField = (page: Page) => sidebar(page).getByRole("textbox", { name: "Withdraw amount" });
const status = (page: Page) => sidebar(page).getByRole("status");
const history = (page: Page) => sidebar(page).getByRole("list", { name: "Deposits" });
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const LOSS = "rgb(255, 107, 91)";

test.beforeEach(async () => {
    test.setTimeout(60_000);
    await fundTreasury("100000");
});

/** Whether the amount field moves sideways within half a second of now. */
const shakes = (page: Page) =>
    amountField(page).evaluate(
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

async function waitForAccount(page: Page, balance = "$200.00") {
    await expect(sidebar(page)).toHaveAttribute("data-open", "true", { timeout: 10_000 });
    await expect(balanceButton(page)).toHaveAccessibleName(`Balance ${balance}, show deposits`, { timeout: 20_000 });
}

/** Signs in with the page's MetaMask, whose account already holds 200 USDC, plus the wallets in `also`. */
async function signIn(page: Page, also: string[] = []) {
    await mockPrivy(page, also);
    await installWallet(page);
    await mockArcRpc(page, 100);
    await seedDeposits(addressOf(page), [{ amount: "200", daysAgo: 1 }]);
    await page.goto("/");
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await modal(page).getByRole("button", { name: "MetaMask" }).click();
    await waitForAccount(page);
}

const arcBalance = async (wallet: string) => BigInt((await chainRpc("eth_getBalance", [wallet])).result as string);
const ether = (usdc: number) => BigInt(usdc) * BigInt(10) ** BigInt(18);

/** Holds back the server's pushes that carry `text` for `ms`. */
async function delayPushes(page: Page, text: string, ms: number) {
    await page.routeWebSocket(/socket\.io/, (ws) => {
        const server = ws.connectToServer();
        ws.onMessage((message) => server.send(message));
        server.onMessage((message) => {
            if (String(message).includes(text)) setTimeout(() => ws.send(message), ms);
            else ws.send(message);
        });
    });
}

async function showHistory(page: Page) {
    await balanceButton(page).hover();
    await expect(history(page)).toBeVisible();
}

async function withdraw(page: Page, amount: string) {
    await withdrawButton(page).click();
    await amountField(page).fill(amount);
    await sidebar(page).getByRole("button", { name: "Withdraw", exact: true }).click();
}

test("withdrawing drops the balance at once and pays the wallet", async ({ page }) => {
    await delayPushes(page, "withdrawal:update", 2_500);
    await signIn(page);
    const wallet = addressOf(page);
    const before = await arcBalance(wallet);

    await withdraw(page, "50");
    await expect(balanceButton(page)).toHaveAccessibleName("Balance $150.00, show deposits");
    await showHistory(page);
    const row = history(page)
        .getByRole("listitem")
        .filter({ hasText: `−$50.00 · to ${short(wallet)}` });
    await expect(row).toContainText("Sending");
    await expect(row).toContainText("Sent", { timeout: 15_000 });
    await expect(balanceButton(page)).toHaveAccessibleName("Balance $150.00, show deposits");
    await expect.poll(async () => (await arcBalance(wallet)) - before).toBe(ether(50));
});

test("more than the maximum turns the amount red and shakes it", async ({ page }) => {
    await signIn(page);
    // Other tests' deposits are swept into the treasury meanwhile, so set it again until the form reads it.
    await expect(async () => {
        await fundTreasury("30");
        // A try before this one left the form open.
        if (await amountField(page).count())
            await sidebar(page).getByRole("button", { name: "Cancel withdrawal" }).click();
        await withdrawButton(page).click();
        await expect(sidebar(page).locator("#withdraw-max")).toHaveText("You can withdraw up to $30.00", {
            timeout: 3_000,
        });
    }).toPass({ timeout: 30_000 });

    await amountField(page).fill("20");
    await expect(amountField(page)).not.toHaveCSS("color", LOSS);
    const shook = shakes(page);
    await amountField(page).fill("40");
    expect(await shook).toBe(true);
    await expect(amountField(page)).toHaveCSS("color", LOSS);
    await expect(sidebar(page).locator("#withdraw-max")).toHaveText("That's more than you can withdraw right now.");
    await sidebar(page).getByRole("button", { name: "Max" }).click();
    await expect(amountField(page)).toHaveValue("30");
    await expect(amountField(page)).not.toHaveCSS("color", LOSS);
});

test("with two EVM wallets, the picked one is paid", async ({ page }) => {
    const second = randomAddress();
    await signIn(page, [second]);
    const first = addressOf(page);
    const [firstBefore, secondBefore] = [await arcBalance(first), await arcBalance(second)];

    await withdrawButton(page).click();
    const picker = sidebar(page).getByRole("radiogroup", { name: "Withdraw to" });
    // The wallet in use is the one picked to begin with.
    await expect(picker.getByRole("radio", { name: short(first) })).toBeChecked();
    await picker.getByRole("radio", { name: short(second) }).click();
    await expect(picker.getByRole("radio", { name: short(second) })).toBeChecked();
    await amountField(page).fill("10");
    await sidebar(page).getByRole("button", { name: "Withdraw", exact: true }).click();

    await expect.poll(async () => (await arcBalance(second)) - secondBefore).toBe(ether(10));
    expect((await arcBalance(first)) - firstBefore).toBe(BigInt(0));
});

/** Signs in with Phantom, with the page's MetaMask there to link. */
async function signInWithSolana(page: Page) {
    const address = randomSolanaAddress();
    const evm = randomAddress();
    pickWallet(page, address);
    await installSolanaWallet(page, address);
    await installWallet(page, evm);
    await mockPrivy(page);
    await mockArcRpc(page, 100, evm);
    await page.goto("/");
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await modal(page).getByRole("button", { name: "Phantom" }).click();
    await waitForAccount(page, "$0.00");
}

test("a Solana-only person is asked to connect an EVM wallet", async ({ page }) => {
    await signInWithSolana(page);
    await withdrawButton(page).click();
    await expect(sidebar(page).getByRole("radiogroup", { name: "Withdraw to" })).toHaveCount(0);
    await sidebar(page).getByRole("button", { name: "Connect an EVM wallet" }).click();
    await expect(modal(page).getByRole("button", { name: "MetaMask" })).toBeVisible();
    await modal(page).getByRole("button", { name: "MetaMask" }).click();
    await expect(sidebar(page).getByRole("button", { name: "Connect an EVM wallet" })).toHaveCount(0, {
        timeout: 10_000,
    });
});

test("the wallet in use is Solana with an EVM wallet linked: the EVM wallet is the default, and the maximum is the credited balance", async ({
    page,
}) => {
    // Once held, a deposit's report never reaches the server: it stays pending and the balance counts it.
    let hold = false;
    await page.routeWebSocket(/socket\.io/, (ws) => {
        const server = ws.connectToServer();
        ws.onMessage((message) => {
            if (!(hold && String(message).includes("deposit:submit"))) server.send(message);
        });
        server.onMessage((message) => ws.send(message));
    });
    // Signed in with MetaMask, which has Phantom's wallet linked.
    const solana = randomSolanaAddress();
    const evm = addressOf(page);
    await mockPrivy(page, [solana]);
    await installWallet(page);
    await installSolanaWallet(page, solana);
    await mockArcRpc(page, 150);
    await page.goto("/");
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await modal(page).getByRole("button", { name: "MetaMask" }).click();
    await waitForAccount(page, "$0.00");
    const deposit = async (amount: string) => {
        await sidebar(page).getByRole("button", { name: "Deposit", exact: true }).click();
        await sidebar(page)
            .getByRole("button", { name: /^USDC on Arc/ })
            .click();
        await sidebar(page).getByRole("textbox", { name: "Deposit amount" }).fill(amount);
        await sidebar(page).getByRole("button", { name: "Deposit", exact: true }).click();
    };
    await deposit("100");
    await expect(status(page)).toHaveText("Deposited $100.00", { timeout: 20_000 });
    hold = true;
    await deposit("5");
    await expect(balanceButton(page)).toHaveAccessibleName("Balance $105.00, show deposits");

    // Back to Solana as the wallet in use.
    await page.evaluate(
        (wallet) => {
            const key = Object.keys(localStorage).find((k) => k.startsWith("active-wallet:"));
            localStorage.setItem(key!, JSON.stringify(wallet));
            window.dispatchEvent(new Event("storage"));
        },
        { kind: "solana", address: solana },
    );
    await expect(sidebar(page).locator("header").first().getByRole("img", { name: "Solana" })).toBeVisible();

    const before = await arcBalance(evm);
    await withdrawButton(page).click();
    await expect(sidebar(page).locator("#withdraw-max")).toHaveText("You can withdraw up to $100.00");
    await expect(balanceButton(page)).toHaveAccessibleName("Balance $105.00, show deposits");
    await sidebar(page).getByRole("button", { name: "Max" }).click();
    await expect(amountField(page)).toHaveValue("100");
    // The one EVM wallet is the recipient: no picker, and it is the one paid.
    await expect(sidebar(page).getByRole("radiogroup", { name: "Withdraw to" })).toHaveCount(0);
    await sidebar(page).getByRole("button", { name: "Withdraw", exact: true }).click();
    await expect.poll(async () => (await arcBalance(evm)) - before).toBe(ether(100));
});

test("a failed payout puts the balance back and says so", async ({ page }) => {
    await signIn(page);
    await failNextPayout();
    await withdraw(page, "50");
    await expect(status(page)).toHaveText("Didn't go through. Your balance is back.", { timeout: 20_000 });
    await expect(balanceButton(page)).toHaveAccessibleName("Balance $200.00, show deposits");
    await showHistory(page);
    await expect(history(page).getByRole("listitem").filter({ hasText: "−$50.00" })).toContainText("Didn't go through");
});

test("Escape closes the form and returns focus to Withdraw", async ({ page }) => {
    await signIn(page);
    await withdrawButton(page).click();
    await expect(amountField(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(amountField(page)).toHaveCount(0);
    await expect(withdrawButton(page)).toBeFocused();
    await expect(sidebar(page)).toHaveAttribute("data-open", "true");
});
