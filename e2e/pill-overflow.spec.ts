import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockArcRpc, mockPrivy } from "./privy-mock";
import type { TrendingView } from "@/server/src/protocol";

const LONG =
    "Will the long-running dispute over every last outcome of this question finally be settled before the end of 2027?";

const trade = (page: Page) => page.getByRole("region", { name: "Trade" });
const picker = (page: Page) => page.locator("[data-floating-dialog]:not([data-closing])");
const questionPill = (page: Page) => trade(page).locator('[data-slot="marketId"] button');

/** The pill's text box: the one that ends in an ellipsis when the line is too short for it. */
const labelOf = (pill: Locator) => pill.locator("span.self-baseline").first();

test.beforeEach(async ({ page }) => {
    await mockPrivy(page);
    await mockArcRpc(page);
    // The first trending question, which Predict starts on, gets a title no line can hold
    await page.route("**/markets/trending", async (route) => {
        const response = await route.fetch();
        const trending = (await response.json()) as TrendingView;
        trending.markets[0] = { ...trending.markets[0], title: LONG };
        await route.fulfill({ response, json: trending });
    });
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
});

test("a question too long for its line ends in an ellipsis and keeps its chevron in the pill", async ({
    page,
    isMobile,
}) => {
    await trade(page).locator('[data-slot="verb"] button').click();
    await picker(page)
        .getByRole("option", { name: /^Predict/ })
        .click();
    await expect(picker(page)).toBeHidden();

    const pill = questionPill(page);
    await expect(pill).toHaveAccessibleName(LONG);
    const label = labelOf(pill);
    // A phone shows the question's short form, which fits; a wider screen shows the whole of it, cut with an ellipsis
    await expect
        .poll(() =>
            label.evaluate((el) => ({
                ellipsis: getComputedStyle(el).textOverflow === "ellipsis",
                cut: el.scrollWidth > el.clientWidth,
            })),
        )
        .toEqual({ ellipsis: true, cut: !isMobile });

    // The chevron is drawn inside the pill, not pushed past its clipped edge
    const pillBox = (await pill.boundingBox())!;
    const chevronBox = (await pill.locator("svg").last().boundingBox())!;
    expect(chevronBox.x + chevronBox.width).toBeLessThanOrEqual(pillBox.x + pillBox.width + 0.5);
    expect(chevronBox.x).toBeGreaterThan(pillBox.x);
});
