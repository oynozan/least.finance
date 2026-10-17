import { expect, test, type Page } from "@playwright/test";
import { trendingView } from "./polymarket";
import { addressOf, installWallet, mockArcRpc, mockPrivy } from "./privy-mock";
import { seedDeposits } from "./backend";
import type { MarketView, TrendingView } from "@/server/src/protocol";

// The pool's limit is the page's own here: the trending answer is rewritten in this page's browser, so the shared pool and the
// other specs placing orders at the same time never see it.

const trade = (page: Page) => page.getByRole("region", { name: "Trade" });
const picker = (page: Page) => page.locator("[data-floating-dialog]:not([data-closing])");
const verbPill = (page: Page) => trade(page).locator('[data-slot="verb"] button');
const questionPill = (page: Page) => trade(page).locator('[data-slot="marketId"] button');
const outcomePill = (page: Page) => trade(page).locator('[data-slot="outcomeId"] button');
const amountPill = (page: Page) => trade(page).getByRole("button", { name: /USD$/ });
const dockButton = (page: Page) => page.getByRole("navigation", { name: "Pages" }).locator("button[data-action]");
const sidebar = (page: Page) => page.locator("#wallet-sidebar");
const walletButton = (page: Page) => page.getByRole("button", { name: /^(Wallet|Connect wallet)/ }).last();
const balanceButton = (page: Page) => sidebar(page).getByRole("button", { name: /^Balance/ });

const LOSS = /rgb\(255, 107, 91\)/;
/** The pill's body, which is what the problem ring is drawn on. */
const body = (pill: ReturnType<typeof outcomePill>) => pill.locator(":scope > span").first();

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function connect(page: Page) {
    await walletButton(page).click();
    await page.locator("#privy-modal-content").getByRole("button", { name: "MetaMask" }).click();
    await expect(sidebar(page)).toHaveAttribute("data-open", "true", { timeout: 10_000 });
    await expect(balanceButton(page)).not.toHaveAccessibleName(/loading/, { timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expect(sidebar(page)).toHaveAttribute("data-open", "false");
}

/** Switches the sentence's verb. */
async function chooseVerb(page: Page, name: RegExp) {
    await verbPill(page).click();
    await picker(page).getByRole("option", { name }).click();
    await expect(picker(page)).toBeHidden();
}

async function setAmount(page: Page, amount: string) {
    await amountPill(page).click();
    await picker(page).getByRole("textbox").fill(amount);
    await picker(page).getByRole("textbox").press("Enter");
}

/** Answers the trending list with the pool's limit, and the questions as `tweak` leaves them; this page only. */
async function limitTo(page: Page, limit: number, tweak: (markets: MarketView[]) => void = () => {}) {
    await page.route("**/markets/trending", async (route) => {
        const response = await route.fetch();
        const trending = (await response.json()) as TrendingView;
        tweak(trending.markets);
        await route.fulfill({ response, json: { ...trending, maxOrderUSD: limit } });
    });
}

const binary = async () => (await trendingView()).markets.filter((m) => m.outcomes.length === 2);

test.beforeEach(async ({ page }) => {
    await mockPrivy(page);
    await mockArcRpc(page);
    await installWallet(page);
    await seedDeposits(addressOf(page), [{ amount: "500", daysAgo: 0 }]);
});

test("an outcome over the pool's limit is named on the dock, and the dock opens the outcomes", async ({ page }) => {
    // An outcome comes along to another question only where that one has an outcome of the same name: two YES / NO questions
    const markets = await binary();
    const pair = markets.filter((m) => m.outcomes[0].label === "YES");
    const [first, second] = pair;
    const yes = first.outcomes[0];
    // YES on the first question starts at $4.35 and every other outcome at $1, under a $2 limit
    await limitTo(page, 2, (markets) => {
        for (const market of markets)
            for (const o of market.outcomes) o.minUSD = market.id === first.id && o.tokenId === yes.tokenId ? 4.35 : 1;
    });
    await page.goto("/");
    await connect(page);
    await dockButton(page).waitFor();

    await chooseVerb(page, /^Predict/);
    await setAmount(page, "2");
    // An untouched sentence doesn't land on the outcome that can't be placed
    await expect(dockButton(page)).toHaveText("Review");
    await expect(outcomePill(page)).not.toHaveAccessibleName(yes.label);

    // YES fits on the second question, and comes along to the first, where it doesn't
    await questionPill(page).click();
    await picker(page)
        .getByRole("option", { name: new RegExp(`^${escaped(second.title)}$`) })
        .click();
    await outcomePill(page).click();
    await picker(page)
        .getByRole("option", { name: new RegExp(`^${escaped(yes.label)}`) })
        .click();
    await questionPill(page).click();
    await picker(page)
        .getByRole("option", { name: new RegExp(`^${escaped(first.title)}$`) })
        .click();

    await expect(outcomePill(page)).toHaveAccessibleName(yes.label);
    await expect(dockButton(page)).toHaveText("Pick another outcome");
    await expect(dockButton(page)).toHaveAccessibleDescription(
        `${yes.label} needs at least $4.35, and predictions are limited to $2 right now. Pick an outcome that starts at $2 or less, or try again later.`,
    );
    // The outcome is ringed as the problem, and the red NO or the neutral outcomes next to it are not
    await expect(body(outcomePill(page))).toHaveCSS("box-shadow", LOSS);
    await expect(body(questionPill(page))).not.toHaveCSS("box-shadow", LOSS);
    await expect(outcomePill(page)).toHaveAttribute("aria-invalid", "true");

    // The dock opens the outcomes, with what is wrong at the top and the one that doesn't fit left out of reach
    await dockButton(page).click();
    await expect(picker(page)).toBeVisible();
    await expect(picker(page)).toContainText(`needs at least $4.35`);
    await expect(picker(page).getByRole("option").filter({ hasNotText: yes.label })).not.toHaveAttribute(
        "aria-disabled",
        "true",
    );
    await picker(page)
        .getByRole("option", { name: new RegExp(`^${escaped(first.outcomes[1].label)}`) })
        .click();
    await expect(dockButton(page)).toHaveText("Review");
    await expect(body(outcomePill(page))).not.toHaveCSS("box-shadow", LOSS);
});

test("a pool that can place nothing reads Predictions paused, on the Predict pill and the dock", async ({ page }) => {
    await limitTo(page, 0);
    await page.goto("/");
    await connect(page);
    await chooseVerb(page, /^Predict/);

    await expect(dockButton(page)).toHaveText("Predictions paused");
    await expect(dockButton(page)).not.toHaveAttribute("aria-disabled", "true");
    await expect(dockButton(page)).toHaveAccessibleDescription(
        "Predictions are paused right now. Pick another trade, or try again later.",
    );
    await expect(verbPill(page)).toHaveAttribute("aria-invalid", "true");
    await expect(body(verbPill(page))).toHaveCSS("box-shadow", LOSS);

    // Pressing it opens the Predict pill's picker, which says why and offers the other trades
    await dockButton(page).click();
    await expect(picker(page)).toContainText(
        "Predictions are paused right now. Pick another trade, or try again later.",
    );
    await expect(picker(page).getByRole("option", { name: /^Buy/ })).toBeVisible();
    await expect(sidebar(page)).toHaveAttribute("data-open", "false");
    await page.keyboard.press("Escape");

    // Nothing to slide and no payout to promise
    await amountPill(page).click();
    await expect(picker(page).getByRole("slider")).toHaveCount(0);
    await expect(picker(page)).not.toContainText("Pays");
    await page.keyboard.press("Escape");

    // The other verbs are not affected
    await chooseVerb(page, /^Buy/);
    await expect(dockButton(page)).not.toHaveText("Predictions paused");
});
