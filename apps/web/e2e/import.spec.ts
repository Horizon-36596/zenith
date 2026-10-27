/**
 * "Import from another planner" (M-C8): a path.json picked from the command palette opens as a new,
 * unsaved auto in the open project, with the importer's notice beside the field; a broken file
 * opens nothing and names the field that is wrong.
 */
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";

const fixture = (path: string): string =>
  fileURLToPath(new URL(`../../../packages/import/fixtures/${path}`, import.meta.url));

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

async function loadExample(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
}

async function importFromPalette(page: Page, path: string): Promise<void> {
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Import from another planner");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("palette-item-project.import").click();
  await (await chooser).setFiles(path);
}

test("a path.json opens as a new unsaved auto, with a notice that is not modal", async ({ page }) => {
  await loadExample(page);
  await importFromPalette(page, fixture("path/pedro-score-and-park.path.json"));

  await expect(page.getByTestId("toolbar-auto-name")).toContainText("pedro-score-and-park.auto.json");
  await expect(page.getByTestId("toolbar-auto-name").getByLabel("Unsaved changes")).toBeVisible();
  await expect(page.getByTestId("step-row-gardenApproach")).toBeVisible();

  const notice = page.getByTestId("import-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("pedro-score-and-park.auto.json");
  // The notice is not modal: the step list behind it still takes a click.
  await page.getByTestId("step-row-park").click();
  await expect(notice).toBeVisible();
  await page.getByTestId("import-notice-dismiss").click();
  await expect(notice).toHaveCount(0);
});

test("a .pp project's notice offers the other alliance, and importing for it replaces the auto", async ({ page }) => {
  await loadExample(page);
  await importFromPalette(page, fixture("pedro/score-and-park.pp"));
  await expect(page.getByTestId("toolbar-auto-name")).toContainText("score-and-park.auto.json");
  await expect(page.getByTestId("alliance-pill")).toHaveAttribute("data-alliance", "RED");
  const notice = page.getByTestId("import-notice");
  await expect(notice).toContainText("If the path was drawn for BLUE, click Import for BLUE on this notice.");
  await expect(notice).not.toContainText("Pass the alliance");

  // The imported auto is still as imported, so the second import replaces it without asking.
  await notice.getByTestId("import-notice-other-alliance").click();
  await expect(page.getByTestId("alliance-pill")).toHaveAttribute("data-alliance", "BLUE");
  await expect(page.getByTestId("toolbar-auto-name")).toContainText("score-and-park.auto.json");
  await expect(notice).not.toContainText("does not say which alliance");
  await expect(notice.getByTestId("import-notice-other-alliance")).toHaveCount(0);
  await expect(page.getByTestId("status")).toContainText("written for BLUE");
});

test("a broken path.json opens nothing and names the field that is wrong", async ({ page }) => {
  await loadExample(page);
  await importFromPalette(page, fixture("path/broken/piecewise-gap.path.json"));

  const notice = page.getByTestId("import-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("steps[2].heading.ranges[1].startT");
  await expect(page.getByTestId("toolbar-auto-name")).toContainText("collect-and-score.auto.json");
});

test("a trajectory.json from MeepMeep opens as a new auto that can be saved and shared", async ({ page }) => {
  await loadExample(page);
  await importFromPalette(page, fixture("trajectory/meepmeep-line-and-turn.trajectory.json"));

  await expect(page.getByTestId("toolbar-auto-name")).toContainText("meepmeep-line-and-turn.auto.json");
  await expect(page.getByTestId("toolbar-auto-name").getByLabel("Unsaved changes")).toBeVisible();
  await expect(page.getByTestId("step-row-drive1")).toBeVisible();
  await expect(page.getByTestId("step-row-wait1")).toBeVisible();
  await expect(page.getByTestId("step-row-turn1")).toBeVisible();

  const notice = page.getByTestId("import-notice");
  await expect(notice).toContainText("Imported the trajectory.json as meepmeep-line-and-turn.auto.json");
  await expect(notice).toContainText("timed from this project's robot.json");
  await expect(notice).toContainText("turns 90 degrees without moving");
});
