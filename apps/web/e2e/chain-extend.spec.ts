/**
 * Issue #204 (the rest of decision D5): the Add path tool's Extend this chain toggle adds a path to
 * the selected path step's chain instead of a new step, and Join with next path makes two path
 * steps that follow each other one chain. The starter's `first-auto.auto.json` runs driveOut north
 * from waypoint start (-13, -63) to waypoint scoreSouth (-13, -36), then scorePreload, then park.
 */
import { expect, test, type Page } from "@playwright/test";
import { editor, loadExample, openAutoNamed, rowIds, skipTour, worldToScreen } from "./qa/helpers";

const segmentCount = (page: Page, id: string) =>
  editor<number>(page, `s.auto.steps.find((x) => x.id === ${JSON.stringify(id)})?.segments?.length ?? 0`);

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
  await openAutoNamed(page, "first-auto.auto.json");
  await page.getByTestId("step-row-driveOut").getByRole("button").first().click();
});

/** Picks the Add path tool, then clicks the field at (xIn, yIn). */
async function addPathClick(page: Page, xIn: number, yIn: number): Promise<void> {
  await page.getByTestId("toolbar-tool.addPath").click();
  const at = await worldToScreen(page, xIn, yIn);
  await page.mouse.click(at.x, at.y);
}

test("with Extend this chain on and driveOut selected, an Add path click adds a Path 2 section to driveOut and no new step", async ({ page }) => {
  const before = await rowIds(page);
  // The option shows beside the tool only while Add path is the tool.
  await expect(page.getByTestId("toolbar-tool.extendChain")).toHaveCount(0);
  await page.getByTestId("toolbar-tool.addPath").click();
  const toggle = page.getByTestId("toolbar-tool.extendChain");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  await addPathClick(page, 6, -24);
  await expect.poll(() => segmentCount(page, "driveOut")).toBe(2);
  expect(await rowIds(page)).toEqual(before);
  await expect(page.getByTestId("inspector").getByRole("button", { name: /^Path 2/ })).toBeVisible();
  await expect(page.getByTestId("status")).toContainText("Added a path to driveOut.");
});

/** The 0.1.2 UX sweep (W1-13): turning the option on with no path step selected did nothing visible. */
test("Extend this chain from the palette with nothing selected says why on the status line", async ({ page }) => {
  await editor(page, "m.selectStep(undefined)");
  await expect.poll(() => editor<string | null>(page, "m.getState().selection.stepId ?? null")).toBeNull();
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Extend this chain");
  await page.getByTestId("palette-item-tool.extendChain").click();
  await expect(page.getByTestId("status")).toContainText("Extend this chain is on, and no path step is selected.");
  await expect(page.getByTestId("status")).toContainText("Select a path step to add to its chain.");
});

test("with Extend this chain off, an Add path click makes a new step after driveOut, as before", async ({ page }) => {
  const before = await rowIds(page);
  await addPathClick(page, 6, -24);
  await expect.poll(async () => (await rowIds(page)).length).toBe(before.length + 1);
  expect(await segmentCount(page, "driveOut")).toBe(1);
});

test("Join with next path on two adjacent path steps leaves one step, and one Ctrl+Z restores both", async ({ page }) => {
  // driveOut is followed by a command, so the item is off and says why.
  await page.getByTestId("step-row-driveOut").click({ button: "right" });
  const item = page.getByTestId("step-menu").getByTestId("menu-edit.joinNext");
  await expect(item).toHaveAttribute("aria-disabled", "true");
  await item.hover();
  await expect(page.locator('[role="tooltip"]')).toContainText("scorePreload is a command step");
  await page.keyboard.press("Escape");

  // A new path straight after driveOut gives two path steps one after the other.
  await addPathClick(page, 6, -24);
  await expect.poll(async () => (await rowIds(page)).length).toBe(4);
  const two = await rowIds(page);
  await page.getByTestId("toolbar-tool.select").click();

  await page.getByTestId("step-row-driveOut").click({ button: "right" });
  const join = page.getByTestId("step-menu").getByTestId("menu-edit.joinNext");
  await expect(join).toHaveAttribute("aria-disabled", "false");
  await join.click();
  await expect.poll(() => rowIds(page)).toEqual(two.filter((id) => id !== two[1]));
  expect(await segmentCount(page, "driveOut")).toBe(2);
  await expect(page.getByTestId("status")).toContainText("onto driveOut");

  await page.keyboard.press("Control+z");
  await expect.poll(() => rowIds(page)).toEqual(two);
  expect(await segmentCount(page, "driveOut")).toBe(1);
});
