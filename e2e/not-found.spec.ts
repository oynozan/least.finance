import { expect, test, type Page } from "@playwright/test";
import { installWallet, mockArcRpc, mockPrivy } from "./privy-mock";

const sentence = (page: Page) => page.locator("main [data-sentence]");

test.beforeEach(async ({ page }) => {
    await mockPrivy(page);
    await mockArcRpc(page);
    await installWallet(page);
});

test("an address that isn't a page answers 404 in a sentence, with pills to the pages that are", async ({ page }) => {
    // The server can't know the address, so it says "this address", visibly and with no internal route name.
    const html = await (await page.request.get("/wallet/my%20coins")).text();
    const text = html
        .slice(html.indexOf("data-sentence"), html.indexOf("</p>", html.indexOf("data-sentence")))
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ");
    expect(text).toMatch(/There’s nothing at this address\. Take\sme\sto Trade or PnL\.$/);
    expect(text).not.toContain("_not-found");
    expect(html).not.toContain('title="/_not-found"');
    expect(html).not.toMatch(/data-part="[^"]+"[^>]*opacity:0/);

    // The page the server sent is the one that stays: nothing is thrown away and drawn again as it loads.
    await page.addInitScript(() => {
        new MutationObserver((records) => {
            for (const record of records)
                for (const node of record.removedNodes)
                    if ((node as Element).querySelector?.("main") || node.nodeName === "MAIN")
                        Object.assign(window, { __redrawn: true });
        }).observe(document, { childList: true, subtree: true });
    });
    const response = await page.goto("/wallet/my%20coins");
    expect(response?.status()).toBe(404);
    await expect(page).toHaveTitle("Not found – Least Finance");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found");

    // In the browser the address springs into its pill, as it was meant.
    await expect(sentence(page)).toHaveText(/^There’s nothing at \/wallet\/my coins\. Take\sme\sto Trade or PnL\.$/);
    await expect(sentence(page).getByTitle("/wallet/my coins")).toBeVisible();
    // Each of its two sentences ends in a full stop of its own.
    const stops = sentence(page).getByText(".", { exact: true });
    await expect(stops).toHaveCount(2);
    for (const stop of await stops.all()) await expect(stop).toHaveCSS("opacity", "1");
    expect(await page.evaluate(() => "__redrawn" in window)).toBe(false);

    await sentence(page).getByRole("link", { name: "PnL" }).click();
    await expect(page).toHaveURL(/\/pnl$/);
    await page.goBack();
    await sentence(page).getByRole("link", { name: "Trade" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("region", { name: "Trade" })).toBeVisible();
});

test("a long address ends in an ellipsis and the sentence stays on screen", async ({ page }) => {
    await page.goto(`/${"a-very-long-address-".repeat(8)}end`);
    const path = sentence(page).locator("[title^='/a-very-long']");
    await expect(path).toBeVisible();
    // Cut short in its pill, not pushing the page sideways.
    await expect
        .poll(() =>
            path
                .locator("span")
                .last()
                .evaluate((el) => el.scrollWidth > el.clientWidth),
        )
        .toBe(true);
    const width = await page.evaluate(() => document.documentElement.clientWidth);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    const box = (await sentence(page).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
});
