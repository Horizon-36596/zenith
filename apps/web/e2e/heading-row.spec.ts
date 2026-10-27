/**
 * Issue #147: a path point's heading row and R act on the step's heading mode instead of writing a
 * dead value. A path point's own headingRad turns nothing (the plan reads the heading mode alone),
 * so the inspector shows the heading the plan gives the robot there, read only, and R on a path
 * point turns the angle the heading arrow at that end turns, or, where the path decides the heading,
 * writes nothing and says so. The hover bubble reads the planned heading, and the Add path tool
 * writes no heading into the new path's end.
 *
 * "Load example" opens the starter's collect-and-score auto, where driveOut drives north from the
 * waypoint start, (-13, -63), to the waypoint scoreSouth, (-13, -36), with Heading: Tangent.
 */
import { expect, test, type Page } from "@playwright/test";
import { editor, installCanvasProbe, loadExample, nextFrame, selectStep, shot, skipTour, withCore, worldToScreen } from "./qa/helpers";

interface StepHeading {
  mode: string;
  headingRad?: number;
  fromRad?: number;
  toRad?: number;
}

const DEG = Math.PI / 180;
const DRIVE_OUT = 's.auto.steps.find((x) => x.id === "driveOut")';
const driveOutTo = (page: Page) => editor<unknown>(page, `${DRIVE_OUT}.segments[0].to`);
const driveOutHeading = (page: Page) => editor<StepHeading>(page, `${DRIVE_OUT}.heading`);
const plannedEnd = (page: Page) =>
  editor<number>(page, `m.currentDerived().plan.steps.find((x) => x.id === "driveOut").endPose.headingRad`);

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await installCanvasProbe(page);
  await loadExample(page);
});

async function pickMode(page: Page, mode: string): Promise<void> {
  await page.getByTestId("inspector-heading-mode").click();
  await page.getByTestId(`inspector-heading-mode-option-${mode}`).click();
  await expect(page.getByTestId("inspector-heading-mode")).toHaveAttribute("data-value", mode);
}

async function setNumber(page: Page, testId: string, value: number): Promise<void> {
  const input = page.getByTestId(testId);
  await input.fill(String(value));
  await input.press("Enter");
}

/** Selects driveOut and then its end dot, drawn on the scoreSouth pin, which the dot keeps. */
async function selectDriveOutEnd(page: Page): Promise<void> {
  await selectStep(page, "driveOut");
  const at = await worldToScreen(page, -13, -36);
  await page.mouse.click(at.x, at.y);
  await expect
    .poll(() => editor<unknown>(page, "s.selection.point"))
    .toEqual({ segmentIndex: 0, pointKind: "to" });
  await page.getByTestId("field-canvas").focus();
}

test("R on a Tangent path's end writes nothing, keeps its waypoint, and names Tangent", async ({ page }) => {
  await selectDriveOutEnd(page);
  await page.keyboard.press("r");
  await page.keyboard.press("r");
  await expect(page.getByTestId("status")).toContainText("driveOut's heading comes from Tangent");
  expect(await driveOutTo(page)).toEqual({ ref: "scoreSouth" });
  expect(await driveOutHeading(page)).toEqual({ mode: "tangent" });
  expect(await editor<number>(page, "s.undo.length")).toBe(0);
});

test("R on a Linear path's end turns its To by 5 degrees, and the planned end heading follows", async ({ page }) => {
  await selectStep(page, "driveOut");
  await pickMode(page, "linear");
  const before = await driveOutHeading(page);
  expect(before.mode).toBe("linear");
  await selectDriveOutEnd(page);
  await page.keyboard.press("r");
  await expect.poll(async () => (await driveOutHeading(page)).toRad ?? 0).toBeCloseTo((before.toRad ?? 0) + 5 * DEG, 6);
  expect((await driveOutHeading(page)).fromRad).toBe(before.fromRad);
  expect(await plannedEnd(page)).toBeCloseTo((before.toRad ?? 0) + 5 * DEG, 4);
  expect(await driveOutTo(page)).toEqual({ ref: "scoreSouth" });
  await expect(page.getByTestId("inspector-to-0-heading")).toHaveText("95.0°");
});

test("the selected To shows the planned heading as read-only text, while the start's heading stays editable", async ({ page }) => {
  await selectDriveOutEnd(page);
  const row = page.getByTestId("inspector-to-0-heading");
  // The angle alone; the mode is its tooltip and the row's hint (issue #409).
  await expect(row).toHaveText("90.0°");
  expect(await row.evaluate((node) => node.tagName)).toBe("SPAN");
  // What decides it is the row's hint (issue #241), not a sentence under the row.
  const hint = page.getByTestId("inspector-to-0-heading-row").locator("span[hidden]");
  await expect(hint).toHaveText(/^Set by Heading: Tangent\./);
  await expect(page.getByTestId("inspector-to-0-heading-source")).toHaveCount(0);
  await expect(page.getByTestId("inspector-to-h-0")).toHaveCount(0);

  // The pencil switches to Linear, starting from what the path does now, and opens its To under Heading.
  await page.getByTestId("inspector-to-0-heading-edit").click();
  await expect(page.getByTestId("inspector-heading-mode")).toHaveAttribute("data-value", "linear");
  await expect(page.getByTestId("inspector-to-0-heading")).toHaveText("90.0°");
  await expect(hint).toHaveText(/^Set by Heading: Linear, its To\./);
  await expect(page.getByTestId("inspector-heading-to")).toBeFocused();
  await setNumber(page, "inspector-heading-to", 120);
  await expect.poll(async () => (await driveOutHeading(page)).toRad ?? 0).toBeCloseTo(120 * DEG, 6);
  await expect(page.getByTestId("inspector-to-0-heading")).toHaveText("120.0°");
  expect(await driveOutTo(page)).toEqual({ ref: "scoreSouth" });
  await shot(page, "heading-row-linear-to");

  // The routine's start has a heading of its own, the one the robot sets up at, and keeps its field.
  await page.evaluate(`import("/src/state/store.ts").then((m) => m.setSelection({ start: true }))`);
  await page.getByTestId("inspector-start-source").selectOption("pose");
  await setNumber(page, "inspector-start-h", 45);
  await expect
    .poll(() => editor<number>(page, "s.auto.start.pose.headingRad"))
    .toBeCloseTo(45 * DEG, 6);
});

test("the pencil opens a folded Heading for now and leaves the person's fold remembered as folded", async ({ page }) => {
  await editor(page, `m.setPrefs({ inspectorFolds: { "path.heading": false } })`);
  await selectDriveOutEnd(page);
  const heading = page.locator('section[data-fold="path.heading"]').locator("button[aria-expanded]").first();
  await expect(heading).toHaveAttribute("aria-expanded", "false");
  await page.getByTestId("inspector-to-0-heading-edit").click();
  await expect(heading).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("inspector-heading-to")).toBeFocused();
  // Open for now only: the memory still says folded, so another path opens folded.
  expect(await editor<unknown>(page, `s.prefs.inspectorFolds["path.heading"]`)).toBe(false);
  await selectStep(page, "toOtherSide");
  await expect(heading).toHaveAttribute("aria-expanded", "false");
});

test("on a piecewise path, the pencil opens a folded Heading and the range deciding the end, and focuses its field", async ({ page }) => {
  // The range's rows mount only once Heading opens, so the range's open must wait for them.
  await editor(page, `m.setPrefs({ inspectorFolds: { "path.heading": false } })`);
  await editor(
    page,
    `m.commit({ ...s.auto, steps: s.auto.steps.map((x) => x.id === "driveOut" ? { ...x, heading: { mode: "piecewise", ranges: [
      { startT: 0, endT: 0.5, heading: { mode: "tangent" } },
      { startT: 0.5, endT: 1, heading: { mode: "constant", headingRad: 1 } } ] } } : x) })`,
  );
  await selectDriveOutEnd(page);
  const heading = page.locator('section[data-fold="path.heading"]').locator("button[aria-expanded]").first();
  await expect(heading).toHaveAttribute("aria-expanded", "false");
  await page.getByTestId("inspector-to-0-heading-edit").click();
  await expect(heading).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("heading-range-1-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("heading-range-0-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("heading-range-1-constant")).toBeFocused();
});

test("an Add path click writes no heading into the new path's end", async ({ page }) => {
  await selectStep(page, "driveOut");
  await page.getByTestId("field-canvas").focus();
  await page.keyboard.press("p");
  await expect.poll(() => editor<string>(page, "s.tool")).toBe("addPath");
  const at = await worldToScreen(page, 24, -48);
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => editor<number>(page, "s.auto.steps.length")).toBeGreaterThan(0);
  const added = await withCore<{ id: string; to: Record<string, unknown> }>(
    page,
    `(() => { const step = JSON.parse(c.canonicalize("auto", s.auto)).steps[1]; return { id: step.id, to: step.segments[0].to }; })()`,
  );
  expect(added.id).not.toBe("shootPreloads");
  expect(added.to).toMatchObject({ provenance: "SET FROM EDITOR" });
  expect(added.to).not.toHaveProperty("headingRad");
});

test("hovering a path point shows the planned heading in the bubble, not the point's own", async ({ page }) => {
  await selectStep(page, "driveOut");
  await pickMode(page, "constant");
  await setNumber(page, "inspector-heading-constant", 0);
  await expect.poll(async () => (await driveOutHeading(page)).headingRad).toBe(0);
  // driveOut's end follows scoreSouth, which faces 90 degrees; the robot faces 0 there now.
  const at = await worldToScreen(page, -13, -36);
  await page.mouse.move(at.x - 6, at.y);
  await page.mouse.move(at.x, at.y);
  await expect.poll(async () => (await nextFrame(page)).texts.some((text) => text.includes("driveOut · point 1"))).toBe(true);
  const texts = (await nextFrame(page)).texts;
  expect(texts.some((text) => text.includes("h 0.0°"))).toBe(true);
  expect(texts.some((text) => text.includes("h 90.0°"))).toBe(false);
});
