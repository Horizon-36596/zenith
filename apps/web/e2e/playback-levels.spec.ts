/**
 * The three playback levels (site/docs/simulation.md, "Playback levels"): Ideal is the default, the one control switches
 * between Ideal, Instant sim and Full sim, the robot, the readouts and the timeline say which level
 * they come from, and a scrub at the Ideal level puts the robot exactly on the planned path.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  canvasView,
  editor,
  installCanvasProbe,
  loadExample,
  nextFrame,
  polygonCentreIn,
  robotOutlines,
  SHOTS_DIR,
  skipTour,
  withCore,
} from "./qa/helpers";

interface PoseRow {
  xIn: number;
  yIn: number;
  headingRad: number;
}

/** The robot's pose as the canvas published it for the last frame it drew. */
async function robotPose(page: Page): Promise<PoseRow> {
  const raw = (await page.getByTestId("field-canvas").getAttribute("data-robot-pose")) ?? "";
  const [xIn, yIn, headingRad] = raw.split(",").map(Number);
  return { xIn: xIn ?? Number.NaN, yIn: yIn ?? Number.NaN, headingRad: headingRad ?? Number.NaN };
}

async function scrubTo(page: Page, atS: number): Promise<void> {
  await page.evaluate(`import("/src/state/store.ts").then((m) => m.setPlayback(${String(atS)}))`);
  // Two frames: one for React to hand the canvas the new time, one for the canvas to draw it.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

const wrap = (rad: number): number => Math.atan2(Math.sin(rad), Math.cos(rad));

test.describe("playback levels", () => {
  test.beforeEach(async ({ page }) => {
    await skipTour(page);
    await installCanvasProbe(page);
    await loadExample(page);
  });

  test("Ideal is the default, and everything says so", async ({ page }) => {
    const control = page.getByTestId("playback-level");
    await expect(control).toBeVisible();
    await expect(control).toHaveAttribute("data-level", "ideal");
    await expect(page.getByTestId("playback-level-ideal")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("playback-level-instant")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("playback-level-full")).toHaveAttribute("aria-pressed", "false");
    expect(await editor<string>(page, "s.prefs.playbackLevel")).toBe("ideal");

    // The robot on the field, the level total, the playhead and the timeline all name the level.
    await expect(page.getByTestId("field-canvas")).toHaveAttribute("data-playback-level", "ideal");
    await expect(page.getByTestId("timeline-level-total")).toHaveAttribute("data-level", "ideal");
    await expect(page.getByTestId("timeline-level-total")).toContainText("ideal");
    await expect(page.getByTestId("playhead-readout")).toContainText("s ideal");
    await expect(page.getByTestId("timeline-track")).toHaveAttribute("data-level", "ideal");
    await expect(page.getByTestId("timeline-preview-track")).toHaveCount(0);
    expect((await nextFrame(page)).texts).toContain("Ideal");

    // The ideal total is core's, on the estimate's clock.
    const idealS = await withCore<number>(
      page,
      `(() => { const d = m.currentDerived(); return c.idealTrajectory(d.plan, d.estimate).totalS; })()`,
    );
    const shown = Number(await page.getByTestId("timeline-level-total").getAttribute("data-seconds"));
    expect(shown).toBeCloseTo(idealS, 3);
    // And the scrubber runs on the ideal clock.
    expect(Number(await page.getByTestId("playback").getAttribute("max"))).toBeCloseTo(idealS, 6);
  });

  test("a scrub at the Ideal level puts the robot exactly on the planned path", async ({ page }) => {
    // Sample times inside every path's motion, and what core says the path is at each.
    const samples = await withCore<
      Array<{ stepId: string; atS: number; pose: PoseRow; offPathIn: number; headingErrorRad: number }>
    >(
      page,
      `(() => {
        const d = m.currentDerived();
        const traj = c.idealTrajectory(d.plan, d.estimate);
        const flat = c.flattenSteps(d.plan.steps);
        const out = [];
        for (const seg of traj.segments) {
          if (seg.kind !== "path" || seg.endS - seg.startS < 0.05) continue;
          const step = flat.find((x) => x.id === seg.stepId);
          const g = step.geometry;
          const headingAt = c.headingFunction(step.step.heading, g);
          for (const f of [0.13, 0.5, 0.77]) {
            const atS = seg.startS + (seg.endS - seg.startS) * f;
            const pose = c.idealPoseAt(traj, atS);
            // The nearest point of the planned geometry: a dense scan, then a golden-section search.
            const dist = (s) => { const p = g.pointAtDistance(s); return Math.hypot(p.xIn - pose.xIn, p.yIn - pose.yIn); };
            let best = 0;
            for (let s = 0; s <= g.lengthIn; s += 0.05) if (dist(s) < dist(best)) best = s;
            let lo = Math.max(0, best - 0.05), hi = Math.min(g.lengthIn, best + 0.05);
            const r = (Math.sqrt(5) - 1) / 2;
            for (let i = 0; i < 80; i += 1) { const a = hi - r * (hi - lo), b = lo + r * (hi - lo); if (dist(a) < dist(b)) hi = b; else lo = a; }
            const s = (lo + hi) / 2;
            const want = headingAt(g.tAtDistance(s));
            out.push({ stepId: seg.stepId, atS, pose, offPathIn: dist(s), headingErrorRad: Math.abs(Math.atan2(Math.sin(pose.headingRad - want), Math.cos(pose.headingRad - want))) });
          }
        }
        return out;
      })()`,
    );
    expect(samples.length).toBeGreaterThan(6);

    for (const sample of samples) {
      const label = `${sample.stepId} at ${sample.atS.toFixed(3)} s`;
      // Core's ideal pose is on the geometry, with the heading mode's heading.
      expect(sample.offPathIn, `${label}: core's ideal pose off the path`).toBeLessThan(1e-6);
      expect(sample.headingErrorRad, `${label}: core's ideal heading`).toBeLessThan(1e-6);

      // And the robot the canvas draws is that pose.
      await scrubTo(page, sample.atS);
      const drawn = await robotPose(page);
      expect(Math.hypot(drawn.xIn - sample.pose.xIn, drawn.yIn - sample.pose.yIn), `${label}: drawn position`).toBeLessThan(1e-9);
      expect(Math.abs(wrap(drawn.headingRad - sample.pose.headingRad)), `${label}: drawn heading`).toBeLessThan(1e-9);
      const view = await canvasView(page);
      const outlines = robotOutlines(await nextFrame(page), view.pxPerIn);
      expect(outlines.length, `${label}: one robot outline`).toBe(1);
      const centre = polygonCentreIn(view, outlines[0] ?? []);
      expect(Math.hypot(centre.xIn - sample.pose.xIn, centre.yIn - sample.pose.yIn), `${label}: outline centre`).toBeLessThan(0.3);
    }
  });

  test("the control switches between Ideal and Instant sim, and remembers the choice", async ({ page }) => {
    const instant = page.getByTestId("playback-level-instant");
    // The instant sim runs a tick after load; until then its option says it has not run.
    await expect(instant).not.toHaveAttribute("aria-disabled", "true");
    const atS = await withCore<number>(
      page,
      `(() => { const d = m.currentDerived(); return c.idealTrajectory(d.plan, d.estimate).totalS * 0.4; })()`,
    );
    await scrubTo(page, atS);
    const ideal = await robotPose(page);

    await instant.click();
    await expect(page.getByTestId("playback-level")).toHaveAttribute("data-level", "instant");
    await expect(instant).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("field-canvas")).toHaveAttribute("data-playback-level", "instant");
    await expect(page.getByTestId("timeline-level-total")).toContainText("instant sim");
    await expect(page.getByTestId("playhead-readout")).toContainText("s instant");
    await expect(page.getByTestId("timeline-preview-track")).toBeVisible();
    await scrubTo(page, atS);
    expect((await nextFrame(page)).texts).toContain("Instant sim");

    // At the same time the instant robot is where core's instant sim puts it, not the ideal pose.
    const want = await withCore<PoseRow>(
      page,
      `(() => { const d = m.currentDerived(); const t = c.simulate(d.plan, s.autoRobot, s.autoField); return c.simPoseAt(t, ${String(atS)}); })()`,
    );
    const drawn = await robotPose(page);
    expect(Math.hypot(drawn.xIn - want.xIn, drawn.yIn - want.yIn)).toBeLessThan(1e-6);
    expect(Math.hypot(drawn.xIn - ideal.xIn, drawn.yIn - ideal.yIn), "the two levels differ here").toBeGreaterThan(0.05);

    // The choice is a preference: it survives a reload.
    expect(await editor<string>(page, "s.prefs.playbackLevel")).toBe("instant");
    await page.reload();
    await page.getByTestId("canvas-load-example").click();
    await expect(page.getByTestId("playback-level")).toHaveAttribute("data-level", "instant");

    await page.getByTestId("playback-level-ideal").click();
    await expect(page.getByTestId("playback-level")).toHaveAttribute("data-level", "ideal");
    await expect(page.getByTestId("field-canvas")).toHaveAttribute("data-playback-level", "ideal");
    expect(await editor<string>(page, "s.prefs.playbackLevel")).toBe("ideal");
  });

  test("Full sim is unavailable without a trace, and its tooltip says why", async ({ page }) => {
    const full = page.getByTestId("playback-level-full");
    await expect(full).toHaveAttribute("aria-disabled", "true");
    // Playwright will not click an aria-disabled button by itself; a person still can.
    await full.click({ force: true });
    await expect(page.getByTestId("playback-level")).toHaveAttribute("data-level", "ideal");
    expect(await editor<string>(page, "s.prefs.playbackLevel")).toBe("ideal");
    // The press closed its tooltip; hovering it afresh opens it again.
    await page.mouse.move(2, 2);
    await full.hover();
    const tip = page.getByRole("tooltip");
    await expect(tip).toContainText("Full sim");
    await expect(tip).toContainText("load the trace");
  });

  test("a step that starts away from the robot gets a visible, timed transition at the Ideal level", async ({ page }) => {
    // Move toGarden's start 12 in off the end of the step before it.
    await page.evaluate(`(async () => {
      const m = await import("/src/state/store.ts");
      const s = m.getState();
      const start = m.currentDerived().plan.steps.find((x) => x.id === "toGarden").startPose;
      const steps = s.auto.steps.map((x) => x.id !== "toGarden" ? x : { ...x, segments: x.segments.map((seg, i) => i !== 0 ? seg : { ...seg, from: { xIn: start.xIn + 12, yIn: start.yIn, provenance: "SET BY HAND: e2e gap" } }) });
      m.commit({ ...s.auto, steps });
    })()`);
    const block = page.getByTestId("timeline-transition-toGarden");
    await expect(block).toBeVisible();
    const transition = await withCore<{ startS: number; endS: number; fromPose: PoseRow; toPose: PoseRow; translateIn: number }>(
      page,
      `(() => { const d = m.currentDerived(); return c.idealTrajectory(d.plan, d.estimate).transitions.find((x) => x.stepId === "toGarden"); })()`,
    );
    expect(transition.translateIn).toBeCloseTo(12, 6);
    expect(transition.endS).toBeGreaterThan(transition.startS);

    // Halfway through, the robot is on the straight line across the gap.
    await scrubTo(page, (transition.startS + transition.endS) / 2);
    const drawn = await robotPose(page);
    const dx = transition.toPose.xIn - transition.fromPose.xIn;
    const dy = transition.toPose.yIn - transition.fromPose.yIn;
    const cross = (drawn.xIn - transition.fromPose.xIn) * dy - (drawn.yIn - transition.fromPose.yIn) * dx;
    expect(Math.abs(cross) / Math.hypot(dx, dy), "on the line across the gap").toBeLessThan(1e-6);
    expect(Math.hypot(drawn.xIn - transition.fromPose.xIn, drawn.yIn - transition.fromPose.yIn)).toBeGreaterThan(1);
    expect(Math.hypot(drawn.xIn - transition.toPose.xIn, drawn.yIn - transition.toPose.yIn)).toBeGreaterThan(1);
    // The gap is drawn dashed on the field.
    expect((await nextFrame(page)).dashes.length).toBeGreaterThan(0);
    await block.hover();
    await expect(page.getByRole("tooltip")).toContainText("does not start where the robot is");
    const dir = process.env["ZENITH_PLAYBACK_SHOTS"] ?? join(SHOTS_DIR, "playback");
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, "playback-ideal-transition.png") });
  });

  test("screenshots of the control, and of the robot at the Ideal and Instant sim levels", async ({ page }) => {
    const dir = process.env["ZENITH_PLAYBACK_SHOTS"] ?? join(SHOTS_DIR, "playback");
    mkdirSync(dir, { recursive: true });
    await expect(page.getByTestId("playback-level-instant")).not.toHaveAttribute("aria-disabled", "true");
    // Halfway through toGarden's curve on the ideal clock, where the two levels part.
    const atS = await withCore<number>(
      page,
      `(() => { const d = m.currentDerived(); const t = c.idealTrajectory(d.plan, d.estimate); const x = t.segments.find((y) => y.kind === "path" && y.stepId === "toGarden"); return (x.startS + x.endS) / 2; })()`,
    );
    await scrubTo(page, atS);
    await page.mouse.move(2, 2);
    await page.getByTestId("playback-level").locator("..").screenshot({ path: join(dir, "playback-control.png") });
    await page.screenshot({ path: join(dir, "playback-ideal.png") });
    await page.getByTestId("playback-level-instant").click();
    await scrubTo(page, atS);
    await page.mouse.move(2, 2);
    await page.screenshot({ path: join(dir, "playback-instant.png") });
    await page.getByTestId("timeline-level-total").locator("../..").screenshot({ path: join(dir, "playback-timeline-instant.png") });
  });
});
