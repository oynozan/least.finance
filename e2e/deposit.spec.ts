import { expect, test, type Locator, type Page } from "@playwright/test";
import { parseGwei, parseUnits } from "viem";
import { accountOf, sendFromOutside } from "./backend";
import {
    addressOf,
    dropNextSend,
    failNextChainSwitch,
    ignoreNextChainSwitch,
    installWallet,
    mockArcRpc,
    mockPrivy,
    moveWalletTo,
    rejectNextChainSwitch,
    rejectNextSend,
    pickWallet,
    walletChainId,
    walletRequests,
} from "./privy-mock";

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Wallet" });
const modal = (page: Page) => page.locator("#privy-modal-content");
const balanceButton = (page: Page) => sidebar(page).getByRole("button", { name: /^Balance/ });
const depositButton = (page: Page) => sidebar(page).getByRole("button", { name: "Deposit", exact: true });
const amountField = (page: Page) => sidebar(page).getByRole("textbox", { name: "Deposit amount" });
const maxButton = (page: Page) => sidebar(page).getByRole("button", { name: "Max" });
const cancelButton = (page: Page) => sidebar(page).getByRole("button", { name: "Cancel deposit" });
/** The form's button while the wallet is asked to approve. */
const confirming = (page: Page) => sidebar(page).getByRole("button", { name: "Confirm in wallet" });
const hint = (page: Page) => sidebar(page).locator("#deposit-hint");
// Read out, not shown: the wallet's balance, or why the amount is too much.
const wallet = (page: Page) => sidebar(page).locator("#deposit-wallet");
const status = (page: Page) => sidebar(page).getByRole("status");
const deposits = (page: Page) => sidebar(page).getByRole("list", { name: "History" });

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

const DROPPED = "hasn't shown up on Arc";
const LOSS = "rgb(255, 107, 91)";
const FOREGROUND = "rgb(245, 245, 243)";

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

async function connect(page: Page, balance = "$0.00") {
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await modal(page).getByRole("button", { name: "MetaMask" }).click();
    // The account loads over a socket once Privy hands over the token; a loaded machine takes a while.
    await expect(balanceButton(page)).toHaveAccessibleName(`Balance ${balance}, show deposits`, { timeout: 20_000 });
}

/** Opens the page with a wallet holding `wallet` USDC, and signs in to an account holding `balance`. */
async function start(page: Page, wallet?: number, balance?: string) {
    await mockArcRpc(page, wallet);
    await page.goto("/");
    await connect(page, balance);
}

/** Hover reveals the history on desktop; a tap on the balance pins it on touch. */
async function showHistory(page: Page, isMobile: boolean) {
    if (isMobile) await balanceButton(page).tap();
    else await balanceButton(page).hover();
    await expect(deposits(page)).toBeVisible();
}

async function openForm(page: Page) {
    await depositButton(page).click();
    await sidebar(page)
        .getByRole("button", { name: /^USDC on Arc/ })
        .click();
    await expect(amountField(page)).toBeFocused();
}

async function submit(page: Page, amount: string) {
    await openForm(page);
    await amountField(page).fill(amount);
    await depositButton(page).click();
}

const sentTransactions = async (page: Page) =>
    (await walletRequests(page)).filter((r) => r.method === "eth_sendTransaction");

const serverBalance = async (page: Page) => (await accountOf(addressOf(page)))?.balance;

test.beforeEach(async ({ page }) => {
    test.setTimeout(60_000);
    await mockPrivy(page);
    await installWallet(page);
});

test("a deposit counts at once, then the server confirms it", async ({ page }) => {
    await start(page);
    await submit(page, "25");

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

test("a long amount stays inside the field, between the $ sign and Max", async ({ page }) => {
    await start(page, 100);
    await openForm(page);
    await expect(maxButton(page)).toBeVisible();
    await amountField(page).fill("99999999.123456");
    expect(await fieldFits(amountField(page))).toBe(true);
});

test("the form closes once the wallet sends, and the status clears after a few seconds", async ({ page }) => {
    await start(page);
    await submit(page, "5");
    await expect(amountField(page)).toHaveCount(0);
    await expect(depositButton(page)).toBeVisible();
    await expect(status(page)).toHaveText("Deposited $5.00");
    await expect(status(page), "the confirmation fades out on its own").toHaveText("", { timeout: 15_000 });
});

test("max fills the wallet's balance less the gas reserve, and deposits exactly that", async ({ page }) => {
    await start(page, 1234.567);
    await openForm(page);
    await expect(wallet(page)).toHaveText("In your wallet: $1,234.57");
    await maxButton(page).click();
    await expect(amountField(page)).toHaveValue("1234.55");

    await depositButton(page).click();
    await expect(balanceButton(page)).toHaveAccessibleName("Balance $1,234.55, show deposits");
    await expect(status(page)).toHaveText("Deposited $1,234.55");
    expect(await serverBalance(page)).toBe("1234.55");
});

test("max is left out when the wallet holds next to nothing", async ({ page }) => {
    await start(page, 0.01);
    await openForm(page);
    await expect(wallet(page)).toHaveText("In your wallet: $0.01");
    await expect(maxButton(page)).toHaveCount(0);
});

test("an amount below the minimum is refused, and nothing is sent", async ({ page }) => {
    await start(page);
    await openForm(page);
    await amountField(page).fill("0.001");

    await expect(hint(page)).toHaveText("The minimum deposit is $0.01.");
    await expect(amountField(page)).toHaveAttribute("aria-invalid", "true");
    await expect(depositButton(page)).toHaveAttribute("aria-disabled", "true");
    await depositButton(page).click({ force: true });
    await expect(amountField(page), "the form stays as it was").toHaveValue("0.001");
    expect(await sentTransactions(page)).toHaveLength(0);
    expect(await serverBalance(page)).toBe("0");

    await amountField(page).fill("0.01");
    await expect(hint(page)).toBeEmpty();
    await expect(wallet(page)).toHaveText("In your wallet: $12,480.52");
    await expect(depositButton(page)).not.toHaveAttribute("aria-disabled");
});

test("more than the wallet holds, after gas, turns the amount red, shakes it, and is refused", async ({ page }) => {
    await start(page, 100);
    await openForm(page);
    // Nothing is written under the field: the balance is only read out.
    await expect(hint(page)).toBeEmpty();
    await expect(wallet(page)).toHaveText("In your wallet: $100.00");

    let shaking = shakes(page);
    await amountField(page).fill("100");
    expect(await shaking, "going past the wallet shakes the amount").toBe(true);
    await expect(amountField(page)).toHaveCSS("color", LOSS);
    await expect(amountField(page)).toHaveAccessibleDescription("That's more than your wallet holds, after gas.");
    await expect(hint(page)).toBeEmpty();
    await expect(depositButton(page)).toHaveAttribute("aria-disabled", "true");

    // Deleting back down while still too much doesn't shake; trying to send does.
    await amountField(page).fill("1500");
    await page.waitForTimeout(600);
    shaking = shakes(page);
    await amountField(page).press("Backspace");
    await expect(amountField(page)).toHaveValue("150");
    expect(await shaking, "deleting doesn't shake").toBe(false);
    shaking = shakes(page);
    await depositButton(page).click({ force: true });
    expect(await shaking, "trying to send shakes").toBe(true);
    expect(await sentTransactions(page)).toHaveLength(0);

    await amountField(page).fill("99.99");
    await expect(amountField(page)).toHaveCSS("color", FOREGROUND);
    await expect(wallet(page)).toHaveText("In your wallet: $100.00");
    await expect(depositButton(page)).not.toHaveAttribute("aria-disabled");
});

test("the amount field keeps only digits and one dot", async ({ page }) => {
    await start(page);
    await openForm(page);

    await amountField(page).fill("1a2b.3.4c");
    await expect(amountField(page)).toHaveValue("12.34");
    await amountField(page).fill("abc");
    await expect(amountField(page)).toHaveValue("");
    await amountField(page).fill("1.2345678");
    await expect(amountField(page), "no more than six decimals").toHaveValue("1.234567");
    await amountField(page).fill("-5");
    await expect(amountField(page)).toHaveValue("5");
});

test("an empty amount can't be submitted", async ({ page }) => {
    await start(page);
    await openForm(page);
    await expect(depositButton(page)).toHaveAttribute("aria-disabled", "true");
    await depositButton(page).click({ force: true });
    await amountField(page).press("Enter");
    await amountField(page).fill("0");
    await expect(depositButton(page)).toHaveAttribute("aria-disabled", "true");
    await amountField(page).fill("");
    await expect(depositButton(page)).toHaveAttribute("aria-disabled", "true");
    expect(await sentTransactions(page)).toHaveLength(0);
});

test("declining in the wallet keeps the form and the amount, and trying again works", async ({ page }) => {
    await start(page);
    await rejectNextSend(page);
    await submit(page, "10");

    await expect.poll(async () => (await sentTransactions(page)).length).toBe(1);
    await expect(amountField(page)).toHaveValue("10");
    await expect(depositButton(page)).toHaveText("Deposit");
    await expect(depositButton(page)).not.toHaveAttribute("aria-disabled");
    await expect(balanceButton(page)).toHaveAccessibleName("Balance $0.00, show deposits");
    await expect(status(page)).toHaveText("");
    expect(await serverBalance(page)).toBe("0");

    await depositButton(page).click();
    await expect(balanceButton(page)).toHaveAccessibleName("Balance $10.00, show deposits");
    await expect(status(page)).toHaveText("Deposited $10.00");
    await expect(amountField(page)).toHaveCount(0);
    expect(await sentTransactions(page)).toHaveLength(2);
    expect(await serverBalance(page)).toBe("10");
});

test("a deposit from another network switches the wallet to Arc first", async ({ page }) => {
    await start(page, 1_000);
    await moveWalletTo(page, "0x1");
    const before = (await walletRequests(page)).length;
    await submit(page, "5");
    await expect.poll(async () => (await sentTransactions(page)).length).toBe(1);

    const after = (await walletRequests(page)).slice(before);
    const toArc = after.findIndex(
        (r) =>
            r.method === "wallet_switchEthereumChain" &&
            (r.params?.[0] as { chainId?: string } | undefined)?.chainId?.toLowerCase() === "0x13b2",
    );
    expect(toArc).toBeGreaterThanOrEqual(0);
    expect(toArc).toBeLessThan(after.findIndex((r) => r.method === "eth_sendTransaction"));
    expect(await walletChainId(page)).toBe("0x13b2");
    // A wallet that has never seen Arc is handed its details first.
    expect(after.filter((r) => r.method === "wallet_addEthereumChain").at(-1)?.params).toEqual([
        {
            chainId: "0x13b2",
            chainName: "Arc",
            nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
            rpcUrls: ["https://rpc.mainnet.arc.io"],
            blockExplorerUrls: ["https://explorer.arc.io"],
        },
    ]);
});

test("the deposit transaction names Arc's chain, so a wallet elsewhere refuses it", async ({ page }) => {
    await start(page, 1_000);
    await submit(page, "5");
    await expect.poll(async () => (await sentTransactions(page)).length).toBe(1);
    const [tx] = (await sentTransactions(page))[0].params as [{ chainId?: string }];
    expect(tx.chainId).toBe("0x13b2");
});

test("declining the network switch keeps the form and sends nothing", async ({ page }) => {
    await start(page, 1_000);
    await moveWalletTo(page, "0x1");
    await rejectNextChainSwitch(page);
    const before = (await walletRequests(page)).length;
    await submit(page, "5");
    await expect
        .poll(async () =>
            (await walletRequests(page)).slice(before).some((r) => r.method === "wallet_switchEthereumChain"),
        )
        .toBe(true);
    await expect(confirming(page)).toBeHidden();

    await expect(amountField(page)).toHaveValue("5");
    await expect(hint(page)).toHaveText("");
    expect(await sentTransactions(page)).toHaveLength(0);

    await depositButton(page).click();
    await expect.poll(async () => (await sentTransactions(page)).length).toBe(1);
});

test("a wallet that can't switch to Arc is told so in the form", async ({ page }) => {
    await start(page, 1_000);
    await moveWalletTo(page, "0x1");
    await failNextChainSwitch(page);
    await submit(page, "5");
    await expect(hint(page)).toContainText("couldn't switch to Arc");
    expect(await sentTransactions(page)).toHaveLength(0);
});

test("a wallet that ignores the switch sends nothing", async ({ page }) => {
    await start(page, 1_000);
    await moveWalletTo(page, "0x1");
    await ignoreNextChainSwitch(page);
    await submit(page, "5");
    await expect(hint(page)).toContainText("on another network");
    expect(await sentTransactions(page)).toHaveLength(0);
});

test("a transaction that never lands is counted at once, then taken back with the server's message", async ({
    page,
}) => {
    await start(page);
    await dropNextSend(page);
    await submit(page, "40");

    await expect(balanceButton(page)).toHaveAccessibleName("Balance $40.00, show deposits");
    await expect(status(page)).toHaveText("Depositing $40.00…");

    await expect(balanceButton(page)).toHaveAccessibleName("Balance $0.00, show deposits", { timeout: 20_000 });
    await expect(status(page)).toContainText(DROPPED);
    await expect(status(page)).toHaveText(
        "That transaction hasn't shown up on Arc. If it lands later, it's credited automatically.",
    );
    expect(await serverBalance(page)).toBe("0");
});

test("a deposit from outside the app shows up without reloading", async ({ page, isMobile }) => {
    await start(page);
    const account = await accountOf(addressOf(page));
    await sendFromOutside(account!.depositAddress, "75");

    await expect(balanceButton(page)).toHaveAccessibleName("Balance $75.00, show deposits", { timeout: 15_000 });
    expect(await serverBalance(page)).toBe("75");

    await showHistory(page, isMobile);
    const rows = deposits(page).getByRole("listitem");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("+$75.00");
    await expect(rows.first()).toContainText("today");
});

test("a deposit from outside adds to one made in the app", async ({ page, isMobile }) => {
    await start(page);
    await submit(page, "20");
    await expect(status(page)).toHaveText("Deposited $20.00");
    const account = await accountOf(addressOf(page));
    await sendFromOutside(account!.depositAddress, "5.5");

    await expect(balanceButton(page)).toHaveAccessibleName("Balance $25.50, show deposits", { timeout: 15_000 });
    await showHistory(page, isMobile);
    const rows = deposits(page).getByRole("listitem");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("+$5.50");
    await expect(rows.last()).toContainText("+$20.00");
});

test("a later visit with the same wallet finds the server's balance and history", async ({
    page,
    browser,
    isMobile,
}) => {
    await start(page);
    await submit(page, "25");
    await expect(status(page)).toHaveText("Deposited $25.00");
    expect(await serverBalance(page)).toBe("25");

    // A fresh browser, as on another day or another device.
    const later = await browser.newContext(isMobile ? { isMobile: true, hasTouch: true } : {});
    try {
        const visit = await later.newPage();
        pickWallet(visit, addressOf(page));
        await mockPrivy(visit);
        await installWallet(visit);
        await start(visit, undefined, "$25.00");
        await showHistory(visit, isMobile);
        const rows = deposits(visit).getByRole("listitem");
        await expect(rows).toHaveCount(1);
        await expect(rows.first()).toContainText("+$25.00");
        await expect(rows.first()).toContainText("today");
    } finally {
        await later.close();
    }
});

test("two devices on the same wallet both see a deposit as it's credited", async ({ page, browser, isMobile }) => {
    // Its own browser: a second tab would share this one's Privy session, which the mock can't restore.
    const device = await browser.newContext(isMobile ? { isMobile: true, hasTouch: true } : {});
    try {
        const other = await device.newPage();
        pickWallet(other, addressOf(page));
        await mockPrivy(other);
        await installWallet(other);
        await start(other);
        await start(page);

        await submit(page, "12");
        await expect(balanceButton(page)).toHaveAccessibleName("Balance $12.00, show deposits");
        await expect(balanceButton(other), "the other device gets the push").toHaveAccessibleName(
            "Balance $12.00, show deposits",
        );
    } finally {
        await device.close();
    }
});

test("a deposit that is still confirming shows as pending, then as today", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover only");
    await start(page);
    await dropNextSend(page);
    await submit(page, "15");
    await expect(status(page)).toHaveText("Depositing $15.00…");

    await balanceButton(page).hover();
    const top = deposits(page).getByRole("listitem").first();
    await expect(top).toContainText("+$15.00");
    await expect(top).toContainText("Pending");
    await expect(top).not.toContainText("today");

    // Taken back when the transaction never shows up.
    await page.mouse.move(700, 700);
    await expect(status(page)).toContainText(DROPPED, { timeout: 20_000 });
    await balanceButton(page).hover();
    await expect(deposits(page)).toHaveCount(0);
});

test("a confirmed deposit's row ends as today, not pending", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover only");
    await start(page);
    await submit(page, "15");
    await expect(status(page)).toHaveText("Deposited $15.00");

    await balanceButton(page).hover();
    const top = deposits(page).getByRole("listitem").first();
    await expect(top).toContainText("+$15.00");
    await expect(top).toContainText("today");
    await expect(top).not.toContainText("Pending");
});

test("escape closes the form and gives back the deposit button", async ({ page }) => {
    await start(page);
    await openForm(page);
    await amountField(page).fill("5");
    await page.keyboard.press("Escape");
    await expect(amountField(page)).toHaveCount(0);
    await expect(depositButton(page)).toBeVisible();
    expect(await sentTransactions(page)).toHaveLength(0);

    await openForm(page);
    await expect(amountField(page), "reopens empty").toHaveValue("");
});

test("cancel closes the form and gives back the deposit button", async ({ page }) => {
    await start(page);
    await openForm(page);
    await amountField(page).fill("5");
    await cancelButton(page).click();
    await expect(amountField(page)).toHaveCount(0);
    await expect(cancelButton(page)).toHaveCount(0);
    await expect(depositButton(page)).toBeVisible();
    expect(await sentTransactions(page)).toHaveLength(0);
});

test("enter in the amount field submits", async ({ page }) => {
    await start(page);
    await openForm(page);
    await amountField(page).fill("7.5");
    await amountField(page).press("Enter");

    await expect(balanceButton(page)).toHaveAccessibleName("Balance $7.50, show deposits");
    await expect(status(page)).toHaveText("Deposited $7.50");
    expect(await serverBalance(page)).toBe("7.5");
});

test("six decimals are deposited exactly", async ({ page }) => {
    await start(page);
    await submit(page, "0.123456");

    await expect(balanceButton(page)).toHaveAccessibleName("Balance $0.12, show deposits");
    await expect(status(page)).toHaveText("Deposited $0.12");
    expect(await serverBalance(page)).toBe("0.123456");
    const [sent] = await sentTransactions(page);
    expect(BigInt((sent.params?.[0] as { value: string }).value)).toBe(parseUnits("0.123456", 18));
});

test("a deposit doesn't reveal the history while the form is open", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover only");
    await start(page);
    await sendFromOutside((await accountOf(addressOf(page)))!.depositAddress, "3");
    await expect(balanceButton(page)).toHaveAccessibleName("Balance $3.00, show deposits", { timeout: 15_000 });

    await openForm(page);
    await balanceButton(page).hover();
    await expect(deposits(page)).toHaveCount(0);
    await cancelButton(page).click();
    await balanceButton(page).hover();
    await expect(deposits(page)).toBeVisible();
});

/** Starts recording the deposit button's phases (idle, running, done, error) as they change. */
const recordPhases = (page: Page) =>
    page.evaluate(() => {
        const phases: string[] = [];
        (window as unknown as { phases: string[] }).phases = phases;
        const record = () => {
            const phase = document.querySelector("#wallet-sidebar [data-phase]")?.getAttribute("data-phase");
            if (phase && phases.at(-1) !== phase) phases.push(phase);
        };
        new MutationObserver(record).observe(document.body, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ["data-phase"],
        });
        record();
    });
const phases = (page: Page) => page.evaluate(() => (window as unknown as { phases: string[] }).phases);

/** The progress fill inside the deposit button: how far across it is, and its color. */
const fill = (page: Page) =>
    depositButton(page).evaluate((button) => {
        const style = getComputedStyle(button.querySelector("span")!);
        return {
            across: new DOMMatrix(style.transform).a,
            color: style.backgroundColor,
            opacity: Number(style.opacity),
        };
    });

const rgb = (color: string) => color.match(/[\d.]+/g)!.map(Number);

test("the deposit button fills while the deposit confirms, then finishes green", async ({ page }) => {
    await start(page);
    await recordPhases(page);
    await submit(page, "25");
    await expect(status(page)).toHaveText("Deposited $25.00");
    await expect(depositButton(page)).toHaveAttribute("data-phase", "done");
    await expect.poll(async () => (await fill(page)).color).toBe("rgb(104, 214, 112)");
    expect((await fill(page)).across).toBeCloseTo(1, 2);
    // Its name doesn't change while it works.
    await expect(depositButton(page)).toHaveText("Deposit");
    // It settles back on its own, before the status line clears.
    await expect(depositButton(page)).toHaveAttribute("data-phase", "idle", { timeout: 5_000 });
    await expect(status(page)).toHaveText("Deposited $25.00");
    expect(await phases(page)).toEqual(["idle", "running", "done", "idle"]);
    await expect.poll(async () => (await fill(page)).opacity).toBe(0);
});

test("the fill creeps across from gray toward green while the server confirms", async ({ page }) => {
    await start(page);
    await dropNextSend(page);
    await submit(page, "40");
    await expect(status(page)).toHaveText("Depositing $40.00…");
    await expect(depositButton(page)).toHaveAttribute("data-phase", "running");
    await expect(depositButton(page)).toHaveAttribute("aria-busy", "true");
    const early = await fill(page);
    await page.waitForTimeout(1_500);
    const later = await fill(page);
    expect(later.across).toBeGreaterThan(early.across);
    expect(later.across).toBeLessThan(0.91);
    // Greener: the green channel pulls ahead of the red one as it goes.
    const [r1, g1] = rgb(early.color);
    const [r2, g2] = rgb(later.color);
    expect(g2 - r2).toBeGreaterThan(g1 - r1);

    // Never landing, it turns red and settles back.
    await expect(status(page)).toContainText(DROPPED, { timeout: 20_000 });
    await expect(depositButton(page)).toHaveAttribute("data-phase", "idle", { timeout: 5_000 });
    await expect(depositButton(page)).not.toHaveAttribute("aria-busy");
});
