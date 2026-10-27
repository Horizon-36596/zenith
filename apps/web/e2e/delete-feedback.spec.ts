/**
 * Every delete says what went and how to get it back, and undo selects the step again (issue #183).
 * The example's `toGarden` is a path in the middle of the list, so deleting it leaves neighbours.
 */
import { expect, test } from "@playwright/test";
import { editor, skipTour } from "./qa/helpers";

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await page.goto("/?cloud=fake");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-toGarden")).toBeVisible();
});

test("Delete says what went, and Ctrl+Z puts the step back and selects it", async ({ page }) => {
  await page.getByTestId("step-main-toGarden").click();
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await page.keyboard.press("Delete");

  await expect(page.getByTestId("step-row-toGarden")).toHaveCount(0);
  await expect(page.getByTestId("status")).toContainText("Deleted toGarden. Ctrl+Z puts it back.");
  // The row after it takes the selection, so a second Delete keeps going (issue #411).
  expect(await editor<string | undefined>(page, `s.selection.stepId`)).toBe("sweepGarden");

  await page.keyboard.press("Control+z");
  await expect(page.getByTestId("step-row-toGarden")).toBeVisible();
  expect(await editor<string | undefined>(page, `s.selection.stepId`)).toBe("toGarden");
});

test("the header trash says the same", async ({ page }) => {
  await page.getByTestId("step-main-toGarden").click();
  await page.getByTestId("delete-step").click();
  await expect(page.getByTestId("status")).toContainText("Deleted toGarden. Ctrl+Z puts it back.");
});
