import { expect, test, type Locator, type Page } from "@playwright/test";
import { failNextPolymarket } from "./backend";
import { API, sampleView, samples } from "./polymarket";
import { installWallet, mockArcRpc, mockPrivy } from "./privy-mock";
import { picker, trade } from "./swap-flow";

// A leaving card is marked while it animates out.
const card = (page: Page) => page.locator("[data-hover-card]:not([data-closing])");
const questionPill = (page: Page) => trade(page).locator('[data-slot="marketId"] button');
const outcomePill = (page: Page) => trade(page).locator('[data-slot="outcomeId"] button');
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Hovers a pill and waits for its card to finish springing open, so boxes are measured at rest. */
async function openCard(page: Page, pill: Locator) {
    await pill.hover();
    await expect(card(page)).toBeVisible();
    let last = "";
    await expect
        .poll(async () => {
            const box = JSON.stringify(await card(page).boundingBox());
            const still = box === last;
            last = box;
            return still;
        })
        .toBe(true);
}

/** Waits for the card to show whole: nothing of it scrolls out of sight. */
async function expectWhole(page: Page) {
    await expect.poll(() => card(page).evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
}

/** Picks Predict, then a sample question; its likeliest outcome comes with it. */
async function predict(page: Page, eventId: string) {
    const market = await sampleView(eventId);
    await trade(page).getByRole("button", { name: "Swap", exact: true }).click();
    await picker(page)
        .getByRole("option", { name: /^Predict/ })
        .click();
    await expect(picker(page)).toBeHidden();
    await questionPill(page).click();
    await picker(page)
        .getByRole("option", { name: new RegExp(`^${escaped(market.title)}$`) })
        .click();
    await expect(picker(page)).toBeHidden();
    await expect(questionPill(page)).toHaveAccessibleName(market.title);
    return market;
}

async function pickOutcome(page: Page, label: string) {
    await outcomePill(page).click();
    await picker(page)
        .getByRole("option", { name: new RegExp(`^${escaped(label)}(?!\\w)`) })
        .click();
    await expect(picker(page)).toBeHidden();
    await expect(outcomePill(page)).toContainText(label);
}

let requests: string[];

test.beforeEach(async ({ page }) => {
    requests = [];
    page.on("request", (request) => requests.push(request.url()));
    await mockPrivy(page);
    await mockArcRpc(page);
    await installWallet(page);
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
});

test("hovering a multi-outcome question shows its 4 likeliest outcomes and +N more", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover only");
    const market = await predict(page, samples.multi!);
    const likeliest = [...market.outcomes].sort((a, b) => b.chance - a.chance).slice(0, 4);
    await openCard(page, questionPill(page));
    await expect(card(page).locator('[data-market-card="question"]')).toBeVisible();
    await expect(card(page).locator("[data-line]")).toHaveCount(4);
    await expect(card(page).locator("[data-legend]")).toHaveCount(4);
    expect(
        await card(page)
            .locator("[data-line]")
            .evaluateAll((els) => els.map((el) => el.getAttribute("data-line"))),
    ).toEqual(likeliest.map((o) => o.tokenId));
    await expect(card(page).locator("[data-more]")).toHaveText(`+${market.outcomes.length - 4} more`);
});

test("the whole multi-outcome question card shows", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover only");
    await predict(page, samples.multi!);
    await openCard(page, questionPill(page));
    await expectWhole(page);
});

test("the whole multi-outcome question card shows on a 1280 by 720 screen", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover only");
    await page.setViewportSize({ width: 1280, height: 720 });
    await predict(page, samples.multi!);
    await openCard(page, questionPill(page));
    await expectWhole(page);
});

test("a Yes/No question draws only YES", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover only");
    const market = await predict(page, samples.yesNo!);
    const yes = market.outcomes.find((o) => o.label.toUpperCase() === "YES")!;
    await openCard(page, questionPill(page));
    await expect(card(page).locator("[data-line]")).toHaveCount(1);
    await expect(card(page).locator("[data-line]")).toHaveAttribute("data-line", yes.tokenId);
    await expect(card(page).locator("[data-more]")).toHaveCount(0);
});

test("the whole Yes/No question card shows", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover only");
    await predict(page, samples.yesNo!);
    await openCard(page, questionPill(page));
    await expectWhole(page);
});

test("the outcome pill shows only that outcome, with its chance and change", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover only");
    const market = await predict(page, samples.multi!);
    const [second] = [...market.outcomes].sort((a, b) => b.chance - a.chance).slice(1);
    await pickOutcome(page, second!.label);
    await openCard(page, outcomePill(page));
    const outcome = card(page).locator('[data-market-card="outcome"]');
    await expect(outcome).toBeVisible();
    await expect(outcome.locator("[data-line]")).toHaveCount(1);
    await expect(outcome.locator("[data-line]")).toHaveAttribute("data-line", second!.tokenId);
    const shown = Number(await outcome.locator("[data-chance]").getAttribute("data-chance"));
    expect(Math.abs(shown - second!.chance)).toBeLessThan(0.005);
    await expect(outcome.locator("[data-change]")).toHaveAttribute("data-change", /^([+−]\d+(\.\d)? pts|0 pts)$/);
});

test("the whole outcome card shows", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover only");
    const market = await predict(page, samples.multi!);
    const [second] = [...market.outcomes].sort((a, b) => b.chance - a.chance).slice(1);
    await pickOutcome(page, second!.label);
    await openCard(page, outcomePill(page));
    await expectWhole(page);
});

test("an outcome outside the 4 likeliest still shows its own line", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover only");
    const market = await predict(page, samples.multi!);
    const ranked = [...market.outcomes].sort((a, b) => b.chance - a.chance);
    expect(ranked.length).toBeGreaterThanOrEqual(5);
    const fifth = ranked[4]!;
    await pickOutcome(page, fifth.label);
    await openCard(page, outcomePill(page));
    await expect(card(page).locator('[data-market-card="outcome"]')).toBeVisible();
    await expect(card(page).locator("[data-line]")).toHaveAttribute("data-line", fifth.tokenId);
});

test("pointing rolls the chances and says when", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover only");
    await predict(page, samples.multi!);
    await openCard(page, questionPill(page));
    const first = card(page).locator("[data-legend] [data-chance]").first();
    const rest = card(page).locator("[data-subtitle]");
    await expect(rest).toHaveText(/^Ends /);
    const before = await first.getAttribute("data-chance");
    const chart = (await card(page).locator("[data-chart]").boundingBox())!;
    await page.mouse.move(chart.x + chart.width / 2, chart.y + 2, { steps: 4 });
    await page.mouse.move(chart.x + 2, chart.y + chart.height / 2, { steps: 6 });
    await expect(rest).toHaveCount(1);
    await expect(rest).not.toHaveText(/^Ends /);
    await expect.poll(() => first.getAttribute("data-chance")).not.toBe(before);
});

test("the chart is read before the hover", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover only");
    await predict(page, samples.multi!);
    await expect
        .poll(() => requests.filter((url) => url.startsWith(`${API}/markets/${samples.multi}/history`)).length)
        .toBeGreaterThan(0);
    await expect(card(page)).toHaveCount(0);
});

test("opening the picker hides the card, and Escape closes it", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover only");
    await predict(page, samples.multi!);
    await openCard(page, questionPill(page));
    await page.keyboard.press("Escape");
    await expect(card(page)).toHaveCount(0);

    await page.mouse.move(5, 5);
    await questionPill(page).hover();
    await expect(card(page)).toBeVisible();
    await questionPill(page).click();
    await expect(picker(page)).toBeVisible();
    await expect(card(page)).toHaveCount(0);
});

test("a history that can't be read shows no card", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover only");
    // The pick's read-ahead takes the failure, and a failed read isn't retried within seconds
    await failNextPolymarket("/batch-prices-history");
    const refused = page.waitForResponse(
        (response) => response.url().startsWith(`${API}/markets/${samples.named}/history`) && response.status() === 503,
    );
    await predict(page, samples.named!);
    await refused;
    await questionPill(page).hover();
    await page.waitForTimeout(500);
    await expect(card(page)).toHaveCount(0);
});

test("a read that lands while the pill is hovered opens the card", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover only");
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(new RegExp(`/markets/${samples.multi}/history`), async (route) => {
        await held;
        await route.continue();
    });
    await predict(page, samples.multi!);
    await questionPill(page).hover();
    await page.waitForTimeout(300);
    await expect(card(page)).toHaveCount(0);
    release();
    await expect(card(page)).toBeVisible();
});

test("a tap opens the picker, never a chart", async ({ page, isMobile }) => {
    test.skip(!isMobile, "touch only");
    await predict(page, samples.multi!);
    await expect
        .poll(() => requests.filter((url) => url.startsWith(`${API}/markets/${samples.multi}/history`)).length)
        .toBeGreaterThan(0);
    await questionPill(page).tap();
    await expect(picker(page)).toBeVisible();
    await page.waitForTimeout(500);
    await expect(card(page)).toHaveCount(0);
});
