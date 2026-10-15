import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import {
    nextOrder,
    releaseOrder,
    resolveMarket,
    resolveNow,
    seedDeposits,
    setPoolBalance,
    shrinkPosition,
} from "./backend";
import { marketIdOf, trendingView } from "./polymarket";
import { addressOf, installWallet, mockArcRpc, mockPrivy } from "./privy-mock";

const trade = (page: Page) => page.getByRole("region", { name: "Trade" });
const pill = (page: Page, name: string | RegExp) =>
    trade(page).getByRole("button", { name, exact: typeof name === "string" });
const picker = (page: Page) => page.locator("[data-floating-dialog]:not([data-closing])");
const questionPill = (page: Page) => trade(page).locator('[data-slot="marketId"] button');
const outcomePill = (page: Page) => trade(page).locator('[data-slot="outcomeId"] button');
const amountPill = (page: Page) => trade(page).getByRole("button", { name: /USD$/ });
const review = (page: Page) => page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: "Review" });
const sidebar = (page: Page) => page.locator("#wallet-sidebar");
const walletButton = (page: Page) => page.getByRole("button", { name: /^(Wallet|Connect wallet)/ }).last();
const balanceButton = (page: Page) => sidebar(page).getByRole("button", { name: /^Balance/ });
const status = (page: Page) => sidebar(page).getByRole("status");
const positions = (page: Page) => sidebar(page).getByRole("list", { name: "Open positions" });

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const exact = (title: string) => new RegExp(`^${escaped(title)}$`);

async function pick(page: Page, from: string | RegExp, option: string | RegExp) {
    await pill(page, from).click();
    await expect(picker(page)).toBeVisible();
    await picker(page).getByRole("option", { name: option }).click();
    await expect(picker(page)).toBeHidden();
}

/** Signs in with the injected wallet, then folds the sidebar the sign-in opened. */
async function connect(page: Page) {
    await walletButton(page).click();
    await page.locator("#privy-modal-content").getByRole("button", { name: "MetaMask" }).click();
    await expect(sidebar(page)).toHaveAttribute("data-open", "true", { timeout: 10_000 });
    await expect(walletButton(page)).toBeFocused();
    await expect(balanceButton(page)).not.toHaveAccessibleName(/loading/, { timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expect(sidebar(page)).toHaveAttribute("data-open", "false");
}

/** A two-outcome question of its own per test, so parallel tests never share a token's fake behavior. */
async function pickMarket(index: number) {
    const binary = (await trendingView()).markets.filter((m) => m.outcomes.length === 2);
    return { market: binary[index], outcome: binary[index].outcomes[0] };
}

type Picked = Awaited<ReturnType<typeof pickMarket>>;

async function predict(page: Page, { market, outcome }: Picked) {
    await pick(page, "Swap", /^Predict/);
    await questionPill(page).click();
    await picker(page)
        .getByRole("option", { name: exact(market.title) })
        .click();
    await expect(picker(page)).toBeHidden();
    await outcomePill(page).click();
    await picker(page)
        .getByRole("option", { name: new RegExp(`^${escaped(outcome.label)}`) })
        .click();
    await expect(picker(page)).toBeHidden();
    await expect(questionPill(page)).toHaveAccessibleName(market.title);
}

const reviewPanel = (page: Page) => page.getByRole("complementary", { name: "Review" });

/** Confirms the review that is open and waits for its done step. */
async function confirmReview(page: Page) {
    await review(page).click();
    await reviewPanel(page).getByRole("button", { name: "Confirm prediction" }).click();
    await expect(reviewPanel(page).getByRole("button", { name: "Done" })).toBeVisible();
}

/** Confirms the review that is open, then folds it and opens the wallet. */
async function confirm(page: Page) {
    await confirmReview(page);
    await reviewPanel(page).getByRole("button", { name: "Done" }).click();
    await expect(sidebar(page)).toHaveAttribute("data-open", "false");
    await walletButton(page).click();
    await expect(sidebar(page)).toHaveAttribute("data-open", "true");
}

const row = (page: Page, picked: Picked) =>
    positions(page).getByRole("listitem").filter({ hasText: picked.market.title });
const pending = (page: Page, picked: Picked) => row(page, picked).filter({ hasText: "Pending" });
const balanceName = (usd: string) => `Balance $${usd}, show deposits`;

test.beforeEach(async ({ page }) => {
    await mockPrivy(page);
    await mockArcRpc(page);
    await installWallet(page);
    await seedDeposits(addressOf(page), [{ amount: "500", daysAgo: 0 }]);
});

test("a prediction lowers the balance and adds a position at once, while the fake holds the order", async ({
    page,
}) => {
    const picked = await pickMarket(0);
    await nextOrder(picked.outcome.tokenId, "hold");
    await page.goto("/");
    await connect(page);
    await predict(page, picked);
    await confirmReview(page);
    await expect(reviewPanel(page)).toContainText("Prediction placed.");
    await reviewPanel(page).getByRole("button", { name: "Done" }).click();
    await expect(sidebar(page)).toHaveAttribute("data-open", "false");
    await walletButton(page).click();
    await expect(sidebar(page)).toHaveAttribute("data-open", "true");

    await expect(balanceButton(page)).toHaveAccessibleName(balanceName("490.00"));
    await expect(row(page, picked)).toHaveCount(1);
    await expect(row(page, picked)).toContainText("Pending");
    await expect(row(page, picked)).toContainText(picked.outcome.label);
    await expect(status(page)).toHaveText("");

    // Nothing to sell until the buy fills: the button stays in the tab order, with its reason.
    const close = row(page, picked).getByRole("button", {
        name: `Close ${picked.outcome.label} on ${picked.market.title}`,
    });
    await expect(close).toHaveAttribute("aria-disabled", "true");
    await expect(close).toHaveAccessibleDescription("Selling opens when the buy is filled.");
    await close.focus();
    await expect(close).toBeFocused();

    await releaseOrder(picked.outcome.tokenId, "fill");
    // The pending row leaves as the filled one takes its place.
    await expect(pending(page, picked)).toHaveCount(0);
    await expect(row(page, picked)).toHaveCount(1);
    await expect(row(page, picked)).toContainText(/\d[\d.]* shares/);
    await expect(balanceButton(page)).toHaveAccessibleName(/^Balance \$49\d\.\d\d, show deposits$/);
});

test("a rejected prediction replaces the done line in the review, then rolls back", async ({ page }) => {
    const picked = await pickMarket(1);
    await nextOrder(picked.outcome.tokenId, "reject:price_moved");
    await page.goto("/");
    await connect(page);
    await predict(page, picked);
    await confirmReview(page);

    const line = "The price moved, so your prediction didn't go through. Nothing was spent.";
    await expect(reviewPanel(page)).toContainText(line);
    await expect(reviewPanel(page).getByText("Prediction placed.")).toHaveCount(0);
    await reviewPanel(page).getByRole("button", { name: "Done" }).click();
    await expect(sidebar(page)).toHaveAttribute("data-open", "false");
    await walletButton(page).click();
    await expect(sidebar(page)).toHaveAttribute("data-open", "true");
    await expect(status(page)).toHaveText(line);
    await expect(row(page, picked)).toHaveCount(0);
    await expect(balanceButton(page)).toHaveAccessibleName(balanceName("500.00"));
});

test("a refusal that comes after the review is closed opens the sidebar on it", async ({ page }) => {
    const picked = await pickMarket(5);
    await nextOrder(picked.outcome.tokenId, "hold");
    await page.goto("/");
    await connect(page);
    await predict(page, picked);
    await confirmReview(page);
    await reviewPanel(page).getByRole("button", { name: "Done" }).click();
    await expect(sidebar(page)).toHaveAttribute("data-open", "false");

    await releaseOrder(picked.outcome.tokenId, "reject:price_moved");
    await expect(sidebar(page)).toHaveAttribute("data-open", "true");
    await expect(status(page)).toHaveText("The price moved, so your prediction didn't go through. Nothing was spent.");
    await expect(balanceButton(page)).toHaveAccessibleName(balanceName("500.00"));
});

test("a prediction in flight survives a reload", async ({ page }) => {
    const picked = await pickMarket(2);
    await nextOrder(picked.outcome.tokenId, "hold");
    await page.goto("/");
    await connect(page);
    await predict(page, picked);
    await confirm(page);
    await expect(row(page, picked)).toContainText("Pending");

    await page.reload();
    await walletButton(page).click();
    await expect(sidebar(page)).toHaveAttribute("data-open", "true");
    await expect(row(page, picked)).toContainText("Pending");
    await expect(row(page, picked)).toHaveCount(1);
    await expect(balanceButton(page)).toHaveAccessibleName(balanceName("490.00"));

    await releaseOrder(picked.outcome.tokenId, "fill");
    await expect(pending(page, picked)).toHaveCount(0);
    await expect(row(page, picked)).toHaveCount(1);
    await expect(row(page, picked)).toContainText(/shares/);
});

test("offline at confirm says so and spends nothing", async ({ page }) => {
    const picked = await pickMarket(3);
    let socket: WebSocketRoute | undefined;
    await page.routeWebSocket(/socket\.io/, (ws) => {
        ws.connectToServer();
        socket = ws;
    });
    await page.goto("/");
    await connect(page);
    await predict(page, picked);
    await review(page).click();
    await page.context().setOffline(true);
    // An open socket doesn't notice the drop for a while; closing it is what going offline does.
    await socket!.close();
    await page.waitForTimeout(500);
    await page
        .getByRole("complementary", { name: "Review" })
        .getByRole("button", { name: "Confirm prediction" })
        .click();
    const reviewPanel = page.getByRole("complementary", { name: "Review" });
    await expect(reviewPanel.getByText("Prediction placed.")).toHaveCount(0);
    await expect(
        reviewPanel.getByRole("paragraph").filter({ hasText: "You're offline. Nothing was spent." }),
    ).toBeVisible();
    await reviewPanel.getByRole("button", { name: "Done" }).click();
    await walletButton(page).click();
    await expect(status(page)).toHaveText("You're offline. Nothing was spent.");
    await expect(balanceButton(page)).toHaveAccessibleName(balanceName("500.00"));
    await expect(row(page, picked)).toHaveCount(0);
    await page.context().setOffline(false);
});

test("the amount can't exceed the pool's limit", async ({ page }) => {
    const picked = await pickMarket(4);
    await setPoolBalance(20);
    try {
        await page.goto("/");
        await connect(page);
        await predict(page, picked);
        await amountPill(page).click();
        await picker(page).getByRole("textbox").fill("50");
        await picker(page).getByRole("textbox").press("Enter");
        await expect(review(page)).toHaveAccessibleDescription(/^Predictions are limited to \$\d+ right now\.$/);
        await expect(review(page)).toHaveAttribute("aria-disabled", "true");
    } finally {
        // The pool is shared with every other test.
        await setPoolBalance(1_000_000);
    }
});

const closeButton = (page: Page, picked: Picked) =>
    row(page, picked).getByRole("button", { name: `Close ${picked.outcome.label} on ${picked.market.title}` });

/** Buys with the fake filling it at once, and leaves the wallet open on the filled row. */
async function buyAndFill(page: Page, picked: Picked) {
    await page.goto("/");
    await connect(page);
    await predict(page, picked);
    await confirm(page);
    await expect(row(page, picked)).toContainText(/\d[\d.]* shares/);
    await expect(pending(page, picked)).toHaveCount(0);
}

/** Slides the row's close button out: a hover, or a tap on touch. */
async function reveal(page: Page, picked: Picked, isMobile: boolean) {
    if (isMobile) await row(page, picked).tap();
    else await row(page, picked).hover();
}

const balanceOf = async (page: Page) => {
    const name = (await balanceButton(page).getAttribute("aria-label")) ?? (await balanceButton(page).innerText());
    return Number(/\$([\d,]+\.\d\d)/.exec(name)![1]!.replace(/,/g, ""));
};

test("closing a position credits the balance at once and the row goes", async ({ page, isMobile }) => {
    const picked = await pickMarket(6);
    await buyAndFill(page, picked);
    const before = await balanceOf(page);

    await nextOrder(picked.outcome.tokenId, "hold");
    await reveal(page, picked, isMobile);
    await closeButton(page, picked).click();
    await expect(row(page, picked)).toHaveCount(0);
    await expect.poll(() => balanceOf(page)).toBeGreaterThan(before);

    await releaseOrder(picked.outcome.tokenId, "fill");
    await expect(row(page, picked)).toHaveCount(0);
    await expect.poll(() => balanceOf(page)).toBeGreaterThan(before);
});

test("a rejected close puts the position back with the message", async ({ page, isMobile }) => {
    const picked = await pickMarket(7);
    await buyAndFill(page, picked);
    const before = await balanceOf(page);

    await nextOrder(picked.outcome.tokenId, "reject:price_moved");
    await reveal(page, picked, isMobile);
    await closeButton(page, picked).click();
    await expect(status(page)).toHaveText("Couldn't sell right now. Your position is back.");
    await expect(row(page, picked)).toHaveCount(1);
    await expect(row(page, picked)).toContainText(/shares/);
    expect(await balanceOf(page)).toBe(before);
});

test("a tiny position's Close is disabled with the reason", async ({ page }) => {
    const picked = await pickMarket(8);
    await buyAndFill(page, picked);
    await shrinkPosition(addressOf(page), picked.outcome.tokenId, "0.5");
    await page.reload();
    await walletButton(page).click();
    await expect(sidebar(page)).toHaveAttribute("data-open", "true");

    await expect(row(page, picked)).toContainText("0.5 shares");
    const close = closeButton(page, picked);
    await expect(close).toHaveAttribute("aria-disabled", "true");
    await expect(close).toHaveAccessibleDescription("Too small to sell. It pays out when the market resolves.");
    await close.focus();
    await expect(close).toBeFocused();
    await close.press("Enter");
    await expect(row(page, picked)).toHaveCount(1);
});

// Resolving closes the market for everyone, so each project resolves a question of its own.
test("a resolved win shows Won and raises the balance", async ({ page, isMobile }) => {
    const picked = await pickMarket(isMobile ? 13 : 12);
    await buyAndFill(page, picked);
    const before = await balanceOf(page);

    await resolveMarket(marketIdOf(picked.outcome.tokenId), ["1", "0"]);
    await resolveNow();
    await expect(row(page, picked)).toContainText(/Won \$\d/);
    await expect(closeButton(page, picked)).toHaveCount(0);
    await expect.poll(() => balanceOf(page)).toBeGreaterThan(before);
});

test("a resolved loss shows Lost", async ({ page, isMobile }) => {
    const picked = await pickMarket(isMobile ? 15 : 14);
    await buyAndFill(page, picked);
    const before = await balanceOf(page);

    await resolveMarket(marketIdOf(picked.outcome.tokenId), ["0", "1"]);
    await resolveNow();
    await expect(row(page, picked)).toContainText("Lost");
    await expect(closeButton(page, picked)).toHaveCount(0);
    expect(await balanceOf(page)).toBe(before);
});

test("a buy restored by a reload shows no amount in place of shares", async ({ page }) => {
    const picked = await pickMarket(11);
    await nextOrder(picked.outcome.tokenId, "hold");
    await page.goto("/");
    await connect(page);
    await predict(page, picked);
    await confirm(page);
    await page.reload();
    await walletButton(page).click();
    await expect(row(page, picked)).toContainText("Pending");
    await expect(row(page, picked)).not.toContainText(/\$\d/);
    await releaseOrder(picked.outcome.tokenId, "fill");
});
