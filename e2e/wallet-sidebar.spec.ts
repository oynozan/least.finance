import { expect, test, type Page } from "@playwright/test";
import { MOCK_DEPOSITS, MOCK_POSITIONS } from "../components/wallet-data";
import { ADDRESS, installWallet, mockPrivy } from "./privy-mock";

const DEPOSITS = MOCK_DEPOSITS.length;
const POSITIONS = MOCK_POSITIONS.length;

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Wallet" });
const dock = (page: Page) => page.getByRole("button", { name: `Wallet ${ADDRESS}` });
const modal = (page: Page) => page.locator("#privy-modal-content");
const position = (page: Page, symbol: string) =>
  sidebar(page).getByRole("listitem").filter({ has: page.getByRole("img", { name: symbol }) });

const GAIN = "rgb(104, 214, 112)";
const LOSS = "rgb(255, 107, 91)";
const FLAT = "rgb(143, 143, 138)";

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

test.beforeEach(async ({ page }) => {
  await mockPrivy(page);
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

  await expect(sidebar(page).getByText("$12,480")).toBeVisible();
  await expect(sidebar(page).getByRole("button", { name: "Deposit", exact: true })).toBeVisible();
  await shoot(page, "2-sidebar-open");
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
  await connect(page);
  await expect(sidebar(page)).toHaveAttribute("data-open", "true", { timeout: 10_000 });
  await settle(page);

  const deposits = sidebar(page).getByRole("list", { name: "Deposits" });
  await expect(deposits).toHaveCount(0);

  await sidebar(page).getByRole("button", { name: /^Balance/ }).hover();
  await expect(deposits.getByRole("listitem")).toHaveCount(DEPOSITS);
  await expect(deposits.getByRole("listitem").first()).toContainText("+$2,500.00");
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
  await connect(page);
  await expect(sidebar(page)).toHaveAttribute("data-open", "true", { timeout: 10_000 });
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
      if (performance.now() - start < 2_000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await sidebar(page).getByRole("button", { name: /^Balance/ }).hover();
  await page.waitForTimeout(1_500);
  const recorded = await page.evaluate(
    () => (window as unknown as { depositFrames: Frame[] }).depositFrames,
  );
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
  expect(revealMs, "the whole deal-out settles quickly").toBeLessThan(500);
});

test("a long deposit history stays inside the sidebar and scrolls", async ({ page, isMobile }) => {
  test.skip(isMobile, "hover only; the tap-pinned history is covered below");
  await connect(page);
  await expect(sidebar(page)).toHaveAttribute("data-open", "true", { timeout: 10_000 });
  await settle(page);

  const history = sidebar(page).getByRole("list", { name: "Deposits" });
  await sidebar(page).getByRole("button", { name: /^Balance/ }).hover();
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
  await expect(oldest).toContainText(`+$${MOCK_DEPOSITS.at(-1)!.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
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
  await connect(page);
  await expect(sidebar(page)).toHaveAttribute("data-open", "true", { timeout: 10_000 });
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

  const rows = sidebar(page).getByRole("list", { name: "Open positions" }).getByRole("listitem");
  await expect(rows).toHaveCount(POSITIONS);
  const scroller = await rows.first().evaluate((row) => {
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
  await expect(position(page, "BTC")).toBeAttached();
  await position(page, "BTC").scrollIntoViewIfNeeded();
  await expect(position(page, "BTC")).toBeInViewport();
  await shoot(page, "8-many-positions");
});

test("scrollable lists blur only the edges that hide more content", async ({ page, isMobile }) => {
  test.skip(isMobile, "hover and wheel");
  await connect(page);
  await expect(sidebar(page)).toHaveAttribute("data-open", "true", { timeout: 10_000 });
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
  await sidebar(page).getByRole("button", { name: /^Balance/ }).hover();
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
  await connect(page);
  await expect(sidebar(page)).toHaveAttribute("data-open", "true", { timeout: 10_000 });
  await sidebar(page).getByRole("button", { name: /^Balance/ }).hover();

  const rows = sidebar(page).getByRole("list", { name: "Deposits" }).getByRole("listitem");
  await expect(rows).toHaveCount(DEPOSITS);
  for (const shadow of await rows.evaluateAll((els) => els.map((el) => getComputedStyle(el).boxShadow))) {
    // e.g. "rgba(0, 0, 0, 0.2) 0px 4px 10px -6px"
    const [, alpha, blur] = shadow.match(/rgba\(0, 0, 0, ([\d.]+)\) -?[\d.]+px -?[\d.]+px ([\d.]+)px/) ?? [];
    expect(Number(alpha), `shadow "${shadow}" is light`).toBeLessThanOrEqual(0.25);
    expect(Number(blur), `shadow "${shadow}" is tight`).toBeLessThanOrEqual(12);
  }
});

test("depositing adds to the history and the balance", async ({ page, isMobile }) => {
  test.skip(isMobile, "hover flow");
  await connect(page);
  await expect(sidebar(page)).toHaveAttribute("data-open", "true", { timeout: 10_000 });

  const deposit = sidebar(page).getByRole("button", { name: "Deposit", exact: true });
  await deposit.hover();
  await deposit.click();
  const rows = sidebar(page).getByRole("list", { name: "Deposits" }).getByRole("listitem");
  await expect(rows).toHaveCount(DEPOSITS + 1);
  await expect(rows.first()).toContainText("+$500.00");
  await expect(rows.first()).toContainText("today");
  await expect(sidebar(page).getByText("$12,980")).toBeVisible();
});

test("hovering a position reveals a close button in the PnL's color", async ({ page, isMobile }) => {
  test.skip(isMobile, "hover only");
  await connect(page);
  await expect(sidebar(page)).toHaveAttribute("data-open", "true", { timeout: 10_000 });
  await settle(page);

  const rows = sidebar(page).getByRole("list", { name: "Open positions" }).getByRole("listitem");
  await expect(rows).toHaveCount(POSITIONS);

  // Bottom to top: the first position sits lowest.
  const tops = await rows.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
  expect(tops).toEqual([...tops].sort((a, b) => b - a));

  // No labels: each row is a logo, a size and a PnL.
  await expect(position(page, "BTC")).toContainText("$4,200");
  await expect(position(page, "BTC")).toContainText("+$312.40");
  await expect(position(page, "BTC")).not.toContainText(/size|pnl|cost/i);

  for (const [symbol, color] of [
    ["BTC", GAIN],
    ["ETH", LOSS],
    ["SOL", FLAT],
  ] as const) {
    const row = position(page, symbol);
    const close = row.getByRole("button", { name: `Close ${symbol} position` });
    await expect.poll(() => close.evaluate((el) => el.parentElement!.getBoundingClientRect().width)).toBe(0);

    await row.hover();
    await expect.poll(() => close.evaluate((el) => el.parentElement!.getBoundingClientRect().width)).toBeGreaterThan(50);
    await expect(close).toHaveCSS("color", color);
    await shoot(page, `4-hover-${symbol.toLowerCase()}`);
  }
});

test("closing a position removes it and frees its value", async ({ page, isMobile }) => {
  await connect(page);
  await expect(sidebar(page)).toHaveAttribute("data-open", "true", { timeout: 10_000 });
  await settle(page);

  const row = position(page, "ETH");
  if (isMobile) await row.tap();
  else await row.hover();
  await row.getByRole("button", { name: "Close ETH position" }).click();

  await expect(position(page, "ETH")).toHaveCount(0);
  await expect(sidebar(page).getByRole("list", { name: "Open positions" }).getByRole("listitem")).toHaveCount(POSITIONS - 1);
  // 12,480.52 + 2,850 − 96.12
  await expect(sidebar(page).getByText("$15,234")).toBeVisible();
  await shoot(page, "5-after-close");
});

test("the close button is reachable by keyboard", async ({ page, isMobile }) => {
  test.skip(isMobile, "keyboard flow is a desktop concern");
  await connect(page);
  await expect(sidebar(page)).toHaveAttribute("data-open", "true", { timeout: 10_000 });

  // The first position's close button follows the deposit button in tab order.
  const close = position(page, "BTC").getByRole("button", { name: "Close BTC position" });
  await sidebar(page).getByRole("button", { name: "Deposit", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await expect.poll(() => close.evaluate((el) => el.parentElement!.getBoundingClientRect().width)).toBeGreaterThan(50);
  await page.keyboard.press("Enter");
  await expect(position(page, "BTC")).toHaveCount(0);
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
  await connect(page);
  await expect(sidebar(page)).toHaveAttribute("data-open", "true", { timeout: 10_000 });
  await settle(page);

  await sidebar(page).getByRole("button", { name: /^Balance/ }).tap();
  await expect(sidebar(page).getByRole("list", { name: "Deposits" }).getByRole("listitem")).toHaveCount(DEPOSITS);
  await shoot(page, "3-deposits");
  await sidebar(page).getByRole("button", { name: /^Balance/ }).tap();
  await expect(sidebar(page).getByRole("list", { name: "Deposits" })).toHaveCount(0);

  await position(page, "BTC").tap();
  await expect(position(page, "BTC").getByRole("button", { name: "Close BTC position" })).toHaveCSS("color", GAIN);
  await shoot(page, "4-tap-btc");
});
