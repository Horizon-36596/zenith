/**
 * Issue #315: an undo or redo never leaves the selection naming a step or waypoint the documents no
 * longer have. Undoing an Add path click clears the selection on the path it removed, so the arrow
 * keys and Delete then change nothing, and undoing a rename of the selected waypoint takes the
 * selection back to the old name, and redo takes it on to the new one.
 */
import { expect, test, type Page } from "@playwright/test";
import { editor, loadExample, skipTour, worldToScreen } from "./qa/helpers";

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
});

const autoText = (page: Page): Promise<string> => editor<string>(page, "JSON.stringify(s.auto)");
const stepIds = (page: Page): Promise<string[]> => editor<string[]>(page, "s.auto.steps.map((x) => x.id)");
const waypointNames = (page: Page): Promise<string[]> =>
  editor<string[]>(page, "Object.keys(s.project.waypoints.waypoints)");

async function press(page: Page, key: string): Promise<void> {
  await page.getByTestId("field-canvas").focus();
  await page.keyboard.press(key);
}

test("undoing an Add path click clears the selection on the path it removed", async ({ page }) => {
  await editor(page, "m.setSelection({})");
  await press(page, "p");
  await expect.poll(() => editor<string>(page, "s.tool")).toBe("addPath");

  const at = await worldToScreen(page, 30, -30);
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => editor<string | undefined>(page, "s.selection.stepId")).toBe("path1");
  const depthAfterAdd = await editor<number>(page, "s.undo.length");

  await press(page, "Control+z");
  await expect.poll(() => stepIds(page)).not.toContain("path1");
  expect(await editor(page, "s.selection")).toEqual({});

  // With nothing selected, the selection keys change nothing and write no undo step.
  const afterUndo = await autoText(page);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("r");
  await page.keyboard.press("Delete");
  expect(await autoText(page)).toBe(afterUndo);
  expect(await editor<number>(page, "s.undo.length")).toBe(depthAfterAdd - 1);
});

test("undoing a rename of the selected waypoint takes the selection back to the old name", async ({ page }) => {
  if (!(await page.getByTestId("inspector-waypoints").isVisible())) {
    await page.getByRole("button", { name: /^Waypoints \(\d+\)$/ }).click();
  }
  const others = page.getByTestId("inspector-waypoints-others");
  const row = page.getByTestId("inspector-waypoint-row-scoreSouth");
  if (!(await row.isVisible()) && (await others.count()) > 0 && (await others.getAttribute("aria-expanded")) === "false") {
    await others.click();
  }
  await row.click();
  await expect.poll(() => editor(page, "s.selection")).toEqual({ waypoint: "scoreSouth" });
  await page.getByTestId("inspector-waypoint-more-scoreSouth").click();
  await page.getByTestId("inspector-waypoint-menu").locator('[data-action="waypoint.rename"]').click();
  await page.getByTestId("waypoint-dialog-name").fill("southSpot");
  await page.getByTestId("waypoint-dialog-confirm").click();
  await expect(page.getByTestId("waypoint-dialog")).toHaveCount(0);
  expect(await editor(page, "s.selection")).toEqual({ waypoint: "southSpot" });

  await press(page, "Control+z");
  await expect.poll(() => waypointNames(page)).toContain("scoreSouth");
  expect(await waypointNames(page)).not.toContain("southSpot");
  expect(await editor(page, "s.selection")).toEqual({ waypoint: "scoreSouth" });
  await expect(page.locator("body")).not.toContainText("has no waypoint named");

  await press(page, "Control+y");
  await expect.poll(() => waypointNames(page)).toContain("southSpot");
  expect(await editor(page, "s.selection")).toEqual({ waypoint: "southSpot" });
  await expect(page.locator("body")).not.toContainText("has no waypoint named");
});
