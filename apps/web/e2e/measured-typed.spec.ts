/**
 * Issue #273, the owner's rulings of 2026-10-10 on #200 for the Inspector.
 *
 * - measured-typed (b): a number typed for a waypoint in the Waypoints list, for a path point or for
 *   the start whose label is MEASURED (or CALIBRATED FROM ROBOT) warns "This changes MEASURED to SET
 *   FROM EDITOR" on the status line and relabels it, and one click on the chip opens the provenance
 *   menu, so MEASURED can be chosen again in one step. The click that leaves the number being typed in
 *   is the click on the chip: the leave commits the number and relabels, and the chip still opens.
 * - envelope-partners: adding an envelope (the Envelope row in More) comes with the Commands switch
 *   and is hidden while it is off; an envelope the step already has always shows.
 */
import { expect, test, type Page } from "@playwright/test";
import { editor, loadExample, openMore, selectStep, skipTour, waitForFonts } from "./qa/helpers";
import { VIEWPORT } from "./viewports";

test.use({ viewport: VIEWPORT });

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
  await waitForFonts(page);
});

const WARNING = "This changes MEASURED to SET FROM EDITOR";

const waypointLabel = (page: Page, name: string): Promise<string> =>
  editor<string>(page, `s.project.waypoints.waypoints.${name}.provenance`);

/**
 * Opens "Other waypoints" in the Waypoints list: park is not followed by the open auto, so its row
 * sits in that group, which starts closed (issue #217).
 */
async function openOtherWaypoints(page: Page): Promise<void> {
  const others = page.getByTestId("inspector-waypoints-others");
  await expect(others).toBeVisible();
  if ((await others.getAttribute("aria-expanded")) === "false") await others.click();
}

/** Labels a waypoint by hand through the store, as the chip's menu would. */
async function labelWaypoint(page: Page, name: string, provenance: string): Promise<void> {
  await page.evaluate(
    `import("/src/app/waypointEdits.ts").then((m) => m.writeWaypointProvenance(${JSON.stringify(name)}, ${JSON.stringify(provenance)}))`,
  );
}

/** The example's path ends are waypoints; this gives driveOut's end a pose of its own, labelled `provenance`. */
async function literalDriveOutEnd(page: Page, provenance: string): Promise<void> {
  await page.evaluate(
    `import("/src/state/store.ts").then((m) => { const s = m.getState(); m.commit({ ...s.auto, steps: s.auto.steps.map((x) => x.id !== "driveOut" ? x : { ...x, segments: x.segments.map((seg) => ({ ...seg, to: { xIn: -12, yIn: -36, headingRad: 1.5708, provenance: ${JSON.stringify(provenance)} } })) }) }); m.selectStep("driveOut"); })`,
  );
  await expect(page.getByTestId("inspector-to-x-0")).toHaveValue("-12.00");
}

const driveOutEnd = (page: Page): Promise<{ xIn: number; provenance: string }> =>
  editor(page, `s.auto.steps.find((x) => x.id === "driveOut").segments[0].to`);

test("typing x into a MEASURED waypoint's row warns, relabels it, and one click on its chip offers MEASURED back", async ({ page }) => {
  await labelWaypoint(page, "park", "MEASURED: tape, 2026-09-30");
  const undoBefore = await editor<number>(page, "s.undo.length");

  // park's row is not the selected one, and first-auto does not follow it, so it is under Other
  // waypoints (issue #217). Its press selects it, so the row says what typing does (decision D12,
  // issue #291) before the number is committed.
  await openOtherWaypoints(page);
  await page.getByTestId("inspector-waypoint-park-x").click();
  await expect(page.getByTestId("inspector-waypoint-measured-notice")).toHaveText(`${WARNING} if you change a number here.`);
  const field = page.getByTestId("inspector-waypoint-x");
  await field.fill("-30");
  await field.press("Enter");

  await expect(page.getByTestId("status")).toContainText(`${WARNING} on waypoint park.`);
  expect(await waypointLabel(page, "park")).toBe("SET FROM EDITOR");
  expect(await editor<number>(page, "s.project.waypoints.waypoints.park.xIn")).toBe(-30);
  expect(await editor<number>(page, "s.undo.length")).toBe(undoBefore + 1);

  // The warning points at the label, so the row opens to its chip.
  await expect.poll(() => editor(page, "s.selection")).toEqual({ waypoint: "park" });
  const chip = page.getByTestId("inspector-waypoint-provenance");
  await expect(chip).toHaveText("From editor");

  // One click opens the menu, with the new label checked, and choosing Measured is the one step back.
  await chip.click();
  const menu = page.getByTestId("inspector-waypoint-provenance-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitemradio", { checked: true })).toHaveText("Set from editor");
  await menu.getByRole("menuitemradio", { name: "Measured" }).click();
  await expect(chip).toHaveText("Measured");
  expect(await waypointLabel(page, "park")).toBe("MEASURED");
  expect(await editor<number>(page, "s.project.waypoints.waypoints.park.xIn")).toBe(-30);
});

test("the click on a waypoint's chip that leaves a number being typed relabels it and still opens the menu", async ({ page }) => {
  await labelWaypoint(page, "scoreSouth", "MEASURED");
  await page.getByTestId("inspector-waypoint-row-scoreSouth").click();
  await expect(page.getByTestId("inspector-waypoint-provenance")).toHaveText("Measured");

  // Typing without Enter: the press on the chip is what leaves the field and commits the number.
  const field = page.getByTestId("inspector-waypoint-y");
  await field.click();
  await field.fill("-20");
  const chip = page.getByTestId("inspector-waypoint-provenance");
  await chip.click();

  await expect(page.getByTestId("inspector-waypoint-provenance-menu")).toBeVisible();
  await expect(chip).toHaveText("From editor");
  expect(await editor<number>(page, "s.project.waypoints.waypoints.scoreSouth.yIn")).toBe(-20);
  await expect(page.getByTestId("status")).toContainText(`${WARNING} on waypoint scoreSouth.`);
  await page.getByTestId("inspector-waypoint-provenance-menu").getByRole("menuitemradio", { name: "Measured" }).click();
  expect(await waypointLabel(page, "scoreSouth")).toBe("MEASURED");
});

test("a number typed on a waypoint with any other label keeps it and says nothing", async ({ page }) => {
  await labelWaypoint(page, "park", "SET BY HAND: chosen");
  await openOtherWaypoints(page);
  const field = page.getByTestId("inspector-waypoint-park-x");
  await field.click();
  await field.fill("-31");
  await field.press("Enter");
  await expect.poll(() => editor<number>(page, "s.project.waypoints.waypoints.park.xIn")).toBe(-31);
  expect(await waypointLabel(page, "park")).toBe("SET BY HAND: chosen");
  await expect(page.getByTestId("status").filter({ hasText: "This changes" })).toHaveCount(0);
  // Nothing opened the row either.
  expect(await editor(page, "s.selection")).not.toEqual({ waypoint: "park" });
});

test("typing x into a MEASURED path point warns, relabels it, and one click on its chip offers MEASURED back", async ({ page }) => {
  await literalDriveOutEnd(page, "MEASURED: tape, 2026-09-30");
  const chip = page.getByTestId("inspector-to-provenance-0");
  await expect(chip).toHaveText("Measured");

  const field = page.getByTestId("inspector-to-x-0");
  await field.click();
  await field.fill("-10");
  // The press on the chip leaves the field: no Enter, no second click.
  await chip.click();

  await expect(page.getByTestId("inspector-to-provenance-0-menu")).toBeVisible();
  await expect(chip).toHaveText("From editor");
  await expect(page.getByTestId("status")).toContainText(`${WARNING} on point 1 of driveOut.`);
  expect(await driveOutEnd(page)).toMatchObject({ xIn: -10, provenance: "SET FROM EDITOR" });

  await page.getByTestId("inspector-to-provenance-0-menu").getByRole("menuitemradio", { name: "Measured" }).click();
  await expect(chip).toHaveText("Measured");
  expect(await driveOutEnd(page)).toMatchObject({ xIn: -10, provenance: "MEASURED" });

  // Ctrl+Z takes the label back to what the typed number replaced, and the number with it.
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  expect(await driveOutEnd(page)).toMatchObject({ xIn: -12, provenance: "MEASURED: tape, 2026-09-30" });
});

test("a number typed on a path point with any other label keeps it and says nothing", async ({ page }) => {
  await literalDriveOutEnd(page, "SET BY HAND: chosen");
  const field = page.getByTestId("inspector-to-y-0");
  await field.click();
  await field.fill("-34");
  await field.press("Enter");
  await expect.poll(() => driveOutEnd(page)).toMatchObject({ provenance: "SET BY HAND: chosen" });
  expect(await editor<number>(page, `s.auto.steps.find((x) => x.id === "driveOut").segments[0].to.yIn`)).toBe(-34);
  await expect(page.getByTestId("status").filter({ hasText: "This changes" })).toHaveCount(0);
});

test("typing into a CALIBRATED FROM ROBOT start warns, relabels it, and one click on its chip offers the label back", async ({ page }) => {
  await page.evaluate(
    `import("/src/state/store.ts").then((m) => { const s = m.getState(); m.commit({ ...s.auto, start: { ...s.auto.start, pose: { xIn: -12, yIn: -63, headingRad: 1.5708, provenance: "CALIBRATED FROM ROBOT" } } }); m.setSelection({ start: true }); })`,
  );
  const chip = page.getByTestId("inspector-start-provenance");
  await expect(chip).toHaveText("Calib. robot");

  const field = page.getByTestId("inspector-start-x");
  await field.click();
  await field.fill("-14");
  await field.press("Enter");
  await expect(page.getByTestId("status")).toContainText("This changes CALIBRATED FROM ROBOT to SET FROM EDITOR on the start.");
  await expect(chip).toHaveText("From editor");
  expect(await editor(page, "s.auto.start.pose")).toEqual({ xIn: -14, yIn: -63, headingRad: 1.5708, provenance: "SET FROM EDITOR" });

  await chip.click();
  const menu = page.getByTestId("inspector-start-provenance-menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitemradio", { name: "Calibrated from robot" }).click();
  await expect(chip).toHaveText("Calib. robot");
  expect(await editor(page, "s.auto.start.pose")).toEqual({ xIn: -14, yIn: -63, headingRad: 1.5708, provenance: "CALIBRATED FROM ROBOT" });
});

test("typing the start's heading on a MEASURED start relabels it too", async ({ page }) => {
  await page.evaluate(
    `import("/src/state/store.ts").then((m) => { const s = m.getState(); m.commit({ ...s.auto, start: { ...s.auto.start, pose: { xIn: -12, yIn: -63, headingRad: 1.5708, provenance: "MEASURED" } } }); m.setSelection({ start: true }); })`,
  );
  const field = page.getByTestId("inspector-start-h");
  await field.click();
  await field.fill("45");
  await field.press("Enter");
  await expect(page.getByTestId("status")).toContainText(`${WARNING} on the start.`);
  await expect(page.getByTestId("inspector-start-provenance")).toHaveText("From editor");
});

/** The Envelope row's buttons, in Advanced (issue #431). */
const entryButtons = (page: Page) => page.getByTestId("inspector").locator('section[data-fold="step.more"]').locator('[data-testid^="inspector-envelope-"]');

test("with Commands off Advanced has no Envelope row, and an envelope the step has still shows; with it on, the row is in Advanced", async ({ page }) => {
  await selectStep(page, "driveOut");
  await openMore(page);
  await expect(page.getByTestId("inspector-envelope-draw")).toBeVisible();
  await expect(page.getByTestId("inspector-envelope-add")).toBeVisible();

  // The switch is live: no reload, and no file changes.
  await page.evaluate(`import("/src/state/features.ts").then((m) => m.setFeature("commands", false))`);
  await expect(page.getByTestId("inspector-timeout")).toBeVisible();
  await expect(entryButtons(page)).toHaveCount(0);
  await expect(page.getByTestId("inspector-envelope-draw")).toHaveCount(0);
  await expect(page.getByTestId("inspector-envelope-add")).toHaveCount(0);
  // A path with nothing rare left has no Advanced at all: its time limit is in Speed (issue #431).
  await expect(page.locator('section[data-fold="step.more"]')).toHaveCount(0);
  await expect(page.locator('section[data-fold="path.speed"]').getByTestId("inspector-timeout")).toBeVisible();

  // An envelope the file already has is its own section, and every row of it edits.
  await page.evaluate(
    `import("/src/state/store.ts").then((m) => { const s = m.getState(); m.commit({ ...s.auto, steps: s.auto.steps.map((x) => x.id !== "driveOut" ? x : { ...x, envelope: { polygon: [{ xIn: -30, yIn: -50 }, { xIn: -10, yIn: -50 }, { xIn: -10, yIn: -30 }, { xIn: -30, yIn: -30 }], maxDurationS: 3, provenance: "SET BY HAND: e2e envelope" } }) }); })`,
  );
  const envelope = page.getByTestId("inspector").locator('section[data-fold="envelope"]');
  await expect(envelope).toBeVisible();
  await expect(envelope.getByTestId("inspector-envelope-seconds")).toHaveValue("3.0");
  await expect(envelope.getByTestId("inspector-envelope-remove")).toBeVisible();
  await expect(page.getByTestId("inspector-envelope-draw")).toHaveCount(0);
  // Its inline short chip opens the provenance menu in one click.
  await envelope.getByTestId("inspector-envelope-provenance").click();
  await expect(page.getByTestId("inspector-envelope-provenance-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("inspector-envelope-provenance-menu")).toHaveCount(0);

  // A step with none offers nothing while Commands is off, and offers the row again once it is on.
  await selectStep(page, "toOtherSide");
  await expect(page.getByTestId("inspector-envelope-draw")).toHaveCount(0);
  await expect(page.getByTestId("inspector-envelope-add")).toHaveCount(0);
  await page.evaluate(`import("/src/state/features.ts").then((m) => m.setFeature("commands", true))`);
  await expect(page.getByTestId("inspector-envelope-draw")).toBeVisible();
  await expect(page.getByTestId("inspector-envelope-add")).toBeVisible();
});

test("Partner sharing does not bring the Envelope row back while Commands is off", async ({ page }) => {
  await page.evaluate(`import("/src/state/features.ts").then((m) => m.setFeatures({ partners: true, ledger: true, commands: false, optimizer: true }))`);
  await selectStep(page, "driveOut");
  await openMore(page);
  await expect(page.getByTestId("inspector-timeout")).toBeVisible();
  await expect(page.getByTestId("inspector-envelope-draw")).toHaveCount(0);
});
