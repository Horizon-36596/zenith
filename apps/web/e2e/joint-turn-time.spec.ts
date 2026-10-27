/**
 * The time estimate counts the turns at path joints (issue #153, sweep finding N8). The Add path
 * tool makes tangent lines from where the robot is, so a zigzag of them starts every path facing a
 * different way from how the last one ended, and the robot turns in place at every corner. The
 * headline total, its over styling and TIME_BUDGET read the estimate, which used to leave those turns
 * out: this zigzag read 26.03 s of 30 s, with no over styling and no TIME_BUDGET, while the ideal run,
 * which plays the turns, took 35.62 s.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { editor, loadExample, SHOTS_DIR, skipTour, withCore } from "./qa/helpers";

/** Twenty-one tangent lines from "current", zigzagging east from the start, as twenty clicks make. */
async function commitZigzag(page: Page): Promise<void> {
  await page.evaluate(`(async () => {
    const m = await import("/src/state/store.ts");
    const s = m.getState();
    const steps = Array.from({ length: 21 }, (_, i) => ({
      id: "path" + String(i + 1),
      kind: "path",
      segments: [{
        kind: "line",
        from: "current",
        to: { xIn: -12 + 3 * (i + 1), yIn: i % 2 === 0 ? -33 : -55, provenance: "SET FROM EDITOR" },
      }],
      heading: { mode: "tangent" },
    }));
    m.commit({ ...s.auto, steps });
  })()`);
  await expect(page.getByTestId("step-row-path21")).toBeVisible();
}

test.describe("the turns at path joints", () => {
  test.beforeEach(async ({ page }) => {
    await skipTour(page);
    await loadExample(page);
    await commitZigzag(page);
  });

  test("a zigzag's corner turns count in the headline, its over styling and TIME_BUDGET", async ({ page }) => {
    const total = page.getByTestId("timeline-total");
    await expect(total).toHaveAttribute("data-over", "true");
    const shownS = Number(await total.getAttribute("data-seconds"));
    expect(shownS).toBeGreaterThan(30);

    // The ideal run plays the same turns inside the steps, so the two totals agree.
    const idealS = Number(await page.getByTestId("timeline-level-total").getAttribute("data-seconds"));
    expect(Math.abs(shownS - idealS)).toBeLessThan(0.01);

    // Over the period on the estimate, so TIME_BUDGET fires; the band's optimistic end still fits.
    const budget = await editor<string[]>(
      page,
      `m.currentDerived().findings.filter((f) => f.code === "TIME_BUDGET").map((f) => f.severity + " " + f.stepId)`,
    );
    expect(budget).toEqual(["warning total"]);
    await expect(page.getByTestId("findings-list")).toContainText("autonomous period");
  });

  test("each path's turn is the hatched start of its own bar, not a block before it", async ({ page }) => {
    const turnS = await withCore<number>(page, `m.currentDerived().estimate.byStepId["path2"].turnS`);
    const stepS = await withCore<number>(page, `m.currentDerived().estimate.byStepId["path2"].nominalS`);
    expect(turnS).toBeGreaterThan(0.1);

    const lead = page.getByTestId("timeline-turn-path2");
    await expect(lead).toBeVisible();
    expect(Number(await lead.getAttribute("data-seconds"))).toBeCloseTo(turnS, 3);
    await expect(page.getByTestId("timeline-transition-path2")).toHaveCount(0);

    // The lead-in is the turn's share of the step's own bar, at its start.
    const bar = page.getByTestId("timeline-track").getByRole("button", { name: "path2", exact: true });
    const barBox = await bar.boundingBox();
    const leadBox = await lead.boundingBox();
    if (barBox === null || leadBox === null) throw new Error("the bar or its lead-in has no box");
    expect(leadBox.x).toBeCloseTo(barBox.x, 0);
    expect(leadBox.width / barBox.width).toBeCloseTo(turnS / stepS, 1);

    await bar.hover();
    await expect(page.getByRole("tooltip")).toContainText("turns in place");
    await page.mouse.move(2, 2);
    await expect(page.getByRole("tooltip")).toHaveCount(0);

    const dir = join(SHOTS_DIR, "timeline");
    mkdirSync(dir, { recursive: true });
    await page.getByTestId("timeline-total").locator("../..").screenshot({ path: join(dir, "timeline-joint-turns.png") });
  });

  test("a straight leg that starts facing the way the robot already faces has no lead-in", async ({ page }) => {
    await page.evaluate(`(async () => {
      const m = await import("/src/state/store.ts");
      const s = m.getState();
      const start = m.currentDerived().plan.startPose;
      const ahead = { xIn: start.xIn + 20 * Math.cos(start.headingRad), yIn: start.yIn + 20 * Math.sin(start.headingRad), provenance: "SET FROM EDITOR" };
      m.commit({ ...s.auto, steps: [{ id: "ahead", kind: "path", segments: [{ kind: "line", from: "current", to: ahead }], heading: { mode: "tangent" } }] });
    })()`);
    await expect(page.getByTestId("step-row-ahead")).toBeVisible();
    await expect(page.getByTestId("timeline-turn-ahead")).toHaveCount(0);
    expect(await withCore<number>(page, `m.currentDerived().estimate.byStepId["ahead"].turnS ?? 0`)).toBe(0);
  });
});
