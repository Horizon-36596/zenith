/**
 * Issue #145: scrubbing a number field in the inspector.
 *
 * - A scrub is one undo step. Before, every pixel was a step of its own: a scrub of Speed from 0.30
 *   added nine, and it took nine Ctrl Z to undo one gesture.
 * - A press-drag in a field that has focus selects its text, as in any input. Before, it scrubbed:
 *   selecting x's text moved the point 39 in and selected nothing.
 * - An angle moves one degree per pixel; its arrow keys still step 5°. Before, a scrub moved it 5°
 *   per pixel.
 * - The scrub starts at the edge of its 3 px dead zone, so the value does not jump, and Esc during
 *   it puts the value back.
 * - A scrub writes only what the field shows. In review, a pixel was a quarter step written as it
 *   was: an 8 px drag left 5.25 pieces under a Holds at start that showed 5, and 0.3625 under a
 *   Speed that showed 0.36 (now 36%, issue #409).
 * - Neither a scrub nor a drag on the heading ranges' track completes the tour's "drag one of the
 *   dots" stop, which asks for a drag on the field.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";
import { choosePreset } from "./qa/helpers";

/** `SCRUB_DEAD_ZONE_PX` in src/components/numberScrub.ts. */
const DEAD_ZONE_PX = 3;

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

/** A top-level step as the file has it. */
const stepOf = (page: Page, id: string) =>
  editor<Record<string, unknown>>(page, `s.auto.steps.find((x) => x.id === ${JSON.stringify(id)})`);

const undoLength = (page: Page) => editor<number>(page, "s.undo.length");

/** The open auto as JSON, to show a gesture changed nothing. */
const autoJson = (page: Page) => editor<string>(page, "JSON.stringify(s.auto)");

/**
 * Presses the middle of a field that has no focus, by its test id or as a locator, and moves the
 * pointer to the edge of the dead zone, where the scrub starts. Returns how to move it `px` further,
 * with the button still down.
 */
async function startScrub(page: Page, field: string | Locator): Promise<(px: number) => Promise<void>> {
  const input = typeof field === "string" ? page.getByTestId(field) : field;
  await input.scrollIntoViewIfNeeded();
  const box = await input.boundingBox();
  if (box === null) throw new Error(`${String(field)} is not on screen`);
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + DEAD_ZONE_PX, y);
  return (px) => page.mouse.move(x + DEAD_ZONE_PX + px, y, { steps: 10 });
}

/** The difference between two headings in degrees, from -180 to 180. */
const turnDeg = (fromRad: number, toRad: number): number => {
  const deg = ((toRad - fromRad) * 180) / Math.PI;
  return ((((deg + 180) % 360) + 360) % 360) - 180;
};

test.describe("with the tour seen", () => {
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

  test("a 20 px scrub on the Speed is one undo step, and one Ctrl Z puts 0.30 back", async ({ page }) => {
    await loadExample(page);
    await page.getByTestId("step-main-collectFlower").click();
    const speed = page.getByTestId("inspector-speed");
    await expect(speed).toHaveValue("30");
    const before = await undoLength(page);

    const scrubTo = await startScrub(page, "inspector-speed");
    // Leaving the dead zone starts the scrub without a jump.
    expect((await stepOf(page, "collectFlower"))["speedFraction"]).toBe(0.3);
    await scrubTo(20);
    await page.mouse.up();

    // 20 px is five steps of 5%, at 4 px a step.
    await expect.poll(async () => (await stepOf(page, "collectFlower"))["speedFraction"]).toBeCloseTo(0.55, 6);
    await expect(speed).toHaveValue("55");
    expect(await undoLength(page)).toBe(before + 1);
    // The scrub left the focus where it was, so Ctrl Z is the routine's undo.
    await expect(speed).not.toBeFocused();

    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await stepOf(page, "collectFlower"))["speedFraction"]).toBe(0.3);
    await expect(speed).toHaveValue("30");
    expect(await undoLength(page)).toBe(before);
  });

  test("a click focuses a field with its text selected, and a drag in it then selects text and changes nothing", async ({ page }) => {
    await loadExample(page);
    await page.getByTestId("step-main-driveOut").click();
    // driveOut starts on the start waypoint; as its own pose, From shows x.
    await page.getByTestId("inspector-from-source-0").selectOption("pose");
    const x = page.getByTestId("inspector-from-x-0");
    await expect(x).toHaveValue("-13.00");
    const file = await autoJson(page);
    const before = await undoLength(page);
    const cursor = () => x.evaluate((el) => getComputedStyle(el).cursor);
    expect(await cursor()).toBe("ew-resize");

    await x.click();
    await expect(x).toBeFocused();
    // With the focus a drag selects text, and the cursor says so.
    expect(await cursor()).toBe("text");
    const selection = () => x.evaluate((el: HTMLInputElement) => [el.selectionStart ?? 0, el.selectionEnd ?? 0]);
    expect(await selection()).toEqual([0, 6]);

    /** A press at the right end of the text and a drag leftwards across its last characters. */
    const box = await x.boundingBox();
    if (box === null) throw new Error("x is not on screen");
    const y = Math.round(box.y + box.height / 2);
    const right = Math.round(box.x + box.width - 3);
    const dragAcross = async (): Promise<void> => {
      await page.mouse.move(right, y);
      await page.mouse.down();
      await page.mouse.move(right - 16, y, { steps: 8 });
      await page.mouse.up();
    };

    // On the text the click selected: nothing scrubs and the text stays selected.
    await dragAcross();
    await expect(x).toBeFocused();
    await expect(x).toHaveValue("-13.00");
    const [all, end] = await selection();
    expect(end).toBeGreaterThan(all);
    expect(await autoJson(page)).toBe(file);
    expect(await undoLength(page)).toBe(before);

    // A click in the field puts the caret there, and a drag from it selects part of the text.
    await page.mouse.click(right, y);
    await dragAcross();
    await expect(x).toHaveValue("-13.00");
    const [start, last] = await selection();
    expect(last).toBe(6);
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(last);
    expect(await autoJson(page)).toBe(file);
    expect(await undoLength(page)).toBe(before);
  });

  test("a 20 px scrub on a Heading turns it 20 degrees, and its arrow keys still step 5", async ({ page }) => {
    await loadExample(page);
    // sweepGarden holds a constant heading of 180°.
    await page.getByTestId("step-main-sweepGarden").click();
    const heading = page.getByTestId("inspector-heading-constant");
    await expect(heading).toHaveValue("180.0");
    const headingRad = async () =>
      ((await stepOf(page, "sweepGarden"))["heading"] as { headingRad: number }).headingRad;
    const startRad = await headingRad();

    const scrubTo = await startScrub(page, "inspector-heading-constant");
    expect(await headingRad()).toBe(startRad);
    await scrubTo(20);
    await page.mouse.up();
    await expect.poll(async () => turnDeg(startRad, await headingRad())).toBeCloseTo(20, 1);

    await heading.click();
    await heading.press("ArrowUp");
    await expect.poll(async () => turnDeg(startRad, await headingRad())).toBeCloseTo(25, 1);
  });

  test("Esc during a scrub puts the value back and leaves no undo step", async ({ page }) => {
    await loadExample(page);
    await page.getByTestId("step-main-collectFlower").click();
    const speed = page.getByTestId("inspector-speed");
    const before = await undoLength(page);

    const scrubTo = await startScrub(page, "inspector-speed");
    await scrubTo(40);
    await expect.poll(async () => (await stepOf(page, "collectFlower"))["speedFraction"]).toBeCloseTo(0.8, 6);
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await stepOf(page, "collectFlower"))["speedFraction"]).toBe(0.3);
    await expect(speed).toHaveValue("30");

    // The rest of the gesture changes nothing, and the release is not a click into the field.
    await scrubTo(60);
    await page.mouse.up();
    expect((await stepOf(page, "collectFlower"))["speedFraction"]).toBe(0.3);
    await expect(speed).not.toBeFocused();
    expect(await undoLength(page)).toBe(before);
    // Esc went to the scrub, not to the page, where it would clear the selection.
    expect(await editor<string>(page, "s.selection.stepId")).toBe("collectFlower");
  });

  test("an 8 px drag on the Speed stores 0.36, the 36% the field shows", async ({ page }) => {
    await loadExample(page);
    await page.getByTestId("step-main-collectFlower").click();
    const speed = page.getByTestId("inspector-speed");
    await expect(speed).toHaveValue("30");

    // 3 px of dead zone and 5 px of scrub: a step and a quarter, 0.3625 before it was rounded.
    const scrubTo = await startScrub(page, "inspector-speed");
    await scrubTo(5);
    await page.mouse.up();
    await expect.poll(async () => (await stepOf(page, "collectFlower"))["speedFraction"]).toBe(0.36);
    await expect(speed).toHaveValue("36");
  });

  test("an 8 px drag on Holds at start writes a whole count, the one the field shows", async ({ page }) => {
    await loadExample(page);
    const holds = () => editor<Record<string, number>>(page, "s.auto.start.holds");
    expect(await holds()).toEqual({ pollen: 4 });
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("Auto details");
    await page.getByTestId("palette-item-project.meta").click();
    const field = page.getByTestId("auto-meta").getByLabel("Holds at start");
    await expect(field).toHaveValue("4");

    const scrubTo = await startScrub(page, field);
    await scrubTo(5);
    await page.mouse.up();
    await expect.poll(holds).toEqual({ pollen: 5 });
    await expect(field).toHaveValue("5");
  });
});

test("neither a scrub nor a heading-range drag in the inspector does the tour's drag-a-dot task", async ({ page }) => {
  await turnOnFeatures(page);
  // A first visit: the example loads and the tour starts on the field.
  await page.goto("/");
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await choosePreset(page);
  const card = page.getByTestId("tour-card");
  await expect(card).toHaveAttribute("data-stop", "field");

  // toOtherSide is a curve with a piecewise heading. The tour's first card sits beside the field,
  // over the top of the Inspector, so its Controls are opened (a fold, not an edit) to bring the
  // heading and speed rows down clear of the card (issue #431).
  await editor(page, `m.setPrefs({ inspectorFolds: { "path.controls": true } })`);
  await page.getByTestId("step-main-toOtherSide").click();
  await expect(page.getByTestId("inspector-control-x-0-2")).toBeVisible();
  const scrubTo = await startScrub(page, "inspector-speed");
  await scrubTo(-20);
  await page.mouse.up();
  // An empty Speed scrubs from the robot's 80% default, five steps of 5% down.
  await expect.poll(async () => (await stepOf(page, "toOtherSide"))["speedFraction"]).toBeCloseTo(0.55, 6);

  // Its piecewise heading, split once more on the track, then a boundary dragged along the track.
  const track = page.getByTestId("heading-track");
  await track.click({ position: { x: 20, y: 6 } });
  await expect(page.getByTestId("heading-range-3")).toBeVisible();
  const boundary = page.getByTestId("heading-track-boundary-0");
  await expect(boundary).toBeVisible();
  await boundary.scrollIntoViewIfNeeded();
  const box = await boundary.boundingBox();
  if (box === null) throw new Error("the boundary is not on screen");
  const before = await autoJson(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  expect(await autoJson(page)).not.toBe(before);

  // The task's check would fill at once and the tour would move on 0.7 s later.
  await page.waitForTimeout(1000);
  await expect(card).toHaveAttribute("data-stop", "field");
  await expect(page.getByTestId("tour-task")).not.toHaveAttribute("data-done", "true");
});
