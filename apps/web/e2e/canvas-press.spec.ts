/**
 * Issue #148: what a press on the field does when something else happens during it.
 *
 * - Escape during an edit drag cancels it: what the drag changed goes back, there is no undo entry,
 *   and the selection stays (it used to clear the selection and let the drag commit).
 * - Escape while drawing an envelope writes none and turns drawing off.
 * - A second finger on the field during a press is ignored, so the first press still closes its
 *   undo transaction (it used to leave it open, and the edits after it could not be undone).
 * - Dragging a point selects it, so the arrow keys and R then act on the point that was dragged
 *   (they used to act on the step's end, unlinking it from the waypoint it follows).
 *
 * "Load example" opens the starter's collect-and-score auto: driveOut runs north from the waypoint
 * start, (-13, -63), to the waypoint scoreSouth, (-13, -36); toOtherSide is a curve with controls at
 * (-40, -46), (-50, 4.79) and (-40, 34), west of the hive frame, that ends on the waypoint flowerNorthApproach, (-24, 46); and
 * collectFlower follows it. Shift held through a drag of a multi-selection is in qa/08-selection.
 */
import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { dragWorld, editor, loadExample, openMore, rowIds, selectStep, shot, skipTour, worldToScreen } from "./qa/helpers";

interface Point {
  xIn: number;
  yIn: number;
}

const step = (id: string): string => `s.auto.steps.find((x) => x.id === ${JSON.stringify(id)})`;
const driveOutTo = (page: Page) => editor<unknown>(page, `${step("driveOut")}.segments[0].to`);
const toOtherSideTo = (page: Page) => editor<unknown>(page, `${step("toOtherSide")}.segments[0].to`);
const control = (page: Page, index: number) =>
  editor<Point>(page, `(() => { const c = ${step("toOtherSide")}.segments[0].control[${String(index)}]; return { xIn: c.xIn, yIn: c.yIn }; })()`);
const undoDepth = (page: Page) => editor<number>(page, "s.undo.length");

/** Presses at one field point and moves, in steps, `fraction` of the way to another, holding the button. */
async function pressAndMove(page: Page, from: Point, to: Point, fraction: number, steps = 6): Promise<void> {
  const a = await worldToScreen(page, from.xIn, from.yIn);
  const b = await worldToScreen(page, to.xIn, to.yIn);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    const f = (fraction * i) / steps;
    await page.mouse.move(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f);
  }
}

/** Moves the held mouse the rest of the way, from `fraction` of the way to the end. */
async function moveRest(page: Page, from: Point, to: Point, fraction: number, steps = 6): Promise<void> {
  const a = await worldToScreen(page, from.xIn, from.yIn);
  const b = await worldToScreen(page, to.xIn, to.yIn);
  for (let i = 1; i <= steps; i += 1) {
    const f = fraction + ((1 - fraction) * i) / steps;
    await page.mouse.move(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f);
  }
}

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
});

test("Escape during a drag of driveOut's end puts it back on scoreSouth, with no undo entry, and keeps the selection", async ({ page }) => {
  await selectStep(page, "driveOut");
  const end = { xIn: -13, yIn: -36 };
  const far = { xIn: 20, yIn: -20 };
  await pressAndMove(page, end, far, 0.5);
  // Halfway, the drag has given the end a pose of its own.
  await expect.poll(() => driveOutTo(page)).not.toEqual({ ref: "scoreSouth" });

  await page.keyboard.press("Escape");
  await expect.poll(() => driveOutTo(page)).toEqual({ ref: "scoreSouth" });
  await expect(page.getByTestId("status")).toContainText("Drag cancelled.");
  // The rest of the gesture moves nothing, and the release is not a click.
  await moveRest(page, end, far, 0.5);
  await page.mouse.up();
  await shot(page, "canvas-press-escape");

  expect(await driveOutTo(page)).toEqual({ ref: "scoreSouth" });
  expect(await undoDepth(page)).toBe(0);
  expect(await editor<string | undefined>(page, "s.selection.stepId")).toBe("driveOut");
  expect(await editor<unknown>(page, "s.selection.point")).toEqual({ segmentIndex: 0, pointKind: "to" });
});

test("Escape while drawing an envelope writes none and turns drawing off", async ({ page }) => {
  await selectStep(page, "shootPreloads");
  await openMore(page);
  await page.getByTestId("inspector-envelope-draw").click();
  await expect(page.getByTestId("inspector-envelope-drawing")).toBeVisible();
  const from = { xIn: -30, yIn: -50 };
  const to = { xIn: -10, yIn: -30 };
  await pressAndMove(page, from, to, 0.6);
  // Halfway, the rectangle so far is already in the auto.
  await expect.poll(() => editor<boolean>(page, `${step("shootPreloads")}.envelope !== undefined`)).toBe(true);

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("inspector-envelope-drawing")).toHaveCount(0);
  await moveRest(page, from, to, 0.6);
  await page.mouse.up();

  expect(await editor<boolean>(page, `${step("shootPreloads")}.envelope === undefined`)).toBe(true);
  expect(await page.evaluate(`import("/src/state/ui.ts").then((m) => m.getUi().envelopeDraw)`)).toBeNull();
  expect(await undoDepth(page)).toBe(0);
  expect(await editor<string | undefined>(page, "s.selection.stepId")).toBe("shootPreloads");
  // The next drag on the field draws nothing either.
  await dragWorld(page, from, to);
  expect(await editor<boolean>(page, `${step("shootPreloads")}.envelope === undefined`)).toBe(true);
});

test("after dragging toOtherSide's control 1, ArrowRight nudges that control and the end stays on flowerNorthApproach", async ({ page }) => {
  await selectStep(page, "toOtherSide");
  await dragWorld(page, { xIn: -40, yIn: -46 }, { xIn: -32, yIn: -42 });
  const dragged = await control(page, 0);
  expect(dragged.xIn).toBeCloseTo(-32, 0);
  expect(dragged.yIn).toBeCloseTo(-42, 0);
  // The drag selected the point it moved.
  expect(await editor<unknown>(page, "s.selection.point")).toEqual({ segmentIndex: 0, pointKind: "control", controlIndex: 0 });

  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await control(page, 0)).xIn).toBeCloseTo(dragged.xIn + 0.5, 6);
  expect((await control(page, 0)).yIn).toBe(dragged.yIn);
  expect(await toOtherSideTo(page)).toEqual({ ref: "flowerNorthApproach" });
  expect(await undoDepth(page)).toBe(2);
});

test.describe("Space on the field (issue #402)", () => {
  const stepCount = (page: Page) => editor<number>(page, "s.auto.steps.length");

  test("a Space+click with Add path pans, so it adds no step", async ({ page }) => {
    await page.getByTestId("field-canvas").focus();
    await page.keyboard.press("p");
    await expect.poll(() => editor<string>(page, "s.tool")).toBe("addPath");
    const before = await stepCount(page);
    const at = await worldToScreen(page, 30, 0);
    await page.keyboard.down(" ");
    await page.mouse.click(at.x, at.y);
    await page.keyboard.up(" ");
    expect(await stepCount(page)).toBe(before);
    expect(await undoDepth(page)).toBe(0);
  });

  test("leaving the window lets Space go, so the next drag on empty field is a marquee, not a pan", async ({ page }) => {
    await page.getByTestId("field-canvas").focus();
    await page.keyboard.down(" ");
    // Space is let go in another window: this one only sees itself lose focus.
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    const before = await worldToScreen(page, 0, 0);
    await dragWorld(page, { xIn: 20, yIn: 20 }, { xIn: 50, yIn: 40 });
    const after = await worldToScreen(page, 0, 0);
    expect(after.x).toBeCloseTo(before.x, 0);
    expect(after.y).toBeCloseTo(before.y, 0);
  });
});

test.describe("two fingers on the field", () => {
  test.use({ hasTouch: true });

  interface Finger {
    x: number;
    y: number;
    id: number;
  }

  const touch = async (client: CDPSession, type: "touchStart" | "touchMove" | "touchEnd", points: Finger[]): Promise<void> => {
    await client.send("Input.dispatchTouchEvent", { type, touchPoints: points });
  };

  /** Deletes collectFlower from the keyboard, with the field focused, as a person would. */
  async function deleteCollectFlower(page: Page): Promise<void> {
    await selectStep(page, "collectFlower");
    await page.getByTestId("field-canvas").focus();
    await page.keyboard.press("Delete");
    await expect.poll(() => rowIds(page)).not.toContain("collectFlower");
  }

  test("a pinch that starts on toOtherSide's control 3 leaves undo working: the delete after it is one Ctrl+Z", async ({ page }) => {
    await selectStep(page, "toOtherSide");
    const before = await control(page, 2);
    const client = await page.context().newCDPSession(page);
    // The finger on the control holds still while the second one spreads away from it.
    const first = await worldToScreen(page, -40, 34);
    const second = await worldToScreen(page, 12, 0);
    const one: Finger = { x: first.x, y: first.y, id: 1 };
    await touch(client, "touchStart", [one]);
    await touch(client, "touchStart", [one, { x: second.x, y: second.y, id: 2 }]);
    for (let i = 1; i <= 6; i += 1) {
      await touch(client, "touchMove", [one, { x: second.x + 12 * i, y: second.y + 10 * i, id: 2 }]);
    }
    await touch(client, "touchEnd", []);

    expect(await control(page, 2)).toEqual(before);
    expect(await undoDepth(page)).toBe(0);
    await deleteCollectFlower(page);
    expect(await undoDepth(page)).toBe(1);
    await page.keyboard.press("Control+z");
    await expect.poll(() => rowIds(page)).toContain("collectFlower");
    expect(await undoDepth(page)).toBe(0);
  });

  test("when both fingers move, control 3 follows the first, and that drag and the delete are one undo step each", async ({ page }) => {
    await selectStep(page, "toOtherSide");
    const before = await control(page, 2);
    const client = await page.context().newCDPSession(page);
    const first = await worldToScreen(page, -40, 34);
    const second = await worldToScreen(page, 12, 0);
    await touch(client, "touchStart", [{ x: first.x, y: first.y, id: 1 }]);
    await touch(client, "touchStart", [{ x: first.x, y: first.y, id: 1 }, { x: second.x, y: second.y, id: 2 }]);
    const px = (await worldToScreen(page, 1, 0)).x - (await worldToScreen(page, 0, 0)).x;
    for (let i = 1; i <= 6; i += 1) {
      // The first finger goes 8 in east; the second goes the other way.
      await touch(client, "touchMove", [
        { x: first.x + ((8 * px) / 6) * i, y: first.y, id: 1 },
        { x: second.x + 12 * i, y: second.y + 10 * i, id: 2 },
      ]);
    }
    await touch(client, "touchEnd", []);

    const moved = await control(page, 2);
    expect(moved.xIn).toBeCloseTo(before.xIn + 8, 0);
    expect(moved.yIn).toBeCloseTo(before.yIn, 0);
    expect(await undoDepth(page)).toBe(1);
    await deleteCollectFlower(page);
    expect(await undoDepth(page)).toBe(2);
    await page.keyboard.press("Control+z");
    await expect.poll(() => rowIds(page)).toContain("collectFlower");
    expect(await control(page, 2)).toEqual(moved);
    await page.keyboard.press("Control+z");
    await expect.poll(() => control(page, 2)).toEqual(before);
  });
});
