/**
 * Issue #149: where steps share a line on the field, a click keeps the selected step, and Alt+click
 * reaches the steps underneath it.
 *
 * The first auto here is three path steps on one line, y = 12 in: outA drives east from the start at
 * (-36, 12) to (24, 12), backB drives back to the start, and outC drives east again. The spot
 * (-6, 12) is on all three lines and away from their dots and from the example's waypoint pins.
 * Before the fix, every press there went to outC, the step drawn last, whatever was selected.
 *
 * The second is one path step, solo, from the start at (-40, 44) to (20, 44), through the example's
 * scoreNorth pin at (-13, 44). Its end dot and the start mark sit on its line and keep the press
 * from it, so an Alt+click on each does what a plain click does. In the first round of review, an
 * Alt+click on any of them selected the step instead. solo does not follow scoreNorth, so the field
 * shows that pin only while it is selected (issue #217), and then it keeps the press too.
 */
import { expect, test, type Page } from "@playwright/test";
import { editor, installCanvasProbe, nextFrame, openProjectWith, selectStep, shot, skipTour, worldToScreen } from "./qa/helpers";

const pose = (xIn: number, yIn = 12) => ({ xIn, yIn, headingRad: 0, provenance: "SET BY HAND: overlap fixture" });

const line = (id: string, to: { xIn: number; yIn: number; headingRad: number; provenance: string }) => ({
  id,
  kind: "path",
  segments: [{ kind: "line", from: "current", to }],
  heading: { mode: "constant", headingRad: 0 },
});

const autoFile = (name: string, title: string, description: string, start: object, steps: object[]): string =>
  JSON.stringify(
    {
      $schema: "https://libraries.horizon36596.org/zenith/schema/v1/auto.json",
      formatVersion: 4,
      name,
      title,
      description,
      robot: "autos/robot.json",
      field: "autos/field/biobuzz.field.json",
      alliance: "RED",
      authors: ["Horizon (FTC 36596)"],
      created: "2026-10-08",
      start: { pose: start },
      steps,
    },
    null,
    2,
  );

const OVERLAP_AUTO = autoFile("overlap", "Overlap", "Three path steps on one line, for the overlapping-paths e2e spec.", pose(-36), [
  line("outA", pose(24)),
  line("backB", pose(-36)),
  line("outC", pose(24)),
]);

const SOLO_AUTO = autoFile("solo", "Solo", "One path step through the scoreNorth pin, for the overlapping-paths e2e spec.", pose(-40, 44), [
  line("solo", pose(20, 44)),
]);

const SPOT = { xIn: -6, yIn: 12 };

const segmentCount = (page: Page, id: string) =>
  editor<number>(page, `s.auto.steps.find((x) => x.id === ${JSON.stringify(id)}).segments.length`);
const selectedStep = (page: Page) => editor<string | undefined>(page, "s.selection.stepId");
const selection = (page: Page) => editor<Record<string, unknown>>(page, "s.selection");

/** A click at a field point, with Alt held through it when `alt` is set. */
async function clickAt(page: Page, at: { xIn: number; yIn: number }, alt = false): Promise<void> {
  const { x, y } = await worldToScreen(page, at.xIn, at.yIn);
  if (alt) await page.keyboard.down("Alt");
  await page.mouse.click(x, y);
  if (alt) await page.keyboard.up("Alt");
}

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await installCanvasProbe(page);
});

test.describe("three steps on one line", () => {
  test.beforeEach(async ({ page }) => {
    await openProjectWith(page, { "overlap.auto.json": OVERLAP_AUTO });
    await selectStep(page, "outA");
    await expect.poll(() => selectedStep(page)).toBe("outA");
  });

  test("with outA selected, a double-click on the shared line splits outA and leaves outC with one segment", async ({ page }) => {
    const at = await worldToScreen(page, SPOT.xIn, SPOT.yIn);
    await page.mouse.dblclick(at.x, at.y);
    await expect.poll(() => segmentCount(page, "outA")).toBe(2);
    expect(await segmentCount(page, "backB")).toBe(1);
    expect(await segmentCount(page, "outC")).toBe(1);
    await shot(page, "overlap-split-selected");
  });

  test("a click and a right-click on the shared line keep outA selected", async ({ page }) => {
    const at = await worldToScreen(page, SPOT.xIn, SPOT.yIn);
    await page.mouse.click(at.x, at.y);
    expect(await selectedStep(page)).toBe("outA");
    await page.mouse.click(at.x, at.y, { button: "right" });
    await expect(page.getByRole("menuitem", { name: /Split path here/ })).toBeVisible();
    expect(await selectedStep(page)).toBe("outA");
    await page.keyboard.press("Escape");
  });

  test("Alt+click at the same spot cycles the selection through outC, backB and outA", async ({ page }) => {
    const at = await worldToScreen(page, SPOT.xIn, SPOT.yIn);
    for (const expected of ["outC", "backB", "outA", "outC"]) {
      await page.keyboard.down("Alt");
      await page.mouse.click(at.x, at.y);
      await page.keyboard.up("Alt");
      await expect.poll(() => selectedStep(page)).toBe(expected);
      // The hover bubble, drawn last, names the step a click there now picks: the one just selected.
      await expect.poll(async () => (await nextFrame(page)).texts.at(-1)).toBe(expected);
    }
    await shot(page, "overlap-alt-click");
    // A plain click keeps whichever step Alt+click reached, and nothing was split on the way.
    await page.mouse.click(at.x, at.y);
    expect(await selectedStep(page)).toBe("outC");
    for (const id of ["outA", "backB", "outC"]) expect(await segmentCount(page, id)).toBe(1);
  });
});

test.describe("one step through a pin", () => {
  const START = { xIn: -40, yIn: 44 };
  const END = { xIn: 20, yIn: 44 };
  const PIN = { xIn: -13, yIn: 44 };

  test.beforeEach(async ({ page }) => {
    await openProjectWith(page, { "solo.auto.json": SOLO_AUTO });
    await selectStep(page, "solo");
    await expect.poll(() => selection(page)).toEqual({ stepId: "solo" });
  });

  /** A plain click at `at`, then, from the step selected again, an Alt+click there: both select the same. */
  async function altClickMatchesClick(page: Page, at: { xIn: number; yIn: number }, expected: Record<string, unknown>): Promise<void> {
    await clickAt(page, at);
    await expect.poll(() => selection(page)).toMatchObject(expected);
    const plain = await selection(page);
    await selectStep(page, "solo");
    await expect.poll(() => selection(page)).toEqual({ stepId: "solo" });
    await clickAt(page, at, true);
    await expect.poll(() => selection(page)).toEqual(plain);
  }

  test("Alt+click on the selected step's end dot selects the dot, as a click does", async ({ page }) => {
    await altClickMatchesClick(page, END, { stepId: "solo", point: { segmentIndex: 0, pointKind: "to" } });
  });

  test("Alt+click on the start mark selects the start, as a click does", async ({ page }) => {
    await altClickMatchesClick(page, START, { start: true });
  });

  test("a pin on the line that solo does not follow takes no press until selected, then keeps it from Alt+click", async ({ page }) => {
    // Not drawn, so a click there is a click on the line.
    await clickAt(page, PIN);
    await expect.poll(() => selection(page)).toEqual({ stepId: "solo" });
    // Selected, as from the inspector's Waypoints list, the pin shows and stays selected rather than
    // giving way to the step. The selection does not change, so this waits for the frames the click
    // asks for before it reads it.
    await page.evaluate(`import("/src/state/store.ts").then((m) => m.setSelection({ waypoint: "scoreNorth" }))`);
    await expect.poll(() => selection(page)).toEqual({ waypoint: "scoreNorth" });
    for (const alt of [true, false]) {
      await clickAt(page, PIN, alt);
      await nextFrame(page);
      expect(await selection(page)).toEqual({ waypoint: "scoreNorth" });
    }
  });

  test("Alt+click on the line itself still selects the step under the pointer", async ({ page }) => {
    await clickAt(page, START);
    await expect.poll(() => selection(page)).toEqual({ start: true });
    await clickAt(page, { xIn: 0, yIn: 44 }, true);
    await expect.poll(() => selection(page)).toEqual({ stepId: "solo" });
  });
});
