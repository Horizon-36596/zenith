/**
 * QA 7, the robot outline (site/docs/editor.md; the old robot ghosts are gone): there is
 * never more than one robot outline on the field; it follows the scrubber and the hover; Play
 * animates it in real time and stops at the end; at the Instant sim playback level its pose is
 * core's `simPoseAt` on the instant sim's trace, for the same plan the editor is showing. The Ideal
 * level, the default, is `playback-levels.spec.ts`.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  canvasView,
  editor,
  installCanvasProbe,
  knownBug,
  lastFrame,
  loadExample,
  nextFrame,
  polygonCentreIn,
  robotOutlines,
  shot,
  skipTour,
  withCore,
  worldToScreen,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  // These checks are of the instant sim's robot, so the preference picks that level.
  await skipTour(page, { playbackLevel: "instant" });
  await installCanvasProbe(page);
  await loadExample(page);
  // The instant sim runs a tick after load; wait for the timeline to show its time.
  await expect.poll(() => simTotal(page)).toBeGreaterThan(1);
  await expect(page.getByTestId("playback-level")).toHaveAttribute("data-level", "instant");
});

const simTotal = (page: Page): Promise<number> =>
  withCore<number>(
    page,
    `(() => { const d = m.currentDerived(); if (!d.plan) return 0; const t = c.simulate(d.plan, s.autoRobot, s.autoField); let end = 0; for (const x of t.steps) if (x.parentId === null) end = Math.max(end, x.endS); return end; })()`,
  );

/** Where core puts the robot at a time, from the editor's own plan, robot and field. */
const simPose = (page: Page, timeS: number): Promise<{ xIn: number; yIn: number; headingRad: number }> =>
  withCore(page, `(() => { const d = m.currentDerived(); const t = c.simulate(d.plan, s.autoRobot, s.autoField); return c.simPoseAt(t, ${String(timeS)}); })()`);

async function outlines(page: Page) {
  const frame = await nextFrame(page);
  const view = await canvasView(page);
  return { view, found: robotOutlines(frame, view.pxPerIn) };
}

async function expectOneRobotAt(page: Page, timeS: number, label: string): Promise<void> {
  await page.evaluate(`import("/src/state/store.ts").then((m) => m.setPlayback(${String(timeS)}))`);
  const { view, found } = await outlines(page);
  expect(found.length, `${label}: one robot outline, not ${String(found.length)}`).toBe(1);
  const want = await simPose(page, timeS);
  // The body is centred on the pose (centreOfRotationIn is 0, 0 in the example robot).
  const got = polygonCentreIn(view, found[0] ?? []);
  expect(Math.hypot(got.xIn - want.xIn, got.yIn - want.yIn), `${label}: outline at simPoseAt(${String(timeS)})`).toBeLessThan(0.3);
}

test("at rest there is exactly one robot outline, at the start", async ({ page }) => {
  await expectOneRobotAt(page, 0, "at rest");
  await shot(page, "07-robot-at-rest");
});

test("scrubbing moves the one outline to where the sim puts the robot", async ({ page }) => {
  const total = await simTotal(page);
  for (const fraction of [0.1, 0.25, 0.5, 0.75, 0.95]) {
    await expectOneRobotAt(page, total * fraction, `at ${String(Math.round(fraction * 100))} %`);
  }
  await shot(page, "07-robot-scrubbed");
});

test("the scrubber control itself moves the robot", async ({ page }) => {
  const slider = page.getByTestId("playback");
  await expect(slider).toBeVisible();
  const before = polygonCentreIn(await canvasView(page), (await outlines(page)).found[0] ?? []);
  await slider.focus();
  // The robot stands still while it scores, so step back from the end into the scoring step.
  await page.keyboard.press("End");
  for (let i = 0; i < 20; i += 1) await page.keyboard.press("ArrowLeft");
  const at = await editor<number>(page, "s.playbackS ?? 0");
  expect(at).toBeGreaterThan(0);
  const { view, found } = await outlines(page);
  expect(found.length).toBe(1);
  const after = polygonCentreIn(view, found[0] ?? []);
  const want = await simPose(page, at);
  expect(Math.hypot(after.xIn - want.xIn, after.yIn - want.yIn)).toBeLessThan(0.3);
  expect(Math.hypot(after.xIn - before.xIn, after.yIn - before.yIn)).toBeGreaterThan(1);
});

test("hovering a path shows the one outline there, and nothing is stamped along it", async ({ page }) => {
  await page.getByTestId("step-row-toGarden").getByRole("button").first().click();
  // A point on toGarden's curve, about halfway: sample the plan for it.
  const mid = await editor<{ xIn: number; yIn: number }>(
    page,
    `(() => { const step = m.currentDerived().plan.steps.find((x) => x.id === "toGarden"); return step.samples[Math.floor(step.samples.length / 2)].pose; })()`,
  );
  const at = await worldToScreen(page, mid.xIn, mid.yIn);
  await page.mouse.move(at.x + 30, at.y + 30);
  await page.mouse.move(at.x, at.y, { steps: 5 });
  const { view, found } = await outlines(page);
  expect(found.length, "one outline under the cursor").toBe(1);
  const got = polygonCentreIn(view, found[0] ?? []);
  expect(Math.hypot(got.xIn - mid.xIn, got.yIn - mid.yIn), "the outline sits at the hovered point").toBeLessThan(6);
  await shot(page, "07-robot-hover");
  await page.mouse.move(5, 5);
});

test("Play animates one outline and stops at the end, with the robot at the last pose", async ({ page }) => {
  const total = await simTotal(page);
  await page.getByTestId("toolbar-view.play").click();
  await expect(page.getByTestId("toolbar-view.play")).toHaveAttribute("aria-pressed", "true");
  for (let i = 0; i < 4; i += 1) {
    await page.waitForTimeout(300);
    const frame = await lastFrame(page);
    const view = await canvasView(page);
    expect(robotOutlines(frame, view.pxPerIn).length, "one outline while playing").toBe(1);
  }
  await shot(page, "07-robot-playing");
  // Jump near the end rather than wait out the whole routine.
  await page.evaluate(`import("/src/state/store.ts").then((m) => m.setPlayback(${String(total - 1)}))`);
  await expect.poll(() => editor<boolean>(page, "s.playing"), { timeout: 10_000 }).toBe(false);
  expect(await editor<number>(page, "s.playbackS")).toBeCloseTo(total, 1);
  await expect(page.getByTestId("toolbar-view.play")).toHaveAttribute("aria-pressed", "false");
  const end = await outlines(page);
  expect(end.found.length).toBe(1);
  const want = await simPose(page, total);
  const got = polygonCentreIn(end.view, end.found[0] ?? []);
  expect(Math.hypot(got.xIn - want.xIn, got.yIn - want.yIn)).toBeLessThan(0.3);
});

/**
 * The playhead and the frame's own timestamp, read together inside an animation frame. Playback
 * ticks in an earlier callback of the same frame (it re-registered during the previous one), so the
 * two belong to the same instant. Reading the playhead with a round trip from the test and timing
 * it with the test's clock instead measures the round trips too, which under load are long enough
 * to make correct playback look 15 % slow.
 */
const playSample = (page: Page): Promise<{ playheadS: number; nowMs: number }> =>
  page.evaluate(`import("/src/state/store.ts").then((m) => new Promise((resolve) =>
    requestAnimationFrame((nowMs) => resolve({ playheadS: m.getState().playbackS ?? 0, nowMs }))))`);

test("Play runs in real time: one second of routine per second", async ({ page }) => {
  await page.getByTestId("toolbar-view.play").click();
  await page.waitForTimeout(300);
  const a = await playSample(page);
  await page.waitForTimeout(2_000);
  const b = await playSample(page);
  expect(b.nowMs - a.nowMs, "the sampled window").toBeGreaterThan(1_500);
  const rate = (b.playheadS - a.playheadS) / ((b.nowMs - a.nowMs) / 1000);
  expect(rate, `playback runs at ${rate.toFixed(2)}x real time`).toBeGreaterThan(0.9);
  expect(rate).toBeLessThan(1.1);
});

test("Play at the end starts again from the beginning", async ({ page }) => {
  const total = await simTotal(page);
  await page.evaluate(`import("/src/state/store.ts").then((m) => m.setPlayback(${String(total)}))`);
  await page.getByTestId("toolbar-view.play").click();
  await page.waitForTimeout(600);
  expect(await editor<boolean>(page, "s.playing")).toBe(true);
  expect(await editor<number>(page, "s.playbackS")).toBeLessThan(2);
});

test("no step draws more than one robot anywhere, in either field view", async ({ page }) => {
  for (const view of ["vector", "image", "image+outlines"]) {
    await page.evaluate(`import("/src/state/store.ts").then((m) => m.setPrefs({ fieldView: ${JSON.stringify(view)} }))`);
    for (const step of ["driveOut", "toGarden", "sweepGarden", "driveBack"]) {
      await page.getByTestId(`step-row-${step}`).getByRole("button").first().click();
      const { found } = await outlines(page);
      expect(found.length, `${view}, ${step} selected`).toBeLessThanOrEqual(1);
    }
  }
});
