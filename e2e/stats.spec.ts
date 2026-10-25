import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { StatsPositionRow, StatsView } from "@/server/src/protocol";
import { randomAddress, seedHistory, signUp } from "./backend";

const card = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const chart = (page: Page) => page.getByRole("slider", { name: "Equity over time" });

const API_PORT = String(process.env.E2E_API_PORT ?? 4100);
const CORS = { "access-control-allow-origin": "*" };
/** The API's own `path`, not the page of the same name on the app's port. */
const api = (path: string) => (url: URL) => url.port === API_PORT && url.pathname === path;

/** The seeded series is linear: oldest 203, then 3 more per snapshot up to 404. */
const isSeeded = (usd: number) => usd >= 203 && usd <= 404 && (usd - 203) % 3 === 0;
const totalOf = async (page: Page) =>
    Number(await card(page, "Our money").locator("[data-total]").getAttribute("data-total"));

test("the page shows our money, balances and fees, and stays out of search", async ({ page }) => {
    await page.goto("/stats");
    await expect(card(page, "Our money")).toBeVisible();
    await expect(card(page, "Balances")).toBeVisible();
    await expect(card(page, "Fees in the last 30 days")).toBeVisible();
    await expect(page.locator("[data-estimated]")).toHaveCount(0);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
    await expect(page).toHaveTitle(/Stats/);
});

test("a wallet row shows its label and dollars, and its address on hover", async ({ page }) => {
    await page.goto("/stats");
    const row = card(page, "Balances").getByRole("listitem").filter({ hasText: "Arc treasury" });
    await expect(row).toContainText("$1,500.00");
    await row.hover();
    await expect(row).toContainText("0x00000000000000000000000000000000000000b1");
    await expect(row.getByRole("button", { name: /Copy/ })).toBeVisible();
});

test("switching the range changes the chart", async ({ page }) => {
    await page.goto("/stats");
    const line = card(page, "Our money").locator("[data-line]");
    await expect(line).toBeVisible();
    const before = await line.getAttribute("d");
    await card(page, "Our money").getByRole("radio", { name: "All" }).click();
    await expect.poll(() => line.getAttribute("d")).not.toBe(before);
});

test("scrubbing with the keyboard rolls the number to the exact equity at that point", async ({ page }) => {
    await page.goto("/stats");
    const total = card(page, "Our money").locator("[data-total]");
    await expect(total).toBeVisible();
    const live = await totalOf(page);
    const slider = chart(page);
    await slider.focus();
    await page.keyboard.press("Home");
    await expect(total).toHaveAttribute("data-total", "203");
    await expect(slider).toHaveAttribute("aria-valuetext", /\$203\.00$/);
    await page.keyboard.press("ArrowRight");
    await expect(total).toHaveAttribute("data-total", "206");
    await page.keyboard.press("End");
    await expect.poll(() => totalOf(page)).not.toBe(206);
    await slider.blur();
    await expect.poll(() => totalOf(page)).toBe(live);
});

test("scrubbing with the pointer rolls the number to the equity under it, and lets go when it leaves", async ({
    page,
}) => {
    await page.goto("/stats");
    const money = card(page, "Our money");
    await expect(chart(page)).toBeVisible();
    const live = await totalOf(page);
    const box = (await chart(page).boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + 1, y);
    await expect.poll(() => totalOf(page)).toBe(203);
    await page.mouse.move(box.x + box.width / 2, y, { steps: 5 });
    await expect.poll(async () => isSeeded(await totalOf(page))).toBe(true);
    const mid = await totalOf(page);
    expect(mid).toBeGreaterThan(203);
    await expect(chart(page)).toHaveAttribute("aria-valuetext", new RegExp(`\\$${mid}\\.00$`));
    await page.mouse.move(box.x + box.width - 1, y, { steps: 5 });
    await expect.poll(async () => (await totalOf(page)) > mid).toBe(true);
    await page.mouse.move(box.x + box.width / 2, box.y - 150);
    await expect.poll(() => totalOf(page)).toBe(live);
    await expect(money.locator("[data-total]")).toBeVisible();
});

test("the header does not move while scrubbing", async ({ page }) => {
    await page.goto("/stats");
    const money = card(page, "Our money");
    const header = [money.locator("[data-total]"), money.getByRole("radiogroup", { name: "Range" })];
    await expect(chart(page)).toBeVisible();
    // The card rises into place on load; measure once it has.
    await page.waitForTimeout(1200);
    const before = await Promise.all(header.map((h) => h.boundingBox()));
    const box = (await chart(page).boundingBox())!;
    for (const x of [1, box.width / 2, box.width - 1]) {
        await page.mouse.move(box.x + x, box.y + box.height / 2);
        await expect.poll(() => chart(page).getAttribute("aria-valuenow")).toBeTruthy();
        const during = await Promise.all(header.map((h) => h.boundingBox()));
        during.forEach((b, i) => {
            expect(b!.y).toBeCloseTo(before[i]!.y, 0);
            expect(b!.x).toBeCloseTo(before[i]!.x, 0);
        });
        const range = await header[1]!.boundingBox();
        expect(range!.height).toBeCloseTo(before[1]!.height, 0);
    }
});

test("the scrub dot stays inside the card at the first and last point", async ({ page }) => {
    await page.goto("/stats");
    const slider = chart(page);
    await expect(slider).toBeVisible();
    const box = (await slider.boundingBox())!;
    for (const key of ["Home", "End"]) {
        await slider.focus();
        await page.keyboard.press(key);
        const dot = slider.locator("span.rounded-full");
        await expect(dot).toBeVisible();
        const d = (await dot.boundingBox())!;
        expect(d.x).toBeGreaterThanOrEqual(box.x - 0.5);
        expect(d.x + d.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
        expect(d.y).toBeGreaterThanOrEqual(box.y - 0.5);
        expect(d.y + d.height).toBeLessThanOrEqual(box.y + box.height + 0.5);
    }
});

test("while a range's line is on its way there is no flat chip, and another range's line is ignored", async ({
    page,
}) => {
    await page.route(api("/stats/pnl"), async (route) => {
        if (new URL(route.request().url()).searchParams.get("range") === "All")
            await new Promise((r) => setTimeout(r, 2000));
        await route.continue();
    });
    await page.goto("/stats");
    const money = card(page, "Our money");
    const line = money.locator("[data-line]");
    await expect(line).toBeVisible();
    const month = await line.getAttribute("d");
    await money.getByRole("radio", { name: "All" }).click();
    await expect(chart(page)).toHaveCount(0);
    await expect(money).not.toContainText("$0.00");
    await expect(money.locator("span.rounded-full.h-8")).toHaveCount(0);
    // The card keeps its height while it waits.
    const waiting = (await money.boundingBox())!;
    await money.getByRole("radio", { name: "30D" }).click();
    await expect(line).toBeVisible();
    await page.waitForTimeout(2500);
    // The All reply landed meanwhile and must not replace the 30D line.
    expect(await line.getAttribute("d")).toBe(month);
    expect(Math.abs((await money.boundingBox())!.height - waiting.height)).toBeLessThan(2);
});

test("the Fees heading names the range", async ({ page }) => {
    await page.goto("/stats");
    const money = card(page, "Our money");
    await expect(card(page, "Fees in the last 30 days")).toBeVisible();
    await money.getByRole("radio", { name: "7D" }).click();
    await expect(card(page, "Fees in the last 7 days")).toBeVisible();
    await money.getByRole("radio", { name: "All" }).click();
    await expect(card(page, "All fees")).toBeVisible();
    await card(page, "All fees").scrollIntoViewIfNeeded();
    await card(page, "All fees").screenshot({ path: `e2e/screenshots/${test.info().project.name}-stats-fees.png` });
});

test("the Fees labels and values share a baseline", async ({ page }) => {
    await page.goto("/stats");
    const row = card(page, "Fees in the last 30 days").locator("dl > div").first();
    await expect(row).toHaveCSS("align-items", "baseline");
});

const wallet = (over: Partial<StatsView["wallets"][number]>): StatsView["wallets"][number] => ({
    id: "treasury",
    label: "Arc treasury",
    network: "Arc",
    address: "0x00000000000000000000000000000000000000b1",
    usd: "1500",
    parts: [],
    error: null,
    readAt: "2026-10-25T10:00:00.000Z",
    ...over,
});
const fees = { totalUsd: "3", spreadUsd: "2", perpUsd: "1" };
const view = (over: Partial<StatsView>): StatsView => ({
    at: "2026-10-25T10:00:00.000Z",
    heldUsd: "1500",
    owedUsd: "1000",
    equityUsd: "500",
    estimated: false,
    wallets: [wallet({})],
    owed: [{ id: "cash", label: "People's cash", usd: "1000" }],
    fees: { "7D": fees, "30D": fees, All: fees },
    ...over,
});
const serve = (page: Page, body: StatsView) =>
    page.route(api("/stats"), (route) => route.fulfill({ json: body, headers: CORS }));

test.describe("a stats view with unread wallets", () => {
    const sentence = "Some wallets couldn't be read, so their last known amounts are used.";

    test("a wallet we haven't set up reads muted, with no problem marked", async ({ page }) => {
        await serve(
            page,
            view({
                wallets: [
                    wallet({}),
                    wallet({
                        id: "hyperliquid",
                        label: "Hyperliquid float",
                        network: "Hyperliquid",
                        address: null,
                        usd: "0",
                        error: "Not set up",
                    }),
                ],
            }),
        );
        await page.goto("/stats");
        const row = card(page, "Balances").getByRole("listitem").filter({ hasText: "Hyperliquid float" });
        await expect(row.getByText("Not set up")).toBeVisible();
        await expect(row.getByText("Not set up")).toHaveClass(/text-muted/);
        await expect(row.getByText("$0.00")).toHaveCount(0);
        await expect(row.locator(".bg-loss")).toHaveCount(0);
        await expect(page.locator("[data-estimated]")).toHaveCount(0);
        await page.screenshot({ path: `e2e/screenshots/${test.info().project.name}-stats-not-set-up.png` });
    });

    test("the estimated dot sits after the total and explains itself on hover or focus", async ({ page }) => {
        await serve(page, view({ estimated: true }));
        await page.goto("/stats");
        const dot = page.locator("[data-estimated]");
        const tip = dot.getByRole("tooltip");
        await expect(dot).toBeVisible();
        await expect(tip).toHaveText(sentence);
        await expect(tip).toHaveCSS("opacity", "0");
        const total = (await card(page, "Our money").locator("[data-total]").boundingBox())!;
        const at = (await dot.boundingBox())!;
        expect(at.x).toBeGreaterThanOrEqual(total.x + total.width);
        // A touch screen has no hover; a tap focuses it.
        if (test.info().project.name === "mobile") await dot.focus();
        else await dot.hover();
        await expect(tip).toHaveCSS("opacity", "1");
        await page.screenshot({ path: `e2e/screenshots/${test.info().project.name}-stats-estimated.png` });
        await dot.blur();
        await page.mouse.move(0, 0);
        await expect(tip).toHaveCSS("opacity", "0");
        await dot.focus();
        await expect(tip).toHaveCSS("opacity", "1");
    });

    test("a wallet that failed to read shows its error on hover and in its accessible name", async ({ page }) => {
        await serve(page, view({ estimated: true, wallets: [wallet({ error: "RPC timed out after 20 s" })] }));
        await page.goto("/stats");
        const row = card(page, "Balances").getByRole("listitem").filter({ hasText: "Arc treasury" });
        const problem = row.getByText("RPC timed out after 20 s");
        await expect(row.locator("div.grid")).toHaveCSS("opacity", "0");
        await expect(row.locator(".bg-loss")).toHaveCount(1);
        await expect(row).toHaveAttribute("aria-label", /Arc treasury, \$1,500\.00, RPC timed out after 20 s/);
        if (test.info().project.name === "mobile") await row.focus();
        else await row.hover();
        await expect(problem).toBeVisible();
        await expect(problem).toHaveClass(/text-loss/);
        await expect(row.locator("div.grid")).toHaveCSS("opacity", "1");
        await page.screenshot({ path: `e2e/screenshots/${test.info().project.name}-stats-wallet-error.png` });
    });
});

test("the dock does not link to /stats", () => {
    expect(readFileSync("components/dock.tsx", "utf8")).not.toContain("/stats");
});

const positions = (page: Page) => card(page, "Positions");
const rowIds = (page: Page) =>
    positions(page)
        .locator("tbody tr")
        .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-id")));

/** Eight pages of three rows, each named by its page. */
const pageOf = (n: number) => ({
    items: Array.from({ length: 3 }, (_, i): StatsPositionRow => ({
        id: `p${n}-${i}`,
        kind: "coin",
        account: "a1b2c3",
        title: `Row ${n}-${i}`,
        detail: "",
        size: "1 ETH",
        valueUsd: "10",
        pnlUsd: "1",
        state: "open",
        openedAt: "2026-10-25T10:00:00.000Z",
        closedAt: null,
    })),
    page: n,
    pages: 8,
    total: 24,
});

test.describe("positions", () => {
    test.beforeAll(async () => {
        const address = randomAddress();
        await signUp(address);
        const predictions = Array.from({ length: 22 }, (_, i) => ({
            kind: "prediction" as const,
            state: i % 2 ? ("won" as const) : ("open" as const),
            cost: "5",
            payout: i % 2 ? "9" : undefined,
            daysAgo: i + 1,
        }));
        await seedHistory(address, [
            ...predictions,
            { kind: "perp", state: "closed", collateral: "10", proceeds: "12", daysAgo: 1 },
            { kind: "perp", state: "open", collateral: "10", daysAgo: 2 },
        ]);
    });

    test("page 2 lists other rows than page 1", async ({ page }) => {
        await page.goto("/stats");
        await expect(positions(page).locator("tbody tr")).toHaveCount(20);
        const first = await rowIds(page);
        await positions(page).getByRole("button", { name: "2", exact: true }).click();
        await expect(positions(page).getByRole("button", { name: "2", exact: true })).toHaveAttribute(
            "aria-current",
            "page",
        );
        await expect.poll(async () => (await rowIds(page))[0]).not.toBe(first[0]);
        const second = await rowIds(page);
        expect(second.length).toBeGreaterThan(0);
        // Other specs seed in parallel, which can slide a row or two across the page break.
        expect(second.filter((id) => !first.includes(id)).length).toBeGreaterThan(0);
    });

    test("the Perps filter shows only perps, and Closed only closed rows", async ({ page }) => {
        await page.goto("/stats");
        await expect(positions(page).locator("tbody tr")).toHaveCount(20);
        await positions(page).getByRole("radio", { name: "Perps" }).click();
        const rows = positions(page).locator("tbody tr");
        await expect(rows.first()).toHaveAttribute("data-kind", "perp");
        const kinds = await rows.evaluateAll((rs) => rs.map((r) => r.getAttribute("data-kind")));
        expect(new Set(kinds)).toEqual(new Set(["perp"]));
        await positions(page).getByRole("radio", { name: "All" }).first().click();
        await positions(page).getByRole("radio", { name: "Closed" }).click();
        await positions(page).getByRole("radio", { name: "Perps" }).click();
        await expect(rows.first()).toHaveAttribute("data-state", /closed|liquidated/);
        const states = await rows.evaluateAll((rs) => rs.map((r) => r.getAttribute("data-state")));
        expect(states.every((s) => s === "closed" || s === "liquidated")).toBe(true);
    });

    test("a filter change returns to page 1", async ({ page }) => {
        await page.goto("/stats");
        await positions(page).getByRole("button", { name: "2", exact: true }).click();
        await expect(positions(page).getByRole("button", { name: "2", exact: true })).toHaveAttribute(
            "aria-current",
            "page",
        );
        await positions(page).getByRole("radio", { name: "Predictions" }).click();
        await expect(positions(page).getByRole("button", { name: "1", exact: true })).toHaveAttribute(
            "aria-current",
            "page",
        );
    });

    test("the pager hides with a single page, and an empty list says so", async ({ page }) => {
        await page.route("**/stats/positions*", (route) =>
            route.fulfill({ json: { items: [], page: 1, pages: 1, total: 0 } }),
        );
        await page.goto("/stats");
        await expect(positions(page).getByText("No positions.")).toBeVisible();
        await expect(positions(page).getByRole("button", { name: "Next" })).toHaveCount(0);
        await expect(positions(page).locator("[aria-current=page]")).toHaveCount(0);
    });

    test("a failed read says so and Try again reads it again", async ({ page }) => {
        let fail = true;
        await page.route("**/stats/positions*", (route) =>
            fail
                ? route.fulfill({ status: 500, json: { error: { code: "internal", message: "x" } } })
                : route.continue(),
        );
        await page.goto("/stats");
        await expect(positions(page).getByText("Couldn't load positions.")).toBeVisible();
        fail = false;
        await positions(page).getByRole("button", { name: "Try again" }).click();
        await expect(positions(page).locator("tbody tr[data-id]").first()).toBeVisible();
    });

    test("the previous page stays while the next loads", async ({ page }) => {
        await page.goto("/stats");
        await expect(positions(page).locator("tbody tr[data-id]")).toHaveCount(20);
        const first = await rowIds(page);
        await page.route(api("/stats/positions"), async (route) => {
            await new Promise((r) => setTimeout(r, 1500));
            await route.continue();
        });
        await positions(page).getByRole("button", { name: "2", exact: true }).click();
        await page.waitForTimeout(600);
        // Still waiting: page 1's rows are on show, not a loading state.
        expect(await rowIds(page)).toEqual(first);
        await expect(positions(page).getByText(/loading/i)).toHaveCount(0);
        await expect.poll(async () => (await rowIds(page))[0]).not.toBe(first[0]);
        const second = await rowIds(page);
        expect(second.filter((id) => first.includes(id)).length).toBeLessThan(first.length);
    });

    test("the first load shows placeholder rows, and the list reads again every minute on the same page", async ({
        page,
    }) => {
        await page.clock.install();
        const ask: string[] = [];
        await page.route(api("/stats/positions"), async (route) => {
            const url = new URL(route.request().url());
            ask.push(url.search);
            if (ask.length === 1) await new Promise((r) => setTimeout(r, 4000));
            await route.fulfill({ json: pageOf(Number(url.searchParams.get("page"))), headers: CORS });
        });
        await page.goto("/stats");
        await expect(positions(page).locator("tbody[aria-busy=true] tr[data-pulse]").first()).toBeVisible();
        // The cards rise on a clock we hold still, so let it run a second.
        await page.clock.runFor(1000);
        await positions(page).scrollIntoViewIfNeeded();
        await positions(page).screenshot({
            path: `e2e/screenshots/${test.info().project.name}-stats-positions-loading.png`,
        });
        await page.clock.runFor(1500);
        await expect(positions(page).locator("tbody tr[data-id]")).toHaveCount(3);
        await positions(page).getByRole("button", { name: "3", exact: true }).click();
        await expect(positions(page).getByRole("button", { name: "3", exact: true })).toHaveAttribute(
            "aria-current",
            "page",
        );
        const before = ask.length;
        await page.clock.runFor(61_000);
        await expect.poll(() => ask.length).toBeGreaterThan(before);
        expect(ask.at(-1)).toContain("page=3");
        // The refreshed page is on show, with no placeholder in between.
        await expect(positions(page).locator("tbody tr[data-id]")).toHaveCount(3);
        await expect(positions(page).locator("tr[data-pulse]")).toHaveCount(0);
    });

    test("the pager shows up to five numbers around the page, and ends disable Previous or Next", async ({ page }) => {
        await page.route(api("/stats/positions"), (route) =>
            route.fulfill({
                json: pageOf(Number(new URL(route.request().url()).searchParams.get("page"))),
                headers: CORS,
            }),
        );
        await page.goto("/stats");
        const numbers = async () =>
            (await positions(page).getByRole("navigation", { name: "Pages" }).getByRole("button").allTextContents())
                .map((t) => t.trim())
                .filter((t) => /^\d+$/.test(t));
        const prev = positions(page).getByRole("button", { name: "Previous" });
        const next = positions(page).getByRole("button", { name: "Next" });
        await expect(prev).toBeDisabled();
        expect(await numbers()).toEqual(["1", "2", "3", "4", "5"]);
        await next.click();
        await next.click();
        await next.click();
        await expect(positions(page).locator('[aria-current="page"]')).toHaveText("4");
        expect(await numbers()).toEqual(["2", "3", "4", "5", "6"]);
        for (let n = 5; n <= 8; n++) await next.click();
        await expect(positions(page).locator('[aria-current="page"]')).toHaveText("8");
        expect(await numbers()).toEqual(["4", "5", "6", "7", "8"]);
        await expect(next).toBeDisabled();
        await expect(prev).toBeEnabled();
    });
});
