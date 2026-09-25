/**
 * QA 10, the instant sim (site/docs/simulation.md):
 * the timeline's preview bars are the sim's times, not the estimate's; an edit reaches the bars
 * within a frame or two; a `linear` heading that asks for more than half a turn is sampled and
 * simulated the short way, as Pedro turns on the robot, and the problems panel says so with a
 * HEADING warning. The timing budget itself is `apps/web/src/state/sim.qa.test.ts`.
 */
import { expect, test, type Page } from "@playwright/test";
import { editor, fixture, loadExample, openProjectWith, shot, skipTour, withCore } from "./helpers";

interface Span {
  id: string;
  durationS: number;
}

/** The sim's own per-step durations for the editor's current plan, from core. */
const coreSpans = (page: Page): Promise<Span[]> =>
  withCore<Span[]>(
    page,
    `(() => { const d = m.currentDerived(); const t = c.simulate(d.plan, d.plan.robot, d.plan.field); return t.steps.filter((x) => x.parentId === null).map((x) => ({ id: x.id, durationS: x.endS - x.startS })); })()`,
  );

/** Each preview bar's flex-grow, which is its share of the track. */
const barGrowth = (page: Page): Promise<Record<string, number>> =>
  page.evaluate(() => {
    const out: Record<string, number> = {};
    for (const bar of document.querySelectorAll<HTMLElement>('[data-testid^="timeline-preview-"]')) {
      const id = (bar.dataset.testid ?? "").replace("timeline-preview-", "");
      if (id === "track") continue;
      out[id] = Number(bar.style.flexGrow);
    }
    return out;
  });

test.describe("on the bundled example", () => {
  test.beforeEach(async ({ page }) => {
    // The preview bars are the Instant sim level's; Ideal, the default, shows the estimate's.
    await skipTour(page, { playbackLevel: "instant" });
    // collect-and-score, the auto the example opens, has eight top-level steps to compare.
    await loadExample(page);
    await expect(page.getByTestId("timeline-preview-track")).toBeVisible();
  });

  test("the preview bars are sized by the sim's step times, and the total is the sim's", async ({ page }) => {
    const spans = await coreSpans(page);
    const bars = await barGrowth(page);
    await shot(page, "10-timeline-preview");
    const long = spans.filter((span) => span.durationS > 0.3);
    expect(long.length).toBeGreaterThan(3);
    // One seconds-to-share scale for every bar: flexGrow / duration is the same for all of them.
    const scales = long.map((span) => (bars[span.id] ?? Number.NaN) / span.durationS);
    const ref = scales[0] ?? Number.NaN;
    for (const [index, scale] of scales.entries()) {
      expect(scale / ref, `${long[index]?.id ?? ""} bar against the sim's ${String(long[index]?.durationS)} s`).toBeCloseTo(1, 2);
    }
    // And the scale is not the estimate's: at least one step differs between the two clocks.
    const estimate = await editor<Record<string, number>>(
      page,
      `(() => { const d = m.currentDerived(); const out = {}; for (const x of d.estimate?.steps ?? []) out[x.stepId] = x.nominalS ?? 0; return out; })()`,
    );
    const differs = long.some((span) => Math.abs((estimate[span.id] ?? span.durationS) - span.durationS) > 0.05);
    expect(differs, "the bars follow the sim, which differs from the estimate somewhere").toBe(true);
    // The level's total reads the sim's end time, and says it is the instant sim's.
    const total = long.reduce((sum, span) => sum + span.durationS, 0);
    const readout = page.getByTestId("timeline-level-total");
    await expect(readout).toBeVisible();
    await expect(readout).toHaveAttribute("data-level", "instant");
    await expect(readout).toContainText("instant sim");
    const label = (await readout.textContent()) ?? "";
    expect(Number(/([0-9]+(?:\.[0-9]+)?)/.exec(label)?.[1] ?? Number.NaN)).toBeGreaterThanOrEqual(total - 0.2);
  });

  test("a bar's tooltip gives its sim time", async ({ page }) => {
    const spans = await coreSpans(page);
    const toGarden = spans.find((span) => span.id === "toGarden");
    await page.getByTestId("timeline-preview-toGarden").hover();
    const tip = page.getByRole("tooltip");
    await expect(tip).toContainText("in the sim");
    await expect(tip).toContainText((toGarden?.durationS ?? 0).toFixed(1));
    await shot(page, "10-timeline-preview-tooltip");
  });

  test("an edit reaches the preview bars within two frames", async ({ page }) => {
    const result = await page.evaluate(`(async () => {
      const m = await import("/src/state/store.ts");
      const bar = () => document.querySelector('[data-testid="timeline-preview-toGarden"]');
      const before = Number(bar().style.flexGrow);
      const s = m.getState();
      const steps = s.auto.steps.map((x) => x.id !== "toGarden" ? x : { ...x, segments: x.segments.map((seg) => ({ ...seg, to: { xIn: -40, yIn: -44, headingRad: -1.5708, provenance: "SET BY HAND: QA edit" } })) });
      const t0 = performance.now();
      m.commit({ ...s.auto, steps });
      let frames = 0;
      while (frames < 30) {
        await new Promise((r) => requestAnimationFrame(r));
        frames += 1;
        const track = document.querySelector('[data-testid="timeline-preview-track"]');
        if (Number(bar().style.flexGrow) !== before && track.dataset.stale !== "true") break;
      }
      return { frames, ms: performance.now() - t0, before, after: Number(bar().style.flexGrow) };
    })()`) as { frames: number; ms: number; before: number; after: number };
    expect(result.after, "the bar changed").not.toBe(result.before);
    expect(result.frames, `the bar caught up after ${String(result.frames)} frames (${result.ms.toFixed(1)} ms)`).toBeLessThanOrEqual(2);
    // Undo puts the old time back.
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await barGrowth(page)).toGarden).toBeCloseTo(result.before, 6);
  });
});

test.describe("a linear heading asked for more than half a turn", () => {
  test.beforeEach(async ({ page }) => {
    await skipTour(page);
    await openProjectWith(page, { "qa-heading.auto.json": fixture("qa-heading.auto.json") });
  });

  test("is sampled and simulated the short way", async ({ page }) => {
    // 0 to 3.5 rad the long way passes +pi/2; the short way, 0 to 3.5 - 2 pi, passes -pi/2.
    const samples = await editor<number[]>(
      page,
      `m.currentDerived().plan.steps.find((x) => x.id === "turn").samples.map((x) => x.pose.headingRad)`,
    );
    const mid = samples[Math.floor(samples.length / 2)] ?? Number.NaN;
    expect(Math.sin(mid), `plan heading halfway is ${mid.toFixed(3)} rad`).toBeLessThan(0);
    const simMid = await withCore<number>(
      page,
      `(() => { const d = m.currentDerived(); const t = c.simulate(d.plan, d.plan.robot, d.plan.field); const x = t.steps.find((y) => y.id === "turn"); return c.simPoseAt(t, (x.startS + x.endS) / 2).headingRad; })()`,
    );
    expect(Math.sin(simMid), `sim heading halfway is ${simMid.toFixed(3)} rad`).toBeLessThan(0);
  });

  test("raises a HEADING warning in the problems panel that says it turns the short way", async ({ page }) => {
    const findings = await editor<Array<{ code: string; severity: string; stepId?: string; message: string }>>(
      page,
      "m.currentDerived().findings",
    );
    const heading = findings.filter((finding) => finding.code === "HEADING");
    expect(heading.length).toBe(1);
    expect(heading[0]?.severity).toBe("warning");
    expect(heading[0]?.stepId).toBe("turn");
    const row = page.getByTestId("finding-row").filter({ hasText: "HEADING" });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(/short way/i);
    await expect(row).toHaveAttribute("data-severity", "warning");
    await shot(page, "10-heading-warning");
  });

  test("the warning goes when the sweep is under half a turn", async ({ page }) => {
    const s = await editor<unknown>(page, "s.auto");
    const auto = s as { steps: Array<{ heading: Record<string, number | string> }> };
    const steps = auto.steps.map((step) => ({ ...step, heading: { ...step.heading, toRad: 2 } }));
    await page.evaluate(
      `import("/src/state/store.ts").then((m) => m.commit({ ...m.getState().auto, steps: ${JSON.stringify(steps)} }))`,
    );
    await expect(page.getByTestId("finding-row").filter({ hasText: "HEADING" })).toHaveCount(0);
  });
});
