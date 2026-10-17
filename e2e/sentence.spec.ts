import { expect, test, type Locator, type Page } from "@playwright/test";
import { toPredictionMarket } from "@/lib/trade/markets";
import { seedDeposits } from "./backend";
import { addressOf, installWallet, mockArcRpc, mockPrivy } from "./privy-mock";
import { sampleView, samples, trendingView } from "./polymarket";

// Trades and the sign-in take a few seconds each, and the first run of a test waits on the server.
test.describe.configure({ timeout: 90_000 });

const trade = (page: Page) => page.getByRole("region", { name: "Trade" });
const pill = (page: Page, name: string | RegExp) =>
    trade(page).getByRole("button", { name, exact: typeof name === "string" });
// Privy keeps a dialog of its own in the page; ours are marked.
const picker = (page: Page) => page.locator("[data-floating-dialog]:not([data-closing])");
/** The amount pill; it drops down a field and a slider. */
const amountPill = (page: Page) => trade(page).getByRole("button", { name: /USD$/ });
const amountField = (page: Page) => picker(page).getByRole("textbox");
const slider = (page: Page) => picker(page).getByRole("slider");
/** The dock's button: Review, or the way out of what blocks the sentence. */
const review = (page: Page) => page.getByRole("navigation", { name: "Pages" }).locator("button[data-action]");
const sidebar = (page: Page) => page.locator("#wallet-sidebar");
const reviewPanel = (page: Page) => page.getByRole("complementary", { name: "Review" });

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

/** Types an amount into the amount's dropdown, then closes it with Enter. */
async function setAmount(page: Page, value: string) {
    await amountPill(page).click();
    await expect(amountField(page)).toBeVisible();
    await amountField(page).fill(value);
    await amountField(page).press("Enter");
    await expect(picker(page)).toBeHidden();
}

async function pick(page: Page, from: string | RegExp, option: string | RegExp) {
    await pill(page, from).click();
    await expect(picker(page)).toBeVisible();
    await picker(page).getByRole("option", { name: option }).click();
    await expect(picker(page)).toBeHidden();
}

/** The panel's box once its entrance spring has settled, and the pill's beside it (both in viewport px). */
async function settledBoxes(page: Page, anchor: Locator) {
    await expect
        .poll(() => picker(page).evaluate((panel) => getComputedStyle(panel).transform), { timeout: 3_000 })
        .toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
    return Promise.all([anchor.boundingBox(), picker(page).boundingBox()]);
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

/** Puts $500 in the account, so there is a balance to buy with; call before connecting. */
const fund = (page: Page) => seedDeposits(addressOf(page), [{ amount: "500", daysAgo: 0 }]);

/** Picks a coin in the picker of one side of the swap sentence. */
async function pickSide(page: Page, part: "swap:fromToken" | "term:token", coin: string) {
    await trade(page).locator(`[data-part="${part}"]`).getByRole("button").click();
    await picker(page).getByRole("option", { name: coin, exact: true }).click();
    await expect(picker(page)).toBeHidden();
}

/** Buys $100 of ETH from the balance, then sets "Swap my ETH to SOL for 10 USD" with it. */
async function holdEth(page: Page) {
    await pick(page, "Swap", /^Buy/);
    await pick(page, "SOL", /^ETH/);
    await setAmount(page, "100");
    await review(page).click();
    await reviewPanel(page).getByRole("button", { name: "Confirm purchase" }).click();
    // A filled trade hands over to the wallet; Escape folds it.
    await expect(sidebar(page)).toHaveAttribute("aria-label", "Wallet");
    await page.keyboard.press("Escape");
    await expect(sidebar(page)).toHaveAttribute("data-open", "false");
    // Back on Swap the bought coin and the amount carry over to the receiving side.
    await pick(page, "Buy", /^Swap/);
    await pickSide(page, "term:token", "SOL");
    await pickSide(page, "swap:fromToken", "ETH");
    await setAmount(page, "10");
    expect(await text(page)).toBe("I want to Swap my ETH to SOL for 10 USD.");
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
    await fund(page);
    expect(await text(page)).toBe("I want to Swap my ETH to SOL for 10 USD.");
    expect(await strayText(page)).toEqual([]);
    await expect(pill(page, "Swap")).toHaveAttribute("aria-haspopup", "dialog");
    await expect(amountPill(page)).toHaveAccessibleName("10 USD");
    // The details stay out of sight until Review is pressed.
    await expect(page.getByRole("region", { name: "Details" })).toBeHidden();
    // Review only appears once a wallet is connected.
    await expect(review(page)).toBeHidden();

    await connect(page);
    // The account holds no ETH to swap yet; buying some from the balance gives it one.
    await expect(review(page)).toHaveText("Pick a coin");
    await expect(review(page)).toHaveAccessibleDescription("Pick a coin to swap from.");
    await holdEth(page);
    await expect(review(page)).toHaveText("Review");
    await expect(review(page)).toHaveCSS("background-color", "rgb(104, 214, 112)");
    // The wallet button sits above the sentence; Review is in the dock below it.
    await expect(page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: "Review" })).toBeVisible();
    const [wallet, sentence, button] = await Promise.all([
        page.getByRole("button", { name: /^Wallet/ }).boundingBox(),
        trade(page).boundingBox(),
        review(page).boundingBox(),
    ]);
    expect(wallet!.y + wallet!.height).toBeLessThan(sentence!.y);
    expect(button!.y).toBeGreaterThan(sentence!.y + sentence!.height);
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
    const [first] = (await trendingView()).markets;
    expect(await text(page)).toMatch(/^I want to Predict .+ on /);
    expect(await text(page)).toContain(` on ${first.title} with 10 USD.`);
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

test("the dock says the way out until the sentence is complete and valid", async ({ page }) => {
    await fund(page);
    await connect(page);
    // A buy is paid from the $500 balance; a swap would first need a coin held.
    await pick(page, "Swap", /^Buy/);
    await setAmount(page, "");
    await expect(review(page)).toHaveText("Enter an amount");
    await expect(review(page)).toHaveAccessibleDescription("Enter an amount.");
    // The button opens the amount instead of the review.
    await expect(review(page)).toBeInViewport();
    await review(page).click();
    await expect(amountField(page)).toBeVisible();
    await expect(sidebar(page)).toHaveAttribute("data-open", "false");
    await page.keyboard.press("Escape");
    await expect(picker(page)).toBeHidden();

    await setAmount(page, "0.05");
    await expect(review(page)).toHaveText("Minimum $0.10");
    await expect(review(page)).toHaveAccessibleDescription("The minimum is $0.10.");
    // The page itself shows nothing but the sentence: the amount turns red.
    expect(await strayText(page)).toEqual([]);
    await expect(amountPill(page)).toHaveCSS("color", "rgb(255, 107, 91)");

    await amountPill(page).click();
    await amountField(page).fill("1,250.009");
    await expect(amountField(page)).toHaveValue("1250.00");
    // Closing and reopening the dropdown never rewrites what was typed.
    await amountField(page).press("Enter");
    await expect(review(page)).toHaveText("Not enough USDC");
    await expect(review(page)).toHaveAccessibleDescription("You have $500.00 USDC to spend.");
    await amountPill(page).click();
    await expect(amountField(page)).toHaveValue("1250.00");
    await amountField(page).fill("25");
    await expect(amountField(page)).toHaveValue("25");
    await amountField(page).press("Enter");
    await expect(review(page)).toHaveText("Review");
});

test("a swap's review shows what you pay and get, folds the rest away until pointed at, and confirms from the balance", async ({
    page,
    isMobile,
}) => {
    await fund(page);
    await connect(page);
    await holdEth(page);
    await review(page).click();
    const panel = reviewPanel(page);
    await expect(panel.getByText("Includes a 0.3% spread. We cover network costs.", { exact: true })).toBeVisible();
    const details = panel.getByRole("region", { name: "Details" });
    // The amounts are in once the pay row shows its coins.
    await expect(details.getByText("You pay", { exact: true })).toBeVisible();
    await expect(details.getByText("You get ≈", { exact: true })).toBeVisible();
    await expect(details).toContainText("0.003115 ETH");
    await expect(details.getByText("$10.00", { exact: true })).toBeVisible();
    // $10 less the 0.3% spread is $9.97, which buys 0.06773 SOL at $147.20
    await expect(details).toContainText("0.06773 SOL");
    // No network step, approval or wallet-signed route.
    await expect(panel.getByText(/approve|sign|route|network fee/i)).toHaveCount(0);

    // The arrival time is folded away until the card is pointed at, or tapped on a phone.
    const folded = details.locator("[data-preview-details]");
    const height = () => folded.evaluate((el) => el.getBoundingClientRect().height);
    await expect(details).toContainText("Arrives");
    await expect.poll(height).toBe(0);
    const card = details.locator("[data-preview-card]");
    if (isMobile) await card.tap();
    else await card.hover();
    await expect.poll(height).toBeGreaterThan(20);
    await expect(details.getByText("Arrives", { exact: true })).toBeVisible();
    await expect(details.getByText("Instant", { exact: true })).toBeVisible();
    await shoot(page, "6-review");

    await panel.getByRole("button", { name: "Confirm swap" }).click();
    // The review says what it came to, then hands over to the wallet, which stays open.
    await expect(sidebar(page)).toContainText("Swapped 0.003115 ETH for ≈ 0.06773 SOL.");
    await expect(sidebar(page)).toHaveAttribute("aria-label", "Wallet");
    await expect(sidebar(page)).toHaveAttribute("data-open", "true");
    await shoot(page, "7-sent");
});

test("with an account balance, the slider tops out at what it can spend", async ({ page }) => {
    await fund(page);
    await connect(page);
    await pick(page, "Swap", /^Buy/);
    await amountPill(page).click();
    await expect(slider(page)).toHaveAttribute("aria-valuemax", "500");
    await expect(picker(page)).toContainText("500 USD");
    await slider(page).focus();
    await page.keyboard.press("End");
    await expect(amountField(page)).toHaveValue("500");
    // Typing past it turns the amount red and says why, in the dropdown only.
    await amountField(page).fill("5000");
    await expect(picker(page)).toContainText("You have $500.00 USDC to spend.");
    await expect(amountField(page)).toHaveCSS("color", "rgb(255, 107, 91)");
});

test("on a range of cents, the thumb stays where it lets go", async ({ page, isMobile }) => {
    await seedDeposits(addressOf(page), [{ amount: "0.29", daysAgo: 0 }]);
    await connect(page);
    await pick(page, "Swap", /^Buy/);
    await amountPill(page).click();
    await expect(slider(page)).toHaveAttribute("aria-valuemax", "0.29");
    await settledBoxes(page, amountPill(page));
    const track = (await slider(page).boundingBox())!;
    const at = { x: track.width / 2, y: track.height / 2 };
    if (isMobile) await slider(page).tap({ position: at });
    else await slider(page).click({ position: at });
    await expect(slider(page)).toHaveAttribute("aria-valuenow", /^0\.(19|2)$/);
    const value = Number(await slider(page).getAttribute("aria-valuenow"));
    // Settled into that value's notch (6px inset, 44px thumb), not thrown to an end. The
    // dropdown follows the pill as its digits change, so the track is measured where it is now.
    const thumb = slider(page).locator("span").last();
    const off = async () => {
        const [now, box] = [(await slider(page).boundingBox())!, (await thumb.boundingBox())!];
        const notch = now.x + 6 + 22 + ((value - 0.1) / 0.19) * (now.width - 56);
        return Math.abs(Math.round(box.x + box.width / 2 - notch));
    };
    await expect.poll(off, { timeout: 3_000 }).toBeLessThanOrEqual(2);
});

test("sliding holds the amount pill at its widest and moves the sentence with it", async ({ page }) => {
    await seedDeposits(addressOf(page), [{ amount: "2", daysAgo: 0 }]);
    await connect(page);
    await pick(page, "Swap", /^Buy/);
    await amountPill(page).click();
    await expect(slider(page)).toHaveAttribute("aria-valuemax", "2");
    await settledBoxes(page, amountPill(page));
    const track = (await slider(page).boundingBox())!;
    const y = track.y + track.height / 2;
    // 6px inset and a 44px thumb: 0.42 of the way is about $0.90, 0.58 about $1.20.
    const xAt = (f: number) => track.x + 28 + f * (track.width - 56);
    await page.mouse.move(xAt(0.42), y);

    // Every frame: the pill's drawn width, and the gap from it to the word after.
    await page.evaluate(() => {
        const button = [...document.querySelectorAll("[data-sentence] button")].find((b) =>
            b.getAttribute("aria-label")?.endsWith("USD"),
        )!;
        const parts = [...document.querySelectorAll<HTMLElement>("[data-sentence] [data-part]")];
        const next = parts[parts.indexOf(button.closest<HTMLElement>("[data-part]")!) + 1];
        const frames: { label: string; width: number; gap: number; sameLine: boolean }[] = [];
        Object.assign(window, { __frames: frames });
        const tick = () => {
            const pill = button.firstElementChild!.getBoundingClientRect();
            const word = next.getBoundingClientRect();
            frames.push({
                label: button.getAttribute("aria-label")!,
                width: pill.width,
                gap: word.left - pill.right,
                sameLine: Math.abs(word.top - pill.top) < pill.height,
            });
            if (!(window as unknown as { __stop?: boolean }).__stop) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    });
    const frames = () =>
        page.evaluate(() => (window as unknown as { __frames: { label: string; width: number; gap: number; sameLine: boolean }[] }).__frames.splice(0));

    await page.mouse.down();
    for (let i = 0; i <= 32; i++) {
        await page.mouse.move(xAt(0.42 + (0.16 * i) / 32), y);
        await page.waitForTimeout(30);
    }
    const held = await frames();
    await page.mouse.up();
    await page.waitForTimeout(900);
    const settled = await frames();
    await page.evaluate(() => Object.assign(window, { __stop: true }));

    // It went through amounts of every width: 0.9, 0.99, 1, 1.1.
    const labels = new Set(held.map((frame) => frame.label));
    expect(labels).toContain("1 USD");
    expect([...labels].some((label) => /^0\.9\d USD$/.test(label))).toBe(true);
    expect([...labels].some((label) => /^1\.\d USD$/.test(label))).toBe(true);
    // Held: the pill never narrows while the pointer is down, only grows (a spring may overshoot a little).
    let widest = 0;
    for (const frame of held) {
        expect(frame.width).toBeGreaterThan(widest - 3);
        widest = Math.max(widest, frame.width);
    }
    // The word after keeps its distance the whole way, so nothing opens up or runs into the pill.
    const sameLine = [...held, ...settled].filter((frame) => frame.sameLine);
    expect(sameLine.length).toBeGreaterThan(20);
    const gaps = sameLine.map((frame) => frame.gap);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(3);
    // Let go, it settles to the amount's own width.
    const natural = await amountPill(page).evaluate((button) => (button.firstElementChild as HTMLElement).offsetWidth);
    expect(Math.abs(settled.at(-1)!.width - natural)).toBeLessThan(1);
    expect(settled.at(-1)!.width).toBeLessThan(widest - 10);
});

test("the amount field grows with every digit and never scrolls", async ({ page }) => {
    const field = () =>
        amountField(page).evaluate((input: HTMLInputElement) => {
            const digits = document.createRange();
            digits.selectNodeContents(input.previousElementSibling!);
            return {
                spare: input.getBoundingClientRect().width - digits.getBoundingClientRect().width,
                scrolled: input.scrollLeft,
                hidden: input.scrollWidth - input.clientWidth,
            };
        });
    await amountPill(page).click();
    await amountField(page).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    for (const digit of "109912345") {
        await page.keyboard.type(digit);
        // Only the caret's room past the digits, and nothing scrolled away.
        expect(await field()).toEqual({ spare: expect.closeTo(2, 1), scrolled: 0, hidden: 0 });
    }
    // The pill behind follows as it's typed, its digits rolling.
    await expect(amountPill(page)).toHaveAccessibleName("109912345 USD");
    await expect(amountPill(page).locator("number-flow-react")).toHaveCount(1);
    // Each engine sizes a bare input its own way; that width must never count.
    await amountField(page).evaluate((input: HTMLInputElement) => (input.size = 40));
    expect(await field()).toEqual({ spare: expect.closeTo(2, 1), scrolled: 0, hidden: 0 });
});

test("the same pair is never swapped into itself: picking a side's coin flips the other", async ({ page }) => {
    const paying = trade(page).locator('[data-part="swap:fromToken"]').getByRole("button");
    const receiving = trade(page).locator('[data-part="term:token"]').getByRole("button");
    // Paying with the coin that is received flips the two sides.
    await paying.click();
    await picker(page).getByRole("option", { name: "SOL", exact: true }).click();
    await expect(picker(page)).toBeHidden();
    expect(await text(page)).toBe("I want to Swap my SOL to ETH for 10 USD.");
    // Receiving the coin that is paid flips them back.
    await receiving.click();
    await picker(page).getByRole("option", { name: "SOL", exact: true }).click();
    await expect(picker(page)).toBeHidden();
    expect(await text(page)).toBe("I want to Swap my ETH to SOL for 10 USD.");
});

test("leverage follows the market's cap, and any allowed value can be typed", async ({ page }) => {
    await pick(page, "Swap", /^Long/);
    await pick(page, "SOL", /^BTC/);
    // The server's cap (20x) is below Hyperliquid's own for BTC, so no 25x or 50x is offered.
    await pill(page, "5x").click();
    await expect(picker(page).getByRole("option", { name: /^20x/ })).toBeVisible();
    await expect(picker(page).getByRole("option", { name: /^(25|50)x/ })).toHaveCount(0);
    await picker(page).getByRole("option", { name: /^20x/ }).click();
    await expect(picker(page)).toBeHidden();
    expect(await strayText(page)).toEqual([]);
    // High leverage isn't flagged on the page: the pill keeps its normal color.
    await expect(pill(page, "20x")).toHaveCSS("color", "rgb(245, 245, 243)");

    // A leverage that isn't listed goes in the input on top of the picker.
    await pill(page, "20x").click();
    const custom = picker(page).getByRole("textbox", { name: "Custom, 1 to 20" });
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
    await custom.fill("30");
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
    // A market with a lower cap pulls the leverage down to it.
    await pick(page, "SOL", /^LINK/);
    expect(await text(page)).toBe("I want to Long LINK at 10x leverage with 10 USD.");
});

test("the outcome pill reads green for YES and red for NO", async ({ page }) => {
    await pick(page, "Swap", /^Predict/);
    const yesNo = await sampleView(samples.yesNo);
    await trade(page).locator('[data-slot="marketId"] button').click();
    await picker(page).getByRole("option", { name: yesNo.title, exact: true }).click();
    await trade(page).locator('[data-slot="outcomeId"] button').click();
    await picker(page).getByRole("option", { name: /^YES/ }).click();
    await expect(pill(page, "YES")).toHaveCSS("color", "rgb(104, 214, 112)");
    await pick(page, "YES", /^NO/);
    await expect(pill(page, "NO")).toHaveCSS("color", "rgb(255, 107, 91)");
});

test("the question picker is wide enough for whole questions", async ({ page, isMobile }) => {
    await pick(page, "Swap", /^Predict/);
    await trade(page).locator('[data-slot="marketId"] button').click();
    await expect(picker(page)).toBeVisible();
    await page.waitForTimeout(500);
    const width = await picker(page).evaluate((el) => el.getBoundingClientRect().width);
    if (!isMobile) {
        expect(width).toBeGreaterThanOrEqual(600);
        // A question of ordinary length stays on one line, with its odds underneath.
        const lines = await picker(page)
            .locator('[role="option"] span[id$="-label"]')
            .evaluateAll((els) =>
                els
                    .filter((el) => (el.textContent?.length ?? 0) <= 30)
                    .map((el) =>
                        Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)),
                    ),
            );
        expect(lines.length).toBeGreaterThan(0);
        expect(lines.every((n) => n === 1)).toBe(true);
    }
    const [first] = (await trendingView()).markets;
    await expect(picker(page).getByRole("option", { name: first.title })).toHaveAccessibleDescription(
        /^\d+% .+, ends [A-Z][a-z]{2} \d{1,2}(, \d{4})?$/,
    );
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
    await expect(amountPill(page)).toBeFocused();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await page.keyboard.type("li");
    await expect(picker(page).getByRole("option", { name: "LINK" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(picker(page)).toBeHidden();
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
    const [first] = (await trendingView()).markets;
    await expect(trade(page).getByText(toPredictionMarket(first, new Date()).short, { exact: true })).toBeVisible();
    await shoot(page, "4-predict");
});

test("the sentence grows on big screens, and still fits above the dock", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop sizes");
    const size = () =>
        trade(page).evaluate((root) =>
            parseFloat(getComputedStyle(root.querySelector("[data-part]")!.parentElement!).fontSize),
        );
    const sizes: Record<string, number> = {};
    for (const [width, height] of [
        [1280, 800],
        [1440, 900],
        [1920, 1080],
        [2560, 1440],
        [3440, 1440],
        [2560, 700],
    ] as const) {
        await page.setViewportSize({ width, height });
        sizes[`${width}x${height}`] = await size();
    }
    // Laptops keep the size they had; only wider screens go past it.
    expect(sizes["1280x800"]).toBe(47);
    expect(sizes["1440x900"]).toBe(47);
    expect(sizes["1920x1080"]).toBeGreaterThan(50);
    expect(sizes["2560x1440"]).toBeGreaterThan(68);
    expect(sizes["3440x1440"]).toBeGreaterThan(sizes["2560x1440"]);
    // A short window holds it back, so it doesn't run off the screen.
    expect(sizes["2560x700"]).toBeLessThan(sizes["2560x1440"]);

    // The longest sentence stays clear of the wallet button above and the dock below.
    for (const [width, height] of [
        [2560, 1440],
        [3440, 1440],
        [2560, 700],
    ] as const) {
        await page.setViewportSize({ width, height });
        if (width === 2560 && height === 1440) await pick(page, "Swap", /^Predict/);
        await page.waitForTimeout(500);
        const sentence = (await trade(page).boundingBox())!;
        const wallet = (await page.getByRole("button", { name: "Connect wallet" }).boundingBox())!;
        const dock = (await page.getByRole("navigation", { name: "Pages" }).boundingBox())!;
        expect(sentence.y).toBeGreaterThan(wallet.y + wallet.height);
        expect(sentence.y + sentence.height).toBeLessThan(dock.y);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
        await shoot(page, `big-${width}x${height}`);
    }
});

test("the amount drops down under its pill, and dragging rolls the sentence live", async ({ page, isMobile }) => {
    await amountPill(page).click();
    await expect(amountField(page)).toBeVisible();
    // A dropdown: it opens right under the pill, overlapping it sideways.
    const [anchor, panel] = await settledBoxes(page, amountPill(page));
    expect(panel!.y).toBeGreaterThanOrEqual(anchor!.y + anchor!.height);
    expect(panel!.y).toBeLessThan(anchor!.y + anchor!.height + 24);
    expect(panel!.x).toBeLessThan(anchor!.x + anchor!.width);
    expect(panel!.x + panel!.width).toBeGreaterThan(anchor!.x);
    // What the amount comes to, and the slider's ends (no wallet, so no cap).
    await expect(picker(page)).toContainText("You get ≈ 0.06773 SOL");
    await expect(picker(page)).toContainText("0.1 USD");
    await expect(picker(page)).toContainText("10K USD");
    await expect(slider(page)).toHaveAttribute("aria-valuenow", "10");

    // Dragging right raises the amount as the pointer moves, in round steps.
    const track = (await slider(page).boundingBox())!;
    const y = track.y + track.height / 2;
    const seen: string[] = [];
    if (!isMobile) {
        await page.mouse.move(track.x + track.width * 0.27, y);
        await page.mouse.down();
        for (const f of [0.4, 0.55, 0.7]) {
            await page.mouse.move(track.x + track.width * f, y, { steps: 4 });
            seen.push((await amountPill(page).getAttribute("aria-label"))!);
        }
        await page.mouse.up();
    } else {
        await slider(page).tap({ position: { x: track.width * 0.7, y: track.height / 2 } });
        seen.push((await amountPill(page).getAttribute("aria-label"))!);
    }
    const values = seen.map((label) => Number(label.replace(" USD", "")));
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1]);
    // Two significant figures at any size
    for (const value of values) expect(Number(value.toPrecision(2))).toBe(value);
    await expect(amountField(page)).toHaveValue(String(values.at(-1)));
    // The pill's digits roll to the new amount instead of being swapped.
    await expect(amountPill(page).locator("number-flow-react")).toHaveCount(1);
    await shoot(page, "8-amount-slider");

    // Keys step it, and End jumps to the top of the range.
    await slider(page).focus();
    await page.keyboard.press("End");
    await expect(amountPill(page)).toHaveAccessibleName("10000 USD");
    // Steps keep two significant figures.
    await page.keyboard.press("ArrowLeft");
    await expect(amountPill(page)).toHaveAccessibleName("9900 USD");
    // Small amounts step by the cent.
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    await expect(amountPill(page)).toHaveAccessibleName("0.11 USD");
    await page.keyboard.press("Escape");
    await expect(picker(page)).toBeHidden();
    await expect(amountPill(page)).toBeFocused();
});

test("pickers drop down from their pill too", async ({ page }) => {
    for (const name of ["Swap", "ETH"]) {
        await pill(page, name).click();
        await expect(picker(page)).toBeVisible();
        const [anchor, panel] = await settledBoxes(page, pill(page, name));
        const below = panel!.y >= anchor!.y + anchor!.height;
        const above = panel!.y + panel!.height <= anchor!.y;
        expect(below || above).toBe(true);
        expect(panel!.x).toBeLessThan(anchor!.x + anchor!.width);
        expect(panel!.x + panel!.width).toBeGreaterThan(anchor!.x);
        await page.keyboard.press("Escape");
        await expect(picker(page)).toBeHidden();
    }
});
