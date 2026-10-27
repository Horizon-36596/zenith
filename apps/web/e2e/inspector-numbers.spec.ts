/**
 * Issue #314: an Inspector number field shows the number the file holds, and writes only real edits.
 *
 * - A typed value that the edit rounds or clamps back to the value already held (a count of 3.6
 *   kept as 4, a speed of 1.5 above its maximum of 1, a range end typed past its neighbour a second
 *   time) left the typed text on screen. The field now shows the stored number after every commit.
 * - Arrow presses added the step as a plain float sum, so three Up presses from 0.30 wrote
 *   0.44999999999999996. They now round to the field's decimals, as a drag does.
 * - Typing the value the field already holds pushed an empty undo step.
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

const stepOf = (page: Page, id: string) =>
  editor<Record<string, unknown>>(page, `s.auto.steps.find((x) => x.id === ${JSON.stringify(id)})`);

const undoLength = (page: Page) => editor<number>(page, "s.undo.length");

/** Types into a number field the way a student does: click, select all, type, Enter. */
async function typeInto(page: Page, testId: string, text: string): Promise<void> {
  const input = page.getByTestId(testId);
  await input.click();
  await input.selectText();
  await input.pressSequentially(text);
  await input.press("Enter");
}

test("a typed count that rounds back to the count it holds shows the whole count", async ({ page }) => {
  await loadExample(page);
  await page.evaluate(
    `import("/src/state/store.ts").then((m) => { const s = m.getState(); m.commit({ ...s.auto, steps: [...s.auto.steps, { id: "scoreFour", kind: "transfer", from: "robot", to: "hiveRedUpCell", expectedCount: 4 }] }); m.selectStep("scoreFour"); })`,
  );
  const expected = page.getByTestId("inspector-transfer-expected");
  await expect(expected).toHaveValue("4");
  const before = await undoLength(page);

  await typeInto(page, "inspector-transfer-expected", "3.6");
  await expect(expected).toHaveValue("4");
  expect((await stepOf(page, "scoreFour"))["expectedCount"]).toBe(4);
  // The file did not change, so neither did the history.
  expect(await undoLength(page)).toBe(before);

  await typeInto(page, "inspector-transfer-expected", "2.5");
  await expect(expected).toHaveValue("3");
  expect((await stepOf(page, "scoreFour"))["expectedCount"]).toBe(3);
});

test("a typed speed above its maximum is refused with the range, and the field keeps what the file holds", async ({ page }) => {
  await loadExample(page);
  await page.getByTestId("step-main-collectFlower").click();
  const speed = page.getByTestId("inspector-speed");
  await expect(speed).toHaveValue("30");

  await typeInto(page, "inspector-speed", "100");
  await expect(speed).toHaveValue("100");
  const before = await undoLength(page);

  // Issue #502: out of range is refused and said once, never written as the nearest end in silence.
  await typeInto(page, "inspector-speed", "150");
  await expect(speed).toHaveValue("100");
  await expect(page.getByTestId("status")).toContainText("Speed runs 1 to 100%.");
  expect((await stepOf(page, "collectFlower"))["speedFraction"]).toBe(1);
  expect(await undoLength(page)).toBe(before);

  await typeInto(page, "inspector-speed", "abc");
  await expect(speed).toHaveValue("100");
  await expect(page.getByTestId("status")).toContainText("Speed takes a number from 1 to 100%.");
  expect(await undoLength(page)).toBe(before);
});

test("a path position far off the field is refused with the field's range (issue #502)", async ({ page }) => {
  await loadExample(page);
  // driveOut ends on a waypoint; give it a literal pose so the Inspector has an x to type in.
  await page.evaluate(
    `import("/src/state/store.ts").then((m) => { const s = m.getState(); m.commit({ ...s.auto, steps: s.auto.steps.map((x) => x.id !== "driveOut" ? x : { ...x, segments: x.segments.map((seg) => ({ ...seg, to: { xIn: -13, yIn: -36, headingRad: 1.5708, provenance: "SET BY HAND: e2e" } })) }) }); })`,
  );
  await page.getByTestId("step-main-driveOut").click();
  const x = page.getByTestId("inspector-to-x-0");
  await expect(x).toHaveValue("-13.00");
  const before = await x.inputValue();
  await typeInto(page, "inspector-to-x-0", "99999");
  await expect(x).toHaveValue(before);
  await expect(page.getByTestId("status")).toContainText(/Position x runs -\d+ to \d+ in\./);
  // A field opens its tooltip on hover only while it does not have focus.
  await x.blur();
  await page.mouse.move(0, 0);
  await x.hover();
  await expect(page.locator('[role="tooltip"]')).toContainText(/Runs -\d+ to \d+ in\./);
});

test("a piecewise range end typed past its neighbour shows the boundary it stores, every time", async ({ page }) => {
  await loadExample(page);
  await page.getByTestId("step-main-driveOut").click();
  await page.getByTestId("inspector-heading-mode").click();
  await page.getByTestId("inspector-heading-mode-option-piecewise").click();
  await page.getByTestId("heading-range-0-split").click();
  await expect(page.getByTestId("heading-range-1")).toBeVisible();
  // A range's rows unfold from its row (issue #431).
  await page.getByTestId("heading-range-0-toggle").click();
  const end = page.getByTestId("heading-range-0-end");
  await expect(end).toHaveValue("50");

  // The last range keeps 2% of the path, so the boundary stops at 98%, the first time and again.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await typeInto(page, "heading-range-0-end", "99");
    await expect(end).toHaveValue("98");
  }
  const stored = (await stepOf(page, "driveOut")) as { heading: { ranges: Array<{ endT: number }> } };
  expect(stored.heading.ranges[0]?.endT).toBeCloseTo(0.98, 9);
});

test("arrow presses on a speed store the value the field shows, with no float drift", async ({ page }) => {
  await loadExample(page);
  await page.getByTestId("step-main-collectFlower").click();
  const speed = page.getByTestId("inspector-speed");
  await expect(speed).toHaveValue("30");

  await speed.click();
  for (let press = 0; press < 3; press += 1) await speed.press("ArrowUp");
  await expect(speed).toHaveValue("45");
  await expect.poll(async () => (await stepOf(page, "collectFlower"))["speedFraction"]).toBe(0.45);
});

test("typing the value a field already holds, then leaving it, adds no undo step", async ({ page }) => {
  await loadExample(page);
  await page.getByTestId("step-main-collectFlower").click();
  const speed = page.getByTestId("inspector-speed");
  await expect(speed).toHaveValue("30");
  const before = await undoLength(page);

  for (const text of ["30", "30.0"]) {
    await typeInto(page, "inspector-speed", text);
    await expect(speed).toHaveValue("30");
  }
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  expect(await undoLength(page)).toBe(before);
  expect((await stepOf(page, "collectFlower"))["speedFraction"]).toBe(0.3);
});
