import { expect, test, type Page } from "@playwright/test";

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const pill = (page: Page, name: string) =>
  heading(page).getByRole("button", { name, exact: true });
const picker = (page: Page) =>
  page.getByRole("dialog", { name: "Build interfaces with" });

/** Waits until an element's center sits on the viewport center. */
async function expectCentered(page: Page, selector: string) {
  await expect(async () => {
    const offset = await page.evaluate((selector) => {
      const box = document.querySelector(selector)!.getBoundingClientRect();
      return {
        x: Math.abs(box.left + box.width / 2 - innerWidth / 2),
        y: Math.abs(box.top + box.height / 2 - innerHeight / 2),
      };
    }, selector);
    expect(offset.x).toBeLessThanOrEqual(2);
    expect(offset.y).toBeLessThanOrEqual(2);
  }).toPass({ timeout: 3_000 });
}

/** Lets springs settle before a screenshot. */
const settle = (page: Page) => page.waitForTimeout(900);

async function shoot(page: Page, name: string) {
  await settle(page);
  await page.screenshot({
    path: `e2e/screenshots/${test.info().project.name}-${name}.png`,
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
});

test("renders only the centered heading", async ({ page }) => {
  await expect(page.getByText("Graphical")).toHaveCount(0);
  await expect(page.getByText("Login")).toHaveCount(0);
  await expect(heading(page).getByRole("button")).toHaveCount(3);
  for (const name of ["languages", "type", "Cursor"]) {
    await expect(pill(page, name)).toBeVisible();
  }
  await expectCentered(page, "h1");
  await shoot(page, "1-initial");
});

test("cycling pills change their text and icon on each click", async ({ page }) => {
  const first = heading(page).getByRole("button").first();
  const icon = () => first.locator("[data-option] svg").last().innerHTML();

  const before = await icon();
  await first.click();
  await expect(first).toHaveAccessibleName("systems");
  await expect.poll(icon).not.toBe(before);

  await first.click();
  await expect(first).toHaveAccessibleName("identities");
  await first.click();
  await expect(first).toHaveAccessibleName("languages");

  await pill(page, "type").click();
  await expect(heading(page).getByRole("button").nth(1)).toHaveAccessibleName("color");
});

test("picker pill opens a centered picker without a backdrop", async ({ page }) => {
  const opener = pill(page, "Cursor");
  await expect(opener).toHaveAttribute("aria-haspopup", "dialog");
  await expect(opener).toHaveAttribute("aria-expanded", "false");

  await opener.click();
  await expect(picker(page)).toBeVisible();
  await expect(opener).toHaveAttribute("aria-expanded", "true");
  // Opening alone never changes the label.
  await expect(opener).toHaveAccessibleName("Cursor");

  await expectCentered(page, '[role="dialog"]');

  const overlay = await page.evaluate(() => {
    const style = getComputedStyle(document.querySelector('[role="dialog"]')!.parentElement!);
    return { background: style.backgroundColor, blur: style.backdropFilter };
  });
  expect(overlay).toEqual({ background: "rgba(0, 0, 0, 0)", blur: "none" });

  const options = picker(page).getByRole("option");
  await expect(options).toHaveText(["Cursor", "Code", "Agents", "Prompts", "Sketches"]);
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await expect(options.first()).toBeFocused();

  for (const fontSize of await options.evaluateAll((els) =>
    els.map((el) => parseFloat(getComputedStyle(el).fontSize)),
  )) {
    expect(fontSize).toBeGreaterThanOrEqual(24);
  }

  await shoot(page, "2-picker-open");
});

test("Escape and outside clicks close the picker without changing the label", async ({ page }) => {
  const opener = pill(page, "Cursor");

  await opener.click();
  await expect(picker(page)).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(picker(page)).toBeHidden();
  await expect(opener).toHaveAccessibleName("Cursor");
  await expect(opener).toBeFocused();

  await opener.click();
  await expect(picker(page)).toBeVisible();
  await page.mouse.click(8, 8);
  await expect(picker(page)).toBeHidden();
  await expect(opener).toHaveAccessibleName("Cursor");
  await expect(opener).toHaveAttribute("aria-expanded", "false");
});

test("choosing an item updates the pill", async ({ page, isMobile }) => {
  await pill(page, "Cursor").click();
  const agents = picker(page).getByRole("option", { name: "Agents" });
  if (!isMobile) {
    await agents.hover();
    await shoot(page, "3-picker-hover");
  }
  await agents.click();

  await expect(picker(page)).toBeHidden();
  const opener = pill(page, "Agents");
  await expect(opener).toBeVisible();
  await expect(opener).toHaveAttribute("aria-expanded", "false");
  await shoot(page, "4-after-choosing");

  await opener.click();
  await expect(picker(page).getByRole("option", { name: "Agents" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(picker(page).getByRole("option", { name: "Cursor" })).toHaveAttribute(
    "aria-selected",
    "false",
  );
});

test("the picker is fully keyboard operable", async ({ page, isMobile }) => {
  test.skip(isMobile, "keyboard flow is a desktop concern");

  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(pill(page, "Cursor")).toBeFocused();
  await page.keyboard.press("Enter");

  const option = (name: string) => picker(page).getByRole("option", { name });
  await expect(option("Cursor")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(option("Agents")).toBeFocused();
  await page.keyboard.press("End");
  await expect(option("Sketches")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(option("Cursor")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(option("Sketches")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(option("Sketches")).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(picker(page)).toBeHidden();
  await expect(pill(page, "Sketches")).toBeFocused();
});

test("picker and pills move on springs", async ({ page, isMobile }) => {
  // Sample the panel's scale every frame while it opens.
  const scales = await page.evaluate(async () => {
    const opener = [...document.querySelectorAll<HTMLButtonElement>("h1 button")].at(-1)!;
    opener.click();
    const samples: number[] = [];
    const start = performance.now();
    while (performance.now() - start < 800) {
      await new Promise(requestAnimationFrame);
      const panel = document.querySelector('[role="dialog"]');
      if (panel) samples.push(new DOMMatrix(getComputedStyle(panel).transform).a);
    }
    return samples;
  });
  expect(Math.max(...scales), "panel overshoots past 1").toBeGreaterThan(1.005);
  expect(scales.at(-1)).toBeCloseTo(1, 2);

  await page.keyboard.press("Escape");
  await expect(picker(page)).toBeHidden();

  // A swap springs the pill width past its target before settling.
  const widths = await page.evaluate(async () => {
    const first = document.querySelector<HTMLButtonElement>("h1 button")!;
    const track = first.firstElementChild!;
    first.click();
    const samples: number[] = [];
    const start = performance.now();
    while (performance.now() - start < 900) {
      await new Promise(requestAnimationFrame);
      samples.push(track.getBoundingClientRect().width);
    }
    return samples;
  });
  const end = widths.at(-1)!;
  expect(end - Math.min(...widths), "width undershoots the narrower target").toBeGreaterThan(0.3);

  if (!isMobile) {
    const cursor = pill(page, "Cursor");
    await cursor.hover();
    await expect
      .poll(() => cursor.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a))
      .toBeCloseTo(1.05, 2);
  }
});

test("taps work on touch screens", async ({ page, isMobile }) => {
  test.skip(!isMobile, "touch only");

  await heading(page).getByRole("button").first().tap();
  await expect(heading(page).getByRole("button").first()).toHaveAccessibleName("systems");

  await pill(page, "Cursor").tap();
  await expect(picker(page)).toBeVisible();
  await expectCentered(page, '[role="dialog"]');
  await shoot(page, "2-picker-open");
  await picker(page).getByRole("option", { name: "Prompts" }).tap();
  await expect(picker(page)).toBeHidden();
  await expect(pill(page, "Prompts")).toBeVisible();
  await shoot(page, "4-after-choosing");
});
