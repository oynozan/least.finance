import { expect, test, type Locator, type Page } from "@playwright/test";
import { fundSource } from "./backend";
import { addressOf, installWallet, mockArcRpc, mockPrivy } from "./privy-mock";

/**
 * Sliding highlights must paint below everything in their list: rows,
 * labels, group headers. Each check moves the list's highlight under every
 * piece of text in the list, makes it hit-testable, and asks the browser
 * what's on top at that text's center. Hit-testing follows paint order, so
 * any text the highlight would cover is reported.
 */
async function textUnderHighlight(list: Locator) {
    return list.evaluate((list) => {
        const highlight = list.querySelector<HTMLElement>("[data-highlight]");
        if (!highlight) throw new Error("no highlight in the list");
        const container = highlight.offsetParent as HTMLElement;
        const texts = [...list.querySelectorAll<HTMLElement>("*")].filter(
            (el) =>
                el !== highlight &&
                !highlight.contains(el) &&
                [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim()) &&
                el.getClientRects().length > 0 &&
                !el.closest(".sr-only"),
        );
        const covered: string[] = [];
        highlight.style.pointerEvents = "auto";
        highlight.style.opacity = "1";
        for (const el of texts) {
            el.scrollIntoView({ block: "nearest" });
            const box = el.getBoundingClientRect();
            const origin = container.getBoundingClientRect();
            // Over the text, wherever the highlight sits in its container.
            highlight.style.transform = `translate(${box.left - origin.left - container.clientLeft}px, ${
                box.top - origin.top - container.clientTop + container.scrollTop
            }px)`;
            highlight.style.inset = "auto";
            highlight.style.top = "0px";
            highlight.style.left = "0px";
            highlight.style.width = `${box.width}px`;
            highlight.style.height = `${box.height}px`;
            const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
            if (hit === highlight) covered.push(el.textContent!.trim());
        }
        return covered;
    });
}

const picker = (page: Page) => page.locator("[data-floating-dialog]:not([data-closing])");
const sidebar = (page: Page) => page.getByRole("complementary", { name: "Wallet" });

async function connect(page: Page) {
    await page
        .getByRole("button", { name: /^(Wallet|Connect wallet)/ })
        .last()
        .click();
    await page.locator("#privy-modal-content").getByRole("button", { name: "MetaMask" }).click();
    await expect(sidebar(page)).toHaveAttribute("data-open", "true", { timeout: 10_000 });
    await expect(sidebar(page).getByRole("button", { name: /^Balance/ })).toHaveAccessibleName(/^Balance \$/, {
        timeout: 20_000,
    });
}

test.beforeEach(async ({ page }) => {
    await mockPrivy(page);
    await mockArcRpc(page);
    await installWallet(page);
});

test("a picker's highlight stays under its rows and group headers", async ({ page }) => {
    await page.goto("/");
    const trade = page.getByRole("region", { name: "Trade" });
    for (const pill of ["Swap", "ETH"]) {
        await trade.getByRole("button", { name: pill, exact: true }).click();
        const list = picker(page).getByRole("listbox");
        await expect(list.locator("[data-highlight]")).toHaveCount(1);
        // Group headers, the case the highlight once covered.
        if (pill === "Swap") await expect(list.getByText("Leverage", { exact: true })).toBeVisible();
        expect(await textUnderHighlight(list)).toEqual([]);
        await page.keyboard.press("Escape");
        await expect(picker(page)).toBeHidden();
    }
});

test("the network step's highlight stays under its rows and their amounts", async ({ page }) => {
    // The wallet holds ETH (and BNB) already; USDT gives the paying side a second coin on several networks.
    await fundSource(addressOf(page), "ethereum:USDT", "50");
    await page.goto("/");
    await connect(page);
    await page.keyboard.press("Escape");
    await expect(sidebar(page)).toHaveAttribute("data-open", "false");
    const trade = page.getByRole("region", { name: "Trade" });
    // The coin paid with: its wallet amount shows in two lines, and empty networks say why.
    await trade.getByRole("button", { name: "ETH", exact: true }).click();
    await picker(page).getByRole("option", { name: "ETH", exact: true }).click();
    const list = picker(page).getByRole("listbox", { name: "On which network?" });
    await expect(list.getByRole("option", { name: "Ethereum", exact: true })).toBeVisible();
    // The wallet's coins are in once the Ethereum row shows its amount.
    await expect(list.getByRole("option", { name: "Ethereum", exact: true })).toContainText("1 ETH");
    await expect(list.getByRole("option", { name: "Base", exact: true })).toContainText("Nothing here");
    await expect(list.locator("[data-highlight]")).toHaveCount(1);
    expect(await textUnderHighlight(list)).toEqual([]);
    // Back and forth replays the list, still with one highlight.
    await picker(page).getByRole("button", { name: "Back" }).click();
    await expect(
        picker(page).getByRole("listbox", { name: "Swap from which coin?" }).locator("[data-highlight]"),
    ).toHaveCount(1);
    await picker(page).getByRole("option", { name: "USDT", exact: true }).click();
    await expect(list.getByRole("option", { name: "Ethereum", exact: true })).toContainText("50 USDT");
    await expect(list.locator("[data-highlight]")).toHaveCount(1);
    expect(await textUnderHighlight(list)).toEqual([]);
});

test("the coin list's highlight stays under its rows and group labels", async ({ page }) => {
    await page.goto("/");
    await connect(page);
    await sidebar(page).getByRole("button", { name: "Deposit", exact: true }).click();
    const list = sidebar(page).getByRole("list", { name: "Coins to deposit" });
    await expect(list.getByRole("button", { name: /^ETH on Ethereum, 1 ETH/ })).toBeVisible({ timeout: 20_000 });
    // The highlight shows under the row pointed at.
    await list.getByRole("button", { name: /^USDC on Arc/ }).hover();
    await expect(list.locator("[data-highlight]")).toHaveCount(1);
    expect(await textUnderHighlight(list)).toEqual([]);
});

test("the range and filter thumbs stay under the labels they slide past", async ({ page }) => {
    await page.goto("/pnl");
    await connect(page);
    await page.keyboard.press("Escape");
    for (const name of ["Range", "Show"]) {
        const group = page.getByRole("radiogroup", { name });
        await expect(group.locator("[data-highlight]")).toHaveCount(1);
        expect(await textUnderHighlight(group)).toEqual([]);
    }
});
