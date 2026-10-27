/**
 * "Download share file" (spec 13 section 8.2, without the cloud): from the command palette, the open
 * auto's view projection downloads as `<auto>.view.projection.json`, and it is a projection.
 */
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { turnOnFeatures } from "./features";

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

test("the palette downloads the open auto's view projection as a file", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Download share file");
  const download = page.waitForEvent("download");
  await page.getByTestId("palette-item-project.downloadShareFile").click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("collect-and-score.view.projection.json");
  const path = await file.path();
  const projection = JSON.parse(readFileSync(path, "utf8")) as { kind: string; level: string };
  expect(projection).toMatchObject({ kind: "projection", level: "view" });
});
