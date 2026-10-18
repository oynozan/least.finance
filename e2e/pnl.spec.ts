import { expect, test, type Page } from "@playwright/test";
import {
    accountOf,
    gate,
    resolveMarket,
    resolveNow,
    seedDeposits,
    seedHistory,
    sendFromOutside,
    type HistorySeed,
} from "./backend";
import { marketIdOf, pricesLosing, trendingView } from "./polymarket";
import { buyPredictions, predictionsToBuy } from "./positions";
import { addressOf, installWallet, mockArcRpc, mockPrivy } from "./privy-mock";

const dock = (page: Page) => page.getByRole("navigation", { name: "Pages" });
const tile = (page: Page, name: string) => dock(page).getByRole("link", { name, exact: true });
// The one up top: it comes after the page's content, which may have a Connect button of its own.
const walletButton = (page: Page) => page.getByRole("button", { name: /^(Wallet|Connect wallet)/ }).last();
const sidebar = (page: Page) => page.locator("#wallet-sidebar");
// The sidebar has a Balance section of its own.
const balance = (page: Page) => page.getByRole("main").getByRole("region", { name: /^Balance/ });
const chart = (page: Page) => page.getByRole("slider", { name: "Balance by day" });
const activity = (page: Page) => page.getByRole("region", { name: "Activity" });
const rows = (page: Page) => activity(page).locator("tbody tr");
const showOlder = (page: Page) => activity(page).getByRole("button", { name: "Show older" });
const tryAgain = (page: Page) => activity(page).getByRole("button", { name: "Try again" });
// The line under the balance, with the PnL pill in it
const pnlLine = (page: Page) => balance(page).locator("p").filter({ hasText: "PnL" });
const FAILURE = "Couldn't load your history.";

// 120 deposits, a day apart, none of them in the balance or the ledger
const OLD_DEPOSITS: HistorySeed[] = Array.from({ length: 120 }, (_, i) => ({
    kind: "deposit",
    usdc: "1",
    daysAgo: i + 1,
}));
// Settled long past the 35 days the live account keeps, so only the paged history has it
const OLD_LOSS: HistorySeed[] = [{ kind: "prediction", state: "lost", cost: "100", daysAgo: 400, settledDaysAgo: 400 }];

/** Counts the activity:list requests the page sends over its socket, so call it before the page opens */
function activityRequests(page: Page) {
    let sent = 0;
    page.on("websocket", (socket) =>
        socket.on("framesent", ({ payload }) => {
            if (typeof payload === "string" && payload.includes('"activity:list"')) sent++;
        }),
    );
    return () => sent;
}

async function shoot(page: Page, name: string) {
    await page.waitForTimeout(900);
    await page.screenshot({ path: `e2e/screenshots/${test.info().project.name}-pnl-${name}.png` });
}

/** Signs in from the wallet button up top, then folds the sidebar the sign-in opened. */
async function connect(page: Page) {
    await walletButton(page).click();
    await page.locator("#privy-modal-content").getByRole("button", { name: "MetaMask" }).click();
    await expect(sidebar(page)).toHaveAttribute("data-open", "true", { timeout: 10_000 });
    // Privy hands focus back to the wallet button a moment after its modal closes; until it has,
    // focusing anything else can be undone under a test's feet.
    await expect(walletButton(page)).toBeFocused();
    await expect(sidebar(page).getByRole("button", { name: /^Balance/ })).not.toHaveAccessibleName(/loading/, {
        timeout: 10_000,
    });
    await page.keyboard.press("Escape");
    await expect(sidebar(page)).toHaveAttribute("data-open", "false");
}

test.beforeEach(async ({ page }) => {
    await mockPrivy(page);
    await mockArcRpc(page);
    await installWallet(page);
});

test("the wallet sits on top and the dock at the bottom, on every page", async ({ page }) => {
    await page.goto("/");
    const viewport = page.viewportSize()!;
    for (const path of ["/", "/pnl"]) {
        if (path === "/pnl") {
            await tile(page, "PnL").click();
            await expect(page).toHaveURL(/\/pnl$/);
        }
        const [wallet, nav] = await Promise.all([walletButton(page).boundingBox(), dock(page).boundingBox()]);
        expect(wallet!.y).toBeLessThan(80);
        expect(Math.abs(wallet!.x + wallet!.width / 2 - viewport.width / 2)).toBeLessThan(2);
        expect(viewport.height - (nav!.y + nav!.height)).toBeLessThan(60);
        expect(Math.abs(nav!.x + nav!.width / 2 - viewport.width / 2)).toBeLessThan(2);
        await expect(tile(page, path === "/" ? "Trade" : "PnL")).toHaveAttribute("aria-current", "page");
    }
    await expect(tile(page, "Trade")).not.toHaveAttribute("aria-current");
    // Back to trading through the dock.
    await tile(page, "Trade").click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("region", { name: "Trade" })).toBeVisible();
});

test("dock tiles swell toward the pointer and name themselves", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover only");
    await page.goto("/");
    const size = async (name: string) => (await tile(page, name).boundingBox())!.width;
    expect(await size("Trade")).toBeCloseTo(48, 0);
    await tile(page, "PnL").hover();
    await expect.poll(() => size("PnL")).toBeGreaterThan(64);
    // Its neighbor swells too, but less.
    const neighbor = await size("Trade");
    expect(neighbor).toBeGreaterThan(48);
    expect(neighbor).toBeLessThan(await size("PnL"));
    await expect(dock(page).getByText("PnL", { exact: true })).toBeVisible();
    await shoot(page, "1-dock-hover");

    await page.mouse.move(10, 10);
    await expect.poll(() => size("PnL")).toBeLessThan(49);
    await expect(dock(page).getByText("PnL", { exact: true })).toBeHidden();
});

test("The trade button sits in the dock on the trade page only", async ({ page }) => {
    // Its words follow the sentence ("Review", or the way out of what blocks it), so it is found by what it is.
    const action = dock(page).locator("button[data-action]");
    await page.goto("/");
    await connect(page);
    await expect(action).toBeVisible();
    await tile(page, "PnL").click();
    await expect(page).toHaveURL(/\/pnl$/);
    await expect(action).toHaveCount(0);
    await tile(page, "Trade").click();
    await expect(action).toBeVisible();
});

test("the PnL page asks for a wallet until one is connected", async ({ page }) => {
    await page.goto("/pnl");
    await expect(page.getByText("Connect a wallet to see your balance and PnL.")).toBeVisible();
    await expect(balance(page)).toHaveCount(0);
    await page.getByRole("main").getByRole("button", { name: "Connect wallet" }).click();
    await expect(page.locator("#privy-modal-content")).toBeVisible();
});

test("the balance is charted by day, and every operation is listed", async ({ page, isMobile }) => {
    // Seeded before connecting, so the session loads it.
    await seedDeposits(addressOf(page), [{ amount: "500", daysAgo: 3 }]);
    const bought = await predictionsToBuy(2);
    await buyPredictions(addressOf(page), bought);
    await page.goto("/pnl");
    await connect(page);
    await expect(balance(page)).toBeVisible();
    await expect(balance(page).getByRole("heading")).toHaveText("Balance");
    await expect(balance(page)).toContainText(/PnL over 30 days/);

    // A bar a day, and arrowing through them rolls the figures to that day.
    await expect(chart(page)).toHaveAttribute("aria-valuemax", "30");
    await chart(page).focus();
    await expect(chart(page)).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(balance(page).getByRole("heading")).toHaveText(/^Balance on \w{3} \d{1,2}$/);
    await expect(chart(page)).toHaveAttribute("aria-valuenow", "29");
    await page.keyboard.press("Home");
    await expect(chart(page)).toHaveAttribute("aria-valuenow", "1");
    await expect(balance(page)).toContainText("PnL that day");

    // Ranges change the number of days.
    await balance(page).getByRole("radio", { name: "7D" }).click();
    await expect(chart(page)).toHaveAttribute("aria-valuemax", "7");
    await expect(balance(page)).toContainText("PnL over 7 days");

    // The deposit is in the table with the predictions, newest first.
    const deposit = rows(page).filter({ hasText: "Deposit" });
    await expect(deposit).toHaveCount(1);
    await expect(deposit).toContainText("+$500.00");
    const predictions = bought.map((b) => `${b.outcome.label} on ${b.market.title}`);
    await expect(rows(page)).toHaveCount(3);
    for (const [i, title] of [...predictions].reverse().entries()) await expect(rows(page).nth(i)).toContainText(title);
    await expect(rows(page).last()).toContainText("Deposit");
    if (!isMobile) await expect(activity(page).getByRole("columnheader", { name: "Result" })).toBeVisible();
    await shoot(page, "2-page");

    await activity(page).getByRole("radio", { name: "Deposits" }).click();
    await expect(rows(page)).toHaveCount(1);
    await activity(page).getByRole("radio", { name: "Trades" }).click();
    await expect(rows(page)).toHaveCount(2);
    await expect(rows(page).filter({ hasText: "Deposit" })).toHaveCount(0);
});

test("a prediction and its sale are listed, with what the sale realized", async ({ page, isMobile }) => {
    const binary = (await trendingView()).markets.filter((m) => m.outcomes.length === 2);
    const { title } = binary[8]!;
    const outcome = binary[8]!.outcomes[0]!;
    await seedDeposits(addressOf(page), [{ amount: "500", daysAgo: 0 }]);
    await page.goto("/");
    await connect(page);

    const picker = page.locator("[data-floating-dialog]:not([data-closing])");
    const trade = page.getByRole("region", { name: "Trade" });
    await trade.getByRole("button", { name: "Swap", exact: true }).click();
    await picker.getByRole("option", { name: /^Predict/ }).click();
    await trade.locator('[data-slot="marketId"] button').click();
    await picker.getByRole("option", { name: title, exact: true }).click();
    await trade.locator('[data-slot="outcomeId"] button').click();
    await picker.getByRole("option", { name: new RegExp(`^${outcome.label}`) }).click();
    await dock(page).getByRole("button", { name: "Review" }).click();
    const review = page.getByRole("complementary", { name: "Review" });
    await review.getByRole("button", { name: "Confirm prediction" }).click();
    // A placed prediction hands over to the wallet on its own.
    await expect(sidebar(page)).toHaveAttribute("aria-label", "Wallet");
    const position = sidebar(page).getByRole("list", { name: "Open positions" }).getByRole("listitem");
    const mine = position.filter({ hasText: title });
    await expect(mine).toContainText(/\d[\d.]* shares/);
    if (isMobile) await mine.tap();
    else await mine.hover();
    await mine.getByRole("button", { name: `Close ${outcome.label} on ${title}` }).click();
    await expect(mine).toHaveCount(0);
    await page.keyboard.press("Escape");

    await tile(page, "PnL").click();
    const opened = rows(page).filter({ hasText: `${outcome.label} on ${title}` });
    await expect(opened).toHaveCount(2);
    const sold = rows(page).filter({ hasText: `Sold ${outcome.label} on ${title}` });
    await expect(sold).toHaveCount(1);
    await expect(sold).toContainText(/[+−]\$\d|—/);
    // The deposit, the buy and the sale: nothing else.
    await expect(rows(page)).toHaveCount(3);
});

/** The Activity card's height on every frame for a while after a click on a filter, from the click on. */
const heightsAfterPicking = (page: Page, filter: string) =>
    activity(page).evaluate(async (section, filter) => {
        const button = [...section.querySelectorAll<HTMLElement>('[role="radio"]')].find(
            (radio) => radio.textContent === filter,
        )!;
        const seen: number[] = [section.getBoundingClientRect().height];
        button.click();
        const until = performance.now() + 900;
        while (performance.now() < until) {
            await new Promise(requestAnimationFrame);
            seen.push(section.getBoundingClientRect().height);
        }
        return seen;
    }, filter);

test("switching the activity filter never stretches the card past where it ends up", async ({ page }) => {
    // Deposits only, so Trades has nothing and shows its empty state
    await seedDeposits(addressOf(page), [
        { amount: "500", daysAgo: 2 },
        { amount: "200", daysAgo: 1 },
    ]);
    await page.goto("/pnl");
    await connect(page);
    await expect(rows(page)).toHaveCount(2);

    for (const [filter, shown] of [
        ["Trades", 0],
        ["All", 2],
        ["Trades", 0],
        ["Deposits", 2],
    ] as const) {
        const heights = await heightsAfterPicking(page, filter);
        await expect(rows(page)).toHaveCount(shown);
        const [before, after] = [heights[0]!, heights.at(-1)!];
        // It moves from one height to the other, never past both: a leaving empty state can't sit under new rows
        expect(Math.max(...heights), `to ${filter}`).toBeLessThanOrEqual(Math.max(before, after) + 1);
    }
});

test("a 400-day-old loss is in 7D, 30D and All", async ({ page }) => {
    await seedHistory(addressOf(page), [
        { kind: "deposit", usdc: "500", daysAgo: 500 },
        { kind: "prediction", state: "lost", cost: "100", daysAgo: 400, settledDaysAgo: 400 },
        { kind: "perp", state: "liquidated", collateral: "40", proceeds: "0", daysAgo: 200, settledDaysAgo: 200 },
        { kind: "deposit", usdc: "20", daysAgo: 10 },
    ]);
    await page.goto("/pnl");
    await connect(page);
    await expect(chart(page)).toBeVisible();

    for (const [range, pnl] of [
        ["7D", /^\$0\.00/],
        ["30D", /^\$0\.00/],
        ["All", /^−\$140\.00/],
    ] as const) {
        await balance(page).getByRole("radio", { name: range }).click();
        await expect(chart(page)).toHaveAttribute("aria-valuetext", /\$380\.00$/);
        await expect(pnlLine(page)).toHaveText(pnl);
    }
});

test("the chart's placeholder shows while the series loads and the stored series shows at once on a second visit", async ({
    page,
}) => {
    const address = addressOf(page);
    await seedDeposits(address, [{ amount: "500", daysAgo: 3 }]);
    try {
        await gate(address, "pnl", "hold");
        await page.goto("/pnl");
        await connect(page);
        await expect(page.getByLabel("Loading balance")).toBeVisible();
        await expect(page.getByText(FAILURE)).toHaveCount(0);
        await gate(address, "pnl", "off");
        await expect(chart(page)).toBeVisible();

        // The series is asked for again on the way back and held, yet the stored one is drawn
        await gate(address, "pnl", "hold");
        await tile(page, "Trade").click();
        await expect(page).toHaveURL(/\/$/);
        await tile(page, "PnL").click();
        await expect(chart(page)).toBeVisible({ timeout: 1000 });
        await expect(page.getByLabel("Loading balance")).toHaveCount(0);
    } finally {
        await gate(address, "pnl", "off");
    }
});

test("opening the page before the session is ready never shows Couldn't load your history", async ({ page }) => {
    await page.addInitScript((sentence) => {
        const seen = window as unknown as { __sawFailure?: boolean };
        new MutationObserver(() => {
            if (document.body?.innerText.includes(sentence)) seen.__sawFailure = true;
        }).observe(document, { childList: true, subtree: true, characterData: true });
    }, FAILURE);
    await page.goto("/pnl");
    await connect(page);
    await expect(chart(page)).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __sawFailure?: boolean }).__sawFailure)).not.toBe(true);
});

test("a failing series says so, and the next pnl:changed repairs it", async ({ page }) => {
    const address = addressOf(page);
    try {
        await gate(address, "pnl", "fail");
        await page.goto("/pnl");
        await connect(page);
        await expect(page.getByText(FAILURE)).toBeVisible({ timeout: 10_000 });
        await expect(chart(page)).toHaveCount(0);

        await gate(address, "pnl", "off");
        const account = await accountOf(address);
        await sendFromOutside(account!.depositAddress, "5");
        await expect(page.getByText(FAILURE)).toHaveCount(0);
        await expect(chart(page)).toBeVisible();
        await expect(chart(page)).toHaveAttribute("aria-valuetext", /\$5\.00$/);
    } finally {
        await gate(address, "pnl", "off");
    }
});

test("a new deposit updates the bars without a reload", async ({ page }) => {
    const { depositAddress } = await seedDeposits(addressOf(page), [{ amount: "500", daysAgo: 3 }]);
    await page.goto("/pnl");
    await connect(page);
    await expect(chart(page)).toHaveAttribute("aria-valuetext", /\$500\.00$/);

    await sendFromOutside(depositAddress, "50");
    await expect(chart(page)).toHaveAttribute("aria-valuetext", /\$550\.00$/);
});

// Resolving closes a market for everyone, and predictions.spec.ts owns 12 to 15 (positions.ts skips these too)
test("a position resolved while the page is open updates the bars without a reload", async ({ page, isMobile }) => {
    const market = (await trendingView()).markets.filter((m) => m.outcomes.length === 2)[isMobile ? 17 : 16]!;
    const outcome = market.outcomes[1]!;
    await seedDeposits(addressOf(page), [{ amount: "500", daysAgo: 3 }]);
    await buyPredictions(addressOf(page), [{ market, outcome }]);
    await page.goto("/pnl");
    await connect(page);
    await expect(chart(page)).toHaveAttribute("aria-valuetext", /\$500\.00$/);
    await expect(pnlLine(page)).toHaveText(/^\$0\.00/);

    // The outcome bought loses, whichever place the question lists it in
    await resolveMarket(marketIdOf(outcome.tokenId), pricesLosing(outcome.tokenId));
    await resolveNow();
    await expect(pnlLine(page)).toHaveText(/^−\$\d/);
    const lastBalance = async () => Number((await chart(page).getAttribute("aria-valuetext"))!.split("$").at(-1));
    await expect.poll(lastBalance).toBeLessThan(500);
});

test("more than 50 old rows show Show older, which loads the next page and goes away at the end", async ({ page }) => {
    await seedHistory(addressOf(page), OLD_DEPOSITS);
    await page.goto("/pnl");
    await connect(page);
    await expect(rows(page)).toHaveCount(50);

    await showOlder(page).click();
    await expect(rows(page)).toHaveCount(100);
    await showOlder(page).click();
    await expect(rows(page)).toHaveCount(120);
    await expect(showOlder(page)).toHaveCount(0);
});

test("a failed older page leaves Show older, which then works", async ({ page }) => {
    const address = addressOf(page);
    const requests = activityRequests(page);
    await seedHistory(address, OLD_DEPOSITS);
    try {
        await page.goto("/pnl");
        await connect(page);
        await expect(rows(page)).toHaveCount(50);

        await gate(address, "feed", "fail");
        const before = requests();
        await showOlder(page).click();
        // The request went out and was refused, so the button is back
        await expect.poll(requests).toBeGreaterThan(before);
        // One message says why, and the button turns into Try again
        await expect(activity(page).getByRole("status")).toHaveText(
            "Couldn't load older activity. The server can't read your history right now. Try again shortly.",
        );
        await expect(tryAgain(page)).toBeEnabled();
        await expect(rows(page)).toHaveCount(50);

        await gate(address, "feed", "off");
        await tryAgain(page).click();
        await expect(rows(page)).toHaveCount(100);
        await expect(activity(page).getByRole("status")).toHaveCount(0);
        await expect(showOlder(page)).toBeVisible();
    } finally {
        await gate(address, "feed", "off");
    }
});

test("the Deposits chip lists old deposits", async ({ page }) => {
    await seedHistory(addressOf(page), OLD_DEPOSITS);
    await page.goto("/pnl");
    await connect(page);
    await activity(page).getByRole("radio", { name: "Deposits" }).click();
    await expect(rows(page)).toHaveCount(50);
    await showOlder(page).click();
    await expect(rows(page)).toHaveCount(100);
    await showOlder(page).click();
    await expect(rows(page)).toHaveCount(120);
    await expect(showOlder(page)).toHaveCount(0);
});

test("the first paint of a person with old history never shows Nothing here yet", async ({ page }) => {
    const address = addressOf(page);
    await seedHistory(address, OLD_LOSS);
    try {
        await gate(address, "feed", "hold");
        await page.goto("/pnl");
        await connect(page);
        await expect(activity(page).locator('[aria-busy="true"]')).toBeVisible();
        await expect(activity(page).getByText("Nothing here yet")).toHaveCount(0);

        await gate(address, "feed", "off");
        await expect(rows(page)).toHaveCount(2);
        await expect(rows(page).filter({ hasText: "Lost Yes on Will it rain?" })).toHaveCount(1);
        await expect(rows(page).filter({ hasText: "Yes on Will it rain?", hasNotText: "Lost" })).toHaveCount(1);
        await expect(activity(page).getByText("Nothing here yet")).toHaveCount(0);
    } finally {
        await gate(address, "feed", "off");
    }
});

test("a failing first page never shows Nothing here yet and repairs itself", async ({ page }) => {
    const address = addressOf(page);
    await seedHistory(address, OLD_LOSS);
    try {
        await gate(address, "feed", "fail");
        await page.goto("/pnl");
        await connect(page);
        // One retry has failed by now
        await page.waitForTimeout(3500);
        await expect(activity(page).getByText("Nothing here yet")).toHaveCount(0);
        await expect(rows(page)).toHaveCount(0);

        await gate(address, "feed", "off");
        await expect(rows(page)).toHaveCount(2, { timeout: 10_000 });
    } finally {
        await gate(address, "feed", "off");
    }
});

test("phones fit the PnL page without scrolling sideways", async ({ page, isMobile }) => {
    test.skip(!isMobile, "phone layout");
    // A long question, so a row has to truncate.
    await seedDeposits(addressOf(page), [{ amount: "500", daysAgo: 1 }]);
    await seedHistory(addressOf(page), OLD_DEPOSITS);
    await buyPredictions(addressOf(page), await predictionsToBuy(1));
    await page.goto("/pnl");
    await connect(page);
    await expect(rows(page).first()).toBeVisible();
    await expect(showOlder(page)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await shoot(page, "3-phone");
});

/** How far the chart's bars reach past its own edge, in px. The chart's scrollWidth leaves them out. */
const overflowOf = (page: Page) =>
    chart(page).evaluate((el) => {
        const edge = el.getBoundingClientRect();
        const reach = Math.max(...[...el.children].map((bar) => bar.getBoundingClientRect().right));
        return Math.max(
            edge.left - Math.min(...[...el.children].map((bar) => bar.getBoundingClientRect().left)),
            reach - edge.right,
        );
    });

test("the most bars a range can hold stay inside the chart", async ({ page }) => {
    // 90 days is the most the All range draws a bar a day for
    await seedHistory(addressOf(page), [{ kind: "deposit", usdc: "500", daysAgo: 89 }]);
    await page.goto("/pnl");
    await connect(page);
    await balance(page).getByRole("radio", { name: "All" }).click();
    await expect(chart(page)).toHaveAttribute("aria-valuemax", "90");
    await expect(chart(page)).toHaveAttribute("aria-valuetext", /\$500\.00$/);
    expect(await overflowOf(page)).toBeLessThanOrEqual(0);
});

test("a bar a month for a decade stay inside the chart", async ({ page }) => {
    await seedHistory(addressOf(page), [{ kind: "deposit", usdc: "500", daysAgo: 3650 }]);
    await page.goto("/pnl");
    await connect(page);
    await balance(page).getByRole("radio", { name: "All" }).click();
    await expect(chart(page)).toHaveAttribute("aria-valuemax", /^1[12]\d$/);
    expect(await overflowOf(page)).toBeLessThanOrEqual(0);
});
