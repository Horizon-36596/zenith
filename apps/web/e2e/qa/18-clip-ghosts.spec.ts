/**
 * QA 18, clip ghosts (`src/canvas/clipGhosts.ts`): a path that runs out to the wall and back looks
 * fine from its start, so the field draws the robot in red where it leaves the field. The Problems
 * header's "Clip ghosts" toggle hides them and is remembered across a reload; pointing at the row
 * emphasises its ghost; clicking the row selects the step and moves the playhead onto the ghost.
 */
import { expect, test } from "@playwright/test";
import { editor, findingRows, loadExample, shot, skipTour } from "./helpers";

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
  // Append a leg that starts where the routine ends, runs east to x = 70 and comes back.
  await page.evaluate(
    `import("/src/state/store.ts").then((m) => {
      const s = m.getState();
      const steps = m.currentDerived().plan.steps;
      const end = steps[steps.length - 1].endPose;
      const y = end.yIn;
      m.commit({ ...s.auto, steps: [...s.auto.steps, {
        id: "clip", kind: "path", heading: { mode: "constant", headingRad: 0 },
        segments: [
          { kind: "line", from: "current", to: { xIn: 70, yIn: y } },
          { kind: "line", from: { xIn: 70, yIn: y }, to: { xIn: end.xIn, yIn: y } },
        ],
      }] });
    })`,
  );
  await expect(findingRows(page, "PERIMETER").filter({ hasText: "clip" })).toHaveCount(1);
});

test("the ghost toggle is on by default, hides the ghosts and is remembered", async ({ page }) => {
  const toggle = page.getByTestId("findings-clip-ghosts");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(toggle).toHaveAttribute("data-has-ghosts", "true");
  const ghost = await editor<{ poseIn?: { xIn: number } } | undefined>(
    page,
    `m.currentDerived().findings.find((f) => f.code === "PERIMETER" && f.stepId === "clip")?.geometry`,
  );
  expect(ghost?.poseIn?.xIn).toBeCloseTo(70, 0);
  await shot(page, "18-clip-ghosts-on");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => JSON.parse(window.localStorage.getItem("zenith.ui") ?? "{}").clipGhosts)).toBe(false);
  await shot(page, "18-clip-ghosts-off");

  await page.reload();
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("findings-clip-ghosts")).toHaveAttribute("aria-pressed", "false");
});

test("pointing at the row emphasises its ghost, and clicking it moves the playhead onto it", async ({ page }) => {
  const row = findingRows(page, "PERIMETER").filter({ hasText: "clip" });
  await row.hover();
  const hovered = await page.evaluate(`import("/src/lib/findingHover.ts").then((m) => m.getHoveredFinding())`);
  expect(String(hovered)).toMatch(/^PERIMETER\|clip\|/);
  await shot(page, "18-clip-ghost-hovered");

  await row.click();
  expect(await editor<string | undefined>(page, "s.selection.stepId")).toBe("clip");
  const playbackS = await editor<number | null>(page, "s.playbackS");
  expect(playbackS).not.toBeNull();
  const pose = await page.getByTestId("field-canvas").evaluate((canvas) => (canvas as HTMLCanvasElement).dataset["robotPose"] ?? "");
  const [xIn] = pose.split(",").map(Number);
  expect(xIn).toBeCloseTo(70, 0);
  await shot(page, "18-clip-ghost-playhead");
});
