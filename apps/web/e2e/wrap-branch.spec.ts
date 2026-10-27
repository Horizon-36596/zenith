/**
 * Wrapping steps in a branch from the command palette (issue #312). It follows the rules a
 * sequence and a parallel group follow: steps with others between them are refused, and wrapping
 * the deadline step of a deadline group passes the deadline to the new branch. The example's
 * `returnToScore` is a deadline group whose deadline is its path `driveBack`.
 */
import { expect, test, type Page } from "@playwright/test";
import { editor, rowIds, skipTour } from "./qa/helpers";

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await page.goto("/?cloud=fake");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-returnToScore")).toBeVisible();
});

async function palette(page: Page, label: string): Promise<void> {
  await page.keyboard.press("Control+k");
  await page.keyboard.type(label);
  await page.keyboard.press("Enter");
}

async function schemaFindings(page: Page): Promise<string[]> {
  await page.getByTestId("bottom-tab-problems").click();
  await expect(page.getByTestId("findings-list")).toBeVisible();
  return page
    .getByTestId("finding-row")
    .filter({ has: page.getByTestId("finding-code").getByText("SCHEMA", { exact: true }) })
    .allInnerTexts();
}

const autoJson = (page: Page): Promise<string> => editor<string>(page, "JSON.stringify(s.auto)");

test("steps with others between them are refused, and the routine is unchanged", async ({ page }) => {
  const rows = await rowIds(page);
  const before = await autoJson(page);
  await page.getByTestId("step-main-driveOut").click();
  await page.getByTestId("step-main-toScoreNorth").click({ modifiers: ["Control"] });
  await expect(page.getByTestId("step-row-toScoreNorth")).toHaveAttribute("data-selected", "true");
  await palette(page, "Wrap in a branch");

  await expect(page.getByTestId("status")).toContainText("unbroken run");
  expect(await rowIds(page)).toEqual(rows);
  expect(await autoJson(page)).toBe(before);
});

test("wrapping the deadline step passes the group's deadline to the new branch", async ({ page }) => {
  await page.getByTestId("step-main-driveBack").click();
  await palette(page, "Wrap in a branch");
  await expect(page.getByTestId("step-row-branch")).toBeVisible();

  const group = await editor<{ deadline?: string; steps: Array<{ id?: string }> }>(
    page,
    `s.auto.steps.find((x) => x.id === "returnToScore")`,
  );
  expect(group.steps.map((step) => step.id)).toEqual(["branch", "clearThenSpinUp"]);
  expect(group.deadline).toBe("branch");
  expect(await schemaFindings(page)).toEqual([]);
});
