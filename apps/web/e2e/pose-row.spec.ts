/**
 * Issues #240 and #431: a pose is one row on the Inspector's grid, with a short provenance chip
 * under its numbers at the value column (UI_GUIDE 9.5).
 *
 * - A curve's control points, behind Controls, take one row each: toOtherSide's three cost three
 *   rows, not nine.
 * - Every pose row's label is at least 72 px wide and uncut, at the default 320 px panel and at the
 *   240 px minimum, and the chip never squeezes it.
 * - The chip is short ("Needs meas."), its tooltip gives the full label, and a click opens the picker.
 * - The selected waypoint's row in the Waypoints list (issue #245) stays one line at both widths,
 *   and its Used by row is one line too.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { LAYOUT_SIZES } from "./viewports";
import { editor, loadExample, openAutoNamed, selectStep, skipTour, waitForFonts } from "./qa/helpers";

/** Opens toOtherSide's Controls, which start folded (issue #431). */
async function openControls(page: Page): Promise<void> {
  const head = page.getByTestId("inspector-controls-0");
  if ((await head.getAttribute("aria-expanded")) === "false") await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");
}

/** Opens the example with the right panel at the given width. */
async function openAt(page: Page, panelRightW: number): Promise<void> {
  await skipTour(page, { panelRightW });
  await loadExample(page);
  await openAutoNamed(page, "collect-and-score.auto.json");
  await waitForFonts(page);
}

/** The element's box, failing the test when it has none, so no check passes on a missing box. */
async function boxOf(locator: Locator, name: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  expect(box, `${name} has a box`).not.toBeNull();
  if (box === null) throw new Error(`${name} has no box`);
  return box;
}

/** The vertical middle of a box. */
const middle = (box: { y: number; height: number }): number => box.y + box.height / 2;

const poseRows = (page: Page): Locator => page.getByTestId("inspector").locator("[data-pose-row]");

/** Every pose row's label: at least 72 px wide, and not cut by its box. */
async function expectLabelsRoomy(page: Page): Promise<void> {
  const labels = page.getByTestId("inspector").locator("[data-pose-label]");
  const count = await labels.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i += 1) {
    const label = labels.nth(i);
    const box = await label.boundingBox();
    expect(box, `label ${String(i)} has a box`).not.toBeNull();
    expect(box?.width ?? 0, `label ${String(i)} is at least 72 px`).toBeGreaterThanOrEqual(71.5);
    const cut = await label.evaluate((node) => node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1);
    expect(cut, `label ${String(i)} is not cut`).toBe(false);
  }
}

/** Every general field row's label keeps its 72 px floor (fields.module.css .label). */
async function expectFieldLabelsRoomy(page: Page): Promise<void> {
  const labels = page.getByTestId("inspector").locator("[data-field-label]");
  const count = await labels.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i += 1) {
    const label = labels.nth(i);
    if (!(await label.isVisible())) continue;
    const box = await boxOf(label, `field label ${String(i)}`);
    expect(box.width, `field label ${String(i)} (${await label.innerText()}) is at least 72 px`).toBeGreaterThanOrEqual(71.5);
  }
}

for (const panelRightW of [320, 240]) {
  test(`field row labels keep 72 px at a ${String(panelRightW)} px panel`, async ({ page }) => {
    await openAt(page, panelRightW);
    await selectStep(page, "toOtherSide");
    await openControls(page);
    await expect(page.getByTestId("inspector-control-row-2")).toBeVisible();
    await expectFieldLabelsRoomy(page);

    // A selected waypoint is one compact list row with no labels (issue #245), so the second view
    // that still draws field rows is the start's own, with its Pose, Position and Heading rows.
    await editor(page, `m.setSelection({ start: true })`);
    await expect(page.getByTestId("inspector-start-source")).toBeVisible();
    await page.getByTestId("inspector-start-source").selectOption("pose");
    await expect(page.getByTestId("inspector-start-x")).toBeVisible();
    await expect(page.getByTestId("inspector-start-h")).toBeVisible();
    await expectFieldLabelsRoomy(page);
    await expectLabelsRoomy(page);
  });

  test(`pose labels keep 72 px and are uncut at a ${String(panelRightW)} px panel`, async ({ page }) => {
    await openAt(page, panelRightW);
    await selectStep(page, "toOtherSide");
    await openControls(page);
    await expect(page.getByTestId("inspector-control-row-2")).toBeVisible();
    await expectLabelsRoomy(page);

    await editor(page, `m.setSelection({ waypoint: "scoreSouth" })`);
    await expect(page.getByTestId("inspector-waypoint-x")).toBeVisible();
    // The waypoint's numbers sit in its list row, which stays one line even at the minimum width.
    const line = await page.getByTestId("inspector-waypoint-line-scoreSouth").boundingBox();
    expect(line?.height ?? 99).toBeLessThanOrEqual(26);
    const x = await page.getByTestId("inspector-waypoint-x").boundingBox();
    const h = await page.getByTestId("inspector-waypoint-h").boundingBox();
    expect(Math.abs((x?.y ?? 0) - (h?.y ?? 99))).toBeLessThan(2);
  });
}

test("toOtherSide's three control points take one row each", async ({ page }) => {
  await openAt(page, 320);
  await selectStep(page, "toOtherSide");
  await openControls(page);
  const controls = page.getByTestId("inspector").locator('[data-testid^="inspector-control-row-"]');
  await expect(controls).toHaveCount(3);
  // One row: the label, both numbers and the unit share a line.
  for (let i = 0; i < 3; i += 1) {
    const row = page.getByTestId(`inspector-control-row-${String(i)}`);
    const rowBox = await row.boundingBox();
    const xBox = await page.getByTestId(`inspector-control-x-0-${String(i)}`).boundingBox();
    const yBox = await page.getByTestId(`inspector-control-y-0-${String(i)}`).boundingBox();
    expect(rowBox && xBox && yBox).toBeTruthy();
    if (rowBox === null || xBox === null || yBox === null) continue;
    expect(Math.abs(xBox.y - yBox.y)).toBeLessThan(2);
    expect(xBox.x + xBox.width).toBeLessThanOrEqual(yBox.x + 1);
    expect(rowBox.height).toBeLessThan(80);
    // A control point that is not selected has no chip, so its row is one 28 px line.
    expect(rowBox.height).toBeLessThanOrEqual(28.5);
  }
});

test("the chip sits under the numbers at the value column, at the default panel and at the minimum", async ({ page }) => {
  await openAt(page, 320);
  await selectStep(page, "toOtherSide");
  // A control point shows its chip only while it is the selected point (issue #409), which opens
  // Controls for now (issue #431).
  await editor(page, `m.setSelection({ stepId: "toOtherSide", point: { segmentIndex: 0, pointKind: "control", controlIndex: 0 } })`);
  const chip = page.getByTestId("inspector-control-provenance-0-0");
  const x = page.getByTestId("inspector-control-x-0-0");
  const under = async (name: string): Promise<void> => {
    const chipBox = await boxOf(chip, name);
    const xBox = await boxOf(x, "x");
    // On the line under the numbers, its left edge on the value column with x's.
    expect(chipBox.y, name).toBeGreaterThan(xBox.y + xBox.height - 4);
    expect(Math.abs(chipBox.x - xBox.x), name).toBeLessThan(4);
    expect(middle(chipBox) - middle(xBox), name).toBeLessThan(30);
  };
  await under("chip");
  await expect(chip).toHaveText(/^.{1,12}$/);

  // The longest short labels, 12 characters, sit there too.
  await chip.click();
  await page.getByTestId("inspector-control-provenance-0-0-menu").getByRole("menuitemradio", { name: "Calibrated from robot" }).click();
  await expect(chip).toHaveText("Calib. robot");
  await under("long chip");
  await page.keyboard.press("Control+z");
  await expect(chip).toHaveText("Placeholder");

  await editor(page, `m.setPrefs({ panelRightW: 240 })`);
  await expect.poll(async () => (await page.getByTestId("inspector").boundingBox())?.width ?? 0).toBeLessThan(260);
  await under("narrow chip");
  await expectLabelsRoomy(page);
});

test("the short chip opens the picker on a click and names the full label on hover", async ({ page }) => {
  await openAt(page, 320);
  await selectStep(page, "toOtherSide");
  await editor(page, `m.setSelection({ stepId: "toOtherSide", point: { segmentIndex: 0, pointKind: "control", controlIndex: 0 } })`);
  await expect(poseRows(page).first()).toBeVisible();
  const chip = page.getByTestId("inspector-control-provenance-0-0");
  await expect(chip).toHaveText("Placeholder");

  await chip.hover();
  await expect(page.locator('[role="tooltip"]')).toContainText("Placeholder: starter example");
  await expect(page.locator('[role="tooltip"]')).toContainText("A stand-in so the file works.");

  await chip.click();
  await expect(page.getByTestId("inspector-control-provenance-0-0-menu")).toBeVisible();
  await page.getByTestId("inspector-control-provenance-0-0-menu").getByRole("menuitemradio", { name: "Approx" }).click();
  await expect(chip).toHaveText("Approx");
  await page.keyboard.press("Control+z");
  await expect(chip).toHaveText("Placeholder");
});

for (const size of LAYOUT_SIZES) {
  test(`the selected waypoint's Used by row is one line under its chip at ${String(size.width)}x${String(size.height)}`, async ({ page }) => {
    await page.setViewportSize(size);
    await skipTour(page);
    await loadExample(page);
    await openAutoNamed(page, "collect-and-score.auto.json");
    await waitForFonts(page);
    await editor(page, `m.setSelection({ waypoint: "scoreSouth" })`);
    const others = page.getByTestId("inspector-waypoint-others");
    await expect(others).toBeVisible();
    await expect(others).not.toHaveText("checking…");
    const used = await page.getByTestId("inspector-waypoint-used-by").boundingBox();
    const chip = await page.getByTestId("inspector-waypoint-provenance").boundingBox();
    const inspector = await page.getByTestId("inspector").boundingBox();
    expect(used && chip && inspector).toBeTruthy();
    if (used === null || chip === null || inspector === null) return;
    expect(used.height).toBeLessThanOrEqual(26);
    expect(used.y).toBeGreaterThanOrEqual(chip.y + chip.height - 1);
    expect(used.x + used.width).toBeLessThanOrEqual(inspector.x + inspector.width + 0.5);
    await expect(page.getByTestId("inspector-waypoint-followers")).toHaveText("point 1 of driveOut");
    await expect(others).toHaveText("3 other autos");
  });
}
