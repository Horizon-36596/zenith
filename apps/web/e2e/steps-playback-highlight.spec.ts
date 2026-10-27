/**
 * The step list highlights the steps running at the playhead (issue #111): the leaf step, the groups
 * it sits in and every running branch of a parallel group, while playing or scrubbed, at the
 * playback level chosen. The highlight is a fill, a play mark, weight and aria-current, never colour
 * alone, and its text keeps AA contrast in both themes.
 */
import { expect, test, type Page } from "@playwright/test";
import { contrast, loadExample, skipTour } from "./qa/helpers";

/**
 * collect-and-score has `returnToScore` near its end, a deadline parallel group of the path `driveBack` and
 * the sequence `clearThenSpinUp` (the wait `clearGarden`, then the command `readyLauncher`).
 */
const NESTED = ["returnToScore", "driveBack", "clearThenSpinUp", "clearGarden"];

async function scrubTo(page: Page, atS: number): Promise<void> {
  await page.evaluate(`import("/src/state/store.ts").then((m) => m.setPlayback(${String(atS)}))`);
}

/** Halfway through a step on the ideal clock, from the same trajectory the editor plays. */
async function idealMidpoint(page: Page, stepId: string): Promise<number> {
  return page.evaluate(async (id) => {
    const store = (await import("/src/state/store.ts" as string)) as {
      currentDerived: () => { plan: unknown; estimate: unknown };
    };
    const playback = (await import("/src/state/playback.ts" as string)) as {
      idealFor: (plan: unknown, estimate: unknown) => { spans: Array<{ stepId: string; startS: number; endS: number }> } | null;
    };
    const derived = store.currentDerived();
    const span = playback.idealFor(derived.plan, derived.estimate)?.spans.find((candidate) => candidate.stepId === id);
    if (span === undefined) throw new Error(`no ideal span for ${id}`);
    return (span.startS + span.endS) / 2;
  }, stepId);
}

/** The ids of the rows highlighted as running, in list order. */
async function runningRows(page: Page): Promise<string[]> {
  return page
    .locator("[data-testid^='step-row-'][data-running='true']")
    .evaluateAll((rows) => rows.map((row) => (row.getAttribute("data-testid") ?? "").slice("step-row-".length)));
}

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
});

test("nothing is highlighted before the playhead is placed", async ({ page }) => {
  expect(await runningRows(page)).toEqual([]);
});

test("scrubbing into a nested step highlights it, its sequence, its parallel group and the other branch", async ({ page }) => {
  await scrubTo(page, await idealMidpoint(page, "clearGarden"));
  await expect.poll(() => runningRows(page)).toEqual(NESTED);
  for (const id of NESTED) {
    const row = page.getByTestId(`step-row-${id}`);
    await expect(row).toHaveAttribute("aria-current", "step");
    await expect(page.getByTestId(`step-running-${id}`)).toBeVisible();
    // The name says so to a screen reader, not only the fill.
    await expect(page.getByTestId(`step-main-${id}`)).toHaveAccessibleName(new RegExp(`${id}.*running`));
  }
  await expect(page.getByTestId("step-row-driveOut")).not.toHaveAttribute("aria-current", "step");
  // The highlighted name is weight 500 and keeps AA contrast on the running fill, in Night and in Day.
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset["theme"] = value;
    }, theme);
    const colours = await page.getByTestId("step-row-clearGarden").evaluate((row) => {
      const name = row.querySelector("[data-testid='step-name-clearGarden'] span") as HTMLElement;
      return { fg: getComputedStyle(name).color, bg: getComputedStyle(row).backgroundColor, weight: getComputedStyle(name).fontWeight };
    });
    expect(colours.weight).toBe("500");
    expect(contrast(colours.fg, colours.bg), theme).toBeGreaterThanOrEqual(4.5);
  }
});

test("playing moves the highlight from step to step", async ({ page }) => {
  await scrubTo(page, 0);
  await expect.poll(() => runningRows(page)).toEqual(["driveOut"]);
  await page.getByTestId("toolbar-view.play").click();
  // The highlight follows the robot onto the next step without anything else being touched.
  await expect.poll(() => runningRows(page), { timeout: 15_000 }).not.toEqual(["driveOut"]);
  expect((await runningRows(page)).length).toBeGreaterThan(0);
  await page.getByTestId("toolbar-view.play").click();
});

test("at Instant sim the highlight follows the instant sim's own clock", async ({ page }) => {
  await page.getByTestId("playback-level-instant").click();
  await expect(page.getByTestId("playback-level")).toHaveAttribute("data-level", "instant");
  const atS = await page.evaluate(async () => {
    const store = (await import("/src/state/store.ts" as string)) as {
      currentDerived: () => { plan: { robot: unknown; field: unknown } | null };
    };
    const sim = (await import("/src/state/sim.ts" as string)) as {
      runSim: (plan: unknown, robot: unknown, field: unknown) => { run: { trace: { steps: Array<{ id: string; startS: number; endS: number }> } } | null };
    };
    const plan = store.currentDerived().plan;
    if (plan === null) throw new Error("no plan");
    const step = sim.runSim(plan, plan.robot, plan.field).run?.trace.steps.find((candidate) => candidate.id === "driveBack");
    if (step === undefined) throw new Error("the instant sim did not reach driveBack");
    return step.startS + (step.endS - step.startS) / 2;
  });
  await scrubTo(page, atS);
  await expect.poll(() => runningRows(page)).toContain("driveBack");
  const running = await runningRows(page);
  expect(running).toContain("returnToScore");
});
