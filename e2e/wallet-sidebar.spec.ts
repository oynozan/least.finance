import { expect, test, type Page } from "@playwright/test";
import { ADDRESS, installWallet, mockPrivy } from "./privy-mock";

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
  await expect(deposits.getByRole("listitem")).toHaveCount(4);
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

test("depositing adds to the history and the balance", async ({ page, isMobile }) => {
  test.skip(isMobile, "hover flow");
  await connect(page);
  await expect(sidebar(page)).toHaveAttribute("data-open", "true", { timeout: 10_000 });

  const deposit = sidebar(page).getByRole("button", { name: "Deposit", exact: true });
  await deposit.hover();
  await deposit.click();
  const rows = sidebar(page).getByRole("list", { name: "Deposits" }).getByRole("listitem");
  await expect(rows).toHaveCount(5);
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
  await expect(rows).toHaveCount(5);

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
  await expect(sidebar(page).getByRole("list", { name: "Open positions" }).getByRole("listitem")).toHaveCount(4);
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
  await expect(sidebar(page).getByRole("list", { name: "Deposits" }).getByRole("listitem")).toHaveCount(4);
  await shoot(page, "3-deposits");
  await sidebar(page).getByRole("button", { name: /^Balance/ }).tap();
  await expect(sidebar(page).getByRole("list", { name: "Deposits" })).toHaveCount(0);

  await position(page, "BTC").tap();
  await expect(position(page, "BTC").getByRole("button", { name: "Close BTC position" })).toHaveCSS("color", GAIN);
  await shoot(page, "4-tap-btc");
});
