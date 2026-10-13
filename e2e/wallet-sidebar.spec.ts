import { expect, test, type Page } from "@playwright/test";
import { randomSolanaAddress, seedDeposits } from "./backend";
import { HISTORY, HISTORY_TOTAL } from "./fixtures";
import { buyPredictions, predictionsToBuy, type Bought } from "./positions";
import {
    addressOf,
    ARC_PRIMARY_RPC,
    ARC_RPC,
    installSolanaWallet,
    installWallet,
    lockWallet,
    mockArcRpc,
    mockPrivy,
    moveWalletTo,
    walletChainId,
    walletRequests,
} from "./privy-mock";

const DEPOSITS = HISTORY.length;
const usd = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
const HISTORY_BALANCE = usd(HISTORY_TOTAL);
// Real predictions, enough that they overflow the sidebar.
const POSITIONS = 10;

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Wallet" });
const dock = (page: Page) => page.getByRole("button", { name: `Wallet ${addressOf(page)}` });
const modal = (page: Page) => page.locator("#privy-modal-content");
const depositButton = (page: Page) => sidebar(page).getByRole("button", { name: "Deposit", exact: true });
const balanceButton = (page: Page) => sidebar(page).getByRole("button", { name: /^Balance/ });
const amountField = (page: Page) => sidebar(page).getByRole("textbox", { name: "Deposit amount" });
const hint = (page: Page) => sidebar(page).locator("#deposit-hint");
// Read out, not shown: the wallet's balance under the amount field.
const walletLine = (page: Page) => sidebar(page).locator("#deposit-wallet");
const showAgain = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
const rows = (page: Page) => sidebar(page).getByRole("list", { name: "Open positions" }).getByRole("listitem");
/** A position by the question it bets on. */
const position = (page: Page, bought: Bought) => rows(page).filter({ hasText: bought.market.title });
const closeButton = (page: Page, bought: Bought) =>
    position(page, bought).getByRole("button", { name: `Close ${bought.outcome.label} on ${bought.market.title}` });

const TREND_COLOR = { gain: "rgb(104, 214, 112)", loss: "rgb(255, 107, 91)", flat: "rgb(143, 143, 138)" };

/** Lets springs settle before a screenshot. */
const settle = (page: Page) => page.waitForTimeout(900);

async function shoot(page: Page, name: string) {
    await settle(page);
    await page.screenshot({
        path: `e2e/screenshots/${test.info().project.name}-wallet-${name}.png`,
    });
}

async function connect(page: Page) {
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await modal(page).getByRole("button", { name: "MetaMask" }).click();
}

/**
 * Connects and waits for the sidebar and the account to load. `history` seeds the 20 deposits first, and
 * `positions` buys that many predictions before signing in, oldest first.
 */
async function openWallet(page: Page, { history = false, positions = 0 } = {}) {
    if (history) await seedDeposits(addressOf(page), HISTORY);
    else if (positions) await seedDeposits(addressOf(page), [{ amount: "500", daysAgo: 0 }]);
    const bought = await predictionsToBuy(positions);
    await buyPredictions(addressOf(page), bought);
    await connect(page);
    await expect(sidebar(page)).toHaveAttribute("data-open", "true", { timeout: 10_000 });
    await expect(balanceButton(page)).toHaveAccessibleName(/^Balance \$/, { timeout: 20_000 });
    await expect(rows(page)).toHaveCount(positions);
    // Open rows, not buys still waiting: each has its shares.
    for (const row of bought) await expect(position(page, row)).toContainText(/\d shares/);
    return bought;
}

/** Opens the deposit form, which is where the wallet's own balance is shown. */
async function openDepositForm(page: Page) {
    await depositButton(page).click();
    await sidebar(page)
        .getByRole("button", { name: /^USDC on Arc/ })
        .click();
    await expect(amountField(page)).toBeFocused();
}

test.beforeEach(async ({ page }) => {
    await mockPrivy(page);
    await mockArcRpc(page);
    await installWallet(page);
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
});

test("the Privy modal wears the app's styles", async ({ page }) => {
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await expect(modal(page).getByRole("button", { name: "MetaMask" })).toBeVisible();

    const styles = await page.evaluate(() => {
        const css = (el: Element | null) => getComputedStyle(el!);
        const wallet = [...document.querySelectorAll("#privy-modal-content button")].find((b) =>
            b.textContent?.includes("MetaMask"),
        )!;
        return {
            font: css(wallet).fontFamily,
            walletRadius: css(wallet).borderRadius,
            walletBorder: css(wallet).borderTopWidth,
            walletBackground: css(wallet).backgroundColor,
            panelBackground: css(document.querySelector("#privy-modal-content")).backgroundColor,
            backdropBlur: css(document.querySelector("#privy-dialog-backdrop")).backdropFilter,
        };
    });
    expect(styles.font).toContain("Inter");
    expect(styles.walletRadius).toBe("999px");
    expect(styles.walletBorder).toBe("0px");
    expect(styles.walletBackground).toBe("rgb(43, 43, 41)");
    expect(styles.panelBackground).toBe("rgb(34, 34, 32)");
    expect(styles.backdropBlur).toBe("none");
    await shoot(page, "1-privy-modal");
});

test("the Privy modal offers only wallets that can use Arc", async ({ page }) => {
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await expect(modal(page).getByRole("button", { name: "MetaMask" })).toBeVisible();
    await expect(modal(page).getByRole("button", { name: "Coinbase Wallet" })).toBeVisible();
    await expect(modal(page).getByRole("button", { name: "Base", exact: true })).toHaveCount(0);
});

test("connecting a wallet opens the sidebar right away and pushes the page", async ({ page }) => {
    await expect(sidebar(page)).toHaveAttribute("data-open", "false");
    await connect(page);

    await expect(sidebar(page)).toHaveAttribute("data-open", "true", { timeout: 10_000 });
    await expect(dock(page)).toHaveAttribute("aria-expanded", "true");
    await expect(dock(page)).toHaveAttribute("aria-controls", "wallet-sidebar");

    // Once settled, the page ends exactly where the panel begins (on phones
    // the panel covers the screen and the page slides out to the left).
    await expect(async () => {
        const edges = await page.evaluate(() => {
            const panel = document.getElementById("wallet-sidebar")!;
            return {
                page: Math.round(panel.previousElementSibling!.getBoundingClientRect().right),
                panel: Math.round(panel.getBoundingClientRect().left),
                viewport: innerWidth,
            };
        });
        expect(edges.page).toBe(edges.panel);
        expect(edges.viewport - edges.panel).toBe(edges.viewport < 560 ? edges.viewport : 400);
    }).toPass({ timeout: 3_000 });

    await expect(balanceButton(page)).toHaveAccessibleName("Balance $0.00, show deposits");
    await expect(depositButton(page)).toBeVisible();
    await shoot(page, "2-sidebar-open");
});

test("the header shows the network the wallet is on", async ({ page }) => {
    await openWallet(page);
    const header = sidebar(page).locator("header");
    for (const [chainId, name] of [
        ["0x1", "Ethereum"],
        ["0x38", "BNB Chain"],
        ["0x2105", "Base"],
        ["0x13b2", "Arc"],
        ["0x3e7", "Chain 999"],
    ]) {
        await moveWalletTo(page, chainId);
        await expect(header.getByRole("img", { name, exact: true })).toBeVisible();
    }
});

test("a locked wallet leaves the header with an unknown network", async ({ page }) => {
    await openWallet(page);
    await lockWallet(page);
    await expect(
        sidebar(page).locator("header").getByRole("img", { name: "Unknown network", exact: true }),
    ).toBeVisible();
    await expect(sidebar(page)).toHaveAttribute("data-open", "true");
});

test("connecting leaves the wallet on its own network", async ({ page }) => {
    await openWallet(page);
    const methods = (await walletRequests(page)).map((r) => r.method);
    expect(methods).not.toContain("wallet_switchEthereumChain");
    expect(methods).not.toContain("wallet_addEthereumChain");
    expect(await walletChainId(page)).toBe("0x1");
    await expect(sidebar(page).locator("header").getByRole("img", { name: "Ethereum", exact: true })).toBeVisible();
    await expect(depositButton(page)).toBeVisible();
    await expect(page.getByRole("button", { name: `Wallet ${addressOf(page)}`, exact: true })).toBeVisible();
    await expect(dock(page).locator('[aria-hidden="true"]')).toHaveCSS("background-color", TREND_COLOR.gain);
});

test("the balance is the account's USDC on the server", async ({ page }) => {
    await mockArcRpc(page, 7_250.75);
    await openWallet(page, { history: true });

    await expect(balanceButton(page)).toHaveAccessibleName(`Balance ${HISTORY_BALANCE}, show deposits`);
    await expect(sidebar(page).getByText(HISTORY_BALANCE.slice(0, -3))).toBeVisible();
});

test("a fresh account has a zero balance and no deposits to show", async ({ page, isMobile }) => {
    await openWallet(page);
    await expect(balanceButton(page)).toHaveAccessibleName("Balance $0.00, show deposits");
    await settle(page);

    if (isMobile) await balanceButton(page).tap();
    else await balanceButton(page).hover();
    await expect(balanceButton(page)).toHaveAttribute("aria-expanded", "true");
    await page.waitForTimeout(500);
    await expect(sidebar(page).getByRole("list", { name: "Deposits" })).toHaveCount(0);
});

test("the deposit form reads out the wallet's balance without writing it under the field", async ({ page }) => {
    await mockArcRpc(page, 7_250.75);
    await openWallet(page);

    await openDepositForm(page);
    await expect(walletLine(page)).toHaveText("In your wallet: $7,250.75");
    await expect(amountField(page)).toHaveAccessibleDescription("In your wallet: $7,250.75");
    await expect(hint(page)).toBeEmpty();
    await expect(balanceButton(page)).toHaveAccessibleName("Balance $0.00, show deposits");
});

test("the wallet's balance refreshes when the page comes back into view", async ({ page }) => {
    await openWallet(page);
    await openDepositForm(page);
    await expect(walletLine(page)).toHaveText("In your wallet: $12,480.52");

    await mockArcRpc(page, 13_000);
    await showAgain(page);
    await expect(walletLine(page)).toHaveText("In your wallet: $13,000.00");
});

test("a failed refresh keeps the wallet's last balance", async ({ page }) => {
    await openWallet(page);
    await openDepositForm(page);
    await expect(walletLine(page)).toHaveText("In your wallet: $12,480.52");

    let attempts = 0;
    await page.route(ARC_RPC, (route) => {
        attempts++;
        return route.abort();
    });
    await showAgain(page);
    await expect.poll(() => attempts).toBeGreaterThanOrEqual(3);
    await page.waitForTimeout(300);
    await expect(walletLine(page)).toHaveText("In your wallet: $12,480.52");
});

test("the wallet's balance falls back to another Arc RPC when the primary is down", async ({ page }) => {
    await page.route(ARC_PRIMARY_RPC, (route) => route.abort());
    await openWallet(page);
    await openDepositForm(page);
    await expect(walletLine(page)).toHaveText("In your wallet: $12,480.52");
});

test("a hanging Arc RPC gives up within one poll and shows no wallet balance", async ({ page }) => {
    test.setTimeout(40_000);
    await page.route(ARC_RPC, () => {});
    await openWallet(page);
    await openDepositForm(page);

    await expect(walletLine(page)).toHaveText("Checking your wallet…");
    await expect(hint(page)).toHaveText("Couldn't read your wallet's balance.", { timeout: 15_000 });
    await expect(sidebar(page).getByRole("button", { name: "Max" })).toHaveCount(0);
});

test("an unreachable Arc RPC shows no wallet balance rather than zero", async ({ page }) => {
    await page.route(ARC_RPC, (route) => route.abort());
    await openWallet(page);
    await openDepositForm(page);

    await expect(hint(page)).toHaveText("Couldn't read your wallet's balance.", { timeout: 10_000 });
    await expect(hint(page)).not.toContainText("$");
    // The account's own balance is unaffected.
    await expect(balanceButton(page)).toHaveAccessibleName("Balance $0.00, show deposits");
});

test("the panel and the page move on one spring", async ({ page }) => {
    await connect(page);
    await expect(sidebar(page)).toHaveAttribute("data-open", "true", { timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expect(sidebar(page)).toHaveAttribute("data-open", "false");
    await settle(page);

    await dock(page).dispatchEvent("click");
    const frames = await page.evaluate(async () => {
        const panel = document.getElementById("wallet-sidebar")!;
        const samples: { gap: number; left: number }[] = [];
        const start = performance.now();
        while (performance.now() - start < 900) {
            await new Promise(requestAnimationFrame);
            const left = panel.getBoundingClientRect().left;
            const right = panel.previousElementSibling!.getBoundingClientRect().right;
            samples.push({ gap: Math.abs(left - right), left });
        }
        return samples;
    });
    expect(Math.max(...frames.map((f) => f.gap)), "page and panel never drift").toBeLessThan(1.5);
    const final = frames.at(-1)!.left;
    expect(Math.min(...frames.map((f) => f.left)), "the push overshoots").toBeLessThan(final - 1);
});

test("the dock button, the close button and Escape all toggle the sidebar", async ({ page }) => {
    await connect(page);
    await expect(sidebar(page)).toHaveAttribute("data-open", "true", { timeout: 10_000 });

    await sidebar(page).getByRole("button", { name: "Close sidebar" }).click();
    await expect(sidebar(page)).toHaveAttribute("data-open", "false");
    await expect(dock(page)).toHaveAttribute("aria-expanded", "false");
    await settle(page);

    await dock(page).click();
    await expect(sidebar(page)).toHaveAttribute("data-open", "true");
    await page.keyboard.press("Escape");
    await expect(sidebar(page)).toHaveAttribute("data-open", "false");
    await settle(page);

    // Closed, the panel is inert and parked fully off-screen.
    const left = await sidebar(page).evaluate((el) => el.getBoundingClientRect().left);
    expect(left).toBeGreaterThan(page.viewportSize()!.width - 0.5);
    expect(await sidebar(page).evaluate((el) => (el as HTMLElement).inert)).toBe(true);
});

test("hovering the balance deals out past deposits", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover only; touch pins it with a tap, covered below");
    await openWallet(page, { history: true });
    await settle(page);

    const deposits = sidebar(page).getByRole("list", { name: "Deposits" });
    await expect(deposits).toHaveCount(0);

    await sidebar(page)
        .getByRole("button", { name: /^Balance/ })
        .hover();
    await expect(deposits.getByRole("listitem")).toHaveCount(DEPOSITS);
    await expect(deposits.getByRole("listitem").first()).toContainText("+$2,500.00");
    await expect(deposits.getByRole("listitem").last()).toContainText("+$3,105.75");
    await shoot(page, "3-deposits");

    // Positions recede behind the history.
    await expect
        .poll(() =>
            page.evaluate(() => getComputedStyle(document.querySelector('[data-history="open"] + div')!).opacity),
        )
        .toBe("0.3");

    await page.mouse.move(200, 200);
    await expect(deposits).toHaveCount(0);
});

test("past deposits are dealt out on reveal, not shown instantly", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover only");
    await openWallet(page, { history: true });
    await settle(page);

    // Record every deposit row's opacity and vertical offset each frame.
    type Frame = { t: number; rows: { opacity: number; y: number; scale: number }[] };
    await page.evaluate(() => {
        const frames: Frame[] = [];
        (window as unknown as { depositFrames: Frame[] }).depositFrames = frames;
        const start = performance.now();
        const tick = () => {
            const rows = document.querySelectorAll('[aria-label="Deposits"] > li');
            if (rows.length) {
                frames.push({
                    t: performance.now(),
                    rows: [...rows].map((row) => {
                        const style = getComputedStyle(row);
                        const matrix = new DOMMatrix(style.transform);
                        return { opacity: +style.opacity, y: matrix.m42, scale: matrix.a };
                    }),
                });
            }
            // Runs until the rows have had time to settle once they show, however late the hover lands.
            const seen = frames[0]?.t ?? Infinity;
            if (performance.now() - start < 15_000 && performance.now() - seen < 1_500) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    });
    await sidebar(page)
        .getByRole("button", { name: /^Balance/ })
        .hover();
    await expect
        .poll(() => page.evaluate(() => (window as unknown as { depositFrames: Frame[] }).depositFrames.length))
        .toBeGreaterThan(0);
    await page.waitForTimeout(1_700);
    const recorded = await page.evaluate(() => (window as unknown as { depositFrames: Frame[] }).depositFrames);
    const frames = recorded.map((frame) => frame.rows);

    expect(frames.length, "rows were sampled").toBeGreaterThan(10);
    const first = frames[0];
    expect(first).toHaveLength(DEPOSITS);
    for (const row of first) {
        expect(row.opacity, "each row starts hidden").toBeLessThan(0.5);
        expect(row.y, "each row starts tucked up under the one above").toBeLessThan(-5);
        expect(row.scale, "no row is scaled past zero, however long the list").toBeGreaterThan(0.5);
    }
    for (const row of frames.at(-1)!) {
        expect(row.opacity).toBe(1);
        expect(Math.abs(row.y)).toBeLessThan(0.5);
    }

    // Staggered top to bottom: no row lands before the one above it, and at
    // some point the top row is clearly ahead of the rows below.
    const visibleAt = first.map((_, i) => frames.findIndex((frame) => frame[i].opacity > 0.9));
    expect(visibleAt.every((frame) => frame >= 0)).toBe(true);
    expect(visibleAt).toEqual([...visibleAt].sort((a, b) => a - b));
    const later = Math.min(7, DEPOSITS - 1);
    expect(
        frames.some((frame) => frame[0].opacity - frame[later].opacity > 0.2),
        "the top row leads the rows below it",
    ).toBe(true);

    // Quick: every row has settled in place shortly after the history appears.
    const settledAt = recorded.findIndex((frame) =>
        frame.rows.every((row) => row.opacity === 1 && Math.abs(row.y) < 0.5),
    );
    const revealMs = recorded[settledAt].t - recorded[0].t;
    test.info().annotations.push({ type: "reveal", description: `${Math.round(revealMs)}ms` });
    console.log(`deposit reveal settled in ${Math.round(revealMs)}ms`);
    expect(revealMs, "the whole deal-out settles quickly").toBeLessThan(900);
});

test("a long deposit history stays inside the sidebar and scrolls", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover only; the tap-pinned history is covered below");
    await openWallet(page, { history: true });
    await settle(page);

    const history = sidebar(page).getByRole("list", { name: "Deposits" });
    await sidebar(page)
        .getByRole("button", { name: /^Balance/ })
        .hover();
    await expect(history.getByRole("listitem")).toHaveCount(DEPOSITS);
    await shoot(page, "6-long-history");

    const box = await history.evaluate((list) => ({
        bottom: list.getBoundingClientRect().bottom,
        panelBottom: list.closest("aside")!.getBoundingClientRect().bottom,
        overflows: list.scrollHeight > list.clientHeight,
    }));
    expect(box.bottom, "the history ends above the sidebar's bottom edge").toBeLessThanOrEqual(box.panelBottom);
    expect(box.overflows, "20 deposits don't fit, so the history scrolls").toBe(true);

    const oldest = history.getByRole("listitem").last();
    await expect(oldest).toContainText(
        `+$${Number(HISTORY.at(-1)!.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
    );
    await expect(oldest).not.toBeInViewport();

    // Wheel over the history scrolls it, not the positions behind it.
    const positionsTop = () =>
        page.evaluate(() => document.querySelector('[aria-label="Open positions"]')!.parentElement!.scrollTop);
    const before = await positionsTop();
    await history.hover();
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 400);
    await expect(oldest).toBeInViewport();
    await expect.poll(() => history.evaluate((list) => list.scrollTop)).toBeGreaterThan(0);
    expect(await positionsTop()).toBe(before);
    await expect(history, "still open while scrolling it").toBeVisible();
    await shoot(page, "7-long-history-scrolled");
});

test("many positions scroll inside the sidebar and enter quickly", async ({ page }) => {
    test.setTimeout(60_000);
    const bought = await openWallet(page, { positions: POSITIONS });
    await page.keyboard.press("Escape");
    await expect(sidebar(page)).toHaveAttribute("data-open", "false");
    await settle(page);

    // Time from reopening until every position in view has landed.
    const entranceMs = await page.evaluate(async () => {
        const panel = document.getElementById("wallet-sidebar")!;
        const dock = document.querySelector<HTMLButtonElement>('[aria-controls="wallet-sidebar"]')!;
        const start = performance.now();
        dock.click();
        while (performance.now() - start < 3_000) {
            await new Promise(requestAnimationFrame);
            const list = panel.querySelector('[aria-label="Open positions"]');
            const scroller = list?.parentElement;
            if (!list || !scroller) continue;
            const view = scroller.getBoundingClientRect();
            const inView = [...list.children].filter((row) => {
                const box = row.getBoundingClientRect();
                return box.bottom > view.top && box.top < view.bottom;
            });
            const landed = inView.every((row) => {
                const style = getComputedStyle(row);
                return style.opacity === "1" && Math.abs(new DOMMatrix(style.transform).m42) < 0.5;
            });
            if (inView.length > 0 && landed) return performance.now() - start;
        }
        return Infinity;
    });
    console.log(`positions entrance settled in ${Math.round(entranceMs)}ms`);
    expect(entranceMs, "the positions in view land soon after opening").toBeLessThan(850);

    await expect(rows(page)).toHaveCount(POSITIONS);
    const scroller = await rows(page)
        .first()
        .evaluate((row) => {
            const list = row.closest("ul")!.parentElement!;
            return {
                overflows: list.scrollHeight > list.clientHeight,
                bottom: list.getBoundingClientRect().bottom,
                panelBottom: list.closest("aside")!.getBoundingClientRect().bottom,
            };
        });
    expect(scroller.overflows, `${POSITIONS} positions don't fit, so they scroll`).toBe(true);
    expect(scroller.bottom).toBeLessThanOrEqual(scroller.panelBottom + 0.5);

    // The oldest position sits at the bottom of the scroll range.
    await expect(position(page, bought[0]!)).toBeAttached();
    await position(page, bought[0]!).scrollIntoViewIfNeeded();
    await expect(position(page, bought[0]!)).toBeInViewport();
    await shoot(page, "8-many-positions");
});

test("scrollable lists blur only the edges that hide more content", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover and wheel");
    test.setTimeout(60_000);
    await openWallet(page, { history: true, positions: POSITIONS });
    await settle(page);

    // Each scroller fades its content out over the band an overlay blurs.
    const edges = (scroller: ReturnType<typeof sidebar>) =>
        scroller.evaluate((el) => {
            const overlay = (side: string) =>
                getComputedStyle(el.parentElement!.querySelector(`:scope > [data-edge="${side}"]`)!);
            const style = getComputedStyle(el);
            return {
                top: +overlay("top").opacity,
                bottom: +overlay("bottom").opacity,
                blur: [overlay("top").backdropFilter, overlay("bottom").backdropFilter],
                fade: [style.getPropertyValue("--fade-top"), style.getPropertyValue("--fade-bottom")],
                edge: style.getPropertyValue("--edge"),
            };
        });
    const expectEdges = async (scroller: ReturnType<typeof sidebar>, top: number, bottom: number) => {
        await expect.poll(async () => (await edges(scroller)).top).toBe(top);
        await expect.poll(async () => (await edges(scroller)).bottom).toBe(bottom);
        const { blur, fade, edge } = await edges(scroller);
        expect(blur).toEqual(["blur(8px)", "blur(8px)"]);
        expect(fade).toEqual([top ? edge : "0px", bottom ? edge : "0px"]);
    };

    // Positions: more below at first, more above once scrolled to the end.
    const positions = sidebar(page).getByRole("list", { name: "Open positions" }).locator("xpath=..");
    await expectEdges(positions, 0, 1);
    await shoot(page, "9-positions-bottom-edge");
    await positions.hover();
    await page.mouse.wheel(0, 120);
    await expectEdges(positions, 1, 1);
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 400);
    await expectEdges(positions, 1, 0);
    await shoot(page, "10-positions-top-edge");

    // Deposit history: the same, inside the floating list.
    await sidebar(page)
        .getByRole("button", { name: /^Balance/ })
        .hover();
    const history = sidebar(page).getByRole("list", { name: "Deposits" });
    await expect(history.getByRole("listitem")).toHaveCount(DEPOSITS);
    await expectEdges(history, 0, 1);
    await history.hover();
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 400);
    await expectEdges(history, 1, 0);
    await shoot(page, "11-history-top-edge");
});

test("deposit rows cast only a light shadow", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover only");
    await openWallet(page, { history: true });
    await sidebar(page)
        .getByRole("button", { name: /^Balance/ })
        .hover();

    const rows = sidebar(page).getByRole("list", { name: "Deposits" }).getByRole("listitem");
    await expect(rows).toHaveCount(DEPOSITS);
    for (const shadow of await rows.evaluateAll((els) => els.map((el) => getComputedStyle(el).boxShadow))) {
        // e.g. "rgba(0, 0, 0, 0.2) 0px 4px 10px -6px"
        const [, alpha, blur] = shadow.match(/rgba\(0, 0, 0, ([\d.]+)\) -?[\d.]+px -?[\d.]+px ([\d.]+)px/) ?? [];
        expect(Number(alpha), `shadow "${shadow}" is light`).toBeLessThanOrEqual(0.25);
        expect(Number(blur), `shadow "${shadow}" is tight`).toBeLessThanOrEqual(12);
    }
});

test("depositing adds to the history", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover flow");
    await openWallet(page, { history: true });
    await expect(balanceButton(page)).toHaveAccessibleName(`Balance ${HISTORY_BALANCE}, show deposits`);

    await openDepositForm(page);
    await amountField(page).fill("500");
    await depositButton(page).click();

    // The history reveals once the form closes, as the pointer is still over the section.
    const rows = sidebar(page).getByRole("list", { name: "Deposits" }).getByRole("listitem");
    await expect(rows).toHaveCount(DEPOSITS + 1);
    await expect(rows.first()).toContainText("+$500.00");
    await expect(rows.first()).toContainText("today", { timeout: 15_000 });
    await expect(rows.first()).not.toContainText("Pending");
    await expect(balanceButton(page)).toHaveAccessibleName(`Balance ${usd(HISTORY_TOTAL + 500)}, show deposits`);
});

test("hovering a position reveals a close button in the PnL's color", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover only");
    const bought = await openWallet(page, { positions: 3 });
    await settle(page);

    // Bottom to top: the oldest position sits lowest.
    const tops = await Promise.all(
        bought.map((b) => position(page, b).evaluate((el) => el.getBoundingClientRect().top)),
    );
    expect(tops).toEqual([...tops].sort((a, b) => b - a));

    for (const b of bought) {
        const row = position(page, b);
        // Each row names the question, then its outcome with its shares and PnL, and what it's worth.
        const label = b.outcome.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        await expect(row).toContainText(
            new RegExp(`${label} · [\\d.,]+ shares · [+−]?\\$[\\d,]+\\.\\d\\d\\$[\\d,]+\\.\\d\\d`),
        );

        const close = closeButton(page, b);
        await expect.poll(() => close.evaluate((el) => el.parentElement!.getBoundingClientRect().width)).toBe(0);
        await row.hover();
        await expect
            .poll(() => close.evaluate((el) => el.parentElement!.getBoundingClientRect().width))
            .toBeGreaterThan(50);
        const trend = (await row.getAttribute("data-trend")) as keyof typeof TREND_COLOR;
        await expect(close).toHaveCSS("color", TREND_COLOR[trend]);
    }
    await shoot(page, "4-hover-position");
});

test("closing a position removes it", async ({ page, isMobile }) => {
    const [kept, sold] = await openWallet(page, { positions: 2 });
    await settle(page);

    if (isMobile) await position(page, sold!).tap();
    else await position(page, sold!).hover();
    await closeButton(page, sold!).click();

    await expect(position(page, sold!)).toHaveCount(0);
    await expect(position(page, kept!)).toHaveCount(1);
    await expect(rows(page)).toHaveCount(1);
    await shoot(page, "5-after-close");
});

test("the close button is reachable by keyboard", async ({ page, isMobile }) => {
    test.skip(isMobile, "keyboard flow is a desktop concern");
    const [only] = await openWallet(page, { positions: 1 });
    // Privy hands focus back to the dock button just after its modal closes, so wait for that first.
    await expect(dock(page)).toBeFocused();

    // The position's close button follows the deposit button in tab order.
    const close = closeButton(page, only!);
    await depositButton(page).focus();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await expect
        .poll(() => close.evaluate((el) => el.parentElement!.getBoundingClientRect().width))
        .toBeGreaterThan(50);
    await page.keyboard.press("Enter");
    await expect(position(page, only!)).toHaveCount(0);
});

test("a fresh account has no open positions", async ({ page }) => {
    await openWallet(page);
    await expect(rows(page)).toHaveCount(0);
    await expect(sidebar(page).getByText("No open positions")).toBeVisible();
});

test("disconnecting signs out and folds the sidebar away", async ({ page }) => {
    await connect(page);
    await expect(sidebar(page)).toHaveAttribute("data-open", "true", { timeout: 10_000 });

    await sidebar(page).getByRole("button", { name: "Disconnect" }).click();
    await expect(sidebar(page)).toHaveAttribute("data-open", "false");
    await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible();
});

test("on touch, taps stand in for hover", async ({ page, isMobile }) => {
    test.skip(!isMobile, "touch only");
    const [only] = await openWallet(page, { history: true, positions: 1 });
    await settle(page);

    await sidebar(page)
        .getByRole("button", { name: /^Balance/ })
        .tap();
    await expect(sidebar(page).getByRole("list", { name: "Deposits" }).getByRole("listitem")).toHaveCount(DEPOSITS);
    await shoot(page, "3-deposits");
    await sidebar(page)
        .getByRole("button", { name: /^Balance/ })
        .tap();
    await expect(sidebar(page).getByRole("list", { name: "Deposits" })).toHaveCount(0);

    await position(page, only!).tap();
    const trend = (await position(page, only!).getAttribute("data-trend")) as keyof typeof TREND_COLOR;
    await expect(closeButton(page, only!)).toHaveCSS("color", TREND_COLOR[trend]);
    await shoot(page, "4-tap-position");
});

test("an EVM-first user connects a Solana wallet from the sidebar", async ({ page }) => {
    const solana = randomSolanaAddress();
    await installSolanaWallet(page, solana);
    await page.reload();
    await openWallet(page, { history: true });
    await expect(balanceButton(page)).toHaveAccessibleName(`Balance ${HISTORY_BALANCE}, show deposits`);

    await sidebar(page).getByRole("button", { name: "Connect another wallet" }).click();
    await modal(page).getByRole("button", { name: "Phantom" }).click();

    await expect(sidebar(page).locator("header").first().getByRole("img", { name: "Solana" })).toBeVisible({
        timeout: 10_000,
    });
    await expect(balanceButton(page)).toHaveAccessibleName(`Balance ${HISTORY_BALANCE}, show deposits`);
});
