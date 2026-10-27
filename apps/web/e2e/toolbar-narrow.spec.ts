/**
 * The toolbar and the start screen in a narrow window (0.1.2 UX sweep, W1-2). At 700 px the tool
 * groups ran past the right edge and took Settings and Help with them, and the start screen squeezed
 * into a 200 px column. Now the groups that do not fit go into a More menu, the right cluster stays
 * on screen down to 640 px, and with nothing open the empty inspector gives its room to the start
 * screen. Each size is named in the test's title.
 */
import { expect, test, type Page } from "@playwright/test";
import { loadExample, skipTour } from "./qa/helpers";

const SIZES = [
  { width: 640, height: 800 },
  { width: 700, height: 900 },
  { width: 900, height: 700 },
  { width: 1280, height: 720 },
] as const;

/** The right edge of an element against the window's width. */
async function insideWindow(page: Page, testId: string, width: number): Promise<void> {
  const box = await page.getByTestId(testId).boundingBox();
  expect(box, `${testId} is drawn`).not.toBeNull();
  expect(box?.x ?? -1, `${testId} starts on screen`).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0), `${testId} ends on screen`).toBeLessThanOrEqual(width);
}

for (const size of SIZES) {
  test(`at ${String(size.width)}x${String(size.height)} Search, Settings and Help stay on screen`, async ({ page }) => {
    await page.setViewportSize(size);
    await skipTour(page);
    await page.goto("/");
    await loadExample(page);
    for (const id of ["toolbar-search", "toolbar-settings", "toolbar-help"]) await insideWindow(page, id, size.width);
    // Nothing the toolbar draws runs past the right edge.
    const overflow = await page.getByTestId("toolbar").evaluate((bar) => bar.scrollWidth - bar.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    await page.getByTestId("toolbar-help").click();
    await expect(page.getByTestId("help-menu")).toBeVisible();
    await page.keyboard.press("Escape");

    if (size.width >= 1280) {
      await expect(page.getByTestId("toolbar-more")).toHaveCount(0);
      await expect(page.getByTestId("toolbar-view.alliance")).toBeVisible();
    }
  });
}

test("at 700x900 the tool groups that do not fit are in the More menu, and they run from there", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await skipTour(page);
  await page.goto("/");
  await loadExample(page);
  await expect(page.getByTestId("toolbar-more")).toBeVisible();
  await expect(page.getByTestId("toolbar-tool.select")).toBeVisible();
  await expect(page.getByTestId("toolbar-view.alliance")).toHaveCount(0);

  await page.getByTestId("toolbar-more").click();
  const menu = page.getByTestId("toolbar-more-menu");
  await expect(menu).toBeVisible();
  // A button that shows a state keeps it in the menu: the mirror is a checkbox item, off until pressed.
  const mirror = menu.getByTestId("menu-view.alliance");
  await expect(mirror).toHaveAttribute("role", "menuitemcheckbox");
  await expect(mirror).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("alliance-pill")).toHaveText("RED");
  await mirror.click();
  await expect(page.getByTestId("alliance-pill")).toHaveText("BLUE");
  await page.getByTestId("toolbar-more").click();
  await expect(menu.getByTestId("menu-view.alliance")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");

  // Widening the window brings the groups back out of the menu.
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByTestId("toolbar-view.alliance")).toBeVisible();
  await expect(page.getByTestId("toolbar-more")).toHaveCount(0);
});

test("at 700x900 a tour stop on a button in the More menu rings the More button", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await skipTour(page);
  await page.goto("/");
  await loadExample(page);
  await expect(page.getByTestId("toolbar-view.alliance")).toHaveCount(0);
  await page.evaluate(() => import("/src/tour/store.ts").then((tour) => tour.startFullTour("view.alliance")));
  await expect(page.getByTestId("tour-title")).toHaveText("The other alliance");
  const more = await page.getByTestId("toolbar-more").boundingBox();
  const ring = page.getByTestId("tour-ring");
  await expect(ring).toBeVisible();
  const box = await ring.boundingBox();
  if (more === null || box === null) throw new Error("More or the ring is not drawn");
  expect(box.x).toBeLessThanOrEqual(more.x);
  expect(box.x + box.width).toBeGreaterThanOrEqual(more.x + more.width);
  expect(box.width).toBeLessThan(more.width + 24);
});

test("at 700x900 the start screen takes the empty inspector's room", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await skipTour(page);
  await page.goto("/");
  const welcome = page.getByTestId("canvas-empty");
  await expect(welcome).toBeVisible();
  const box = await welcome.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(400);
  await expect(page.getByTestId("inspector-panel")).toBeHidden();
  // F6 skips the hidden inspector: every press lands in a region that is drawn.
  for (let i = 0; i < 5; i += 1) {
    await page.keyboard.press("F6");
    const drawn = await page.evaluate(() => {
      const region = document.activeElement?.closest("[data-region]");
      return region !== null && region !== undefined && region.getClientRects().length > 0;
    });
    expect(drawn, `F6 press ${String(i + 1)} lands in a drawn region`).toBe(true);
  }
  // Opening the example brings the panel bar, and the inspector opens from it as a sheet (layout rule 9).
  await welcome.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("panel-bar")).toBeVisible();
  await expect(page.getByTestId("inspector-panel")).toBeHidden();
  await page.getByTestId("panel-switch-inspector").click();
  await expect(page.getByTestId("inspector-panel")).toBeVisible();
});
