/**
 * The Optimize card (issue #308). On the example's collect-and-score, Optimize path from the palette
 * proposes a route for `toOtherSide`, which the field draws dashed in `--path-candidate`; Apply writes
 * it as one undo step, and one Undo gives back the identical auto. Discard and Esc leave the auto at
 * the same object. With the Optimize path switch off, the Inspector's button and the palette commands
 * are gone.
 *
 * The auto's canonical text and its object identity are read from the editor's own store module,
 * which the dev server hands the page at the same address the app imports it from.
 */
import { expect, test, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";
import { findingRows, useWideRoute } from "./qa/helpers";

const STEP = "toOtherSide";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
    }
    window.localStorage.removeItem("zenith.cloudFake");
  });
});

async function loadExample(page: Page): Promise<void> {
  await page.goto("/?cloud=fake");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId(`step-row-${STEP}`)).toBeVisible();
  await page.getByTestId(`step-row-${STEP}`).click();
}

/** The example with toOtherSide on the wide route, which has a faster one to find (issue #367). */
async function loadWideExample(page: Page): Promise<void> {
  await loadExample(page);
  await useWideRoute(page);
  await page.getByTestId(`step-row-${STEP}`).click();
}

/** A hash of the open auto's canonical text, from the editor's store (the Code tab's own `shaOf`). */
const autoText = (page: Page): Promise<string> =>
  page.evaluate(async () => {
    const store = (await import(/* @vite-ignore */ "/src/state/store.ts")) as { getState(): { auto: unknown } };
    const code = (await import(/* @vite-ignore */ "/src/panels/codeView.ts")) as { shaOf(auto: unknown): string };
    return code.shaOf(store.getState().auto);
  });

/** Keeps the open auto object on the window, to compare its identity later. */
const keepAuto = (page: Page): Promise<void> =>
  page.evaluate(async () => {
    const store = (await import(/* @vite-ignore */ "/src/state/store.ts")) as { getState(): { auto: unknown } };
    (window as unknown as { keptAuto: unknown }).keptAuto = store.getState().auto;
  });

const sameAuto = (page: Page): Promise<boolean> =>
  page.evaluate(async () => {
    const store = (await import(/* @vite-ignore */ "/src/state/store.ts")) as { getState(): { auto: unknown } };
    return (window as unknown as { keptAuto: unknown }).keptAuto === store.getState().auto;
  });

async function runFromPalette(page: Page, id: string, query: string): Promise<void> {
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill(query);
  await page.getByTestId(`palette-item-${id}`).click();
  await expect(page.getByTestId("optimize-card")).toBeVisible();
}

/** Waits for a result with a route to apply: the run's own, or the best so far at the 5 s safety stop. */
async function waitForRoute(page: Page): Promise<void> {
  const card = page.getByTestId("optimize-card");
  await expect(card).toHaveAttribute("data-phase", "result", { timeout: 60_000 });
  await expect(page.getByTestId("optimize-apply")).not.toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("optimize-apply")).toBeEnabled();
  await expect(page.getByTestId("field-canvas")).toHaveAttribute("data-candidate", STEP);
}

test("Optimize path from the palette draws the candidate, Apply changes the step, and one Undo restores the identical auto", async ({ page }) => {
  test.setTimeout(120_000);
  await loadWideExample(page);
  const before = await autoText(page);
  await runFromPalette(page, "path.optimize", "Optimize path");
  await expect(page.getByTestId("optimize-step")).toHaveText(STEP);
  await waitForRoute(page);

  // Both models' times, then, under What changes (closed at first), the closest clearance and the markers that move.
  await expect(page.getByTestId("optimize-time-sim")).toContainText("→");
  await expect(page.getByTestId("optimize-time-estimate")).toContainText("→");
  await expect(page.getByTestId("optimize-details")).not.toHaveAttribute("open", /.*/);
  await page.getByTestId("optimize-details").locator("summary").click();
  await expect(page.getByTestId("optimize-closest")).toContainText("Closest clearance:");
  await expect(page.getByTestId("optimize-markers")).toBeVisible();
  // The margin round nearby structures, and never more than one robot outline for the candidate.
  const canvas = page.getByTestId("field-canvas");
  expect(Number(await canvas.getAttribute("data-candidate-margins"))).toBeGreaterThan(0);
  expect(Number(await canvas.getAttribute("data-candidate-outlines"))).toBeLessThanOrEqual(1);
  // Nothing is written until Apply.
  expect(await autoText(page)).toBe(before);

  await page.getByTestId("optimize-apply").click();
  await expect(page.getByTestId("optimize-card")).toHaveCount(0);
  await expect(page.getByTestId("status")).toContainText(`Optimized ${STEP}:`);
  await expect(canvas).not.toHaveAttribute("data-candidate", /.*/);
  const after = await autoText(page);
  expect(after).not.toBe(before);

  await page.getByTestId("toolbar-edit.undo").click();
  expect(await autoText(page)).toBe(before);
});

test("Discard and Esc leave the auto at the same object, and nothing is written", async ({ page }) => {
  test.setTimeout(120_000);
  await loadWideExample(page);
  await keepAuto(page);
  const before = await autoText(page);

  // The palette's Optimize path runs it at once (the Inspector has no button since issue #409).
  await runFromPalette(page, "path.optimize", "Optimize path");
  await waitForRoute(page);
  await page.getByTestId("optimize-discard").click();
  await expect(page.getByTestId("optimize-card")).toHaveCount(0);
  await expect(page.getByTestId("field-canvas")).not.toHaveAttribute("data-candidate", /.*/);
  expect(await sameAuto(page)).toBe(true);

  // With options, the card waits for Run; Esc closes it.
  await runFromPalette(page, "path.optimizeWithOptions", "Optimize path with options");
  await expect(page.getByTestId("optimize-card")).toHaveAttribute("data-phase", "options");
  await expect(page.getByTestId("optimize-margin")).toHaveValue("1.00");
  await page.getByTestId("optimize-run").click();
  await waitForRoute(page);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("optimize-card")).toHaveCount(0);
  expect(await sameAuto(page)).toBe(true);
  expect(await autoText(page)).toBe(before);
});

test("the card's heading holds start off, remember a typed length and run with it (issue #448)", async ({ page }) => {
  test.setTimeout(120_000);
  await loadWideExample(page);
  await runFromPalette(page, "path.optimizeWithOptions", "Optimize path with options");
  const card = page.getByTestId("optimize-card");
  await expect(card).toHaveAttribute("data-phase", "options");
  const holdEnd = page.getByTestId("optimize-optimizeHoldEndHeadingIn");
  await expect(page.getByTestId("optimize-optimizeHoldStartHeadingIn")).toHaveValue("0");
  await expect(holdEnd).toHaveValue("0");
  await holdEnd.fill("12");
  await holdEnd.press("Enter");
  await expect
    .poll(() => page.evaluate(() => (JSON.parse(window.localStorage.getItem("zenith.ui") ?? "{}") as Record<string, unknown>)["optimizeHoldEndHeadingIn"]))
    .toBe(12);
  await page.getByTestId("optimize-run").click();
  await expect(card).toHaveAttribute("data-phase", "result", { timeout: 60_000 });
});

test("Enter applies the result from the card, and Enter in the margin field does not", async ({ page }) => {
  test.setTimeout(120_000);
  await loadWideExample(page);
  const before = await autoText(page);
  await runFromPalette(page, "path.optimizeWithOptions", "Optimize path with options");
  const card = page.getByTestId("optimize-card");
  await expect(card).toHaveAttribute("data-phase", "options");
  // Enter in the margin field belongs to the field: it neither applies nor closes the card.
  await page.getByTestId("optimize-margin").focus();
  await page.keyboard.press("Enter");
  await expect(card).toBeVisible();
  await page.getByTestId("optimize-run").click();
  await waitForRoute(page);
  // The options fold away once a run starts; opening them shows the margin field again.
  await page.getByTestId("optimize-options").locator("summary").click();
  await page.getByTestId("optimize-margin").focus();
  await expect(page.getByTestId("optimize-margin")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(card).toBeVisible();
  expect(await autoText(page)).toBe(before);

  // On the card itself, Enter is Apply.
  await card.focus();
  await page.keyboard.press("Enter");
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("status")).toContainText(`Optimized ${STEP}:`);
  expect(await autoText(page)).not.toBe(before);
});

test("with Optimize path off, the Inspector's button and the palette commands are absent", async ({ page }) => {
  await turnOnFeatures(page, { commands: true });
  await loadExample(page);
  await expect(page.getByTestId(`step-row-${STEP}`)).toBeVisible();
  await expect(page.getByTestId("inspector")).toBeVisible();
  await expect(page.getByTestId("inspector-optimize")).toHaveCount(0);
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Optimize path");
  await expect(page.getByTestId("palette-item-path.optimize")).toHaveCount(0);
  await expect(page.getByTestId("palette-item-path.optimizeWithOptions")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("optimize-card")).toHaveCount(0);
});

/**
 * Finding actions (issue #309). A route that drives into the hive frame's legs raises STRUCTURE, whose
 * row offers "Route around <the leg>"; a heading held at a fixed angle on a path raises
 * STRAFE_FRACTION, whose row offers "Find a faster heading". Each button opens the Optimize card on its
 * step in the right mode, and runs at once.
 */

/** Rewrites one step of the open auto through the editor's own `commit`, so the checks run on the result. */
async function rewriteStep(page: Page, stepId: string, rewrite: string): Promise<void> {
  await page.evaluate(
    `import("/src/state/store.ts").then((m) => {
      const s = m.getState();
      const rewrite = ${rewrite};
      m.commit({ ...s.auto, steps: s.auto.steps.map((step) => (step.id === ${JSON.stringify(stepId)} ? rewrite(step) : step)) });
    })`,
  );
}

/** The hive-clipping fixture: toOtherSide's first two curve controls moved in to x = -9, under the hive and into the frame's legs. */
const clipTheHive = (page: Page): Promise<void> =>
  rewriteStep(
    page,
    STEP,
    `(step) => ({ ...step, segments: [{ ...step.segments[0], control: step.segments[0].control.map((c, i) => (i < 2 ? { ...c, xIn: -9 } : c)) }] })`,
  );

test("a STRUCTURE finding on a route that clips the hive offers Route around it, which opens the card in Route around mode", async ({ page }) => {
  test.setTimeout(120_000);
  await loadExample(page);
  await clipTheHive(page);

  // The route clips the frame's west base bar and two legs, one row each.
  const rows = findingRows(page, "STRUCTURE");
  await expect(rows.filter({ hasText: "south-west leg of the hive frame" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "west base bar of the hive frame" })).toHaveCount(1);
  // The fixes are on the selected rows, and say a verb and a noun. One Route around serves the
  // step: the first row has it and the others say so (K20).
  const structure = rows.first();
  await expect(structure).toContainText("west base bar of the hive frame");
  await structure.getByTestId("finding-select").click();
  await expect(rows.getByTestId("fix-optimizeRoute")).toHaveCount(1);
  const button = structure.getByTestId("fix-optimizeRoute");
  await expect(button).toHaveText("Route around");
  await expect(rows.filter({ hasText: "south-west leg of the hive frame" }).getByTestId("finding-nofix")).toHaveText(
    "Route around on this step's first structure row goes round this one too.",
  );
  const before = await autoText(page);
  await button.click();

  const card = page.getByTestId("optimize-card");
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-mode", "routeAround");
  await expect(page.getByTestId("optimize-step")).toHaveText(STEP);
  await expect(page.getByTestId("optimize-action")).toHaveText("Route around the west base bar of the hive frame");
  // It runs at once, and nothing is written until Apply.
  await expect(card).not.toHaveAttribute("data-phase", "options");
  await expect(card).toHaveAttribute("data-phase", "result", { timeout: 60_000 });
  expect(await autoText(page)).toBe(before);
  await page.getByTestId("optimize-discard").click();
  await expect(card).toHaveCount(0);
  expect(await autoText(page)).toBe(before);
});

test("a STRAFE_FRACTION finding offers Find a faster heading, which keeps the path's segments as written", async ({ page }) => {
  test.setTimeout(120_000);
  await loadExample(page);
  await rewriteStep(page, "driveOut", `(step) => ({ ...step, heading: { mode: "constant", headingRad: 0 } })`);
  const segments = (): Promise<string> =>
    page.evaluate(`import("/src/state/store.ts").then((m) => JSON.stringify(m.getState().auto.steps.find((s) => s.id === "driveOut").segments))`) as Promise<string>;
  const written = await segments();

  const strafe = findingRows(page, "STRAFE_FRACTION").filter({ hasText: "driveOut" });
  await expect(strafe).toHaveCount(1);
  await strafe.getByTestId("finding-select").click();
  const button = strafe.getByTestId("fix-optimizeRoute");
  await expect(button).toHaveText("Find faster heading");
  await button.click();

  const card = page.getByTestId("optimize-card");
  await expect(card).toHaveAttribute("data-mode", "headingOnly");
  await expect(page.getByTestId("optimize-step")).toHaveText("driveOut");
  await expect(card).toHaveAttribute("data-phase", "result", { timeout: 60_000 });
  await expect(page.getByTestId("optimize-apply")).toBeEnabled();
  await page.getByTestId("optimize-apply").click();
  await expect(card).toHaveCount(0);
  expect(await segments()).toBe(written);
  await expect(findingRows(page, "STRAFE_FRACTION")).toHaveCount(0);
});

/**
 * A step through the hive frame (issue #388). A path that goes through a structure was never a route
 * the robot could drive, so plain Optimize path, from any entry point, proposes the fastest clear route
 * even when it is slower and says what the original goes through; with no clear route between the
 * step's ends it says that instead of "no faster route", and Optimize every path counts a cleared step
 * apart from the time saved.
 */

const PAST_THE_HIVE = "pastTheHive";

/** One path from south of the hive frame's west base bar to north of it, straight along the bar and so through it. */
const throughTheHive = {
  $schema: "https://libraries.horizon36596.org/zenith/schema/v1/auto.json",
  formatVersion: 4,
  name: "through-the-hive",
  alliance: "RED",
  start: { pose: { xIn: -23.65, yIn: -40, headingRad: 1.5708 } },
  steps: [
    {
      id: PAST_THE_HIVE,
      kind: "path",
      segments: [{ kind: "line", from: "current", to: { xIn: -23.65, yIn: 40 } }],
      heading: { mode: "constant", headingRad: 1.5708 },
    },
  ],
};

/** Replaces the open auto with `throughTheHive` and selects its path. */
async function useThroughTheHive(page: Page): Promise<void> {
  await page.evaluate(`import("/src/state/store.ts").then((m) => { m.commit(${JSON.stringify(throughTheHive)}); })`);
  await page.getByTestId(`step-row-${PAST_THE_HIVE}`).click();
  await expect(findingRows(page, "STRUCTURE").first()).toBeVisible();
}

/** Waits for the card's result, the run's own or the best so far at the 5 s safety stop. */
async function waitForResult(page: Page): Promise<void> {
  await expect(page.getByTestId("optimize-card")).toHaveAttribute("data-phase", "result", { timeout: 60_000 });
}

test("Optimize path on a step through the hive frame proposes the fastest clear route and says what the original goes through", async ({ page }) => {
  test.setTimeout(120_000);
  await loadExample(page);
  await useThroughTheHive(page);
  const before = await autoText(page);
  await runFromPalette(page, "path.optimize", "Optimize path");
  await waitForResult(page);
  await expect(page.getByTestId("optimize-apply")).toBeEnabled();
  await expect(page.getByTestId("field-canvas")).toHaveAttribute("data-candidate", PAST_THE_HIVE);
  // It is not "no faster route": it names what the original goes through and gives the clear route.
  const status = page.getByTestId("optimize-status");
  await expect(status).toContainText(/the original goes through the .+ of the hive frame/i);
  await expect(status).toContainText("fastest clear route found");
  await expect(status).not.toContainText("No faster route");
  expect(await autoText(page)).toBe(before);

  await page.getByTestId("optimize-apply").click();
  await expect(page.getByTestId("optimize-card")).toHaveCount(0);
  await expect(page.getByTestId("status")).toContainText(new RegExp(`Routed ${PAST_THE_HIVE} clear of the .+ of the hive frame:`));
  await expect(findingRows(page, "STRUCTURE")).toHaveCount(0);
});

test("Optimize every path counts a cleared step through the hive frame apart from the time saved", async ({ page }) => {
  test.setTimeout(120_000);
  await loadExample(page);
  await useThroughTheHive(page);
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Optimize every path");
  await page.getByTestId("palette-item-path.optimizeAll").click();
  await waitForResult(page);
  await expect(page.getByTestId(`optimize-all-accept-${PAST_THE_HIVE}`)).toBeChecked();
  await expect(page.getByTestId("optimize-all-results")).toContainText(`${PAST_THE_HIVE}: cleared,`);
  await expect(page.getByTestId("optimize-all-total")).toHaveText("1 of 1 paths searched. The ticked ones save 0.00 s in all and clear 1 blocked path.");
  await page.getByTestId("optimize-apply").click();
  await expect(page.getByTestId("status")).toContainText("Optimized 1 path: 1 blocked path cleared.");
});

test("Optimize path says there is no clear route, not no faster one, when nothing goes round", async ({ page }) => {
  test.setTimeout(120_000);
  await loadExample(page);
  await useThroughTheHive(page);
  // A barrier across the whole field between the step's ends, as the auto's own field.
  await page.evaluate(`import("/src/state/store.ts").then((m) => {
    const s = m.getState();
    const field = s.autoField ?? s.project.field;
    const barrier = { id: "barrier", kind: "box", minXIn: -80, maxXIn: 80, minYIn: -3, maxYIn: 3, minZIn: 0, maxZIn: 10, solidToRobot: true, provenance: "PLACEHOLDER: e2e fixture" };
    m.setAutoOverrides(s.autoRobot ?? s.project.robot, { ...field, obstacles: [...(field.obstacles ?? []), barrier] });
  })`);
  // The run must end on its own, never at the 5 s safety stop, even on a machine running other
  // suites: the estimate scores it, and the real optimizer runs with a budget of 100 evaluations
  // instead of the default. No route crosses the barrier, so a smaller search proves the same thing.
  await page.evaluate(`Promise.all([import("/src/optimize/state.ts"), import("/src/optimize/host.ts")]).then(([o, h]) => {
    o.setOptimizeStarter((request, options, events, host) => h.startOptimize(request, { ...options, budget: 100 }, events, host));
  })`);
  await runFromPalette(page, "path.optimizeWithOptions", "Optimize path with options");
  await page.getByTestId("optimize-scorer").selectOption("estimate");
  await page.getByTestId("optimize-run").click();
  await waitForResult(page);
  const card = page.getByTestId("optimize-card");
  await expect(card).toHaveAttribute("data-status", "infeasible");
  await expect(page.getByTestId("optimize-stopped")).toHaveCount(0);
  await expect(page.getByTestId("optimize-status")).toContainText("and no clear route was found between the step's two ends.");
  await expect(page.getByTestId("optimize-apply")).toBeDisabled();
});

test("with Optimize path off, a finding offers no Route around or Find a faster heading", async ({ page }) => {
  await turnOnFeatures(page, { commands: true });
  await loadExample(page);
  await clipTheHive(page);
  const structure = findingRows(page, "STRUCTURE");
  await expect(structure.first()).toBeVisible();
  await structure.first().hover();
  await expect(page.getByTestId("fix-optimizeRoute")).toHaveCount(0);
  await expect(page.getByTestId("optimize-card")).toHaveCount(0);
});
