/**
 * A partner who paths on the fly or plans in RoadRunner hands over a trajectory.json rather than a
 * projection (spec 13 section 11). The Partners panel takes it through the same file picker, reads
 * it against the open auto's field, and shows the partner beside the auto like any other.
 */
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { turnOnFeatures } from "./features";

const TRAJECTORY = fileURLToPath(
  new URL("../../../packages/import/fixtures/trajectory/meepmeep-line-and-turn.trajectory.json", import.meta.url),
);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem(
        "zenith.ui",
        JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }),
      );
    }
  });
  await turnOnFeatures(page);
});

test("a partner's trajectory.json loads into the alliance view like a projection", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await page.getByTestId("partners-panel-fold").click();
  await page.getByTestId("partners-file-input").setInputFiles(TRAJECTORY);
  await expect(page.getByTestId("partners-list")).toContainText("MeepMeep line and turn");
});
