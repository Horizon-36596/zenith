/**
 * Settings, Robot and Commands (issue #100): both edit the open project's robot.json. A folder
 * project writes through the browser's folder access; the example shows its robot read only, with
 * the reason. Commands shows only while the Commands switch is on.
 */
import { expect, test, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";
import { openServedFolder, readServed, serveFolder, starterFiles } from "./opfsProject";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
    }
    window.localStorage.removeItem("zenith.cloudFake");
  });
});

interface RobotFile {
  name: string;
  kinematics: { maxForwardVelInPerS: { value: number; provenance?: string }; maxAngularVelRadPerS: { value: number } };
  commands: Array<{ name: string; summary?: string; estimateS: string; params?: Record<string, { type: string }> }>;
}

const robotFile = async (page: Page): Promise<RobotFile> => JSON.parse(await readServed(page, "autos/robot.json")) as RobotFile;

async function openFolder(page: Page): Promise<void> {
  await serveFolder(page, starterFiles());
  await page.goto("/");
  await openServedFolder(page);
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
}

async function openSection(page: Page, section: "robot" | "commands"): Promise<void> {
  await page.getByTestId("toolbar-settings").click();
  await page.getByTestId(`settings-nav-${section}`).click();
  await expect(page.getByTestId(`settings-section-${section}`)).toBeVisible();
}

test("the example's robot reads as values, with the reason it cannot change here", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await openSection(page, "robot");
  // The window says it once, in a banner, and the section carries no note of its own.
  await expect(page.getByTestId("settings-example-banner")).toContainText("The example is read only");
  await expect(page.getByTestId("settings-robot-read-only")).toHaveCount(0);
  await expect(page.getByTestId("settings-robot-maxForward")).toContainText("60.0");
  await expect(page.getByTestId("settings-robot-save")).toHaveCount(0);
  // Default path speed reads in percent, as the Inspector does, and the follower's version names its
  // library (0.1.2 UX sweep, W1-16).
  await expect(page.getByTestId("settings-robot-speedFraction")).toContainText("80%");
  await expect(page.getByTestId("settings-robot-speedFraction")).not.toContainText("×");
  await expect(page.getByTestId("settings-robot-follower-version-read")).toContainText("Pedro Pathing version");
});

test("Default path speed is typed in percent and written to robot.json as a fraction", async ({ page }) => {
  await openFolder(page);
  await openSection(page, "robot");
  const speed = page.getByTestId("settings-robot-speedFraction");
  await expect(speed).toHaveValue("80");
  await speed.fill("65");
  await speed.press("Enter");
  await page.getByTestId("settings-robot-save").click();
  await expect(page.getByTestId("settings-robot-result")).toHaveText("Saved robot.json to autos/robot.json.");
  const after = JSON.parse(await readServed(page, "autos/robot.json")) as { kinematics: { defaultPathSpeedFraction: { value: number } } };
  expect(after.kinematics.defaultPathSpeedFraction.value).toBe(0.65);
});

test("a Robot edit is saved to the folder's robot.json, keeping the value's provenance", async ({ page }) => {
  await openFolder(page);
  const before = JSON.parse(starterFiles()["autos/robot.json"] ?? "{}") as RobotFile;
  await openSection(page, "robot");
  await expect(page.getByTestId("settings-robot-read-only")).toHaveCount(0);

  const speed = page.getByTestId("settings-robot-maxForward");
  await speed.fill("72");
  await speed.press("Enter");
  // Turning speed shows in degrees per second and is written in radians.
  const turn = page.getByTestId("settings-robot-maxTurn");
  await turn.fill("180");
  await turn.press("Enter");
  await page.getByTestId("settings-robot-save").click();
  await expect(page.getByTestId("settings-robot-result")).toHaveText("Saved robot.json to autos/robot.json.");

  const after = await robotFile(page);
  expect(after.kinematics.maxForwardVelInPerS.value).toBe(72);
  expect(after.kinematics.maxForwardVelInPerS.provenance).toBe(before.kinematics.maxForwardVelInPerS.provenance);
  expect(after.kinematics.maxAngularVelRadPerS.value).toBeCloseTo(Math.PI, 9);
  // Nothing else in the file moved.
  expect(after.commands).toEqual(before.commands);
});

test("Default path speed says the robot applies it only if its ZenithRobot implements atSpeed (#192)", async ({ page }) => {
  await openFolder(page);
  await openSection(page, "robot");
  await page.getByTestId("settings-robot-speedFraction").hover();
  await expect(page.getByRole("tooltip")).toContainText("atSpeed");
});

test("Height says it decides which part of the slanted legs the robot hits (#272)", async ({ page }) => {
  await openFolder(page);
  await openSection(page, "robot");
  await page.getByTestId("settings-robot-height").hover();
  await expect(page.getByRole("tooltip")).toContainText("which part of the slanted legs the robot hits");
});

test("Commands shows only with the switch on, and adds, edits and removes a command in robot.json", async ({ page }) => {
  await openFolder(page);
  await page.getByTestId("toolbar-settings").click();
  // Commands is on by default (#112), so switch it off first to see the section go.
  await page.getByTestId("settings-nav-general").click();
  await page.getByTestId("settings-feature-commands-choice-off").click();
  await expect(page.getByTestId("settings-nav-commands")).toHaveCount(0);
  await page.getByTestId("settings-feature-commands-choice-on").click();
  await page.getByTestId("settings-nav-commands").click();
  await expect(page.getByTestId("settings-command-score")).toBeVisible();

  // Add.
  await page.getByTestId("settings-commands-add").click();
  await page.getByTestId("settings-command-name").fill("liftUp");
  await page.getByTestId("settings-command-summary").fill("Raises the lift.");
  await page.getByTestId("settings-command-estimate").fill("0.5 + height * 0.1");
  await page.getByTestId("settings-command-add-param").click();
  await page.getByTestId("settings-command-param-0-name").fill("height");
  await page.getByTestId("settings-command-save").click();
  await expect(page.getByTestId("settings-command-liftUp")).toBeVisible();
  await expect.poll(async () => (await robotFile(page)).commands.find((command) => command.name === "liftUp")?.estimateS).toBe("0.5 + height * 0.1");
  expect((await robotFile(page)).commands.find((command) => command.name === "liftUp")?.params?.["height"]?.type).toBe("number");

  // Edit.
  await page.getByTestId("settings-command-liftUp-edit").click();
  await page.getByTestId("settings-command-summary").fill("Raises the lift to a height.");
  await page.getByTestId("settings-command-save").click();
  await expect.poll(async () => (await robotFile(page)).commands.find((command) => command.name === "liftUp")?.summary).toBe("Raises the lift to a height.");

  // Remove, after a confirmation.
  await page.getByTestId("settings-command-liftUp-remove").click();
  await page.getByTestId("settings-command-liftUp-confirm-remove").click();
  await expect(page.getByTestId("settings-command-liftUp")).toHaveCount(0);
  await expect.poll(async () => (await robotFile(page)).commands.some((command) => command.name === "liftUp")).toBe(false);
  const names = (await robotFile(page)).commands.map((command) => command.name);
  expect(names).toEqual((JSON.parse(starterFiles()["autos/robot.json"] ?? "{}") as RobotFile).commands.map((command) => command.name));
});

test("a form problem is said in words and nothing is written", async ({ page }) => {
  await turnOnFeatures(page, { commands: true });
  await openFolder(page);
  await openSection(page, "commands");
  await page.getByTestId("settings-commands-add").click();
  await page.getByTestId("settings-command-name").fill("score");
  await page.getByTestId("settings-command-save").click();
  await expect(page.getByTestId("settings-command-problem")).toHaveText("The robot already has a command named score.");
  expect((await robotFile(page)).commands.filter((command) => command.name === "score")).toHaveLength(1);
});
