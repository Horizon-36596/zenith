/**
 * Duplicating or moving the steps of a deadline group (issue #160). The example's `returnToScore`
 * is a deadline parallel group whose deadline is its path `driveBack`. Duplicating it used to leave
 * the copy naming the original's `driveBack`, a SCHEMA error that stopped the Code tab writing any
 * Java; dragging `driveBack` out of the group left the group naming a step it no longer holds. Now
 * the group's deadline passes to the step left in it, as a switch to deadline picks (issue #144).
 */
import { expect, test, type Page } from "@playwright/test";
import { editor, skipTour, useWideRoute } from "./qa/helpers";

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await page.goto("/?cloud=fake");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-returnToScore")).toBeVisible();
  // The steps below were written against the wide route issue #365 first gave collect-and-score (issue #367).
  await useWideRoute(page);
});

/** The SCHEMA rows the Problems tab lists. */
async function schemaFindings(page: Page): Promise<string[]> {
  await page.getByTestId("bottom-tab-problems").click();
  await expect(page.getByTestId("findings-list")).toBeVisible();
  return page
    .getByTestId("finding-row")
    .filter({ has: page.getByTestId("finding-code").getByText("SCHEMA", { exact: true }) })
    .allInnerTexts();
}

test("Ctrl+D on a deadline group leaves no SCHEMA finding, and the Code tab writes Java", async ({ page }) => {
  await page.getByTestId("step-main-returnToScore").click();
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await page.keyboard.press("Control+d");

  await expect(page.getByTestId("step-row-returnToScoreCopy")).toBeVisible();
  await expect(page.getByTestId("step-row-driveBackCopy")).toBeVisible();
  expect(await editor<string | undefined>(page, `s.auto.steps.find((x) => x.id === "returnToScoreCopy").deadline`)).toBe(
    "driveBackCopy",
  );
  // The inspector's Ends with row names the copy's own drive, not the dash it showed before.
  await expect(page.getByTestId("inspector-panel")).toContainText("returnToScoreCopy");
  await expect(page.getByTestId("inspector-panel").getByRole("combobox", { name: "Ends with" })).toHaveValue("driveBackCopy");

  expect(await schemaFindings(page)).toEqual([]);

  // The copy drives driveBack a second time from the scoring spot, a route drawn to start at the
  // garden, so it runs into the hive frame and the Code tab waits for that error. With the original
  // deleted the copy takes its place, and a copy that still named the original's driveBack would be
  // a SCHEMA error again.
  await page.getByTestId("step-main-returnToScore").click();
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("step-row-returnToScore")).toHaveCount(0);
  expect(await schemaFindings(page)).toEqual([]);

  await page.getByTestId("bottom-tab-code").click();
  await expect(page.getByTestId("code-panel")).toBeVisible();
  await expect(page.getByTestId("code-blocked")).toHaveCount(0);
  await expect(page.getByTestId("code-view")).toContainText("private Command stepReturnToScoreCopy()");
});

test("dragging the deadline member out of its group passes the deadline on and says so", async ({ page }) => {
  const target = page.getByTestId("step-row-scoreGardenPollen");
  // Both rows in view before the drag starts, so the drag never has to scroll the list mid-way.
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (box === null) throw new Error("the scoreGardenPollen row has no box");
  // The lower part of a step row drops after it, at the top level, outside returnToScore.
  await page.getByTestId("step-handle-driveBack").dragTo(target, {
    targetPosition: { x: box.width / 2, y: box.height * 0.8 },
  });

  await expect(page.getByTestId("status")).toHaveText(
    /driveBack was the deadline of returnToScore, so clearThenSpinUp is its deadline now\. Pick another in the Inspector, or press Ctrl Z to undo\./,
  );
  expect(await editor<number>(page, `s.auto.steps.findIndex((x) => x.id === "driveBack")`)).toBeGreaterThan(0);
  // The group keeps running until one of its own steps ends (issue #144), so nothing is left to resolve.
  expect(await editor<string | undefined>(page, `s.auto.steps.find((x) => x.id === "returnToScore").deadline`)).toBe(
    "clearThenSpinUp",
  );
  expect(await schemaFindings(page)).toEqual([]);
});
