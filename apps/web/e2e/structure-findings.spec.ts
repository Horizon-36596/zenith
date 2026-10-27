/**
 * Issue #152: a collision is reported once, on the step that drove into it, with the obstacle named
 * in words a student can find and outlined while its row is pointed at.
 *
 * In the bundled example, `collectFlower` drives north to flower1 and the robot then stands there
 * through `waitForFull` and `stopIntake` before `toScoreNorth` backs away. Ending `collectFlower`
 * 0.9 in into the flower's foot used to raise the same STRUCTURE error on all four steps.
 */
import { expect, test, type Page } from "@playwright/test";
import { findingRows, loadExample, skipTour } from "./qa/helpers";

/** Ends one path step of the example, whose only segment runs to a waypoint, at `to` instead. */
async function endStepAt(page: Page, stepId: string, to: { xIn: number; yIn: number }): Promise<void> {
  await page.evaluate(
    `import("/src/state/store.ts").then((m) => {
      const s = m.getState();
      const steps = s.auto.steps.map((step) =>
        step.id === ${JSON.stringify(stepId)}
          ? { ...step, segments: [{ ...step.segments[0], to: ${JSON.stringify(to)} }] }
          : step,
      );
      m.commit({ ...s.auto, steps });
    })`,
  );
}

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
  await expect(page.getByTestId("findings-count-error")).toHaveText("0 errors");
});

test("a robot ending in a flower's foot is one error, named, and outlined on hover", async ({ page }) => {
  await endStepAt(page, "collectFlower", { xIn: -24, yIn: 59 });

  const structure = findingRows(page, "STRUCTURE");
  await expect(structure).toHaveCount(1);
  await expect(page.getByTestId("findings-count-error")).toHaveText("1 error");
  await expect(structure).toContainText("collectFlower");
  await expect(structure).toContainText("the foot of flower1 on the north wall (flower1Foot)");
  await expect(structure).toContainText("0.90 in deep");

  const canvas = page.getByTestId("field-canvas");
  await expect(canvas).not.toHaveAttribute("data-outlined-obstacle");
  await structure.hover();
  await expect(canvas).toHaveAttribute("data-outlined-obstacle", "flower1Foot");
  await page.getByTestId("findings-count-error").hover();
  await expect(canvas).not.toHaveAttribute("data-outlined-obstacle");
});

test("a sweep that ends through the wall is one PERIMETER error, on the sweep", async ({ page }) => {
  await endStepAt(page, "sweepGarden", { xIn: -64, yIn: -62 });

  const perimeter = findingRows(page, "PERIMETER");
  await expect(perimeter).toHaveCount(1);
  await expect(perimeter).toContainText("sweepGarden");
  await expect(page.getByTestId("findings-count-error")).toHaveText("1 error");
});
