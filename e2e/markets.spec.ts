import { expect, test, type Page } from "@playwright/test";
import { seedDeposits } from "./backend";
import { addressOf, installWallet, mockArcRpc, mockPrivy } from "./privy-mock";
import { API, sampleView, samples, trendingView } from "./polymarket";

const trade = (page: Page) => page.getByRole("region", { name: "Trade" });
const pill = (page: Page, name: string | RegExp) =>
    trade(page).getByRole("button", { name, exact: typeof name === "string" });
// Privy keeps a dialog of its own in the page; ours are marked.
const picker = (page: Page) => page.locator("[data-floating-dialog]:not([data-closing])");
const questionPill = (page: Page) => trade(page).locator('[data-slot="marketId"] button');

/** The sentence as a reader sees it: each pill's name between the plain words. */
async function sentence(page: Page) {
    await expect(trade(page).locator('[data-part][aria-hidden="true"]')).toHaveCount(0);
    return trade(page).evaluate((root) =>
        [...root.querySelectorAll("[data-part]")]
            .map((part) => {
                const copy = part.cloneNode(true) as HTMLElement;
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

const exact = (title: string) => new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
const cors = { "access-control-allow-origin": "*" };

/** Signs in with the injected wallet; the Review button only exists once someone has. */
async function connect(page: Page) {
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await page.locator("#privy-modal-content").getByRole("button", { name: "MetaMask" }).click();
    const sidebar = page.locator("#wallet-sidebar");
    await expect(sidebar).toHaveAttribute("data-open", "true", { timeout: 10_000 });
    await expect(sidebar.getByRole("button", { name: /^Balance/ })).not.toHaveAccessibleName(/loading/, {
        timeout: 10_000,
    });
    await page.keyboard.press("Escape");
    await expect(sidebar).toHaveAttribute("data-open", "false");
}

test.beforeEach(async ({ page }) => {
    await mockPrivy(page);
    await mockArcRpc(page);
    await installWallet(page);
});

test("the picker shows the cached markets at once, then the fresh ones", async ({ page }) => {
    const [first] = (await trendingView()).markets;
    const cached = {
        markets: [
            {
                id: "424242",
                title: "Will the cached question show first?",
                image: null,
                endDate: "2030-01-01T00:00:00Z",
                volume24hUSD: 1,
                outcomes: [
                    {
                        tokenId: "c-yes",
                        label: "YES",
                        buyPrice: 0.5,
                        chance: 0.5,
                        tone: "gain",
                        minUSD: 1,
                        image: null,
                    },
                    { tokenId: "c-no", label: "NO", buyPrice: 0.5, chance: 0.5, tone: "loss", minUSD: 1, image: null },
                ],
            },
        ],
        maxOrderUSD: null,
        readAt: "2026-10-12T00:00:00Z",
    };
    await page.addInitScript((value) => localStorage.setItem("markets:trending", JSON.stringify(value)), cached);
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/markets/trending", async (route) => {
        await gate;
        await route.continue();
    });
    await page.goto("/");
    await pick(page, "Swap", /^Predict/);
    await questionPill(page).click();
    await expect(picker(page).getByRole("option", { name: cached.markets[0].title })).toBeVisible();
    await expect(picker(page)).not.toContainText(/loading|checking/i);
    release();
    await expect(picker(page).getByRole("option", { name: first.title })).toBeVisible();
    await expect(picker(page)).not.toContainText(/loading|checking/i);
    // The cached question stays listed while it's the picked one; choosing another lets it go.
    await picker(page).getByRole("option", { name: first.title }).click();
    await questionPill(page).click();
    await expect(picker(page).getByRole("option", { name: first.title })).toBeVisible();
    await expect(picker(page).getByRole("option", { name: cached.markets[0].title })).toHaveCount(0);
    await expect(picker(page)).not.toContainText(/loading|checking/i);
});

test("signed out, the picker still shows live markets", async ({ page }) => {
    const [first] = (await trendingView()).markets;
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible();
    await pick(page, "Swap", /^Predict/);
    await expect(questionPill(page)).toHaveAccessibleName(first.title);
    await questionPill(page).click();
    await expect(picker(page).getByRole("option", { name: first.title })).toBeVisible();
});

test("a multi-outcome event reads Predict [option] on [event]", async ({ page }) => {
    const multi = await sampleView(samples.multi);
    const top = multi.outcomes.reduce((a, b) => (b.chance > a.chance ? b : a));
    await page.goto("/");
    await pick(page, "Swap", /^Predict/);
    await questionPill(page).click();
    await picker(page)
        .getByRole("option", { name: exact(multi.title) })
        .click();
    await expect(picker(page)).toBeHidden();
    // YES isn't one of its options, so the outcome waits to be picked.
    await pick(page, "pick one", exact(top.label));
    expect(await sentence(page)).toBe(`I want to Predict ${top.label} on ${multi.title} with 10 USD.`);
});

test("with nothing cached and Polymarket down, the picker says so", async ({ page }) => {
    await page.route("**/markets/trending", (route) =>
        route.fulfill({ json: { markets: [], maxOrderUSD: null, readAt: null }, headers: cors }),
    );
    await page.goto("/");
    await pick(page, "Swap", /^Predict/);
    await questionPill(page).click();
    await expect(picker(page)).toContainText("No markets to show right now.");
    await expect(picker(page).getByRole("option")).toHaveCount(0);
});

test("while the markets load, the question picker shows skeleton rows", async ({ page }) => {
    const [first] = (await trendingView()).markets;
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/markets/trending", async (route) => {
        await gate;
        await route.continue();
    });
    await page.goto("/");
    await pick(page, "Swap", /^Predict/);
    await questionPill(page).click();
    const skeleton = picker(page).getByRole("status");
    await expect(skeleton).toHaveText("Loading");
    await expect(picker(page).getByRole("option")).toHaveCount(0);
    await expect(picker(page)).not.toContainText("No markets to show right now.");
    release();
    await expect(picker(page).getByRole("option", { name: first.title })).toBeVisible();
    await expect(skeleton).toHaveCount(0);
});

test("the question picker has no title, and its hint names it", async ({ page }) => {
    await page.goto("/");
    await pick(page, "Swap", /^Predict/);
    await questionPill(page).click();
    await expect(picker(page)).toHaveAccessibleName("Prediction market");
    await expect(picker(page).getByRole("searchbox", { name: "Search markets" })).toBeVisible();
    await expect(picker(page).locator("p:not(.sr-only)", { hasText: "Prediction market" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(picker(page)).toBeHidden();
    // Pickers with a title still show it
    await pill(page, /^Predict/).click();
    await expect(picker(page).getByText("What do you want to do?")).toBeVisible();
});

test("a question that stops being offered asks for a question again", async ({ page }) => {
    const view = await sampleView(samples.yesNo);
    await page.goto("/");
    // Seeded before connecting, so the session loads it and no balance error comes first.
    await seedDeposits(addressOf(page), [{ amount: "100", daysAgo: 1 }]);
    await connect(page);
    await page.clock.install();
    await pick(page, "Swap", /^Predict/);
    await questionPill(page).click();
    await picker(page)
        .getByRole("option", { name: exact(view.title) })
        .click();
    await expect(picker(page)).toBeHidden();
    await expect(questionPill(page)).toHaveAccessibleName(view.title);

    await page.route(`${API}/markets/${view.id}`, (route) =>
        route.fulfill({ status: 404, json: { error: "not_found" }, headers: cors }),
    );
    await page.clock.fastForward(10_000);
    await expect(questionPill(page)).toHaveAccessibleName("pick one");
    await expect(page.getByRole("button", { name: "Review", exact: true })).toHaveAccessibleDescription(
        "Pick a question.",
    );
});

test("search finds a market that isn't trending", async ({ page }) => {
    const extra = await sampleView(samples.extra);
    const trending = await trendingView();
    expect(trending.markets.some((m) => m.id === extra.id)).toBe(false);
    await page.goto("/");
    await pick(page, "Swap", /^Predict/);
    await questionPill(page).click();
    await expect(picker(page).getByRole("option", { name: exact(extra.title) })).toHaveCount(0);
    await picker(page).getByRole("searchbox", { name: "Search markets" }).fill(extra.title.split(" ")[0]);
    const option = picker(page).getByRole("option", { name: exact(extra.title) });
    await expect(option).toBeVisible();
    await option.click();
    await expect(picker(page)).toBeHidden();
    await expect(questionPill(page)).toHaveAccessibleName(extra.title);
});

test("a query with no matches says so, over the trending list", async ({ page }) => {
    const [first] = (await trendingView()).markets;
    await page.goto("/");
    await pick(page, "Swap", /^Predict/);
    await questionPill(page).click();
    await picker(page).getByRole("searchbox", { name: "Search markets" }).fill("zzzz");
    await expect(picker(page)).toContainText("No markets match \u201czzzz\u201d.");
    await expect(picker(page).getByRole("option", { name: first.title })).toBeVisible();
    await expect(picker(page)).not.toContainText(/loading|searching/i);
});

test("a search that fails says so, over the trending list", async ({ page }) => {
    const [first] = (await trendingView()).markets;
    await page.route("**/markets/search*", (route) =>
        route.fulfill({ status: 503, json: { error: "unavailable" }, headers: cors }),
    );
    await page.goto("/");
    await pick(page, "Swap", /^Predict/);
    await questionPill(page).click();
    await picker(page).getByRole("searchbox", { name: "Search markets" }).fill("fed");
    await expect(picker(page)).toContainText("Search isn't available right now.");
    await expect(picker(page).getByRole("option", { name: first.title })).toBeVisible();
    await expect(picker(page).getByRole("status")).toHaveCount(0);
});

test("the search field is reachable by keyboard", async ({ page }) => {
    const [first] = (await trendingView()).markets;
    await page.goto("/");
    await pick(page, "Swap", /^Predict/);
    await questionPill(page).click();
    const field = picker(page).getByRole("searchbox", { name: "Search markets" });
    await expect(field).toBeFocused();
    // Typeahead is off, so letters go to the field only.
    await page.keyboard.type("zzzz");
    await expect(field).toHaveValue("zzzz");
    // The rows come back with the answer; until then there's nothing to move to
    await expect(picker(page)).toContainText("No markets match \u201czzzz\u201d.");
    await page.keyboard.press("ArrowDown");
    await expect(picker(page).getByRole("option").first()).toBeFocused();
    await expect(picker(page).getByRole("option", { name: first.title })).toBeVisible();
    await page.keyboard.press("ArrowUp");
    await expect(field).toBeFocused();
});

test("closing the picker ends the search", async ({ page }) => {
    const extra = await sampleView(samples.extra);
    const [first] = (await trendingView()).markets;
    await page.goto("/");
    await pick(page, "Swap", /^Predict/);
    await questionPill(page).click();
    await picker(page).getByRole("searchbox", { name: "Search markets" }).fill(extra.title.split(" ")[0]);
    await expect(picker(page).getByRole("option", { name: exact(extra.title) })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(picker(page)).toBeHidden();
    await questionPill(page).click();
    await expect(picker(page).getByRole("searchbox", { name: "Search markets" })).toHaveValue("");
    await expect(picker(page).getByRole("option", { name: first.title })).toBeVisible();
    await expect(picker(page).getByRole("option", { name: exact(extra.title) })).toHaveCount(0);
});

test("a pending search shows skeleton rows, and its results arriving don't move focus", async ({ page }) => {
    const extra = await sampleView(samples.extra);
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/markets/search*", async (route) => {
        await gate;
        await route.continue();
    });
    await page.goto("/");
    await pick(page, "Swap", /^Predict/);
    await questionPill(page).click();
    const field = picker(page).getByRole("searchbox", { name: "Search markets" });
    await field.fill(extra.title.split(" ")[0]);
    const skeleton = picker(page).getByRole("status");
    await expect(skeleton).toHaveText("Loading");
    await expect(picker(page).getByRole("option")).toHaveCount(0);
    // No rows to move to while they load
    await page.keyboard.press("ArrowDown");
    await expect(field).toBeFocused();
    release();
    await expect(picker(page).getByRole("option", { name: exact(extra.title) })).toBeVisible();
    await expect(skeleton).toHaveCount(0);
    await expect(field).toBeFocused();
});
