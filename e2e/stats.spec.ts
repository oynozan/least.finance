import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { randomAddress, seedHistory, signUp } from "./backend";

const card = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const chart = (page: Page) => page.getByRole("slider", { name: "Equity over time" });

test("the page shows our money, balances and fees, and stays out of search", async ({ page }) => {
    await page.goto("/stats");
    await expect(card(page, "Our money")).toBeVisible();
    await expect(card(page, "Balances")).toBeVisible();
    await expect(card(page, "Fees")).toBeVisible();
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

test("scrubbing rolls the number to that point", async ({ page }) => {
    await page.goto("/stats");
    const total = card(page, "Our money").locator("[data-total]");
    await expect(total).toBeVisible();
    const slider = chart(page);
    const before = await slider.getAttribute("aria-valuetext");
    await slider.focus();
    await page.keyboard.press("Home");
    await expect.poll(() => slider.getAttribute("aria-valuetext")).not.toBe(before);
    await expect(total).toHaveAttribute("data-total", /^\d/);
    const first = await total.getAttribute("data-total");
    await page.keyboard.press("End");
    await expect.poll(() => total.getAttribute("data-total")).not.toBe(first);
});

test("the dock does not link to /stats", () => {
    expect(readFileSync("components/dock.tsx", "utf8")).not.toContain("/stats");
});

const positions = (page: Page) => card(page, "Positions");
const rowIds = (page: Page) =>
    positions(page)
        .locator("tbody tr")
        .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-id")));

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
        await expect(positions(page).locator("tbody tr").first()).toBeVisible();
    });

    test("the previous page stays while the next loads", async ({ page }) => {
        await page.goto("/stats");
        await expect(positions(page).locator("tbody tr")).toHaveCount(20);
        await page.route("**/stats/positions*", async (route) => {
            await new Promise((r) => setTimeout(r, 1500));
            await route.continue();
        });
        await positions(page).getByRole("button", { name: "2", exact: true }).click();
        await expect(positions(page).locator("tbody tr")).toHaveCount(20);
        await expect(positions(page).getByText(/loading/i)).toHaveCount(0);
    });
});
