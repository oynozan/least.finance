import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

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
