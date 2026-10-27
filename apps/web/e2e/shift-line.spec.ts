/**
 * Issue #188: Shift on a path end holds the point to a ray from the other end of its segment, not to
 * the horizontal or vertical line through where the point was at the press.
 *
 * Before the fix, Shift-dragging the end of a diagonal driveOut with the pointer 1.8 in from the
 * start left the end at the old y and the line 20 in long, because the other coordinate was put back
 * to its press value and the segment's other end was never looked at.
 *
 * The example opens collect-and-score. Its driveOut runs from the start waypoint, (-13, -63), to
 * scoreSouth, (-13, -36); it is made diagonal here by dragging its end to (7, -43), 28.28 in away at
 * 45 degrees. The routine's last end is scoreNorth, (-13, 44), where Add path continues from.
 */
import { expect, test, type Page } from "@playwright/test";
import { dragWorld, editor, loadExample, skipTour, worldToScreen } from "./qa/helpers";

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
});

const ANCHOR = { xIn: -13, yIn: -63 };
const END = { xIn: 7, yIn: -43 };
/** driveOut's end where it is now, a followed waypoint's position when the end follows one. */
const driveOutEnd = (page: Page): Promise<{ xIn: number; yIn: number }> =>
  editor(
    page,
    `(() => { const to = s.auto.steps.find((step) => step.id === "driveOut").segments[0].to; return to.ref === undefined ? to : s.project.waypoints.waypoints[to.ref]; })()`,
  );

const lengthFromAnchor = (end: { xIn: number; yIn: number }): number => Math.hypot(end.xIn - ANCHOR.xIn, end.yIn - ANCHOR.yIn);

/** Makes driveOut a diagonal line by dragging its end, with no key held, and checks where it landed. */
async function makeDiagonal(page: Page): Promise<void> {
  await dragWorld(page, { xIn: -13, yIn: -36 }, END, { steps: 10 });
  const end = await driveOutEnd(page);
  expect(end.xIn).toBeCloseTo(END.xIn, 6);
  expect(end.yIn).toBeCloseTo(END.yIn, 6);
  expect(lengthFromAnchor(end)).toBeCloseTo(28.28, 1);
}

const canvasAttr = (page: Page, name: string): Promise<string> =>
  page.getByTestId("field-canvas").getAttribute(name).then((value) => value ?? "");

test("Shift-dragging a diagonal line's end to 1.8 in from the start leaves a line of at most 2 in, not 20", async ({ page }) => {
  await makeDiagonal(page);
  const near = { xIn: ANCHOR.xIn + 1.8 * Math.SQRT1_2, yIn: ANCHOR.yIn + 1.8 * Math.SQRT1_2 };
  await dragWorld(page, END, near, { keys: ["Shift"], steps: 14 });
  const end = await driveOutEnd(page);
  expect(lengthFromAnchor(end)).toBeLessThanOrEqual(2 + 1e-6);
  // Still on the diagonal it was on at the press (the start waypoint is on it too, and may catch the end).
  expect(end.xIn - ANCHOR.xIn).toBeCloseTo(end.yIn - ANCHOR.yIn, 6);
});

test("moving the pointer 1 in across the diagonal moves the end at most 1.5 in, and the bubble names the line", async ({ page }) => {
  await makeDiagonal(page);
  const along = { xIn: ANCHOR.xIn + 14, yIn: ANCHOR.yIn + 14 };
  await dragWorld(page, END, along, { keys: ["Shift"], release: false, steps: 10 });
  const before = await driveOutEnd(page);
  const across = await worldToScreen(page, along.xIn + Math.SQRT1_2, along.yIn - Math.SQRT1_2);
  await page.mouse.move(across.x, across.y, { steps: 4 });
  const after = await driveOutEnd(page);
  expect(Math.hypot(after.xIn - before.xIn, after.yIn - before.yIn)).toBeLessThanOrEqual(1.5);
  expect(await canvasAttr(page, "data-readout-snap")).toBe("grid 0.5 in · line 45° · length (Shift)");
  await page.mouse.up();
  await page.keyboard.up("Shift");
});

test("an end held to its ray lands on a half-inch length, and one undo puts the whole drag back", async ({ page }) => {
  await makeDiagonal(page);
  const undoBefore = await editor<number>(page, "s.undo.length");
  await dragWorld(page, END, { xIn: ANCHOR.xIn + 10.1, yIn: ANCHOR.yIn + 10.3 }, { keys: ["Shift"], steps: 10 });
  const end = await driveOutEnd(page);
  const length = lengthFromAnchor(end);
  expect(Math.abs(length / 0.5 - Math.round(length / 0.5))).toBeLessThan(1e-6);
  expect(end.xIn - ANCHOR.xIn).toBeCloseTo(end.yIn - ANCHOR.yIn, 6);
  expect(await editor<number>(page, "s.undo.length")).toBe(undoBefore + 1);
  await page.keyboard.press("Control+z");
  const undone = await driveOutEnd(page);
  expect(undone.xIn).toBeCloseTo(END.xIn, 6);
  expect(undone.yIn).toBeCloseTo(END.yIn, 6);
});

test("in Add path, a Shift-click at a 40 degree bearing from the anchor writes a 45 degree line", async ({ page }) => {
  await editor(page, "m.setSelection({})");
  await page.getByTestId("field-canvas").focus();
  await page.keyboard.press("p");
  await expect.poll(() => editor<string>(page, "s.tool")).toBe("addPath");

  // The new path continues from the routine's last end, scoreNorth, (-13, 44).
  const anchor = { xIn: -13, yIn: 44 };
  const reachIn = 24;
  const aim = {
    xIn: anchor.xIn + reachIn * Math.cos((40 * Math.PI) / 180),
    yIn: anchor.yIn + reachIn * Math.sin((40 * Math.PI) / 180),
  };
  const at = await worldToScreen(page, aim.xIn, aim.yIn);
  await page.mouse.move(at.x - 12, at.y + 6);
  await page.mouse.move(at.x, at.y, { steps: 3 });
  await page.keyboard.down("Shift");
  await expect.poll(() => canvasAttr(page, "data-readout-snap")).toMatch(/line 45° · length \(Shift\)$/);
  const band = (await canvasAttr(page, "data-rubber-band")).split(",").map(Number);
  expect(band[0]).toBeCloseTo(anchor.xIn, 3);
  expect(band[1]).toBeCloseTo(anchor.yIn, 3);
  await page.mouse.click(at.x, at.y);
  await page.keyboard.up("Shift");

  await expect.poll(() => editor<string | undefined>(page, "s.selection.stepId")).toBe("path1");
  const end = await editor<{ xIn: number; yIn: number }>(page, `s.auto.steps.find((step) => step.id === "path1").segments[0].to`);
  expect(end.yIn - anchor.yIn).toBeCloseTo(end.xIn - anchor.xIn, 6);
  expect(end.xIn).toBeGreaterThan(anchor.xIn + 5);
});
