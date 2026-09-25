/**
 * QA 5 through the UI (the core half is `apps/web/src/canvas/wallSnap.qa.test.ts`): drag a pose
 * into each of the four walls at headings 0, 45, 90 and 180 degrees. The pointer is pushed 2 in past
 * flush while the point stays on the field; the snap must rest the whole footprint, body and
 * mouths, flush against the wall, and the problems panel must show no PERIMETER for that step.
 */
import { expect, test, type Page } from "@playwright/test";
import { clearStatus, dragWorld, editor, fixture, openProjectWith, shot, skipTour, withCore } from "./helpers";

interface Pose {
  xIn: number;
  yIn: number;
}

type Wall = "minX" | "maxX" | "minY" | "maxY";

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await openProjectWith(page, { "qa-walls.auto.json": fixture("qa-walls.auto.json") });
  // Only for clean screenshots: the status bar overlays the layout and never moves the field.
  await clearStatus(page);
});

const to = (page: Page, step: string) =>
  editor<Pose>(page, `s.auto.steps.find((x) => x.id === ${JSON.stringify(step)}).segments[0].to`);

/** The union box of the body and every mouth at a pose, from core, with the field's bounds. */
const boxes = (page: Page, pose: Pose, headingRad: number) =>
  withCore<{ box: { minXIn: number; maxXIn: number; minYIn: number; maxYIn: number }; bounds: { minXIn: number; maxXIn: number; minYIn: number; maxYIn: number } }>(
    page,
    `({ box: c.footprintBoundsIn({ xIn: ${String(pose.xIn)}, yIn: ${String(pose.yIn)}, headingRad: ${String(headingRad)} }, s.autoRobot), bounds: c.fieldBounds(s.autoField) })`,
  );

for (const deg of [0, 45, 90, 180]) {
  test(`the ${String(deg)} degree leg rests flush against all four walls with no PERIMETER`, async ({ page }) => {
    const step = `w${String(deg)}`;
    const headingRad = Math.round(((deg * Math.PI) / 180) * 1e4) / 1e4;
    await page.getByTestId(`step-row-${step}`).getByRole("button").first().click();
    const zero = await boxes(page, { xIn: 0, yIn: 0 }, headingRad);
    const walls: Array<[Wall, Pose]> = [
      ["maxX", { xIn: zero.bounds.maxXIn - zero.box.maxXIn + 2, yIn: 6.3 }],
      ["maxY", { xIn: 6.3, yIn: zero.bounds.maxYIn - zero.box.maxYIn + 2 }],
      ["minX", { xIn: zero.bounds.minXIn - zero.box.minXIn - 2, yIn: 6.3 }],
      ["minY", { xIn: 6.3, yIn: zero.bounds.minYIn - zero.box.minYIn - 2 }],
    ];
    const failures: string[] = [];
    for (const [wall, pointer] of walls) {
      const from = await to(page, step);
      await dragWorld(page, from, pointer, { steps: 10 });
      const at = await to(page, step);
      const { box, bounds } = await boxes(page, at, headingRad);
      const gap = { minX: box.minXIn - bounds.minXIn, maxX: bounds.maxXIn - box.maxXIn, minY: box.minYIn - bounds.minYIn, maxY: bounds.maxYIn - box.maxYIn }[wall];
      if (Math.abs(gap) > 0.1) failures.push(`${wall}: ${gap.toFixed(3)} in from flush at (${at.xIn.toFixed(2)}, ${at.yIn.toFixed(2)})`);
      const perimeter = await editor<string[]>(
        page,
        `m.currentDerived().findings.filter((f) => f.code === "PERIMETER" && f.stepId === ${JSON.stringify(step)}).map((f) => f.message)`,
      );
      if (perimeter.length > 0) failures.push(`${wall}: PERIMETER ${perimeter.join("; ")}`);
      await shot(page, `05-wall-${String(deg)}-${wall}`);
    }
    // The problems panel agrees with the store: no PERIMETER row names this step.
    await expect(page.getByTestId("finding-row").filter({ hasText: step }).filter({ hasText: "PERIMETER" })).toHaveCount(0);
    expect(failures).toEqual([]);
  });
}
