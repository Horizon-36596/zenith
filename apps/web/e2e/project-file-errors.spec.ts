/**
 * What opening a robot repository says when one of its files is broken (the 0.1.2 UX sweep, W3-3 to
 * W3-8): the file's path, the line and column of bad JSON, and what to do; an auto that does not load
 * does not leave the project without one; a project file chosen as a partner's share file gets one
 * sentence, not the schema's list; and Save a copy to downloads says what it downloaded.
 *
 * The folder is served from the origin-private file system by `opfsProject.ts`, so Open folder takes
 * the same File System Access path a person's folder does. Screenshots go to
 * test-results/project-file-errors/.
 */
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";
import { serveFolder, starterFiles } from "./opfsProject";

const SHOTS = fileURLToPath(new URL("../test-results/project-file-errors/", import.meta.url));
const ROBOT = fileURLToPath(new URL("../../../examples/starter/autos/robot.json", import.meta.url));

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
    }
  });
});

/** Serves `files` as the folder, then opens it with the welcome screen's Open a folder button. */
async function openWith(page: Page, files: Record<string, string>): Promise<void> {
  await serveFolder(page, files);
  await page.goto("/");
  await expect(page.getByTestId("canvas-empty")).toBeVisible();
  await page.getByTestId("canvas-open-project").click();
}

const status = (page: Page) => page.getByTestId("status");

test("W3-4: a robot.json that is not valid JSON is named, with its line and column and what to do", async ({ page }) => {
  await openWith(page, starterFiles({ "autos/robot.json": () => "{ kinematics: 1 }" }));
  await expect(status(page)).toContainText(
    "autos/robot.json is not valid JSON (line 1, column 3). Fix it, or restore it from git.",
  );
  // The empty canvas says the folder did not open, with the same sentence (issue #502).
  const failed = page.getByTestId("canvas-open-failed");
  await expect(failed).toContainText("robot-repo did not open");
  await expect(page.getByTestId("canvas-open-failed-why")).toContainText("autos/robot.json is not valid JSON");
  await expect(page.getByTestId("canvas-empty")).toHaveCount(0);
  await expect(page.getByTestId("canvas-open-failed-another")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}w3-4-robot-not-json.png` });
  // The example is another way in, and the canvas then shows it.
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await expect(failed).toHaveCount(0);
});

test("W3-5: a file zenith.json names that is missing says which key names it", async ({ page }) => {
  const files = starterFiles();
  delete files["autos/robot.json"];
  await openWith(page, files);
  await expect(status(page)).toContainText(
    'autos/robot.json is not in this folder, but zenith.json\'s "robot" names it. Fix that path in zenith.json, or add the file.',
  );
  await page.screenshot({ path: `${SHOTS}w3-5-robot-missing.png` });
});

test("W3-5: a field file from a newer Zenith says to update Zenith", async ({ page }) => {
  await openWith(
    page,
    starterFiles({ "autos/field/biobuzz.field.json": (text) => text.replace(/"formatVersion":\s*\d+/, '"formatVersion": 77') }),
  );
  await expect(status(page)).toContainText("autos/field/biobuzz.field.json was made by a newer Zenith (field format 77;");
  await expect(status(page)).toContainText("Update Zenith to open it.");
  await page.screenshot({ path: `${SHOTS}w3-5-field-newer.png` });
});

test("W3-3: a broken first auto opens the next one, and the status line names the broken file", async ({ page }) => {
  await openWith(page, { ...starterFiles(), "autos/a-broken.auto.json": '{\n  "formatVersion": 4,\n  oops\n}\n' });
  await expect(page.getByTestId("toolbar-auto-name")).toContainText("first-auto.auto.json");
  await expect(page.getByTestId("canvas-empty")).toHaveCount(0);
  await expect(status(page)).toContainText(
    "autos/a-broken.auto.json is not valid JSON (line 3, column 3). Fix it, or restore it from git. Opened first-auto.auto.json instead.",
  );
  await page.screenshot({ path: `${SHOTS}w3-3-next-auto-opened.png` });
});

test("W3-3: when no auto loads, the canvas lists the project's autos instead of the first-run welcome", async ({ page }) => {
  await openWith(page, starterFiles({ "autos/first-auto.auto.json": () => "{ " }));
  const pick = page.getByTestId("canvas-pick-auto");
  await expect(pick).toBeVisible();
  await expect(pick).toContainText("Pick an auto in robot-repo");
  await expect(page.getByTestId("canvas-auto-first-auto.auto.json")).toBeVisible();
  await expect(page.getByTestId("canvas-empty")).toHaveCount(0);
  await expect(status(page)).toContainText("None of the autos in robot-repo opened. autos/first-auto.auto.json is cut off: the JSON in it stops part way.");
  await page.screenshot({ path: `${SHOTS}w3-3-none-opened.png` });
  // With nothing focused, the first Tab lands on the first auto to pick, as it lands on Open the
  // example on the first-run screen (0.1.2 UX sweep, W1-10), and the next Tab leaves the list alone.
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("canvas-auto-first-auto.auto.json")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("canvas-auto-first-auto.auto.json")).not.toBeFocused();
});

test("W3-6: a robot.json chosen as a partner's share file gets one sentence", async ({ page }) => {
  await turnOnFeatures(page);
  await page.goto("/");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await page.getByTestId("partners-panel-fold").click();
  await page.getByTestId("partners-file-input").setInputFiles(ROBOT);
  await expect(status(page)).toContainText(
    "robot.json is a Zenith robot file, not a share file. Ask your partner for the file Download share file makes in their Zenith.",
  );
  await expect(status(page)).not.toContainText("Invalid");
  await page.screenshot({ path: `${SHOTS}w3-6-not-a-share-file.png` });
});

test("W3-7: Save a copy to downloads says what it downloaded", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  const download = page.waitForEvent("download");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("Save a copy to downloads");
  await page.keyboard.press("Enter");
  expect((await download).suggestedFilename()).toBe("collect-and-score.auto.json");
  await expect(status(page)).toContainText("Downloaded collect-and-score.auto.json.");
  await page.screenshot({ path: `${SHOTS}w3-7-saved-copy.png` });
});

test("W3-8: with a folder picker, the welcome screen's link offers only what the dialog has", async ({ page }) => {
  await page.goto("/");
  const link = page.getByTestId("canvas-open-other");
  await expect(link).toContainText("Other ways to open: GitHub");
  await expect(link).not.toContainText("single files");
  await link.click();
  await expect(page.getByTestId("open-project-files")).toHaveCount(0);
});
