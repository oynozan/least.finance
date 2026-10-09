import { expect, test, type Page } from "@playwright/test";
import { seedDeposits } from "./backend";
import { addressOf, installWallet, mockArcRpc, mockPrivy } from "./privy-mock";

const trade = (page: Page) => page.getByRole("region", { name: "Trade" });
const pill = (page: Page, name: string | RegExp) =>
    trade(page).getByRole("button", { name, exact: typeof name === "string" });
const amount = (page: Page) => trade(page).getByRole("textbox");
// Privy keeps a dialog of its own in the page; ours are marked.
const picker = (page: Page) => page.locator("[data-floating-dialog]:not([data-closing])");
const review = (page: Page) => page.getByRole("button", { name: "Review", exact: true });
const sidebar = (page: Page) => page.locator("#wallet-sidebar");

/** The sentence as a reader sees it: pill values, the typed amount, no hidden hints. */
async function text(page: Page) {
    await expect(trade(page).locator('[data-part][aria-hidden="true"]')).toHaveCount(0);
    return trade(page).evaluate((root) =>
        [...root.querySelectorAll("[data-part]")]
            .map((part) => {
                const copy = part.cloneNode(true) as HTMLElement;
                // Hints, and the hidden copy of the amount that sizes its input.
                copy.querySelectorAll('.sr-only, [aria-hidden="true"]').forEach((node) => node.remove());
                const input = part.querySelector("input");
                copy.querySelectorAll("input").forEach((node) => node.replaceWith(input?.value ?? ""));
                copy.querySelectorAll("button").forEach((button, i) => {
                    button.replaceWith(part.querySelectorAll("button")[i].getAttribute("aria-label") ?? "");
                });
                return copy.textContent?.replace(/\s+/g, " ").trim();
            })
            .join(" "),
    );
}

async function pick(page: Page, from: string | RegExp, option: string | RegExp) {
    await pill(page, from).click();
    await expect(picker(page)).toBeVisible();
    await picker(page).getByRole("option", { name: option }).click();
    await expect(picker(page)).toBeHidden();
}

async function shoot(page: Page, name: string) {
    await page.waitForTimeout(900);
    await page.screenshot({ path: `e2e/screenshots/${test.info().project.name}-sentence-${name}.png` });
}

async function connect(page: Page) {
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await page.locator("#privy-modal-content").getByRole("button", { name: "MetaMask" }).click();
    await expect(sidebar(page)).toHaveAttribute("data-open", "true", { timeout: 10_000 });
    // Spendable USDC comes from the account: let it settle before the sentence is read.
    await expect(sidebar(page).getByRole("button", { name: /^Balance/ })).not.toHaveAccessibleName(/loading/, {
        timeout: 10_000,
    });
    // A fresh connection opens the wallet; fold it away to see the sentence.
    await page.keyboard.press("Escape");
    await expect(sidebar(page)).toHaveAttribute("data-open", "false");
}

test.beforeEach(async ({ page }) => {
    await mockPrivy(page);
    await mockArcRpc(page);
    await installWallet(page);
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
});

/** Visible text on the page that isn't the sentence or a button. */
const strayText = (page: Page) =>
    page.evaluate(() => {
        const walker = document.createTreeWalker(document.querySelector("main")!, NodeFilter.SHOW_TEXT);
        const stray: string[] = [];
        while (walker.nextNode()) {
            const node = walker.currentNode;
            if (!node.textContent?.trim()) continue;
            if (node.parentElement?.closest("[data-part], .sr-only, button")) continue;
            stray.push(node.textContent.trim());
        }
        return stray;
    });

test("starts as a swap sentence, with only the sentence on the page", async ({ page }) => {
    expect(await text(page)).toBe("I want to Swap my ETH to SOL for 10 USD.");
    expect(await strayText(page)).toEqual([]);
    await expect(pill(page, "Swap")).toHaveAttribute("aria-haspopup", "dialog");
    await expect(amount(page)).toHaveValue("10");
    // The details stay out of sight until Review is pressed.
    await expect(page.getByRole("region", { name: "Details" })).toBeHidden();
    // Review only appears once a wallet is connected.
    await expect(review(page)).toBeHidden();

    await connect(page);
    await expect(review(page)).not.toHaveAttribute("aria-disabled");
    await expect(review(page)).toHaveCSS("background-color", "rgb(104, 214, 112)");
    // The Review button sits next to the wallet button.
    const [wallet, button] = await Promise.all([
        page.getByRole("button", { name: /^Wallet/ }).boundingBox(),
        review(page).boundingBox(),
    ]);
    expect(Math.abs(wallet!.y + wallet!.height / 2 - (button!.y + button!.height / 2))).toBeLessThan(2);
    expect(button!.x).toBeGreaterThan(wallet!.x + wallet!.width);
    await shoot(page, "1-swap");
});

test("the first pill restructures the sentence for each verb", async ({ page }) => {
    await pick(page, "Swap", /^Buy/);
    expect(await text(page)).toBe("I want to Buy 10 USD of SOL.");
    await shoot(page, "2-buy");

    await pick(page, "Buy", /^Sell/);
    expect(await text(page)).toBe("I want to Sell 10 USD of my SOL.");

    await pick(page, "Sell", /^Long/);
    expect(await text(page)).toBe("I want to Long SOL at 5x leverage with 10 USD.");
    await shoot(page, "3-long");

    await pick(page, "Long", /^Predict/);
    expect(await text(page)).toMatch(/^I want to Predict YES on Will BTC reach \$150K\? with 10 USD\.$|BTC \$150K\?/);
    await shoot(page, "4-predict");

    // Back to Swap: it remembers its own coins, and the amount follows along.
    await pick(page, "Predict", /^Swap/);
    expect(await text(page)).toBe("I want to Swap my ETH to SOL for 10 USD.");
});

test("the picker's highlight stays behind its rows, even as it opens", async ({ page }) => {
    await pill(page, "Swap").click();
    // Sample while the rows are still springing in: the selected row's label
    // must be the topmost element at its own center, never the highlight.
    const covered = await page.evaluate(async () => {
        const hits: string[] = [];
        const start = performance.now();
        while (performance.now() - start < 600) {
            await new Promise(requestAnimationFrame);
            const label = document.querySelector('[role="option"][aria-selected="true"] span[id$="-label"]');
            if (!label) continue;
            const box = label.getBoundingClientRect();
            const top = document.elementFromPoint(box.left + 4, box.top + box.height / 2);
            if (top && !label.contains(top) && top !== label) hits.push(top.className);
        }
        return hits;
    });
    expect(covered).toEqual([]);
    await shoot(page, "picker");
});

test("persisting pills glide to their new places", async ({ page, isMobile }) => {
    test.skip(isMobile, "measured on desktop");
    await pill(page, "Swap").click();
    // Track the amount pill while the sentence restructures from Swap to Buy.
    const frames = await page.evaluate(async () => {
        const target = () => document.querySelector('[data-part="term:amountUSD"]')!;
        const option = [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent?.startsWith("Buy"));
        (option as HTMLButtonElement).click();
        const xs: number[] = [];
        const start = performance.now();
        while (performance.now() - start < 900) {
            await new Promise(requestAnimationFrame);
            xs.push(target().getBoundingClientRect().left);
        }
        return xs;
    });
    const moved = frames.at(-1)! - frames[0];
    const jumps = frames.slice(1).map((x, i) => Math.abs(x - frames[i]));
    console.log(
        `amount pill moved ${Math.round(moved)}px over ${new Set(frames.map(Math.round)).size} distinct frames`,
    );
    expect(Math.abs(moved), "the amount pill changes place").toBeGreaterThan(20);
    expect(Math.max(...jumps), "it glides instead of jumping").toBeLessThan(Math.abs(moved) * 0.5);
});

test("Review stays disabled until the sentence is complete and valid", async ({ page }) => {
    await connect(page);
    await amount(page).fill("");
    await expect(review(page)).toHaveAttribute("aria-disabled", "true");
    await expect(review(page)).toHaveAccessibleDescription("Enter an amount.");
    // Forced: Playwright won't click an aria-disabled button on its own, and a
    // forced click doesn't wait for the page to finish sliding back into view.
    await expect(review(page)).toBeInViewport();
    await review(page).click({ force: true });
    await page.waitForTimeout(300);
    await expect(sidebar(page)).toHaveAttribute("data-open", "false");

    await amount(page).fill("0.5");
    await expect(review(page)).toHaveAttribute("aria-disabled", "true");
    await expect(review(page)).toHaveAccessibleDescription("The minimum is $1.");
    // The page itself shows nothing but the sentence: the amount turns red.
    expect(await strayText(page)).toEqual([]);
    await expect(amount(page)).toHaveCSS("color", "rgb(255, 107, 91)");

    await amount(page).fill("1,250.009");
    await expect(amount(page)).toHaveValue("1250.00");
    // Leaving and re-entering the field never rewrites what was typed.
    await amount(page).blur();
    await expect(amount(page)).toHaveValue("1250.00");
    await amount(page).fill("25");
    await expect(amount(page)).toHaveValue("25");
    await expect(review(page)).not.toHaveAttribute("aria-disabled");
});

test("the amount grows with every digit and never scrolls", async ({ page }) => {
    const field = () =>
        amount(page).evaluate((input: HTMLInputElement) => {
            const digits = document.createRange();
            digits.selectNodeContents(input.previousElementSibling!);
            return {
                spare: input.getBoundingClientRect().width - digits.getBoundingClientRect().width,
                scrolled: input.scrollLeft,
                hidden: input.scrollWidth - input.clientWidth,
            };
        });
    await amount(page).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    for (const digit of "109912345") {
        await page.keyboard.type(digit);
        // Only the caret's room past the digits, and nothing scrolled away.
        expect(await field()).toEqual({ spare: expect.closeTo(2, 1), scrolled: 0, hidden: 0 });
    }
    // Each engine sizes a bare input its own way; that width must never count.
    await amount(page).evaluate((input: HTMLInputElement) => (input.size = 40));
    expect(await field()).toEqual({ spare: expect.closeTo(2, 1), scrolled: 0, hidden: 0 });
});

test("a coin is never swapped into itself", async ({ page }) => {
    await pill(page, "SOL").click();
    const eth = picker(page).getByRole("option", { name: "ETH" });
    await expect(eth).toHaveAccessibleDescription(/Switch sides/);
    await eth.click();
    expect(await text(page)).toBe("I want to Swap my SOL to ETH for 10 USD.");
});

test("leverage follows the market's cap, and any allowed value can be typed", async ({ page }) => {
    await pick(page, "Swap", /^Long/);
    await pick(page, "SOL", /^BTC/);
    await pick(page, "5x", /^50x/);
    expect(await strayText(page)).toEqual([]);
    // High leverage isn't flagged on the page: the pill keeps its normal color.
    await expect(pill(page, "50x")).toHaveCSS("color", "rgb(245, 245, 243)");

    // A leverage that isn't listed goes in the input on top of the picker.
    await pill(page, "50x").click();
    const custom = picker(page).getByRole("textbox", { name: "Custom, 1 to 50" });
    // The field's text and placeholder share one size and sit centered in their row.
    const field = await custom.evaluate((input) => {
        const row = input.closest("form")!.getBoundingClientRect();
        const box = input.getBoundingClientRect();
        return {
            offset: Math.abs(box.top + box.height / 2 - (row.top + row.height / 2)),
            text: getComputedStyle(input).fontSize,
            placeholder: getComputedStyle(input, "::placeholder").fontSize,
        };
    });
    expect(field.offset).toBeLessThanOrEqual(1);
    expect(field.placeholder).toBe(field.text);
    await custom.fill("70");
    await expect(custom).toHaveAttribute("aria-invalid", "true");
    await expect(picker(page).getByRole("button", { name: "Set" })).toHaveAttribute("aria-disabled", "true");
    await custom.fill("7");
    await shoot(page, "custom-leverage");
    await custom.press("Enter");
    await expect(picker(page)).toBeHidden();
    expect(await text(page)).toBe("I want to Long BTC at 7x leverage with 10 USD.");
    // Reopening starts in the input, holding the typed value.
    await pill(page, "7x").click();
    await expect(picker(page).getByRole("textbox")).toBeFocused();
    await expect(picker(page).getByRole("textbox")).toHaveValue("7");
    await page.keyboard.press("Escape");

    await pick(page, "BTC", /^SOL/);
    expect(await text(page)).toBe("I want to Long SOL at 7x leverage with 10 USD.");
    await pick(page, "7x", /^20x/);
    await pick(page, "SOL", /^BTC/);
    await pick(page, "BTC", /^SOL/);
    expect(await text(page)).toBe("I want to Long SOL at 20x leverage with 10 USD.");
});

test("the question picker is wide enough for whole questions", async ({ page, isMobile }) => {
    await pick(page, "Swap", /^Predict/);
    await trade(page).locator('[data-slot="marketId"] button').click();
    await expect(picker(page)).toBeVisible();
    await page.waitForTimeout(500);
    const width = await picker(page).evaluate((el) => el.getBoundingClientRect().width);
    if (!isMobile) {
        expect(width).toBeGreaterThanOrEqual(600);
        // Each question stays on one line, with its odds underneath.
        const lines = await picker(page)
            .locator('[role="option"] span[id$="-label"]')
            .evaluateAll((els) =>
                els.map((el) =>
                    Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)),
                ),
            );
        expect(lines.every((n) => n === 1)).toBe(true);
    }
    await expect(
        picker(page).getByRole("option", { name: "Will SOL set a new all-time high?" }),
    ).toHaveAccessibleDescription("44% YES · ends Nov 30");
    await shoot(page, "markets");
});

test("pill text sits centered, with room for descenders", async ({ page }) => {
    const pills = await page.evaluate(() => {
        const ctx = document.createElement("canvas").getContext("2d")!;
        return [...document.querySelectorAll("[data-part] span.bg-pill")].map((pill) => {
            const label = pill.querySelector<HTMLElement>("span.self-baseline")!;
            const style = getComputedStyle(label);
            ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
            // An empty inline-block's bottom edge sits on the baseline.
            const probe = document.createElement("span");
            probe.style.cssText = "display:inline-block;width:0;height:0";
            label.prepend(probe);
            const baseline = probe.getBoundingClientRect().bottom;
            probe.remove();
            const box = pill.getBoundingClientRect();
            const size = parseFloat(style.fontSize);
            return {
                aboveCaps: (baseline - ctx.measureText("H").actualBoundingBoxAscent - box.top) / size,
                belowBaseline: (box.bottom - baseline) / size,
                descender: ctx.measureText("g").actualBoundingBoxDescent / size,
            };
        });
    });
    expect(pills.length).toBeGreaterThan(0);
    for (const { aboveCaps, belowBaseline, descender } of pills) {
        expect(Math.abs(aboveCaps - belowBaseline)).toBeLessThan(0.01);
        expect(belowBaseline).toBeGreaterThan(descender + 0.02);
    }
});

test("Review opens the details in the sidebar, then confirms", async ({ page, isMobile }) => {
    await connect(page);
    await review(page).click();
    await expect(sidebar(page)).toHaveAttribute("data-open", "true");
    await expect(page.getByRole("complementary", { name: "Review" })).toBeVisible();
    const details = page.getByRole("region", { name: "Details" });
    await expect(details).toContainText("0.003115 ETH ($10.00)");
    await expect(details).toContainText("1 ETH = 21.81 SOL");

    // On a desktop Review stays in view and toggles the sidebar closed;
    // on a phone the sidebar covers it, so it closes with its own button.
    if (isMobile) await sidebar(page).getByRole("button", { name: "Close review" }).click();
    else await review(page).click();
    await expect(sidebar(page)).toHaveAttribute("data-open", "false");

    await amount(page).fill("5000");
    await expect(review(page)).toHaveAttribute("aria-disabled", "true");
    await expect(review(page)).toHaveAccessibleDescription("That's more than your $4,013.00 of ETH.");
    await amount(page).fill("100");

    await review(page).click();
    await expect(page.getByRole("complementary", { name: "Review" })).toBeVisible();
    await shoot(page, "6-review");
    await sidebar(page).getByRole("button", { name: "Confirm swap" }).click();
    await expect(sidebar(page)).toContainText("Trading isn't live yet, so nothing was sent.");
    await expect(sidebar(page).locator("pre")).toHaveText(
        JSON.stringify({ type: "swap", fromToken: "ETH", toToken: "SOL", amountUSD: "100" }, null, 2),
    );
    await shoot(page, "7-not-sent");
    // The review stays in place, unfaded, while the sidebar slides away.
    const done = sidebar(page).getByRole("button", { name: "Done" });
    const button = await done.elementHandle();
    await done.click();
    const frames = await button!.evaluate(
        (button) =>
            new Promise<{ rendered: boolean; opacity: number }[]>((resolve) => {
                const frames: { rendered: boolean; opacity: number }[] = [];
                const start = performance.now();
                const sample = () => {
                    let opacity = 1;
                    for (let el: Element | null = button; el; el = el.parentElement)
                        opacity *= Number(getComputedStyle(el).opacity);
                    frames.push({ rendered: button.getClientRects().length > 0, opacity });
                    if (performance.now() - start < 400) requestAnimationFrame(sample);
                    else resolve(frames);
                };
                sample();
            }),
    );
    expect(frames.every((frame) => frame.rendered && frame.opacity > 0.99)).toBe(true);
    await expect(sidebar(page)).toHaveAttribute("data-open", "false");

    // The wallet button still opens the wallet, not the review.
    await page.getByRole("button", { name: /^Wallet/ }).click();
    await expect(page.getByRole("complementary", { name: "Wallet" })).toBeVisible();
});

for (const [seeded, blocked] of [
    ["2400", true],
    ["3500", false],
] as const) {
    test(`a buy of 3000 USD is ${blocked ? "blocked" : "allowed"} with ${seeded} USDC in the account`, async ({
        page,
    }) => {
        // Seeded before connecting, so the session loads it.
        await seedDeposits(addressOf(page), [{ amount: seeded, daysAgo: 1 }]);
        await connect(page);
        await expect(sidebar(page).getByRole("button", { name: /^Balance/ })).toHaveAccessibleName(
            `Balance $${Number(seeded).toLocaleString("en-US")}.00, show deposits`,
        );
        await pick(page, "Swap", /^Buy/);
        await amount(page).fill("3000");
        if (blocked) {
            await expect(review(page)).toHaveAttribute("aria-disabled", "true");
            await expect(review(page)).toHaveAccessibleDescription("You have $2,400.00 USDC to spend.");
        } else {
            await expect(review(page)).not.toHaveAttribute("aria-disabled");
        }
    });
}

test("the sentence is keyboard operable", async ({ page, isMobile }) => {
    test.skip(isMobile, "keyboard flow");
    await pill(page, "Swap").focus();
    await page.keyboard.press("Enter");
    await expect(picker(page).getByRole("option", { name: /^Swap/ })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(picker(page)).toBeHidden();
    await expect(pill(page, "Buy")).toBeFocused();
    expect(await text(page)).toBe("I want to Buy 10 USD of SOL.");

    // Typeahead jumps to a coin by its first letters. The amount comes first.
    await page.keyboard.press("Tab");
    await expect(amount(page)).toBeFocused();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await page.keyboard.type("li");
    await expect(picker(page).getByRole("option", { name: "LINK" })).toBeFocused();
    await page.keyboard.press("Enter");
    expect(await text(page)).toBe("I want to Buy 10 USD of LINK.");
    // Escape in a picker closes only the picker.
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await expect(picker(page)).toBeHidden();
});

test("phones wrap the sentence without overflowing", async ({ page, isMobile }) => {
    test.skip(!isMobile, "phone layout");
    for (const [from, verb] of [
        ["Swap", /^Buy/],
        ["Buy", /^Long/],
        ["Long", /^Predict/],
    ] as const) {
        await pick(page, from, verb);
        await page.waitForTimeout(500);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        expect(overflow).toBeLessThanOrEqual(0);
    }
    // The long market question gets its short form on a phone.
    await expect(trade(page).getByText("BTC $150K?")).toBeVisible();
    await shoot(page, "4-predict");
});
