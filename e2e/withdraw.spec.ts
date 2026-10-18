import { expect, test, type Locator, type Page } from "@playwright/test";
import {
    chainRpc,
    failNextPayout,
    fundTreasury,
    pauseDepositScan,
    randomAddress,
    randomSolanaAddress,
    resumeDepositScan,
    seedDeposits,
} from "./backend";
import { addressOf, installSolanaWallet, installWallet, mockArcRpc, mockPrivy } from "./privy-mock";

// The treasury is shared by the whole backend: every test that withdraws or sets it lives in this file, which runs
// one test at a time and only on desktop, so nothing withdraws meanwhile. A payout made to fail belongs to its
// recipient. Touch is covered by the deposit history's tests.
test.describe.configure({ mode: "serial" });
test.skip(({ isMobile }) => isMobile, "shares the treasury with the desktop run");

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Wallet" });
const modal = (page: Page) => page.locator("#privy-modal-content");
const balanceButton = (page: Page) => sidebar(page).getByRole("button", { name: /^Balance/ });
const withdrawButton = (page: Page) => sidebar(page).getByRole("button", { name: "Withdraw", exact: true });
const amountField = (page: Page) => sidebar(page).getByRole("textbox", { name: "Withdraw amount" });
const LOSS = "rgb(255, 107, 91)";
/** What the e2e payout error "insufficient funds for gas * price + value" reads as. */
const PAYOUT_REFUSED =
    "Our payout wallet can't cover the network fee right now, so the network refused it. Your balance is back.";
const status = (page: Page) => sidebar(page).getByRole("status");
const history = (page: Page) => sidebar(page).getByRole("list", { name: "History" });
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** Whether the $ sign, the digits and Max sit side by side inside the field, each in view and apart. */
const fieldFits = (input: Locator) =>
    input.evaluate((el) => {
        const field = el.closest("label")!;
        const box = (node: Element) => node.getBoundingClientRect();
        const prefix = box(field.querySelector('[aria-hidden="true"]')!);
        const max = box(field.querySelector("button")!);
        const [f, i] = [box(field), box(el)];
        const tol = 1;
        // Scrolled digits stop short of the $ sign and of Max.
        const style = getComputedStyle(el);
        if (parseFloat(style.paddingLeft) < 6 || parseFloat(style.paddingRight) < 6) return false;
        return (
            prefix.left >= f.left - tol &&
            prefix.right <= i.left + tol &&
            i.right <= max.left + tol &&
            max.right <= f.right + tol
        );
    });

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
        .filter({ hasText: `−$50.00 to ${short(wallet)}` });
    await expect(row).toContainText("Sending");
    await expect(row).toContainText(/now|\d+m ago/, { timeout: 15_000 });
    await expect(row).not.toContainText("Sending");
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

test("the wallet in use is Solana with an EVM wallet linked: Solana is the default, and the maximum is the credited balance", async ({
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
    // The server's own scan would credit the deposit within moments, so it stays off until the end.
    await pauseDepositScan();
    try {
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
        // The wallet in use is picked to begin with; the EVM wallet is picked to be paid.
        const picker = sidebar(page).getByRole("radiogroup", { name: "Withdraw to" });
        await expect(picker.getByRole("radio", { name: short(solana) })).toBeChecked();
        await picker.getByRole("radio", { name: short(evm) }).click();
        await sidebar(page).getByRole("button", { name: "Withdraw", exact: true }).click();
        await expect.poll(async () => (await arcBalance(evm)) - before).toBe(ether(100));
    } finally {
        await resumeDepositScan();
    }
});

test("a failed payout puts the balance back and says so", async ({ page }) => {
    await signIn(page);
    await failNextPayout(addressOf(page));
    await withdraw(page, "50");
    await expect(status(page)).toHaveText(PAYOUT_REFUSED, { timeout: 20_000 });
    // The Deposit button isn't told a deposit failed.
    const depositButton = sidebar(page).getByRole("button", { name: "Deposit", exact: true });
    await expect(depositButton).toHaveAttribute("data-phase", "idle");
    await expect(depositButton).not.toHaveAttribute("aria-busy", "true");
    await expect(balanceButton(page)).toHaveAccessibleName("Balance $200.00, show deposits");
    await showHistory(page);
    const failed = history(page).getByRole("listitem").filter({ hasText: "−$50.00" });
    await expect(failed).toContainText("Failed");
    await expect(failed).toContainText(PAYOUT_REFUSED);
    // The recipient reads whole: the status gives way, not the address.
    await expect(failed).toContainText(`to ${short(addressOf(page))}`);
    const amount = failed.locator("span").first();
    expect(await amount.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
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

test("Escape on a recipient row closes only the form", async ({ page }) => {
    await signIn(page, [randomAddress()]);
    await withdrawButton(page).click();
    const picker = sidebar(page).getByRole("radiogroup", { name: "Withdraw to" });
    await picker.getByRole("radio", { name: short(addressOf(page)) }).focus();
    await page.keyboard.press("Escape");
    await expect(amountField(page)).toHaveCount(0);
    await expect(withdrawButton(page)).toBeFocused();
    await expect(sidebar(page)).toHaveAttribute("data-open", "true");
});

test("arrow keys move the picked recipient", async ({ page }) => {
    const second = randomAddress();
    const third = randomAddress();
    await signIn(page, [second, third]);
    const first = addressOf(page);
    await withdrawButton(page).click();
    const picker = sidebar(page).getByRole("radiogroup", { name: "Withdraw to" });
    const radio = (address: string) => picker.getByRole("radio", { name: short(address) });
    // Only the picked row is a tab stop.
    await expect(radio(first)).toHaveAttribute("tabindex", "0");
    await expect(radio(second)).toHaveAttribute("tabindex", "-1");
    await radio(first).focus();

    await page.keyboard.press("ArrowDown");
    await expect(radio(second)).toBeChecked();
    await expect(radio(second)).toBeFocused();
    await expect(radio(second)).toHaveAttribute("tabindex", "0");
    await expect(radio(first)).toHaveAttribute("tabindex", "-1");
    await page.keyboard.press("ArrowRight");
    await expect(radio(third)).toBeChecked();
    // It wraps at the end, and goes back with Up and Left.
    await page.keyboard.press("ArrowDown");
    await expect(radio(first)).toBeChecked();
    await page.keyboard.press("ArrowUp");
    await expect(radio(third)).toBeChecked();
    await page.keyboard.press("ArrowLeft");
    await expect(radio(second)).toBeChecked();
    await expect(radio(second)).toBeFocused();
});

test("a long amount stays inside the field, between the $ sign and Max", async ({ page }) => {
    await signIn(page);
    await withdrawButton(page).click();
    // The server's maximum is read as the form opens, which is when Max appears.
    await expect(sidebar(page).getByRole("button", { name: "Max" })).toBeVisible();
    await amountField(page).fill("99999999.123456");
    expect(await fieldFits(amountField(page))).toBe(true);
});

// The PnL page's own pieces: the wallet button up top comes after the page's content, which may have a Connect button.
const walletButton = (page: Page) => page.getByRole("button", { name: /^(Wallet|Connect wallet)/ }).last();
const chart = (page: Page) => page.getByRole("slider", { name: "Balance by day" });
const activity = (page: Page) => page.getByRole("region", { name: "Activity" });
const rows = (page: Page) => activity(page).locator("tbody tr");

test("the PnL feed lists a withdrawal under Deposits, and the chart drops by it", async ({ page }) => {
    await mockPrivy(page);
    await mockArcRpc(page);
    await installWallet(page);
    await seedDeposits(addressOf(page), [{ amount: "200", daysAgo: 1 }]);
    await page.goto("/pnl");
    await walletButton(page).click();
    await modal(page).getByRole("button", { name: "MetaMask" }).click();
    await waitForAccount(page);
    // Privy hands focus back to the wallet button a moment after its modal closes.
    await expect(walletButton(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(sidebar(page)).toHaveAttribute("data-open", "false");
    await expect(chart(page)).toHaveAttribute("aria-valuetext", /: \$200\.00$/);

    await walletButton(page).click();
    await withdraw(page, "50");
    await expect(balanceButton(page)).toHaveAccessibleName("Balance $150.00, show deposits");
    await page.keyboard.press("Escape");
    await expect(sidebar(page)).toHaveAttribute("data-open", "false");

    await expect(chart(page)).toHaveAttribute("aria-valuetext", /: \$150\.00$/);
    const row = rows(page).filter({ hasText: "Withdrawal" });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("USDC to 0x");
    await expect(row).toContainText("−$50.00");
    // Money moved, not a loss.
    await expect(row.locator("span", { hasText: "−$50.00" })).not.toHaveCSS("color", LOSS);
    // The day it happened reads as a withdrawal, not a negative deposit.
    await chart(page).focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowRight");
    await expect(chart(page)).toHaveAttribute("aria-valuenow", "30");
    await expect(page.getByRole("main").getByRole("region", { name: /^Balance/ })).toContainText(
        "PnL that day, and $50.00 withdrawn",
    );
    await activity(page).getByRole("radio", { name: "Deposits" }).click();
    await expect(rows(page)).toHaveCount(2);
    await activity(page).getByRole("radio", { name: "Trades" }).click();
    await expect(rows(page)).toHaveCount(0);
});
