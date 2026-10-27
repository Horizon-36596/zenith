/**
 * Timeouts in the time budget and the problems panel (issue #154, sweep finding N9). The example's
 * TIME_BUDGET note used to name no step, so clicking it selected "total" and the inspector said
 * "Nothing selected."; now it names waitForFull, the wait whose 1 s timeout bounds the total. Since
 * issue #413 the Problems panel does not list that info note at all, and the clean example reads "No
 * problems found."; check() still returns it. A wait until a condition with no timeout warns, and its fix puts
 * the cursor in the Timeout field without writing a number. A timeout shorter than a path's own
 * estimate warns, and its fix raises the timeout far enough to clear it. Playback stops the robot
 * where that timeout runs out, so the timeline and the robot agree.
 */
import { expect, test } from "@playwright/test";
import { editor, findingRows, loadExample, skipTour, withCore } from "./qa/helpers";

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
});

test("the time budget note names the step that bounds it, and the Problems panel does not list it", async ({ page }) => {
  // check() still returns the note, naming waitForFull first.
  const notes = await editor<Array<{ severity: string; stepIds?: string[]; message: string }>>(
    page,
    `m.currentDerived().findings.filter((f) => f.code === "TIME_BUDGET")`,
  );
  expect(notes).toHaveLength(1);
  expect(notes[0]?.severity).toBe("info");
  expect(notes[0]?.stepIds?.[0]).toBe("waitForFull");
  expect(notes[0]?.message).toContain("waitForFull");
  expect(notes[0]?.message).not.toContain("may not fit");

  // The panel neither lists nor counts it, so the clean example opens on "No problems found."
  await expect(findingRows(page, "TIME_BUDGET")).toHaveCount(0);
  await expect(page.getByTestId("findings-count-info")).toHaveText("0 info");
  await expect(page.getByTestId("findings-empty")).toContainText("No problems found.");
});

test("a wait until a condition with no timeout warns, and its fix focuses the Timeout field", async ({ page }) => {
  await page.evaluate(`(async () => {
    const store = await import("/src/state/store.ts");
    const edits = await import("/src/app/edits.ts");
    store.selectStep("stopIntake");
    edits.addWaitUntil("hopperFull");
    store.selectStep("driveOut");
  })()`);
  const row = findingRows(page, "WAIT_NO_TIMEOUT");
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute("data-severity", "warning");

  // The fixes are on the selected row only.
  await row.getByTestId("finding-select").click();
  const fix = row.getByTestId("fix-focusTimeout");
  await expect(fix).toHaveText("Set timeout");
  await fix.click();
  expect(await editor<string | undefined>(page, "s.selection.stepId")).toBe("waitUntil");
  await expect(page.getByTestId("inspector-timeout")).toBeFocused();
  // It writes no number: the wait still has no timeout until the person types one.
  expect(await editor<unknown>(page, `s.auto.steps.find((x) => x.id === "waitUntil").timeoutS`)).toBeUndefined();

  await page.getByTestId("inspector-timeout").fill("2");
  await page.keyboard.press("Enter");
  await expect(findingRows(page, "WAIT_NO_TIMEOUT")).toHaveCount(0);
});

test("a timeout that cuts a path short warns, and raising it clears the warning", async ({ page }) => {
  await page.evaluate(
    `import("/src/state/store.ts").then((m) => { const s = m.getState(); m.commit({ ...s.auto, steps: s.auto.steps.map((x) => x.id !== "toGarden" ? x : { ...x, timeoutS: 1 }) }); })`,
  );
  const row = findingRows(page, "TIMEOUT_TIGHT");
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute("data-severity", "warning");
  await expect(row).toContainText("short of the end");

  await row.getByTestId("finding-select").click();
  const fix = row.getByTestId("fix-raiseTimeout");
  await expect(fix).toHaveText("Raise timeout");
  // The number is in its tooltip.
  await fix.hover();
  await expect(page.getByRole("tooltip")).toContainText("Raise the timeout to 4.3 s.");
  await fix.click();
  await expect(findingRows(page, "TIMEOUT_TIGHT")).toHaveCount(0);
  expect(await editor<number>(page, `s.auto.steps.find((x) => x.id === "toGarden").timeoutS`)).toBe(4.3);
});

test("the ideal robot stops where the timeout runs out, and the next path opens with a transition", async ({ page }) => {
  const cutTo = async (timeoutS: number): Promise<void> => {
    await page.evaluate(
      `import("/src/state/store.ts").then((m) => { const s = m.getState(); m.commit({ ...s.auto, steps: s.auto.steps.map((x) => x.id !== "toGarden" ? x : { ...x, timeoutS: ${String(timeoutS)} }) }); })`,
    );
  };
  await cutTo(1);
  await expect(findingRows(page, "TIMEOUT_TIGHT")).toHaveCount(1);

  // Playback spends 1 s on toGarden, as its timeline bar does, and stops short of the path's end.
  const run = await withCore<{
    estimateS: number;
    idealS: number;
    toGardenS: number;
    gapS: number;
    cutS: number;
    stop: { xIn: number; yIn: number; headingRad: number };
    end: { xIn: number; yIn: number };
  }>(
    page,
    `(() => {
      const d = m.currentDerived();
      const t = c.idealTrajectory(d.plan, d.estimate);
      const span = t.spans.find((x) => x.stepId === "toGarden");
      const step = c.flattenSteps(d.plan.steps).find((x) => x.id === "toGarden");
      return {
        estimateS: d.estimate.nominalS,
        idealS: t.totalS,
        toGardenS: span.endS - span.startS,
        gapS: t.spans.find((x) => x.stepId === "sweepGarden").transitionS,
        cutS: span.endS,
        stop: c.idealPoseAt(t, span.endS),
        end: step.endPose,
      };
    })()`,
  );
  expect(run.toGardenS).toBeCloseTo(1, 6);
  expect(Math.hypot(run.stop.xIn - run.end.xIn, run.stop.yIn - run.end.yIn)).toBeGreaterThan(12);
  // The drive from there to sweepGarden's start is the one gap between the ideal total and the
  // estimate's, and the timeline draws it as a transition block before sweepGarden.
  expect(run.gapS).toBeGreaterThan(0);
  expect(run.idealS).toBeCloseTo(run.estimateS + run.gapS, 6);
  await expect(page.getByTestId("timeline-transition-sweepGarden")).toHaveCount(1);
  expect(Number(await page.getByTestId("timeline-level-total").getAttribute("data-seconds"))).toBeCloseTo(run.idealS, 3);

  // The robot on the field is at the stop a moment after the timeout, not further along the path.
  await page.evaluate(`import("/src/state/store.ts").then((m) => m.setPlayback(${String(run.cutS + 0.01)}))`);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const [xIn, yIn] = ((await page.getByTestId("field-canvas").getAttribute("data-robot-pose")) ?? "").split(",").map(Number);
  expect(Math.hypot((xIn ?? Number.NaN) - run.stop.xIn, (yIn ?? Number.NaN) - run.stop.yIn)).toBeLessThan(1);

  // A timeout the path fits inside leaves no gap.
  await cutTo(4.6);
  await expect(findingRows(page, "TIMEOUT_TIGHT")).toHaveCount(0);
  await expect(page.getByTestId("timeline-transition-sweepGarden")).toHaveCount(0);
});
