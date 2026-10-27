/**
 * Decision D12, "select first" (issue #291): with Protect measured waypoints on, a pin labelled
 * MEASURED or CALIBRATED FROM ROBOT does not move on its first press. That press only selects it and
 * the status line says so; the next press-drag moves it and the label becomes SET FROM EDITOR. Other
 * pins drag at once. Typing a number in the Inspector stays allowed, and the Inspector says what it
 * relabels before the number is committed. With the setting off a measured pin drags on the first
 * press, as it did before.
 */
import { expect, test, type Page } from "@playwright/test";
import { editor, loadExample, skipTour, waitForFonts, worldToScreen } from "./qa/helpers";
import { VIEWPORT } from "./viewports";

test.use({ viewport: VIEWPORT });

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
  // The open auto does not follow park, so its pin is drawn and pressed only with every pin shown
  // (issue #217); the rule under test is about the press, not about which pins show.
  await page.evaluate(`import("/src/state/store.ts").then((m) => m.setWaypointPins("all"))`);
  await waitForFonts(page);
});

const PARK = { xIn: -40, yIn: -36 };

const park = (page: Page): Promise<{ xIn: number; yIn: number; provenance: string }> =>
  editor(page, "s.project.waypoints.waypoints.park");

/** Labels a waypoint by hand through the store, as the chip's menu would. */
async function label(page: Page, name: string, provenance: string): Promise<void> {
  await page.evaluate(
    `import("/src/app/waypointEdits.ts").then((m) => m.writeWaypointProvenance(${JSON.stringify(name)}, ${JSON.stringify(provenance)}))`,
  );
}

/** One press-drag on the canvas, from a field point to a spot 12 in to its right, as a hand would. */
async function pressDrag(page: Page, from: { xIn: number; yIn: number }): Promise<void> {
  const a = await worldToScreen(page, from.xIn, from.yIn);
  const b = await worldToScreen(page, from.xIn + 12, from.yIn);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 5 });
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
}

test("dragging an unselected measured pin does not move it, selects it and says why; the next drag moves it", async ({ page }) => {
  await label(page, "park", "MEASURED: tape, 2026-09-30");
  await page.evaluate(`import("/src/state/store.ts").then((m) => { m.setSelection({}); m.clearStatus(); })`);
  const undoBefore = await editor<number>(page, "s.undo.length");
  const bytesBefore = await editor<string>(page, "JSON.stringify(s.project.waypoints)");

  await pressDrag(page, PARK);
  expect(await editor<string>(page, "JSON.stringify(s.project.waypoints)")).toBe(bytesBefore);
  expect(await editor<number>(page, "s.undo.length")).toBe(undoBefore);
  expect(await editor(page, "s.selection")).toEqual({ waypoint: "park" });
  await expect(page.getByTestId("status")).toContainText("Waypoint park is MEASURED, so the first press only selected it.");

  // The pin is selected now, so the next press-drag moves it, and the label is the editor's.
  await pressDrag(page, PARK);
  await expect.poll(async () => (await park(page)).xIn).toBeGreaterThan(PARK.xIn + 5);
  expect((await park(page)).provenance).toBe("SET FROM EDITOR");
  await expect(page.getByTestId("status")).toContainText("which was MEASURED");
});

test("a pin with any other label drags on the first press", async ({ page }) => {
  await page.evaluate(`import("/src/state/store.ts").then((m) => m.setSelection({}))`);
  await pressDrag(page, PARK);
  await expect.poll(async () => (await park(page)).xIn).toBeGreaterThan(PARK.xIn + 5);
  expect((await park(page)).provenance).toBe("SET FROM EDITOR");
});

test("with Protect measured waypoints off, a measured pin drags on the first press", async ({ page }) => {
  await page.evaluate(`import("/src/state/store.ts").then((m) => m.setSetting("editing.protectMeasuredPins", false))`);
  await label(page, "park", "MEASURED");
  await page.evaluate(`import("/src/state/store.ts").then((m) => m.setSelection({}))`);
  await pressDrag(page, PARK);
  await expect.poll(async () => (await park(page)).xIn).toBeGreaterThan(PARK.xIn + 5);
  expect((await park(page)).provenance).toBe("SET FROM EDITOR");
});

test("the Inspector says what typing relabels before it is committed, and the arrow keys move a selected measured pin", async ({ page }) => {
  await label(page, "park", "CALIBRATED FROM ROBOT: 3 runs");
  // Focusing a number on an unselected row selects it first, so the notice is up before anything is typed.
  const field = page.getByTestId("inspector-waypoint-park-x");
  await field.click();
  await expect(page.getByTestId("inspector-waypoint-measured-notice")).toHaveText(
    "This changes CALIBRATED FROM ROBOT to SET FROM EDITOR if you change a number here.",
  );
  expect((await park(page)).provenance).toBe("CALIBRATED FROM ROBOT: 3 runs");
  expect(await editor(page, "s.selection")).toEqual({ waypoint: "park" });

  // Typing still changes the pin and stamps SET FROM EDITOR, after the notice.
  const selectedField = page.getByTestId("inspector-waypoint-x");
  await selectedField.fill("-30");
  await selectedField.press("Enter");
  await expect.poll(async () => (await park(page)).xIn).toBe(-30);
  expect((await park(page)).provenance).toBe("SET FROM EDITOR");
  await expect(page.getByTestId("inspector-waypoint-measured-notice")).toHaveCount(0);

  // Back to a measured label, the selected pin takes the arrow keys.
  await label(page, "park", "MEASURED");
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await page.getByTestId("field-canvas").focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await park(page)).xIn).toBeCloseTo(-29.5, 6);
});

test("Settings, Editor, Editing has the switch, on by default, and it is kept in zenith.ui only", async ({ page }) => {
  await page.getByTestId("toolbar-settings").click();
  await page.getByTestId("settings-nav-editor").click();
  const row = page.getByTestId("settings-protect-measured-pins");
  await expect(row).toBeVisible();
  await expect(page.getByTestId("settings-protect-measured-pins-choice-on")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("settings-protect-measured-pins-choice-off").click();
  expect(await editor<boolean>(page, "s.prefs.protectMeasuredPins")).toBe(false);
  const stored = await page.evaluate(() => JSON.parse(window.localStorage.getItem("zenith.ui") ?? "{}") as Record<string, unknown>);
  expect(stored["protectMeasuredPins"]).toBe(false);
  expect(await editor<number>(page, "s.undo.length")).toBe(0);
});
