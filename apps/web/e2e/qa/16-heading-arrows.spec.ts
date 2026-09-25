/**
 * QA 16, heading arrows and piecewise ranges (site/docs/editor.md, "The field" and "Inspector"),
 * through real pointer drags on the canvas and real clicks in the inspector:
 *
 * - a Linear end arrow sets the mode's end angle, the inspector shows it, and one undo puts it back;
 * - the two arrows of a Constant heading are one angle: turning one moves the other;
 * - "Split heading here" on the path makes a piecewise heading;
 * - a piecewise heading split on the inspector's track, one range Constant and one Linear, with
 *   its boundary dragged along the path on the canvas, saves as formatVersion 3 with those ranges.
 *
 * The fixture's `hop` step is a straight line from (36, 12) to (36, 40), so t along it is
 * (y - 12) / 28 and every pose on it is easy to place.
 */
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { canvasView, editor, fixture, installCanvasProbe, openProjectWith, shot, skipTour, worldToScreen } from "./helpers";

interface Range {
  startT: number;
  endT: number;
  heading: { mode: string; headingRad?: number; fromRad?: number; toRad?: number };
}

interface StepHeading {
  mode: string;
  headingRad?: number;
  fromRad?: number;
  toRad?: number;
  ranges?: Range[];
}

const HOP_START = { xIn: 36, yIn: 12 };
const HOP_END = { xIn: 36, yIn: 40 };
const hopAt = (t: number): { xIn: number; yIn: number } => ({ xIn: 36, yIn: 12 + 28 * t });
const rad = (deg: number): number => (deg * Math.PI) / 180;

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await installCanvasProbe(page);
  await openProjectWith(page, { "qa-curves.auto.json": fixture("qa-curves.auto.json") });
  await page.getByTestId("step-row-hop").getByRole("button").first().click();
  await expect.poll(() => editor<string>(page, "s.selection.stepId")).toBe("hop");
});

const hopHeading = (page: Page) => editor<StepHeading>(page, `s.auto.steps.find((x) => x.id === "hop").heading`);

async function pickMode(page: Page, testId: string, mode: string): Promise<void> {
  await page.getByTestId(testId).click();
  await page.getByTestId(`${testId}-option-${mode}`).click();
  await expect(page.getByTestId(testId)).toHaveAttribute("data-value", mode);
}

async function setNumber(page: Page, testId: string, value: number): Promise<void> {
  const input = page.getByTestId(testId);
  await input.fill(String(value));
  await input.press("Enter");
}

/** Drags the arrow drawn at `base` along `nowRad` (26 px long) round to point towards `towardsDeg`. */
async function dragArrow(page: Page, base: { xIn: number; yIn: number }, nowRad: number, towardsDeg: number): Promise<void> {
  const view = await canvasView(page);
  const reachIn = 26 / view.pxPerIn;
  const grab = await worldToScreen(page, base.xIn + reachIn * Math.cos(nowRad), base.yIn + reachIn * Math.sin(nowRad));
  const to = await worldToScreen(page, base.xIn + 12 * Math.cos(rad(towardsDeg)), base.yIn + 12 * Math.sin(rad(towardsDeg)));
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) await page.mouse.move(grab.x + ((to.x - grab.x) * i) / 8, grab.y + ((to.y - grab.y) * i) / 8);
  await page.mouse.up();
}

test("a Linear end arrow sets the end angle, the inspector shows it, and undo restores it", async ({ page }) => {
  await pickMode(page, "inspector-heading-mode", "linear");
  const before = await hopHeading(page);
  expect(before.mode).toBe("linear");
  await dragArrow(page, HOP_END, before.toRad ?? 0, 90);
  const after = await hopHeading(page);
  expect(after.toRad ?? 0).toBeCloseTo(Math.PI / 2, 3);
  expect(after.fromRad).toBe(before.fromRad);
  await expect(page.getByTestId("inspector-heading-to")).toHaveValue(/^90(\.0)?$/);
  await shot(page, "16-linear-end-arrow");

  await page.getByTestId("field-canvas").focus();
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await hopHeading(page)).toRad).toBe(before.toRad);
});

test("the two arrows of a Constant heading are one angle", async ({ page }) => {
  expect((await hopHeading(page)).mode).toBe("constant");
  await dragArrow(page, HOP_START, 0, 45);
  expect((await hopHeading(page)).headingRad ?? 0).toBeCloseTo(Math.PI / 4, 3);
  // The end arrow turned with it: it is now found along 45 degrees, and turning it sets both.
  await dragArrow(page, HOP_END, Math.PI / 4, 90);
  expect((await hopHeading(page)).headingRad ?? 0).toBeCloseTo(Math.PI / 2, 3);
  await expect(page.getByTestId("inspector-heading-constant")).toHaveValue(/^90(\.0)?$/);
});

test("Split heading here, on the path's context menu, makes a piecewise heading", async ({ page }) => {
  const at = await worldToScreen(page, hopAt(0.25).xIn, hopAt(0.25).yIn);
  await page.mouse.click(at.x, at.y, { button: "right" });
  const item = page.getByTestId("canvas-context-menu").locator('[data-action="canvas.splitHeading"]');
  await expect(item).toBeEnabled();
  await item.click();
  const heading = await hopHeading(page);
  expect(heading.mode).toBe("piecewise");
  expect(heading.ranges?.length).toBe(2);
  expect(Math.abs((heading.ranges?.[0]?.endT ?? 0) - 0.25)).toBeLessThan(0.02);
  await expect(page.getByTestId("inspector-heading-mode")).toHaveAttribute("data-value", "piecewise");
});

test("a piecewise heading: split on the track, one Constant and one Linear range, boundary dragged on the canvas, saved", async ({ page }) => {
  await pickMode(page, "inspector-heading-mode", "piecewise");
  await expect(page.getByTestId("heading-ranges")).toBeVisible();
  const track = page.getByTestId("heading-track");
  const box = await track.boundingBox();
  if (box === null) throw new Error("the heading track has no box");
  await track.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(page.getByTestId("heading-range-1")).toBeVisible();

  await pickMode(page, "heading-range-0-mode", "constant");
  await setNumber(page, "heading-range-0-constant", 30);
  await pickMode(page, "heading-range-1-mode", "linear");
  await setNumber(page, "heading-range-1-from", 0);
  await setNumber(page, "heading-range-1-to", 90);

  let heading = await hopHeading(page);
  expect(heading.ranges?.map((range) => range.heading.mode)).toEqual(["constant", "linear"]);
  expect(heading.ranges?.[0]?.endT).toBeCloseTo(0.5, 2);

  // Drag the boundary tick along the path from t 0.5 to t 0.75.
  const from = await worldToScreen(page, hopAt(0.5).xIn, hopAt(0.5).yIn);
  const to = await worldToScreen(page, hopAt(0.75).xIn, hopAt(0.75).yIn);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) await page.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
  await page.mouse.up();

  heading = await hopHeading(page);
  const boundary = heading.ranges?.[0]?.endT ?? 0;
  expect(Math.abs(boundary - 0.75), `the boundary is at t ${String(boundary)}`).toBeLessThan(0.01);
  expect(heading.ranges?.[1]?.startT).toBe(boundary);
  await expect(page.getByTestId("heading-range-0-end")).toHaveValue(boundary.toFixed(2));
  await shot(page, "16-piecewise");

  const download = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  const saved = JSON.parse(readFileSync(await (await download).path(), "utf8")) as {
    formatVersion: number;
    steps: Array<{ id: string; heading?: StepHeading }>;
  };
  expect(saved.formatVersion).toBe(3);
  // The file rounds radians to four places (site/docs/file-format.md).
  const written = saved.steps.find((step) => step.id === "hop")?.heading;
  expect(written?.mode).toBe("piecewise");
  expect(written?.ranges?.length).toBe(2);
  const [first, second] = written?.ranges ?? [];
  expect(first?.startT).toBe(0);
  expect(first?.endT).toBe(boundary);
  expect(first?.heading.mode).toBe("constant");
  expect(first?.heading.headingRad ?? 0).toBeCloseTo(rad(30), 4);
  expect(second?.startT).toBe(boundary);
  expect(second?.endT).toBe(1);
  expect(second?.heading.mode).toBe("linear");
  expect(second?.heading.fromRad ?? 1).toBeCloseTo(0, 4);
  expect(second?.heading.toRad ?? 0).toBeCloseTo(rad(90), 4);
});
