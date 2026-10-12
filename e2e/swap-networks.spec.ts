import { expect, test, type Page } from "@playwright/test";
import { installWallet, mockArcRpc, mockPrivy } from "./privy-mock";

const trade = (page: Page) => page.getByRole("region", { name: "Trade" });
// Privy keeps a dialog of its own in the page; ours are marked.
const picker = (page: Page) => page.locator("[data-floating-dialog]:not([data-closing])");
const pay = (page: Page) => trade(page).locator('[data-part="swap:fromToken"]').getByRole("button");
const receive = (page: Page) => trade(page).locator('[data-part="term:token"]').getByRole("button");
const option = (page: Page, name: string) => picker(page).getByRole("option", { name, exact: true });
const back = (page: Page) => picker(page).getByRole("button", { name: "Back" });
const amountPill = (page: Page) => trade(page).getByRole("button", { name: /USD$/ });
const amountField = (page: Page) => picker(page).getByRole("textbox");
const review = (page: Page) => page.getByRole("button", { name: "Review", exact: true });
const sidebar = (page: Page) => page.locator("#wallet-sidebar");
// A network row by its label; its accessible name may carry the amounts too.
const row = (page: Page, network: string) => picker(page).getByRole("option").filter({ hasText: network }).first();

/** The sentence as a reader sees it: pill names and the typed amount, no hidden hints or badges. */
async function text(page: Page) {
    await expect(trade(page).locator('[data-part][aria-hidden="true"]')).toHaveCount(0);
    return trade(page).evaluate((root) =>
        [...root.querySelectorAll("[data-part]")]
            .map((part) => {
                const copy = part.cloneNode(true) as HTMLElement;
                copy.querySelectorAll('.sr-only, [aria-hidden="true"]').forEach((node) => node.remove());
                const input = part.querySelector("input");
                copy.querySelectorAll("input").forEach((node) => node.replaceWith(input?.value ?? ""));
                copy.querySelectorAll("button").forEach((button, i) => {
                    button.replaceWith(part.querySelectorAll("button")[i].getAttribute("aria-label") ?? "");
                });
                return copy.textContent?.replace(/\s+/g, " ").trim();
            })
            .join(" "),
    );
}

/** The panel's box once its entrance spring has settled (viewport px). */
async function settledPanel(page: Page) {
    await expect
        .poll(() => picker(page).evaluate((panel) => getComputedStyle(panel).transform), { timeout: 3_000 })
        .toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
    return (await picker(page).boundingBox())!;
}

test.beforeEach(async ({ page }) => {
    await mockPrivy(page);
    await mockArcRpc(page);
    await installWallet(page);
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
});

test("picking a coin moves to its networks in the same picker", async ({ page }) => {
    await receive(page).click();
    await expect(picker(page)).toHaveAccessibleName("Swap to which coin?");
    await option(page, "BTC").click();
    await expect(picker(page)).toHaveAccessibleName("On which network?");
    await expect(page.locator("[data-floating-dialog]")).toHaveCount(1);
    await expect(picker(page).locator("[data-highlight]")).toHaveCount(1);
    await expect(option(page, "Base")).toHaveAccessibleDescription(/cbBTC/);

    await option(page, "Base").click();
    await expect(picker(page)).toBeHidden();
    await expect(receive(page)).toHaveAccessibleName("BTC");
    await expect(receive(page)).toHaveAccessibleDescription(/on Base/);
    await expect(receive(page).locator('img[src$="networks/base.svg"]')).toBeVisible();
    // The network never reaches the sentence.
    expect(await text(page)).toBe("I want to Swap my ETH to BTC for 10 USD.");
});

test("closing at the network step keeps the default", async ({ page }) => {
    await receive(page).click();
    await option(page, "ETH").click();
    await expect(picker(page)).toHaveAccessibleName("On which network?");
    await expect(option(page, "Arbitrum")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Escape");
    await expect(picker(page)).toBeHidden();
    await expect(receive(page)).toHaveAccessibleDescription(/on Arbitrum/);
    expect(await text(page)).toBe("I want to Swap my ETH to ETH for 10 USD.");
});

test("an outside click at the network step keeps the default too", async ({ page }) => {
    await receive(page).click();
    await option(page, "BTC").click();
    await expect(picker(page)).toHaveAccessibleName("On which network?");
    await page.mouse.click(4, 4);
    await expect(picker(page)).toBeHidden();
    await expect(receive(page)).toHaveAccessibleName("BTC");
    await expect(receive(page)).toHaveAccessibleDescription(/on Ethereum/);
});

test("Back returns to the coins", async ({ page }) => {
    await receive(page).click();
    await expect(back(page)).toHaveCount(0);
    await option(page, "BTC").click();
    await expect(picker(page)).toHaveAccessibleName("On which network?");
    await expect(back(page)).toBeVisible();
    await expect(back(page)).toHaveText("Back");
    await back(page).click();

    await expect(picker(page)).toHaveAccessibleName("Swap to which coin?");
    await expect(back(page)).toHaveCount(0);
    await expect(picker(page).locator("[data-highlight]")).toHaveCount(1);
    // The coin just picked is the current one.
    await expect(option(page, "BTC")).toHaveAttribute("aria-selected", "true");
    await expect(option(page, "BTC")).toBeFocused();

    // Another coin goes on to its own networks.
    await option(page, "LINK").click();
    await expect(picker(page)).toHaveAccessibleName("On which network?");
    await expect(option(page, "Ethereum")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Escape");
    await expect(receive(page)).toHaveAccessibleName("LINK");
    await expect(receive(page)).toHaveAccessibleDescription(/on Ethereum/);
});

test("a coin on one network closes after the first step", async ({ page }) => {
    await receive(page).click();
    await option(page, "BNB").click();
    await expect(picker(page)).toBeHidden();
    await expect(receive(page)).toHaveAccessibleName("BNB");
    await expect(receive(page)).toHaveAccessibleDescription(/on BNB Chain/);
    expect(await text(page)).toBe("I want to Swap my ETH to BNB for 10 USD.");
});

test("both steps work from the keyboard", async ({ page, isMobile }) => {
    test.skip(isMobile, "keyboard flow");
    await receive(page).focus();
    await page.keyboard.press("Enter");
    await expect(option(page, "SOL")).toBeFocused();
    await page.keyboard.type("bt");
    await expect(option(page, "BTC")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(picker(page)).toHaveAccessibleName("On which network?");
    await expect(option(page, "Ethereum")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(option(page, "Arbitrum")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(picker(page)).toBeHidden();
    await expect(receive(page)).toBeFocused();
    await expect(receive(page)).toHaveAccessibleDescription(/on Arbitrum/);

    // Picking the current coin again opens its networks on the current one; ArrowUp from the first row reaches Back.
    await page.keyboard.press("Enter");
    await expect(option(page, "BTC")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(option(page, "Arbitrum")).toBeFocused();
    await page.keyboard.press("Home");
    await expect(option(page, "Ethereum")).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(back(page)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(picker(page)).toHaveAccessibleName("Swap to which coin?");
    await expect(option(page, "BTC")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(picker(page)).toBeHidden();
    await expect(receive(page)).toHaveAccessibleDescription(/on Arbitrum/);
});

test("reopening starts at the coins", async ({ page }) => {
    // During the close animation the same panel is revived, still showing the network step.
    await receive(page).click();
    await option(page, "BTC").click();
    await expect(picker(page)).toHaveAccessibleName("On which network?");
    const closing = await page.evaluate(async () => {
        const dialog = document.querySelector("[data-floating-dialog]")!;
        dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await new Promise(requestAnimationFrame);
        const wasClosing = document.querySelector("[data-floating-dialog][data-closing]") !== null;
        document.querySelector<HTMLButtonElement>('[data-part="term:token"] button')!.click();
        return wasClosing;
    });
    expect(closing).toBe(true);
    await expect(page.locator("[data-floating-dialog]")).toHaveCount(1);
    await expect(picker(page)).toHaveAccessibleName("Swap to which coin?");
    await expect(back(page)).toHaveCount(0);
    await expect(option(page, "BTC")).toHaveAttribute("aria-selected", "true");
    await expect(option(page, "BTC")).toBeFocused();
    await expect(picker(page).locator("[data-highlight]")).toHaveCount(1);

    // After Back, closing and reopening shows the coins again, in the same way.
    await option(page, "LINK").click();
    await expect(picker(page)).toHaveAccessibleName("On which network?");
    await back(page).click();
    await expect(option(page, "LINK")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Escape");
    await receive(page).click();
    await expect(picker(page)).toHaveAccessibleName("Swap to which coin?");
    await expect(option(page, "LINK")).toHaveAttribute("aria-selected", "true");
    await expect(option(page, "LINK")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(picker(page)).toBeHidden();
    await receive(page).click();
    await expect(picker(page)).toHaveAccessibleName("Swap to which coin?");
    await expect(option(page, "LINK")).toBeFocused();
});

test("step 2 stays on screen on a phone", async ({ page }) => {
    await receive(page).click();
    await option(page, "ETH").click();
    await expect(picker(page)).toHaveAccessibleName("On which network?");
    // Nine networks: the tallest list.
    await expect(picker(page).getByRole("option")).toHaveCount(9);
    const viewport = page.viewportSize()!;
    await settledPanel(page);
    await expect
        .poll(async () => {
            const box = (await picker(page).boundingBox())!;
            return (
                box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height
            );
        })
        .toBe(true);
});

test("the badge sits at the coin's bottom-right", async ({ page }) => {
    const pill = pay(page);
    // The name stays the bare symbol.
    await expect(pill).toHaveAccessibleName("ETH");
    const badge = pill.locator("[data-badge]");
    await expect(badge.locator('img[src$="networks/ethereum.svg"]')).toBeVisible();
    const coin = pill.locator('img[src$="coins/ETH.svg"]').locator("..");
    const [c, b] = [(await coin.boundingBox())!, (await badge.boundingBox())!];
    // At the corner, or slightly past it.
    expect(b.x + b.width).toBeGreaterThanOrEqual(c.x + c.width - 2);
    expect(b.y + b.height).toBeGreaterThanOrEqual(c.y + c.height - 2);
    expect(b.x + b.width).toBeLessThanOrEqual(c.x + c.width + c.width * 0.2);
    expect(b.y + b.height).toBeLessThanOrEqual(c.y + c.height + c.height * 0.2);
    expect(b.width / c.width).toBeGreaterThanOrEqual(0.4);
    expect(b.width / c.width).toBeLessThanOrEqual(0.48);
    // Hidden from screen readers: the network is in the description.
    await expect(pill).toHaveAccessibleDescription(/on Ethereum/);
    expect(await badge.evaluate((el) => el.closest('[aria-hidden="true"]') !== null)).toBe(true);
});

test("the badge's ring is the colour of what it sits on", async ({ page, isMobile }) => {
    const pill = pay(page);
    const badge = pill.locator("[data-badge]");
    const ring = () => badge.evaluate((el) => getComputedStyle(el).boxShadow);
    const surface = () => pill.locator("span.bg-pill").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(await ring()).toContain(await surface());
    // The pill lightens under a pointer, and the ring with it.
    if (!isMobile) {
        await pill.hover();
        await expect.poll(surface).toBe("rgb(53, 53, 50)");
        await expect.poll(async () => (await ring()).includes(await surface())).toBe(true);
        await page.mouse.move(2, 2);
    }

    // In the picker the rows sit on the panel.
    await receive(page).click();
    await option(page, "BTC").click();
    const rowBadge = option(page, "Base").locator("[data-badge]");
    const panel = await picker(page).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(await rowBadge.evaluate((el) => getComputedStyle(el).boxShadow)).toContain(panel);
});

/** Signs the e2e wallet in, which holds 1 ETH on the Ethereum chain, and folds the sidebar away. */
async function connect(page: Page) {
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await page.locator("#privy-modal-content").getByRole("button", { name: "MetaMask" }).click();
    await expect(sidebar(page)).toHaveAttribute("data-open", "true", { timeout: 10_000 });
    await expect(sidebar(page).getByRole("button", { name: /^Balance/ })).not.toHaveAccessibleName(/loading/, {
        timeout: 10_000,
    });
    await page.keyboard.press("Escape");
    await expect(sidebar(page)).toHaveAttribute("data-open", "false");
}

/** Types an amount into the amount's dropdown, then closes it with Enter. */
async function setAmount(page: Page, value: string) {
    await amountPill(page).click();
    await expect(amountField(page)).toBeVisible();
    await amountField(page).fill(value);
    await amountField(page).press("Enter");
    await expect(picker(page)).toBeHidden();
}

/** Lets the page's socket through, minus the server's holdings pushes; counts the refreshes the page asks for. */
async function blockHoldings(page: Page) {
    const asked = { refreshes: 0 };
    await page.routeWebSocket(/socket\.io/, (ws) => {
        const server = ws.connectToServer();
        ws.onMessage((message) => {
            if (typeof message === "string" && message.includes('"swap:holdings:refresh"')) asked.refreshes += 1;
            server.send(message);
        });
        server.onMessage((message) => {
            if (typeof message === "string" && message.includes('"swap:holdings"')) return;
            ws.send(message);
        });
    });
    // Routing only reaches pages loaded after it.
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
    return asked;
}

test("the amount turns red past the wallet's real balance", async ({ page }) => {
    await connect(page);
    // 1 ETH on Ethereum, less the 0.002 ETH kept for gas, at $3,210.40.
    await setAmount(page, "5000");
    await expect(amountPill(page)).toHaveAttribute("aria-invalid", "true");
    await expect(review(page)).toHaveAttribute("aria-disabled", "true");
    await expect(review(page)).toHaveAccessibleDescription("That's more than your $3,203.98 of ETH on Ethereum.");
    await setAmount(page, "100");
    await expect(amountPill(page)).not.toHaveAttribute("aria-invalid");
    await expect(review(page)).not.toHaveAttribute("aria-disabled");
});

test("the network step shows the wallet's amount on each network", async ({ page }) => {
    await connect(page);
    await pay(page).click();
    await option(page, "ETH").click();
    await expect(picker(page)).toHaveAccessibleName("On which network?");
    await expect(row(page, "Ethereum")).toContainText("1 ETH");
    await expect(row(page, "Ethereum")).toContainText("$3,210.40");
    await expect(row(page, "Ethereum")).not.toHaveAttribute("aria-disabled");
    await expect(row(page, "Base")).toHaveAttribute("aria-disabled", "true");
    await expect(row(page, "Base")).toContainText("Nothing here");
    // The paying side is the wallet's: a network with nothing stays out of reach.
    await expect(picker(page).locator("[data-highlight]")).toHaveCount(1);
});

test("holdings that never arrive leave the sentence uncapped", async ({ page }) => {
    await blockHoldings(page);
    await connect(page);
    // The push is lost, so give it the time it would take.
    await page.waitForTimeout(1_500);
    await setAmount(page, "5000");
    await expect(amountPill(page)).not.toHaveAttribute("aria-invalid");
    await expect(review(page)).not.toHaveAttribute("aria-disabled");

    await pay(page).click();
    await option(page, "ETH").click();
    await expect(picker(page)).toHaveAccessibleName("On which network?");
    await expect(picker(page).getByRole("option")).toHaveCount(9);
    await expect(picker(page).getByText("Nothing here")).toHaveCount(0);
    for (const network of ["Ethereum", "Base", "Solana"]) {
        await expect(row(page, network)).not.toHaveAttribute("aria-disabled");
    }
    await back(page).click();
    // The coin rows show prices, not amounts, and none is disabled.
    await expect(option(page, "ETH")).toContainText("$3,210.40");
    await expect(option(page, "SOL")).toContainText("$147.20");
    await expect(picker(page).locator('[role="option"][aria-disabled="true"]')).toHaveCount(0);
});

test("opening a coin pill asks the server for fresh holdings", async ({ page }) => {
    const asked = await blockHoldings(page);
    await connect(page);
    await page.waitForTimeout(500);
    const before = asked.refreshes;
    await receive(page).click();
    await expect.poll(() => asked.refreshes).toBeGreaterThan(before);
    await page.keyboard.press("Escape");
    // The amount is not a coin: opening it asks for nothing.
    const after = asked.refreshes;
    await amountPill(page).click();
    await page.waitForTimeout(300);
    expect(asked.refreshes).toBe(after);
});
