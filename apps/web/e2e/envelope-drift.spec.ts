/**
 * Issue #481: a command that drives the robot by itself (`movesRobot`), inside an envelope, with a
 * rejoin pose on the path after it. The playback robot drifts from where the command starts to the
 * rejoin pose inside the command's window, at the Ideal and the Instant sim levels, drawn as a ghost
 * in the unknown-position colour, its envelope hatched in that colour while the window is open; the
 * Ideal total is the estimate's. The Stay-inside box's Actual row previews a shorter run.
 */
import { expect, test, type Page } from "@playwright/test";
import { turnOnFeatures, type Features } from "./features";
import { editor, selectStep } from "./qa/helpers";

const REJOIN = { xIn: -58, yIn: -60, headingRad: Math.PI };

/** The example with a vision collect that drives the robot, timed by its envelope, and a rejoin after it. */
async function loadDriftAuto(page: Page): Promise<void> {
  await page.goto("/?cloud=fake");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await editor(
    page,
    `m.replaceProjectRobot({ ...s.project.robot, commands: [...s.project.robot.commands, { name: "visionCollect", estimateS: "unknown", movesRobot: true }] })`,
  );
  await editor(
    page,
    `m.commit({ ...s.auto, steps: [
      s.auto.steps.find((x) => x.id === "driveOut"),
      { id: "hunt", kind: "command", name: "visionCollect", envelope: {
        polygon: [{ xIn: -70, yIn: -70 }, { xIn: -10, yIn: -70 }, { xIn: -10, yIn: -20 }, { xIn: -70, yIn: -20 }],
        maxDurationS: 4, provenance: "SET BY HAND: e2e, the hunt stays in the garden" } },
      { id: "back", kind: "path", rejoinFrom: { xIn: ${REJOIN.xIn}, yIn: ${REJOIN.yIn}, headingRad: ${REJOIN.headingRad}, provenance: "SET BY HAND: e2e" },
        segments: [{ kind: "line", from: "current", to: { xIn: -36, yIn: -12 } }],
        heading: { mode: "linear", fromRad: ${REJOIN.headingRad}, toRad: 1.5708 } },
    ] })`,
  );
  await expect(page.getByTestId("step-row-hunt")).toBeVisible();
}

const setPlayback = (page: Page, atS: number): Promise<unknown> => editor(page, `m.setPlayback(${String(atS)})`);

/** The hunt's span on the ideal clock, and the ideal and estimate totals. */
const idealTimes = (page: Page): Promise<{ startS: number; endS: number; idealS: number; estimateS: number; transitionS: number }> =>
  page.evaluate(
    `Promise.all([import("/src/state/store.ts"), import("/src/state/playback.ts")]).then(([m, p]) => {
      const d = m.currentDerived();
      const ideal = p.idealFor(d.plan, d.estimate);
      const span = ideal.spans.find((x) => x.stepId === "hunt");
      const back = ideal.spans.find((x) => x.stepId === "back");
      return { startS: span.startS, endS: span.endS, idealS: ideal.totalS, estimateS: d.estimate.nominalS, transitionS: back.transitionS };
    })`,
  ) as Promise<{ startS: number; endS: number; idealS: number; estimateS: number; transitionS: number }>;

/** What the canvas publishes about the robot after the frame at the playback time is drawn. */
async function robotAt(page: Page, atS: number): Promise<{ xIn: number; yIn: number; unknown: string | null; envelope: string | null }> {
  await setPlayback(page, atS);
  const canvas = page.getByTestId("field-canvas");
  // The canvas draws on the next frame; wait until the published pose is from this time's frame.
  await page.waitForTimeout(120);
  const pose = (await canvas.getAttribute("data-robot-pose")) ?? "";
  const [xIn, yIn] = pose.split(",").map(Number);
  return {
    xIn: xIn ?? Number.NaN,
    yIn: yIn ?? Number.NaN,
    unknown: await canvas.getAttribute("data-robot-unknown"),
    envelope: await canvas.getAttribute("data-unknown-envelope"),
  };
}

const ON: Partial<Features> = { commands: true, ledger: true, partners: false, optimizer: false, fullSim: true };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
    }
  });
});

test("the Ideal robot drifts to the rejoin pose inside the window, as a ghost, and the Ideal total is the estimate's", async ({ page }) => {
  await turnOnFeatures(page, ON);
  await loadDriftAuto(page);
  const times = await idealTimes(page);
  expect(times.endS - times.startS).toBeCloseTo(4, 6);
  expect(times.idealS).toBeCloseTo(times.estimateS, 6);
  expect(times.transitionS).toBe(0);

  const before = await robotAt(page, times.startS - 0.2);
  expect(before.unknown).toBeNull();
  expect(before.envelope).toBeNull();

  const mid = await robotAt(page, (times.startS + times.endS) / 2);
  expect(mid.unknown).toBe("hunt");
  expect(mid.envelope).toBe("hunt");
  const start = await robotAt(page, times.startS);
  expect(Math.hypot(mid.xIn - start.xIn, mid.yIn - start.yIn)).toBeGreaterThan(5);

  // On the rejoin pose as the window ends, and an ordinary robot again on the path after it.
  const end = await robotAt(page, times.endS);
  expect(end.unknown).toBeNull();
  expect(end.envelope).toBeNull();
  expect(Math.hypot(end.xIn - REJOIN.xIn, end.yIn - REJOIN.yIn)).toBeLessThan(0.01);
});

test("the Instant sim robot drifts inside the window too, as a ghost", async ({ page }) => {
  await turnOnFeatures(page, ON);
  await loadDriftAuto(page);
  await page.getByTestId("playback-level-instant").click();
  await expect(page.getByTestId("field-canvas")).toHaveAttribute("data-playback-level", "instant");
  const unknown: Array<{ atS: number; xIn: number; yIn: number }> = [];
  for (let atS = 0; atS <= 12; atS += 0.25) {
    const robot = await robotAt(page, atS);
    if (robot.unknown === "hunt") unknown.push({ atS, xIn: robot.xIn, yIn: robot.yIn });
  }
  // About the 4 s window, in quarter-second samples.
  expect(unknown.length).toBeGreaterThanOrEqual(15);
  expect(unknown.length).toBeLessThanOrEqual(17);
  const first = unknown[0] as { xIn: number; yIn: number; atS: number };
  const last = unknown[unknown.length - 1] as { xIn: number; yIn: number; atS: number };
  expect(Math.hypot(first.xIn - last.xIn, first.yIn - last.yIn)).toBeGreaterThan(10);
  // A quarter second after the window, the robot is on its way from the rejoin pose.
  const after = await robotAt(page, last.atS + 0.25);
  expect(after.unknown).toBeNull();
  expect(Math.hypot(after.xIn - REJOIN.xIn, after.yIn - REJOIN.yIn)).toBeLessThan(3);
});

test("the Actual row previews a shorter run, reads as a what-if, and resets to the window", async ({ page }) => {
  await turnOnFeatures(page, ON);
  await loadDriftAuto(page);
  await selectStep(page, "hunt");
  const estimate = page.getByTestId("inspector-estimate");
  await expect(estimate).toHaveText("at most 4.00 s");
  const actual = page.getByTestId("inspector-envelope-actual");
  await expect(actual).toBeVisible();
  await expect(actual).toHaveValue("");
  await expect(actual).toHaveAttribute("placeholder", "4.0");

  await actual.fill("1.5");
  await actual.press("Enter");
  await expect(estimate).toHaveText("what-if 1.50 s");
  const times = await idealTimes(page);
  expect(times.endS - times.startS).toBeCloseTo(1.5, 6);
  expect(times.idealS).toBeCloseTo(times.estimateS, 6);
  expect(
    await editor<number | undefined>(page, `s.auto.steps.find((x) => x.id === "hunt").envelope.actualDurationS`),
  ).toBe(1.5);

  // One undo step, and the bin puts the window back. Out of the field first, whose own Ctrl+Z is the text's.
  await actual.blur();
  await page.keyboard.press("Control+z");
  await expect(estimate).toHaveText("at most 4.00 s");
  await page.keyboard.press("Control+y");
  await expect(estimate).toHaveText("what-if 1.50 s");
  await page.getByTestId("inspector-envelope-actual-reset").click();
  await expect(estimate).toHaveText("at most 4.00 s");
  expect(await editor<boolean>(page, `"actualDurationS" in s.auto.steps.find((x) => x.id === "hunt").envelope`)).toBe(false);

  // Longer than the window is never written: the file keeps no what-if.
  await actual.fill("6");
  await actual.press("Enter");
  expect(await editor<boolean>(page, `"actualDurationS" in s.auto.steps.find((x) => x.id === "hunt").envelope`)).toBe(false);
});

test("the Actual row comes with the Ledger switch, but one the file sets always shows", async ({ page }) => {
  await turnOnFeatures(page, { ...ON, ledger: false });
  await loadDriftAuto(page);
  await selectStep(page, "hunt");
  await expect(page.getByTestId("inspector-envelope-seconds")).toBeVisible();
  await expect(page.getByTestId("inspector-envelope-actual")).toHaveCount(0);
  await editor(
    page,
    `m.commit({ ...s.auto, steps: s.auto.steps.map((x) => x.id === "hunt" ? { ...x, envelope: { ...x.envelope, actualDurationS: 2 } } : x) })`,
  );
  await expect(page.getByTestId("inspector-envelope-actual")).toHaveValue("2.0");
  await expect(page.getByTestId("inspector-estimate")).toHaveText("what-if 2.00 s");
});
