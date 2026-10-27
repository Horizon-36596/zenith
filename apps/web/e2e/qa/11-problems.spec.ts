/**
 * QA 11, the problems panel (UI_GUIDE section 9.7, site/docs/checks-and-findings.md): rows are not
 * tinted, the severity is the icon; the code chip has a tooltip that says what the code means and
 * how to fix it; clicking a row selects its step, and the selected step's rows show their fixes,
 * with no "How to fix" line (issue #413); the severity counts filter the list.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  canvasView,
  dragWorld,
  editor,
  findingRows,
  installCanvasProbe,
  knownBug,
  loadExample,
  nextFrame,
  polygonCentreIn,
  robotOutlines,
  shot,
  skipTour,
} from "./helpers";

/**
 * The example's autos validate clean. collect-and-score, the one it opens, raises one finding,
 * TIME_BUDGET on `total`, an info that is not on a step, which the panel does not list (issue #413).
 * Running its sweepGarden leg at 0.8 adds SWEEP_SPEED, a warning on a real step, so the panel has a
 * row to click.
 */
test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
  await page.evaluate(
    `import("/src/state/store.ts").then((m) => { const s = m.getState(); m.commit({ ...s.auto, steps: s.auto.steps.map((x) => x.id !== "sweepGarden" ? x : { ...x, speedFraction: 0.8 }) }); })`,
  );
  await expect(findingRows(page, "SWEEP_SPEED")).toHaveCount(1);
  await expect(findingRows(page, "TIME_BUDGET")).toHaveCount(0);
});

/** The findings the panel lists: every one but the time budget's info note. */
const findings = (page: Page) =>
  editor<Array<{ code: string; severity: string; stepId?: string; message: string }>>(
    page,
    `m.currentDerived().findings.filter((f) => !(f.code === "TIME_BUDGET" && f.severity === "info"))`,
  );

test("rows are not tinted by severity: an idle row has the panel's own background", async ({ page }) => {
  await page.mouse.move(2, 2);
  const colours = await page.getByTestId("finding-row").evaluateAll((rows) =>
    rows.map((row) => ({ severity: row.getAttribute("data-severity"), bg: getComputedStyle(row).backgroundColor, selected: row.getAttribute("data-selected") })),
  );
  expect(colours.length).toBeGreaterThan(0);
  for (const row of colours.filter((c) => c.selected !== "true")) {
    expect(row.bg, `${row.severity ?? ""} row`).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  }
  // The icon carries the colour instead, and differs by severity.
  const iconColours = await page.getByTestId("finding-row").evaluateAll((rows) =>
    Object.fromEntries(rows.map((row) => [row.getAttribute("data-severity"), getComputedStyle(row.querySelector("svg") as Element).color])),
  );
  const distinct = new Set(Object.values(iconColours));
  expect(distinct.size).toBe(Object.keys(iconColours).length);
  await shot(page, "11-problems");
});

test("every code chip has a tooltip with what it means and how to fix it", async ({ page }) => {
  const codes = await page.getByTestId("finding-code").allTextContents();
  const unique = [...new Set(codes.map((code) => code.trim()))];
  expect(unique.length).toBeGreaterThan(0);
  for (const code of unique) {
    const chip = page.getByTestId("finding-code").filter({ hasText: code }).first();
    await chip.hover();
    const tip = page.getByRole("tooltip");
    await expect(tip, `${code} tooltip`).toBeVisible();
    // Titled with the code it explains, then what it means and how to fix it as two paragraphs (K22).
    await expect(tip, `${code} tooltip names its code`).toContainText(`(${code})`);
    await expect(tip.locator("span").last(), `${code} tooltip has a how-to-fix`).toHaveText(/^To fix: /);
    await expect(tip).not.toContainText("How to fix:");
    await page.mouse.move(2, 2);
  }
  // The chip is focusable and its tooltip opens on keyboard focus as well.
  await page.getByTestId("finding-code").first().focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("finding-code").first()).toBeFocused();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await shot(page, "11-code-tooltip");
});

test("clicking a row selects its step and shows its whole message and its fixes, with no how-to line", async ({ page }) => {
  // SWEEP_SPEED on sweepGarden, from the beforeEach, is the finding on a real step to click.
  const ids = await editor<string[]>(page, "s.auto.steps.map((x) => x.id)");
  const all = await findings(page);
  const withStep = all.filter((finding) => finding.stepId !== undefined && ids.includes(finding.stepId));
  expect(withStep.length).toBeGreaterThan(0);
  await expect(page.getByTestId("finding-fixes")).toHaveCount(0);
  const target = withStep[0];
  const row = page.getByTestId("finding-row").filter({ hasText: target?.message.slice(0, 30) ?? "" }).first();
  await row.click();
  expect(await editor<string | undefined>(page, "s.selection.stepId")).toBe(target?.stepId);
  await expect(row).toHaveAttribute("data-selected", "true");
  await expect(row.getByTestId("finding-fixes")).toBeVisible();
  await expect(row).not.toContainText("How to fix");
  await expect(page.getByTestId(`step-row-${target?.stepId ?? ""}`)).toHaveAttribute("data-selected", "true");
  await shot(page, "11-problems-selected");
});

test("no finding the example raises has a How to fix line in its row, selected or not", async ({ page }) => {
  const all = await findings(page);
  for (const finding of all.filter((f) => f.stepId !== undefined)) {
    await page.evaluate(`import("/src/state/store.ts").then((m) => m.selectStep(${JSON.stringify(finding.stepId)}))`);
    // Two steps can raise the same message; the selected one is the row marked selected.
    const row = findingRows(page, finding.code).filter({ hasText: finding.message.slice(0, 30) });
    const selected = row.and(page.locator('[data-selected="true"]'));
    await expect(selected.first(), `${finding.code} on ${finding.stepId ?? ""}`).toBeVisible();
    await expect(selected.first()).not.toContainText("How to fix");
  }
});

test("a finding row can be selected from the keyboard", async ({ page }) => {
  const chip = page.getByTestId("finding-code").first();
  await chip.focus();
  const before = await editor<string | undefined>(page, "s.selection.stepId");
  await page.keyboard.press("Enter");
  const after = await editor<string | undefined>(page, "s.selection.stepId");
  expect(after).not.toBe(before);
  expect(after).toBeDefined();
});

test("the severity counts filter the list and toggle back", async ({ page }) => {
  const all = await findings(page);
  const severities = [...new Set(all.map((finding) => finding.severity))];
  for (const severity of severities) {
    const toggle = page.getByTestId(`findings-count-${severity}`);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    const shown = await page.getByTestId("finding-row").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-severity")));
    expect(new Set(shown)).toEqual(new Set([severity]));
    expect(shown.length).toBe(all.filter((finding) => finding.severity === severity).length);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
  }
  await expect(page.getByTestId("finding-row")).toHaveCount(all.length);
});

test("a start the rule refuses has a one-click fix that moves it to the nearest legal spot", async ({ page }) => {
  // In the middle of RED's own half, touching no wall: START_ILLEGAL on the start.
  await page.evaluate(
    `import("/src/state/store.ts").then((m) => { const s = m.getState(); m.commit({ ...s.auto, start: { ...s.auto.start, pose: { xIn: -36, yIn: 0, headingRad: 0, provenance: "SET BY HAND: test" } } }); })`,
  );
  const row = findingRows(page, "START_ILLEGAL");
  await expect(row.first()).toBeVisible();
  // The fixes are on the selected row only: clicking it selects the start.
  await row.first().getByTestId("finding-select").click();
  const fix = row.first().getByTestId("fix-moveStartToLegal");
  await expect(fix).toHaveText("Move start");
  await fix.click();

  await expect(findingRows(page, "START_ILLEGAL")).toHaveCount(0);
  await expect(page.getByTestId("status")).toContainText("Moved the start to the nearest legal spot");
  const pose = await editor<{ xIn: number; yIn: number; provenance: string }>(page, "s.auto.start.pose");
  expect(pose.provenance).toMatch(/^SET FROM EDITOR: the nearest legal start Zenith found/);
  // One undo puts the refused start back.
  await page.keyboard.press("Control+z");
  await expect(findingRows(page, "START_ILLEGAL").first()).toBeVisible();
});

/**
 * Issue #155, sweep finding N25. With the start dragged to (-40, -40), the fix used to move it to
 * (-42, -63) facing 90 degrees, and the tangent driveOut then turned the robot about 48 degrees
 * against the south wall: START_ILLEGAL became PERIMETER. Now it takes the nearest legal start where
 * the whole auto gains no new error.
 */
test("after the start is dragged to (-40, -40), the legal-start fix leaves no START_ILLEGAL and no PERIMETER on driveOut", async ({ page }) => {
  // The start mark sits on the start waypoint, (-13, -63), and carries driveOut's first point with it.
  await dragWorld(page, { xIn: -13, yIn: -63 }, { xIn: -40, yIn: -40 }, { steps: 12 });
  const dragged = await editor<{ xIn: number; yIn: number }>(page, "s.auto.start.pose");
  expect(Math.hypot(dragged.xIn + 40, dragged.yIn + 40)).toBeLessThan(1.5);
  const row = findingRows(page, "START_ILLEGAL");
  await expect(row).toHaveCount(1);
  await row.getByTestId("finding-select").click();
  await row.getByTestId("fix-moveStartToLegal").click();

  await expect(findingRows(page, "START_ILLEGAL")).toHaveCount(0);
  await expect(page.getByTestId("status")).toContainText("Moved the start to the nearest legal spot");
  const after = await findings(page);
  expect(after.filter((finding) => finding.code === "PERIMETER" && finding.stepId === "driveOut")).toEqual([]);
  expect(after.filter((finding) => finding.severity === "error").map((finding) => finding.code)).toEqual([]);
  await shot(page, "11-legal-start-fix");
});

/** Puts the start in the middle of RED's own half, touching no wall: START_ILLEGAL on the start. */
const refuseTheStart = (page: Page) =>
  page.evaluate(
    `import("/src/state/store.ts").then((m) => { const s = m.getState(); m.commit({ ...s.auto, start: { ...s.auto.start, pose: { xIn: -36, yIn: 0, headingRad: 0, provenance: "SET BY HAND: test" } } }); })`,
  );

test("clicking the START_ILLEGAL row selects the start, pauses, and puts the playhead at 0", async ({ page }) => {
  await refuseTheStart(page);
  await page.evaluate(`import("/src/state/store.ts").then((m) => { m.setPlayback(4); m.setPlaying(true); })`);
  const row = findingRows(page, "START_ILLEGAL");
  await row.getByTestId("finding-select").click();

  expect(await editor(page, "s.selection")).toEqual({ start: true });
  expect(await editor(page, "s.playbackS")).toBe(0);
  expect(await editor(page, "s.playing")).toBe(false);
  await expect(row).toHaveAttribute("data-selected", "true");
  await expect(row.getByTestId("fix-moveStartToLegal")).toBeVisible();
  await expect(page.getByTestId("inspector").locator('section[data-fold="routine.start"]')).toBeVisible();
  await expect(page.getByTestId("inspector-empty")).toHaveCount(0);
});

test("while START_ILLEGAL stands, the canvas draws the start in the error colour, over the robot", async ({ page }) => {
  const canvas = page.getByTestId("field-canvas");
  await expect(canvas).toHaveAttribute("data-start-mark", "normal");
  await refuseTheStart(page);
  await expect(canvas).toHaveAttribute("data-start-mark", "error");
  await page.keyboard.press("Control+z");
  await expect(canvas).toHaveAttribute("data-start-mark", "normal");
});

test("the START_ILLEGAL outline is drawn over the robot at the start of playback", async ({ page }) => {
  await installCanvasProbe(page);
  await loadExample(page);
  await refuseTheStart(page);
  await page.evaluate(`import("/src/state/store.ts").then((m) => { m.setPlaying(false); m.setPlayback(0); })`);
  await expect(page.getByTestId("field-canvas")).toHaveAttribute("data-robot-pose", /^-36,0,/);
  const error = await page.evaluate(() => {
    const ctx = document.createElement("canvas").getContext("2d") as CanvasRenderingContext2D;
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--sev-error").trim();
    return String(ctx.strokeStyle);
  });
  const view = await canvasView(page);
  const frame = await nextFrame(page);
  // The robot box and the outline are both the 18 in square at (-36, 0): the last one drawn there wins.
  const onStart = frame.polygons.filter((polygon) => {
    const centre = polygonCentreIn(view, polygon.pts);
    return Math.hypot(centre.xIn + 36, centre.yIn) < 0.5 && robotOutlines({ ...frame, polygons: [polygon] }, view.pxPerIn).length === 1;
  });
  expect(onStart.length).toBeGreaterThan(2);
  expect(onStart[onStart.length - 1]).toMatchObject({ op: "stroke", style: error });
  await shot(page, "11-start-illegal");
});

/**
 * Issue #186, sweep finding N52. A path that starts away from where the robot is used to raise
 * CONTINUITY with no button, though its help spelled out the edit. Now the row offers "Start from
 * robot"; Problems is where this fix is offered, not the Steps panel.
 */
test("the CONTINUITY start-gap row in Problems shows a fix button, and it starts the path from where the robot is", async ({ page }) => {
  await page.evaluate(
    `import("/src/state/store.ts").then((m) => { const s = m.getState(); m.commit({ ...s.auto, steps: s.auto.steps.map((x) => x.id !== "toOtherSide" ? x : { ...x, segments: [{ ...x.segments[0], from: { xIn: -30, yIn: -20, provenance: "SET BY HAND: test" } }, ...x.segments.slice(1)] }) }); })`,
  );
  const row = findingRows(page, "CONTINUITY");
  await expect(row).toHaveCount(1);
  await row.getByTestId("finding-select").click();
  const fix = row.getByTestId("fix-startFromCurrent");
  await expect(fix).toHaveText("Start from robot");
  await fix.click();

  await expect(findingRows(page, "CONTINUITY")).toHaveCount(0);
  expect(await editor<unknown>(page, `s.auto.steps.find((x) => x.id === "toOtherSide").segments[0].from`)).toBe("current");
  await shot(page, "11-start-from-current-fix");
  // One undo puts the gap back.
  await page.keyboard.press("Control+z");
  await expect(findingRows(page, "CONTINUITY")).toHaveCount(1);
});
