import { expect, test, type Locator, type Page } from "@playwright/test";
import { installWallet, mockArcRpc, mockPrivy } from "./privy-mock";
import { picker, trade } from "./swap-flow";

const API_URL = `http://localhost:${process.env.E2E_API_PORT ?? 4100}`;

// A leaving card is marked while it animates out.
const card = (page: Page) => page.locator("[data-hover-card]:not([data-closing])");
const coinPill = (page: Page, symbol: string) => trade(page).getByRole("button", { name: symbol, exact: true });
/** The price the card shows; NumberFlow's own digits can't be read as text. */
const shownPrice = (page: Page) => card(page).locator("[data-price]").getAttribute("data-price").then(Number);

async function shoot(page: Page, name: string) {
    await page.waitForTimeout(900);
    await page.screenshot({ path: `e2e/screenshots/${test.info().project.name}-price-card-${name}.png` });
}

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

/** Whether a pill sits on the sentence's last line. */
const onLastLine = (pill: Locator) =>
    pill.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const sentence = el.closest("[data-sentence]")!.getBoundingClientRect();
        return rect.bottom > sentence.bottom - rect.height / 2;
    });

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Above the pill unless it's on the last line, or the preferred side has no
 * room: within the viewport and clear of the dock and the wallet button
 * wherever they're in the card's column. Centered on the pill.
 */
async function expectPlaced(page: Page, pill: Locator) {
    const [p, c] = await Promise.all([pill.boundingBox(), card(page).boundingBox()]);
    const viewport = page.viewportSize()!;
    const bars = await page
        .locator("[data-keep-clear]")
        .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON() as DOMRect));
    let ceiling = 16;
    let floor = viewport.height - 16;
    for (const bar of bars) {
        if (bar.right <= c!.x || bar.left >= c!.x + c!.width) continue;
        if (bar.top >= p!.y + p!.height) floor = Math.min(floor, bar.top - 12);
        else if (bar.bottom <= p!.y) ceiling = Math.max(ceiling, bar.bottom + 12);
    }
    const preferred = (await onLastLine(pill)) ? "below" : "above";
    const room = { above: p!.y - 12 - ceiling, below: floor - (p!.y + p!.height) - 12 };
    const other = preferred === "above" ? "below" : "above";
    const side = room[preferred] >= c!.height ? preferred : room[other] >= c!.height ? other : preferred;
    await expect(card(page)).toHaveAttribute("data-side", side);
    if (side === "below") expect(c!.y).toBeGreaterThanOrEqual(p!.y + p!.height);
    else expect(c!.y + c!.height).toBeLessThanOrEqual(p!.y);
    expect(Math.abs(c!.x + c!.width / 2 - (p!.x + p!.width / 2))).toBeLessThan(2);
    expect(c!.x).toBeGreaterThanOrEqual(16);
    expect(c!.x + c!.width).toBeLessThanOrEqual(viewport.width - 16);
    expect(c!.y).toBeGreaterThanOrEqual(ceiling - 0.5);
    expect(c!.y + c!.height).toBeLessThanOrEqual(floor + 0.5);
    for (const bar of bars)
        expect(overlaps(c!, { x: bar.x, y: bar.y, width: bar.width, height: bar.height })).toBe(false);
    return side;
}

/** The server's week of prices for a coin. */
const pointsOf = async (symbol: string) =>
    (await (await fetch(`${API_URL}/prices/history?range=7d&coins=${symbol}`)).json()).coins[0].points as [
        number,
        number,
    ][];

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

test("hovering a coin shows its week of prices, loaded before the hover", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover only");
    // Tall enough that the dock is out of the way below the last line
    await page.setViewportSize({ width: 1388, height: 900 });
    // Read once in the background, from our server
    await expect.poll(() => requests.filter((url) => url.includes("/prices/history")).length).toBe(1);
    expect(requests.find((url) => url.includes("/prices/history"))).toBe(`${API_URL}/prices/history?range=7d`);
    const asked = requests.length;

    // ETH is on the sentence's first line and SOL on its last, so the card goes above one and below the other
    const eth = coinPill(page, "ETH");
    const sol = coinPill(page, "SOL");
    expect(await onLastLine(eth)).toBe(false);
    expect(await onLastLine(sol)).toBe(true);

    await openCard(page, eth);
    await expect(card(page)).toContainText("Ethereum");
    await expect(card(page)).toContainText("ETH");
    await expect(card(page)).toContainText(/^[^%]*[+\u2212]?\d+\.\d{2}%[^%]*$/);
    // The coin, its price and its change: no other labels
    for (const label of ["Low", "High", "Past", "days"]) await expect(card(page)).not.toContainText(label);
    // The latest price, as the server has it
    expect(await shownPrice(page)).toBe((await pointsOf("ETH")).at(-1)![1]);
    expect(await expectPlaced(page, eth)).toBe("above");
    await shoot(page, "1-eth");

    // Straight from one coin to the next, the card swaps at once
    await openCard(page, sol);
    await expect(card(page)).toHaveCount(1);
    await expect(card(page)).toContainText("Solana");
    expect(await expectPlaced(page, sol)).toBe("below");
    await shoot(page, "2-sol");

    // Hovering asked our server for nothing, and DefiLlama is never called from the browser
    expect(requests.slice(asked).filter((url) => url.startsWith(API_URL))).toEqual([]);
    expect(requests.filter((url) => url.includes("llama.fi"))).toEqual([]);

    await page.mouse.move(5, 5);
    await expect(page.locator("[data-hover-card]")).toHaveCount(0);
});

test("pointing along the chart rolls the price to that moment and says when", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover only");
    const points = await pointsOf("ETH");
    const date = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric" });
    // The ticker line under the name; while one gives way to the other, both are there for a moment
    const subtitle = card(page).locator("[data-subtitle]");
    await openCard(page, coinPill(page, "ETH"));
    const chart = card(page).locator("[data-chart]");
    const box = (await chart.boundingBox())!;
    const cardBox = (await card(page).boundingBox())!;
    // It runs to the card's edges
    expect(Math.abs(box.x - cardBox.x)).toBeLessThan(1);
    expect(Math.abs(box.x + box.width - (cardBox.x + cardBox.width))).toBeLessThan(1);
    expect(Math.abs(box.y + box.height - (cardBox.y + cardBox.height))).toBeLessThan(1);
    // And so does its line, from the first price at the left edge to the latest at the right
    // (its box takes in the round caps, half the 2.5px stroke past each end)
    const line = (await chart.locator("[data-line]").boundingBox())!;
    expect(Math.abs(line.x - cardBox.x)).toBeLessThan(2);
    expect(Math.abs(line.x + line.width - (cardBox.x + cardBox.width))).toBeLessThan(2);

    // Into the card, then to the chart's left edge: the week's first price
    await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + 30, { steps: 4 });
    await page.mouse.move(box.x + 0.3, box.y + box.height / 2, { steps: 4 });
    await expect.poll(() => shownPrice(page)).toBe(points[0]![1]);
    await expect(subtitle).toHaveCount(1);
    await expect(subtitle).toHaveText(date.format(points[0]![0]));

    // Halfway along, a price from the middle of the week, with its own time
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    await expect.poll(() => shownPrice(page)).not.toBe(points[0]![1]);
    // The fake's prices repeat daily, so the point is found by its time, which is unique
    await expect(subtitle).toHaveCount(1);
    const shownAt = await subtitle.textContent();
    const at = points.findIndex(([time]) => date.format(time) === shownAt);
    expect(at).toBeGreaterThan(points.length * 0.4);
    expect(at).toBeLessThan(points.length * 0.6);
    expect(await shownPrice(page)).toBe(points[at]![1]);
    await shoot(page, "4-scrub");

    // Off the chart, back to now
    await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + 30, { steps: 4 });
    await expect.poll(() => shownPrice(page)).toBe(points.at(-1)![1]);
    await expect(subtitle).toHaveCount(1);
    await expect(subtitle).toHaveText("ETH");
});

test("a card below the last line that would reach the dock goes above instead", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover only");
    const sol = coinPill(page, "SOL");
    expect(await onLastLine(sol)).toBe(true);
    await openCard(page, sol);
    const [p, c, dock] = await Promise.all([
        sol.boundingBox(),
        card(page).boundingBox(),
        page.getByRole("navigation", { name: "Pages" }).boundingBox(),
    ]);
    // Between the pill and the dock there's no room for it
    expect(dock!.y - 12 - (p!.y + p!.height) - 12).toBeLessThan(c!.height);
    expect(await expectPlaced(page, sol)).toBe("above");
    expect(overlaps(c!, dock!)).toBe(false);
    await shoot(page, "5-clear-of-dock");
});

test("on a short window the card turns to the side with room", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover only");
    await page.setViewportSize({ width: 1388, height: 520 });
    const eth = coinPill(page, "ETH");
    await expect(eth).toBeVisible();
    await page.waitForTimeout(400);
    expect(await onLastLine(eth)).toBe(false);

    await openCard(page, eth);
    const [p, c] = await Promise.all([eth.boundingBox(), card(page).boundingBox()]);
    // No room above the first line here, so it drops below instead
    expect(p!.y - 28).toBeLessThan(c!.height);
    expect(await expectPlaced(page, eth)).toBe("below");
    await shoot(page, "3-flipped");
});

test("the card stays while the pointer crosses onto it, and Escape or a click puts it away", async ({
    page,
    isMobile,
}) => {
    test.skip(isMobile, "hover only");
    const eth = coinPill(page, "ETH");
    await openCard(page, eth);

    // Across the gap and onto the card
    const box = (await card(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
    await page.waitForTimeout(400);
    await expect(card(page)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(card(page)).toHaveCount(0);

    // A press opens the picker instead
    await page.mouse.move(5, 5);
    await eth.hover();
    await expect(card(page)).toBeVisible();
    await eth.click();
    await expect(picker(page)).toBeVisible();
    await expect(card(page)).toHaveCount(0);
});

test("a market's pill shows no price card, though it has a coin's icon", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover only");
    await trade(page).getByRole("button", { name: "Swap", exact: true }).click();
    await picker(page)
        .getByRole("option", { name: /^Predict/ })
        .click();
    await expect(picker(page)).toBeHidden();
    await trade(page).locator('[data-slot="marketId"] button').hover();
    await page.waitForTimeout(500);
    await expect(card(page)).toHaveCount(0);
});

test("a tap on a phone opens the picker, never the card", async ({ page, isMobile }) => {
    test.skip(!isMobile, "touch only");
    await expect.poll(() => requests.filter((url) => url.includes("/prices/history")).length).toBe(1);
    await coinPill(page, "ETH").tap();
    await expect(picker(page)).toBeVisible();
    await page.waitForTimeout(500);
    await expect(card(page)).toHaveCount(0);
});
