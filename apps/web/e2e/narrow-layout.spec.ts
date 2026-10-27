/**
 * The editor below desktop width (UI_GUIDE layout rule 9, issue #508). Below 640 px the steps column
 * and the Inspector took fixed widths and left the field 0 px, with the Inspector cut at the right
 * edge and nothing on screen saying why. Now the Inspector, below 820 px, and the steps column, below
 * 640 px, open one at a time as sheets over the field from a panel bar that says a wider window shows
 * every panel. At 900 px the Problems header drops a zero count rather than running it under its icon,
 * and the timeline's level switch stays inside its column. Each size is named in the test's title.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { fixture, loadExample, openProjectWith, selectStep, skipTour } from "./qa/helpers";

/** The element's box, which must be drawn. */
async function boxOf(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  expect(box, "the element is drawn").not.toBeNull();
  return box ?? { x: 0, y: 0, width: 0, height: 0 };
}

/** The element lies inside the window's width. */
async function insideWindow(page: Page, locator: Locator): Promise<void> {
  const box = await boxOf(locator);
  const width = page.viewportSize()?.width ?? 0;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
}

const field = (page: Page): Locator => page.locator('[data-region][aria-label="Field canvas"]');

test("at 390x844 the field takes the width and the panels open one at a time from the panel bar", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await skipTour(page);
  // The step rows are in the closed steps sheet, so loadExample's own check would not see them.
  await page.goto("/");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("toolbar-auto-name")).toContainText("collect-and-score");
  await expect(page.getByTestId("panel-bar")).toBeVisible();
  await expect(page.getByTestId("panel-bar-note")).toHaveText("A wider window shows every panel.");
  expect((await boxOf(field(page))).width).toBeGreaterThanOrEqual(380);
  await expect(page.getByTestId("inspector-panel")).toBeHidden();
  await expect(page.getByTestId("step-row-driveOut")).toBeHidden();
  await expect(page.getByTestId("panel-switch-field")).toHaveAttribute("aria-pressed", "true");
  // The status bar starts at the window's left edge, not beside a steps column that is not there.
  await expect(page.getByTestId("status")).toBeVisible();
  expect((await boxOf(page.getByTestId("status"))).x).toBe(0);

  await page.getByTestId("panel-switch-steps").click();
  await expect(page.getByTestId("panel-switch-steps")).toHaveAttribute("aria-pressed", "true");
  await insideWindow(page, page.getByTestId("step-row-driveOut"));
  await insideWindow(page, page.getByTestId("playback-level"));
  await selectStep(page, "driveOut");

  // One sheet at a time: the Inspector takes the steps sheet's place.
  await page.getByTestId("panel-switch-inspector").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeHidden();
  await insideWindow(page, page.getByTestId("inspector-panel"));
  await expect(page.getByTestId("inspector-panel")).toContainText("driveOut");

  // A second press on the open sheet's segment closes it, as Field does.
  await page.getByTestId("panel-switch-inspector").click();
  await expect(page.getByTestId("inspector-panel")).toBeHidden();
  await expect(page.getByTestId("panel-switch-field")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("panel-switch-steps").click();
  await page.getByTestId("panel-switch-field").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeHidden();
});

test("at 700x900 the steps stay in the row and the Inspector is a sheet", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await skipTour(page);
  await loadExample(page);
  await expect(page.getByTestId("panel-switch-steps")).toBeHidden();
  await expect(page.getByTestId("inspector-panel")).toBeHidden();
  expect((await boxOf(field(page))).width).toBeGreaterThanOrEqual(400);
  await selectStep(page, "driveOut");
  await page.getByTestId("panel-switch-inspector").click();
  await insideWindow(page, page.getByTestId("inspector-panel"));
  // The sheet lies over the field and leaves the steps where they were.
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
});

test("at 900x700 every panel is in the row, and the timeline and Problems headers fit their columns", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await skipTour(page);
  await loadExample(page);
  await expect(page.getByTestId("panel-bar")).toBeHidden();
  await expect(page.getByTestId("inspector-panel")).toBeVisible();
  expect((await boxOf(field(page))).width).toBeGreaterThanOrEqual(360);

  // The timeline's switch and ? end inside the steps column (the Full level was cut at its edge).
  const column = await boxOf(page.locator('aside[aria-label="Steps and ledger"]'));
  const help = await boxOf(page.getByTestId("help-timeline"));
  expect(help.x + help.width).toBeLessThanOrEqual(column.x + column.width);
  const full = await boxOf(page.getByTestId("playback-level-full"));
  expect(full.x + full.width).toBeLessThanOrEqual(column.x + column.width);

  // The Problems header drops its zero warnings and info counts, keeps the error count, and nothing
  // in it runs past its end.
  const head = page.getByTestId("findings-head");
  await expect(page.getByTestId("findings-count-error")).toBeVisible();
  await expect(page.getByTestId("findings-count-info")).toBeHidden();
  await expect(page.getByTestId("findings-count-warning")).toBeHidden();
  const overflow = await head.evaluate((node) => node.scrollWidth - node.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("at 1280x720 there is no panel bar and the Problems header shows every count", async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
  await expect(page.getByTestId("panel-bar")).toBeHidden();
  await expect(page.getByTestId("findings-count-info")).toBeVisible();
  await expect(page.getByTestId("timeline-budget")).toBeVisible();
});

test("a four-digit total leaves the timeline's level switch and ? where a short one does", async ({ browser }) => {
  // Two windows, each opening a project.
  test.setTimeout(120_000);
  const curves = fixture("qa-curves.auto.json");
  const far = curves.replace('"to": { "xIn": 36, "yIn": 12', '"to": { "xIn": 99999, "yIn": 12');
  expect(far).not.toBe(curves);

  /** Opens the auto in a fresh window and reads the total and where the switch and ? are drawn. */
  const measure = async (auto: string): Promise<{ total: string; switchX: number; helpX: number }> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    await skipTour(page);
    await openProjectWith(page, { "qa-curves.auto.json": auto });
    await expect(page.getByTestId("timeline-total")).not.toHaveText("—");
    const result = {
      total: await page.getByTestId("timeline-total").innerText(),
      switchX: (await boxOf(page.getByTestId("playback-level"))).x,
      helpX: (await boxOf(page.getByTestId("help-timeline"))).x,
    };
    await context.close();
    return result;
  };

  const short = await measure(curves);
  const long = await measure(far);
  expect(long.total.replace(/\D/g, "").length).toBeGreaterThan(short.total.replace(/\D/g, "").length);
  expect(long.switchX).toBeCloseTo(short.switchX, 0);
  expect(long.helpX).toBeCloseTo(short.helpX, 0);
});
