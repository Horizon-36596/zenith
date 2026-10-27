/**
 * Import commands from Java: Java files picked from the command palette are scanned in the
 * browser, the dialog previews what changes in robot.json, and applying it on the read-only example
 * downloads the new robot.json and puts the new command in the editor at once.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { turnOnFeatures } from "./features";

const javaFixture = fileURLToPath(new URL("./fixtures/java/StarterRobot.java", import.meta.url));

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
    }
  });
  await turnOnFeatures(page);
});

test("picked Java files preview the robot.json additions, and applying downloads robot.json", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();

  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Import commands from Java");
  await page.getByTestId("palette-item-project.importCommands").click();
  const dialog = page.getByTestId("import-commands");
  await expect(dialog).toBeVisible();
  // Nothing has been read yet, so there is nothing to apply.
  await expect(page.getByTestId("import-commands-apply")).toBeDisabled();

  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-commands-pick-files").click();
  await (await chooser).setFiles(javaFixture);

  await expect(page.getByTestId("import-commands-summary")).toContainText("5 commands and 3 conditions registered");
  await expect(page.getByTestId("import-commands-changes")).toContainText("Add the command wiggle with seconds");
  await expect(page.getByTestId("import-commands-diff")).toContainText('"name": "wiggle"');
  // robot.json's intakeOn declares a state the Java never reads; the preview lists what is left to settle.
  await expect(page.getByTestId("import-commands-findings")).toBeVisible();

  const download = page.waitForEvent("download");
  await page.getByTestId("import-commands-apply").click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe("robot.json");
  const text = readFileSync(await saved.path(), "utf8");
  const robot = JSON.parse(text) as { commands: Array<{ name: string; estimateS: string; provenance?: string }> };
  expect(robot.commands.find((command) => command.name === "wiggle")).toMatchObject({
    estimateS: "unknown",
    provenance: "SET FROM StarterRobot.java; estimateS NEEDS MEASUREMENT",
  });
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("status")).toContainText("Downloaded the new robot.json");
});
