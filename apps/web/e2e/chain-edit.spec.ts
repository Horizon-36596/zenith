/**
 * Issue #185 (decision D5): a path chain gains and loses paths while it stays joined, and Del on
 * one selected point removes just that point. The starter's `first-auto.auto.json` has driveOut as
 * one straight path north from waypoint start (-13, -63) to waypoint scoreSouth (-13, -36).
 */
import { expect, test, type Page } from "@playwright/test";
import { editor, loadExample, openAutoNamed, skipTour, worldToScreen } from "./qa/helpers";

interface Segment {
  kind: string;
  from: unknown;
  to: unknown;
}

const segments = (page: Page) =>
  editor<Segment[]>(page, `s.auto.steps.find((x) => x.id === "driveOut")?.segments ?? []`);
const continuity = (page: Page) =>
  editor<number>(page, `m.currentDerived().findings.filter((f) => f.code === "CONTINUITY").length`);

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
  await openAutoNamed(page, "first-auto.auto.json");
  await page.getByTestId("step-row-driveOut").getByRole("button").first().click();
});

test("Del on the point a split made joins driveOut back into one line, and one Ctrl+Z restores the split", async ({ page }) => {
  const at = await worldToScreen(page, -13, -42);
  await page.mouse.dblclick(at.x, at.y);
  await expect.poll(async () => (await segments(page)).length).toBe(2);
  const joint = (await segments(page))[0]?.to as { xIn: number; yIn: number };

  const point = await worldToScreen(page, joint.xIn, joint.yIn);
  await page.mouse.click(point.x, point.y);
  await expect.poll(() => editor<string | undefined>(page, "s.selection.point?.pointKind")).toBe("to");
  await page.keyboard.press("Delete");

  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await expect.poll(() => segments(page)).toEqual([{ kind: "line", from: { ref: "start" }, to: { ref: "scoreSouth" } }]);
  await expect(page.getByTestId("status")).toContainText("they are one path now");
  expect(await continuity(page)).toBe(0);

  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await segments(page)).length).toBe(2);
  // Undo brings back the file as canonical form writes it, to three decimals of an inch.
  const restored = (await segments(page))[0]?.to as { xIn: number; yIn: number };
  expect(restored.xIn).toBeCloseTo(joint.xIn, 2);
  expect(restored.yIn).toBeCloseTo(joint.yIn, 2);
});

test("the point menu offers Delete point before Delete step", async ({ page }) => {
  const at = await worldToScreen(page, -13, -42);
  await page.mouse.dblclick(at.x, at.y);
  await expect.poll(async () => (await segments(page)).length).toBe(2);
  const joint = (await segments(page))[0]?.to as { xIn: number; yIn: number };
  const point = await worldToScreen(page, joint.xIn, joint.yIn);
  await page.mouse.click(point.x, point.y, { button: "right" });
  const items = page.getByRole("menuitem");
  const labels = await items.allInnerTexts();
  const deletePoint = labels.findIndex((label) => label.startsWith("Delete point"));
  const deleteStep = labels.findIndex((label) => label.startsWith("Delete step"));
  expect(deletePoint).toBeGreaterThanOrEqual(0);
  expect(deletePoint).toBeLessThan(deleteStep);
  await items.nth(deletePoint).click();
  await expect.poll(async () => (await segments(page)).length).toBe(1);
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
});

test("Add path to chain adds a Path 2 section, and a lone path has no bin to remove it", async ({ page }) => {
  const inspector = page.getByTestId("inspector");
  const remove = inspector.getByTestId("inspector-segment-remove-0");
  // Issue #409: a chain of one path has no Path 1 level and no bin that cannot delete.
  await expect(remove).toHaveCount(0);
  await expect(inspector.getByTestId("inspector-from-source-0")).not.toContainText("Previous path's end");

  await inspector.getByTestId("inspector-chain-add").click();
  await expect(inspector.getByRole("button", { name: /^Path 2/ })).toBeVisible();
  const added = await segments(page);
  expect(added).toHaveLength(2);
  expect(added[1]).toMatchObject({ kind: "line", from: "current" });
  expect(await continuity(page)).toBe(0);
  await expect(page.getByTestId("status")).toContainText("Added a path to driveOut.");
  // The new path holds the selected point, so it is the one open, and its From is the joint.
  await expect(inspector.getByTestId("inspector-from-joint-1")).toContainText("End of Path 1");
  await expect(remove).toHaveAttribute("aria-disabled", "false");

  await inspector.getByTestId("inspector-segment-remove-1").click();
  await expect.poll(async () => (await segments(page)).length).toBe(1);
  await expect(inspector.getByRole("button", { name: /^Path 2/ })).toHaveCount(0);
});
