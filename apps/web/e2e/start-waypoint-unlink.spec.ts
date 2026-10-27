/**
 * Issue #133: a start that follows a waypoint can be moved. Every starter auto starts at the
 * waypoint `start`, (-13, -63) facing 1.5708 rad, and writes its first path, driveOut, from that same
 * waypoint, so the path's first dot is drawn on the start mark. Dragging the start there makes it a
 * pose of its own where it is dropped, carries driveOut's first point with it so the route stays
 * joined, and says on the status line that both no longer follow the waypoint. One Ctrl+Z links
 * them again. In the inspector, for the start and for a path's ends alike, "this pose" keeps the
 * point where it stands, and "a waypoint" picks the waypoint at that spot rather than the first by
 * name.
 */
import { expect, test, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem(
        "zenith.ui",
        JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }),
      );
    }
  });
  await turnOnFeatures(page);
});

/** "Load example" opens the starter's `collect-and-score.auto.json`. */
async function loadExample(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
}

/** A value from the editor's store, through the dev server's module graph. */
async function editor<T>(page: Page, expr: string): Promise<T> {
  return (await page.evaluate(
    `import("/src/state/store.ts").then((m) => { const s = m.getState(); return (${expr}); })`,
  )) as T;
}

const START_POSE = "s.auto.start.pose";
const DRIVE_OUT_FROM = 's.auto.steps.find((step) => step.id === "driveOut").segments[0].from';

/** Where a field inch sits on screen, from the view the canvas publishes on its element. */
async function worldToScreen(page: Page, xIn: number, yIn: number): Promise<{ x: number; y: number }> {
  const canvas = page.getByTestId("field-canvas");
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("the canvas has no box");
  const pxPerIn = Number(await canvas.getAttribute("data-px-per-in"));
  const originXPx = Number(await canvas.getAttribute("data-origin-x-px"));
  const originYPx = Number(await canvas.getAttribute("data-origin-y-px"));
  // The example field puts the audience at the bottom: +x right, +y up the screen.
  return { x: box.x + originXPx + pxPerIn * xIn, y: box.y + originYPx - pxPerIn * yIn };
}

test("dragging a start that follows a waypoint moves it, carries the first path, and one undo links it again", async ({ page }) => {
  await loadExample(page);
  expect(await editor(page, START_POSE)).toEqual({ ref: "start" });
  expect(await editor(page, DRIVE_OUT_FROM)).toEqual({ ref: "start" });

  // Over the start, the cursor says it can be moved.
  const canvas = page.getByTestId("field-canvas");
  const from = await worldToScreen(page, -13, -63);
  await page.mouse.move(from.x - 4, from.y);
  await page.mouse.move(from.x, from.y);
  await expect(canvas).toHaveCSS("cursor", "move");

  // Along the south wall, 24 in toward the west wall, in small steps as a hand would.
  const to = await worldToScreen(page, -37, -63);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();

  await expect(page.getByTestId("status")).toHaveText(
    /The start and the first point of driveOut no longer follow waypoint start\. Undo links them again\./,
  );
  const start = await editor<{ xIn: number; yIn: number; headingRad: number; provenance: string }>(page, START_POSE);
  expect(start.xIn).toBeGreaterThan(-39);
  expect(start.xIn).toBeLessThan(-35);
  expect(Math.abs(start.yIn + 63)).toBeLessThan(1.5);
  // The drag keeps the heading the waypoint gave, and the editor owns the new numbers.
  expect(start.headingRad).toBeCloseTo(1.5708, 4);
  expect(start.provenance).toBe("SET FROM EDITOR");
  // driveOut still starts where the robot does.
  expect(await editor(page, DRIVE_OUT_FROM)).toMatchObject({ xIn: start.xIn, yIn: start.yIn });

  // One undo puts both back on the waypoint.
  await page.keyboard.press("Control+z");
  await expect.poll(() => editor(page, START_POSE)).toEqual({ ref: "start" });
  expect(await editor(page, DRIVE_OUT_FROM)).toEqual({ ref: "start" });
});

test("the inspector's \"This pose\" keeps the start where it stands, and a waypoint chosen is followed", async ({ page }) => {
  await loadExample(page);

  // A click on the start selects it, and the inspector opens its section: one Pose select, as a
  // path end has (issue #409).
  const at = await worldToScreen(page, -13, -63);
  await page.mouse.click(at.x, at.y);
  const kind = page.getByTestId("inspector-start-source");
  await expect(kind).toHaveValue("ref:start");

  await kind.selectOption("pose");
  await expect(page.getByTestId("status")).toHaveText(/The start no longer follows waypoint start\. Undo links it again\./);
  const start = await editor<{ xIn: number; yIn: number; headingRad: number; provenance: string }>(page, START_POSE);
  expect(start).toMatchObject({ xIn: -13, yIn: -63, headingRad: 1.5708 });
  // The waypoint's own provenance comes with its numbers.
  expect(start.provenance).toMatch(/^SET FROM EDITOR: starter example/);

  // Back to a waypoint, chosen by name in the same select.
  await kind.selectOption("ref:start");
  await expect(kind).toHaveValue("ref:start");
  await expect.poll(() => editor(page, START_POSE)).toEqual({ ref: "start" });
});

test("the start's section shows with nothing selected and when the start is selected, never under a step", async ({ page }) => {
  await loadExample(page);
  // Nothing selected: the Routine view holds the start's rows.
  await expect(page.getByTestId("inspector-start-source")).toHaveValue("ref:start");
  // A step selected: they are gone.
  await page.getByTestId("step-row-driveOut").getByRole("button").first().click();
  await expect(page.getByTestId("inspector-start-source")).toHaveCount(0);
  // The start selected on the field: back, and the select works as before.
  const at = await worldToScreen(page, -13, -63);
  await page.mouse.click(at.x, at.y);
  await expect(page.getByTestId("inspector-start-source")).toHaveValue("ref:start");
});

test("the inspector's \"This pose\" keeps a path's end where it stands, and a waypoint chosen is followed", async ({ page }) => {
  await loadExample(page);

  // driveOut ends at the scoreSouth waypoint, (-13, -36). Issue #241: one SourceSelect per end.
  await page.getByTestId("step-row-driveOut").getByRole("button").first().click();
  // Issue #244: a step's inspector holds the step alone, so the start is not in it.
  await expect(page.getByTestId("inspector-start-source")).toHaveCount(0);
  const toKind = page.getByTestId("inspector-to-source-0");
  await expect(toKind).toHaveValue("ref:scoreSouth");
  await toKind.selectOption("pose");
  await expect(page.getByTestId("inspector-to-x-0")).toHaveValue("-13.00");
  await expect(page.getByTestId("inspector-to-y-0")).toHaveValue("-36.00");
  await expect(page.getByTestId("status")).toHaveText(
    /Point 1 of driveOut no longer follows waypoint scoreSouth\. Undo links it again\./,
  );
  const end = await editor<{ provenance: string }>(page, 's.auto.steps.find((step) => step.id === "driveOut").segments[0].to');
  expect(end.provenance).toMatch(/^SET FROM EDITOR: starter example/);
  await toKind.selectOption("ref:scoreSouth");
  await expect(toKind).toHaveValue("ref:scoreSouth");
  expect(await editor(page, 's.auto.steps.find((step) => step.id === "driveOut").segments[0].to')).toEqual({ ref: "scoreSouth" });

  // toOtherSide starts from the last step's end, which is where driveOut left the robot.
  const resolvedFrom = await page.evaluate(
    `import("/src/state/store.ts").then((m) => { const flat = (steps) => steps.flatMap((x) => [x, ...flat(x.children ?? [])]); const step = flat(m.currentDerived().resolved.steps).find((x) => x.id === "toOtherSide"); return step.segments[0].fromPose; })`,
  ) as { xIn: number; yIn: number };
  await page.getByTestId("step-row-toOtherSide").getByRole("button").first().click();
  const fromKind = page.getByTestId("inspector-from-source-0");
  await expect(fromKind).toHaveValue("current");
  await fromKind.selectOption("pose");
  await expect(page.getByTestId("inspector-from-x-0")).toHaveValue(resolvedFrom.xIn.toFixed(2));
  await expect(page.getByTestId("inspector-from-y-0")).toHaveValue(resolvedFrom.yIn.toFixed(2));
  // From there, the waypoint at that spot is chosen by name.
  await fromKind.selectOption("ref:scoreSouth");
  await expect(fromKind).toHaveValue("ref:scoreSouth");
});
