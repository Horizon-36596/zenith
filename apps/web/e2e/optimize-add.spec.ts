/**
 * Add a clear path here (issue #310). The example's collect-and-score ends at scoreNorth, (-13, 44),
 * north of the hive; a straight line from there to (-45, -10), past the hive's west side, drives into
 * the frame. The field's right-click item opens the Optimize card on that path in Route around mode,
 * the field draws a route that keeps the margin from the hive, and Apply adds it as one step in one
 * undo step. With Extend this chain on, the route goes onto the selected chain as more of its paths
 * instead. The card's switcher, when it offers more than one route, steps through the pick and its
 * alternatives, each of which passes the final check with the season's rules, as the card's own run
 * does.
 */
import { expect, test, type Page } from "@playwright/test";
import { editor, loadExample, skipTour, useWideRoute, worldToScreen } from "./qa/helpers";

const PAST_THE_HIVE = { xIn: -45, yIn: -10 };

test.beforeEach(async ({ page }) => {
  await skipTour(page, { features: { partners: true, ledger: true, commands: true, optimizer: true } });
});

/** A hash of the open auto's canonical text, from the editor's store (the Code tab's own `shaOf`). */
const autoText = (page: Page): Promise<string> =>
  page.evaluate(async () => {
    const store = (await import(/* @vite-ignore */ "/src/state/store.ts")) as { getState(): { auto: unknown } };
    const code = (await import(/* @vite-ignore */ "/src/panels/codeView.ts")) as { shaOf(auto: unknown): string };
    return code.shaOf(store.getState().auto);
  });

/**
 * Right-clicks a field spot and chooses Add a clear path here. The press goes to the whole pixel the
 * spot rounds to, so the menu event's position and the pointer's own are the same and at most half a
 * pixel from the spot, inside half a grid step, and the snap lands on the spot itself.
 */
async function addClearPath(page: Page, xIn: number, yIn: number): Promise<void> {
  const exact = await worldToScreen(page, xIn, yIn);
  const at = { x: Math.round(exact.x), y: Math.round(exact.y) };
  await page.mouse.move(at.x, at.y);
  await page.mouse.click(at.x, at.y, { button: "right" });
  const menu = page.getByTestId("canvas-context-menu");
  const item = menu.locator('[data-action="field.addClearPathHere"]');
  await expect(item).toHaveText(/Add a clear path here/);
  await item.click();
  await expect(page.getByTestId("optimize-card")).toBeVisible();
}

/**
 * Waits for a result Apply can write: the run's own, or the best so far at the 5 s safety stop.
 * A stop with nothing to apply yet goes on with Continue until the run ends.
 */
async function waitForApply(page: Page): Promise<void> {
  const card = page.getByTestId("optimize-card");
  const apply = page.getByTestId("optimize-apply");
  for (;;) {
    await expect(card).toHaveAttribute("data-phase", "result", { timeout: 60_000 });
    if (await apply.isEnabled()) return;
    const more = page.getByTestId("optimize-continue");
    if ((await more.count()) === 0) break;
    await more.click();
  }
  await expect(apply).toBeEnabled();
}

/** Waits for a route to apply, drawn on the field, and gives the draft step's id, which the card does not show. */
async function waitForRoute(page: Page): Promise<string> {
  await waitForApply(page);
  const stepId = (await page.evaluate(`import("/src/optimize/state.ts").then((o) => o.getOptimizeCard().stepId)`)) as string;
  await expect(page.getByTestId("field-canvas")).toHaveAttribute("data-candidate", stepId);
  return stepId;
}

/** The routes the card offers, and every one of them put through the hard final check again on the draft. */
async function routesPassTheFinalCheck(page: Page): Promise<{ count: number; ok: boolean[] }> {
  return (await page.evaluate(`(async () => {
    const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/packages/core/") && /index\\.(js|ts)$/.test(n.split("?")[0]));
    const c = await import(url);
    const m = await import("/src/state/store.ts");
    const o = await import("/src/optimize/state.ts");
    const s = m.getState();
    const card = o.getOptimizeCard();
    const routes = o.optimizeRoutes(card);
    const seasons = await import("/src/optimize/driver.ts");
    const input = seasons.inputOf({ auto: card.draft.auto, robot: s.project.robot, field: s.project.field, waypoints: s.project.waypoints, stepId: card.stepId, withSeason: true });
    const objective = c.createObjective(input, { marginIn: card.result.marginIn, scorer: card.result.scorer });
    const check = c.createFinalCheck(input, objective, { routeAround: true });
    return { count: routes.length, ok: routes.map((route) => check.verify(route.step).ok) };
  })()`)) as { count: number; ok: boolean[] };
}

test("Add a clear path here past the hive keeps the margin from it, and Apply adds one step in one undo", async ({ page }) => {
  test.setTimeout(120_000);
  await loadExample(page);
  await useWideRoute(page);
  await editor(page, "m.setSelection({})");
  const before = await autoText(page);
  const stepCount = await editor<number>(page, "s.auto.steps.length");

  await addClearPath(page, PAST_THE_HIVE.xIn, PAST_THE_HIVE.yIn);
  const card = page.getByTestId("optimize-card");
  await expect(card).toHaveAttribute("data-clear-path", "new");
  await expect(card).toHaveAttribute("data-mode", "routeAround");
  // The header says what the card does, and names no step: the new one does not exist yet.
  await expect(page.getByTestId("optimize-title")).toHaveText("Add a clear path");
  await expect(page.getByTestId("optimize-step")).toHaveCount(0);
  await expect(page.getByTestId("optimize-action")).toHaveCount(0);
  const stepId = await waitForRoute(page);
  await expect(page.getByTestId("optimize-status")).toHaveText("A clear path, the fastest found.");

  // The route keeps the margin from the hive: its closest clearance is at least the margin.
  const margin = Number(await page.getByTestId("optimize-margin").inputValue());
  const closest = (await page.getByTestId("optimize-closest").textContent()) ?? "";
  // The structure is named by its field label, "the west base bar of the hive frame", never its id.
  const match = /Closest clearance: ([\d.]+) in, to (the [a-z ,-]+)\./.exec(closest);
  expect(match, closest).not.toBeNull();
  expect(Number(match?.[1])).toBeGreaterThanOrEqual(margin);
  expect(Number(await page.getByTestId("field-canvas").getAttribute("data-candidate-margins"))).toBeGreaterThan(0);
  // Nothing is written until Apply.
  expect(await autoText(page)).toBe(before);

  // The card offers up to three routes, each passing the final check. Since issue #365 the way
  // east of the hive crosses the centre line, which the season forbids, so on RED's side the hive is
  // passed one way and the switcher, shown only for two routes or more, may not appear.
  const routes = await routesPassTheFinalCheck(page);
  expect(routes.count).toBeGreaterThanOrEqual(1);
  expect(routes.count).toBeLessThanOrEqual(3);
  expect(routes.ok.every(Boolean)).toBe(true);
  if (routes.count === 1) {
    await expect(page.getByTestId("optimize-switcher")).toHaveCount(0);
  } else {
    const shown = page.getByTestId("optimize-route");
    await expect(shown).toHaveText(new RegExp(`^Route 1 of ${String(routes.count)}`));
    for (let k = 1; k < routes.count; k += 1) {
      await page.getByTestId("optimize-route-next").click();
      await expect(shown).toHaveAttribute("data-choice", String(k));
      await expect(shown).toHaveText(new RegExp(`^Route ${String(k + 1)} of ${String(routes.count)}`));
      await expect(page.getByTestId("field-canvas")).toHaveAttribute("data-candidate", stepId);
    }
    await page.getByTestId("optimize-route-next").click();
    await expect(shown).toHaveAttribute("data-choice", "0");
  }

  await page.getByTestId("optimize-apply").click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("status")).toContainText(`Added ${stepId}, a clear path to here`);
  expect(await editor<number>(page, "s.auto.steps.length")).toBe(stepCount + 1);
  expect(await editor<string | undefined>(page, "s.selection.stepId")).toBe(stepId);

  await page.getByTestId("toolbar-edit.undo").click();
  expect(await autoText(page)).toBe(before);
  expect(await editor<number>(page, "s.auto.steps.length")).toBe(stepCount);
});

test("with Extend this chain on, the route goes onto the selected chain as more of its paths, not a new step", async ({ page }) => {
  test.setTimeout(120_000);
  await loadExample(page);
  await editor(page, `m.setSetting("editing.addPathExtends", true)`);
  await editor(page, `m.selectStep("driveOut")`);
  const before = await autoText(page);
  const ids = await editor<string[]>(page, "s.auto.steps.map((step) => step.id)");
  const paths = await editor<number>(page, `s.auto.steps.find((step) => step.id === "driveOut").segments.length`);

  await addClearPath(page, -26, -52);
  await expect(page.getByTestId("optimize-card")).toHaveAttribute("data-clear-path", "extend");
  const card = page.getByTestId("optimize-card");
  await waitForApply(page);
  expect(await autoText(page)).toBe(before);

  await page.getByTestId("optimize-apply").click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("status")).toContainText("to driveOut, a clear path to here");
  expect(await editor<string[]>(page, "s.auto.steps.map((step) => step.id)")).toEqual(ids);
  const after = await editor<number>(page, `s.auto.steps.find((step) => step.id === "driveOut").segments.length`);
  expect(after).toBeGreaterThan(paths);
  // The spot the right-click picked, exactly: `addClearPath` presses on the pixel the spot rounds to.
  const end = await editor<{ xIn: number; yIn: number; provenance: string }>(page, `s.auto.steps.find((step) => step.id === "driveOut").segments.at(-1).to`);
  expect(end.xIn).toBe(-26);
  expect(end.yIn).toBe(-52);
  expect(end.provenance).toBe("SET FROM EDITOR");

  await page.getByTestId("toolbar-edit.undo").click();
  expect(await autoText(page)).toBe(before);
});

test("with Optimize path off, the field's menu has no Add a clear path here", async ({ page }) => {
  await page.addInitScript(() => {
    const prefs = JSON.parse(window.localStorage.getItem("zenith.ui") ?? "{}") as Record<string, unknown>;
    prefs["features"] = { partners: true, ledger: true, commands: true, optimizer: false };
    window.localStorage.setItem("zenith.ui", JSON.stringify(prefs));
  });
  await loadExample(page);
  await useWideRoute(page);
  await editor(page, "m.setSelection({})");
  const at = await worldToScreen(page, PAST_THE_HIVE.xIn, PAST_THE_HIVE.yIn);
  await page.mouse.click(at.x, at.y, { button: "right" });
  const menu = page.getByTestId("canvas-context-menu");
  await expect(menu.locator('[data-action="field.addPathHere"]')).toBeVisible();
  await expect(menu.locator('[data-action="field.addClearPathHere"]')).toHaveCount(0);
});
