/**
 * Issue #317: Alt + Up and Alt + Down move a step into and out of groups, the same as a drag
 * (site/docs/editor.md, "Steps panel"); a rename refused because another step has the id keeps the
 * renamed step selected; and deleting a sequence's last step is refused in plain words. The example
 * ends with `returnToScore`, a deadline parallel group of `driveBack` (its deadline) and the
 * sequence `clearThenSpinUp`, which holds `clearGarden` and `readyLauncher`.
 */
import { expect, test, type Page } from "@playwright/test";
import { editor, skipTour } from "./qa/helpers";

const topLevel = (page: Page): Promise<string[]> => editor<string[]>(page, "s.auto.steps.map((x) => x.id)");
const membersOf = (page: Page, id: string): Promise<string[]> =>
  editor<string[]>(page, `s.auto.steps.find((x) => x.id === ${JSON.stringify(id)}).steps.map((x) => x.id)`);

async function blur(page: Page): Promise<void> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
}

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await page.goto("/?cloud=fake");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-returnToScore")).toBeVisible();
});

test("Alt Up on a group's first step moves it out, Alt Down moves it back in, and undo restores it", async ({ page }) => {
  const before = await editor<string>(page, "JSON.stringify(s.auto)");
  await page.getByTestId("step-main-driveBack").click();
  await page.getByTestId("step-main-driveBack").press("Alt+ArrowUp");

  await expect.poll(async () => topLevel(page)).toContain("driveBack");
  const top = await topLevel(page);
  expect(top.indexOf("driveBack")).toBe(top.indexOf("returnToScore") - 1);
  expect(await membersOf(page, "returnToScore")).toEqual(["clearThenSpinUp"]);
  await expect(page.getByTestId("status")).toContainText("so clearThenSpinUp is its deadline now");
  expect(await editor<string | undefined>(page, "s.selection.stepId")).toBe("driveBack");

  // Down from just above the open group puts it back in, as the group's first step.
  await page.getByTestId("step-main-driveBack").press("Alt+ArrowDown");
  await expect.poll(async () => membersOf(page, "returnToScore")).toEqual(["driveBack", "clearThenSpinUp"]);

  await blur(page);
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await expect.poll(async () => editor<string>(page, "JSON.stringify(s.auto)")).toBe(before);
});

test("Alt Down on a group's last step moves it out, to just after the group", async ({ page }) => {
  await page.getByTestId("step-main-clearThenSpinUp").click();
  await page.getByTestId("step-main-clearThenSpinUp").press("Alt+ArrowDown");
  await expect.poll(async () => membersOf(page, "returnToScore")).toEqual(["driveBack"]);
  const top = await topLevel(page);
  expect(top.indexOf("clearThenSpinUp")).toBe(top.indexOf("returnToScore") + 1);
});

test("a rename to an id another step has is refused, and the renamed step stays selected", async ({ page }) => {
  await page.getByTestId("step-main-toGarden").click();
  await page.getByTestId("step-main-toGarden").press("F2");
  await page.getByTestId("step-id-input-toGarden").fill("sweepGarden");
  await page.getByTestId("step-id-input-toGarden").press("Enter");
  await expect(page.getByTestId("status")).toContainText("There is already a step named sweepGarden. toGarden keeps its id.");
  // The field stays open on the refused text, so Esc gives the row back.
  await expect(page.getByTestId("step-id-input-toGarden")).toBeVisible();
  await page.getByTestId("step-id-input-toGarden").press("Escape");
  await expect(page.getByTestId("step-row-toGarden")).toBeVisible();
  expect(await editor<string | undefined>(page, "s.selection.stepId")).toBe("toGarden");
  await expect(page.getByTestId("step-main-toGarden")).toBeFocused();
});

test("deleting a sequence's last step is refused in plain words, and the sequence keeps it", async ({ page }) => {
  await page.getByTestId("step-main-clearGarden").click();
  await blur(page);
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("step-row-clearGarden")).toHaveCount(0);

  await page.getByTestId("step-main-readyLauncher").click();
  await blur(page);
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("status")).toContainText(
    "clearThenSpinUp is a sequence and needs at least one step, so readyLauncher cannot be deleted.",
  );
  await expect(page.getByTestId("status")).not.toContainText("Array must contain");
  await expect(page.getByTestId("step-row-readyLauncher")).toBeVisible();
});
