/**
 * Issue #235: waypoint pin names are drawn in their own style and never on top of one another. The
 * bundled example had gardenPickup an inch from gardenSweepEnd until issue #211 dropped it as unused,
 * so the test puts it back where it was and shows every pin; zoomed to 8.8 px per inch their names
 * used to be drawn over each other. The unit test (src/canvas/pinLabels.test.ts) checks
 * the boxes; this one zooms the real canvas to that scale at 1440x900 with a device scale factor of
 * 1.95, keeps a screenshot of the south-west corner, and checks that the selected pin still works.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.95 });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
    }
  });
  await turnOnFeatures(page);
});

async function pxPerIn(page: Page): Promise<number> {
  return Number(await page.getByTestId("field-canvas").getAttribute("data-px-per-in"));
}

async function screenOf(page: Page, xIn: number, yIn: number): Promise<{ x: number; y: number }> {
  const canvas = page.getByTestId("field-canvas");
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("the canvas has no box");
  const scale = await pxPerIn(page);
  const originXPx = Number(await canvas.getAttribute("data-origin-x-px"));
  const originYPx = Number(await canvas.getAttribute("data-origin-y-px"));
  return { x: box.x + originXPx + scale * xIn, y: box.y + originYPx - scale * yIn };
}

test("zoomed to 8.8 px per inch the garden pins keep one readable name, and the selected pin keeps its own", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await page.evaluate(
    `import("/src/state/store.ts").then((m) => { m.setWaypointPins("all"); const s = m.getState(); const w = s.project.waypoints; m.commitWithWaypoints(s.auto, { ...w, waypoints: { ...w.waypoints, gardenPickup: { xIn: -61, yIn: -62, headingRad: -1.5708, provenance: "PLACEHOLDER: test" } } }); })`,
  );

  // Zoom about the two garden pins until the canvas is at 8.8 px per inch or just past it.
  for (let turns = 0; turns < 12 && (await pxPerIn(page)) < 8.8; turns += 1) {
    const at = await screenOf(page, -61.5, -62);
    const before = await pxPerIn(page);
    await page.mouse.move(at.x, at.y);
    await page.mouse.wheel(0, -120);
    // Wait for the canvas to publish the new zoom rather than for a fixed time.
    await expect.poll(() => pxPerIn(page)).toBeGreaterThan(before);
  }
  const scale = await pxPerIn(page);
  expect(scale).toBeGreaterThanOrEqual(8.8);
  expect(scale).toBeLessThan(10);

  const dir = process.env["ZENITH_QA_SHOTS"] ?? join(process.cwd(), "test-results", "pin-labels");
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, "pins-8.8.png") });

  // The names the static layer drew, which the canvas publishes: of the two pins an inch apart only
  // the first by name keeps its name.
  const canvas = page.getByTestId("field-canvas");
  const drawn = async (): Promise<string[]> => ((await canvas.getAttribute("data-pin-labels")) ?? "").split(",");
  await expect.poll(drawn).toContain("gardenPickup");
  expect(await drawn()).not.toContain("gardenSweepEnd");

  // Selecting the hidden one from the list gives it its name at once and the other gives way.
  const sweepRow = page.getByTestId("inspector-waypoint-row-gardenSweepEnd");
  if (!(await sweepRow.isVisible())) await page.getByRole("button", { name: /^Waypoints \(\d+\)/ }).click();
  await sweepRow.click();
  await expect(sweepRow).toHaveAttribute("aria-pressed", "true");
  await expect.poll(drawn).toContain("gardenSweepEnd");
  expect(await drawn()).not.toContain("gardenPickup");
  await page.screenshot({ path: join(dir, "pins-8.8-selected.png") });

  // And selecting gardenPickup brings its own name back.
  const pickupRow = page.getByTestId("inspector-waypoint-row-gardenPickup");
  await pickupRow.click();
  await expect(pickupRow).toHaveAttribute("aria-pressed", "true");
  await expect.poll(drawn).toContain("gardenPickup");
  expect(await drawn()).not.toContain("gardenSweepEnd");
});
