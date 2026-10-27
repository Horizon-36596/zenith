/**
 * Issue #159 (N35): opening a team's own FTC repository, which has no zenith.json yet. Open folder
 * used to stop at "Could not read zenith.json in this folder."; now it shows Set up, which scans
 * TeamCode, prefills the robot class and the commands it registers (and the command library only
 * from an import that names one), writes the five files Zenith needs and opens the folder as a
 * writable project.
 *
 * The folder is served from the origin-private file system by `opfsProject.ts`, so Open folder takes
 * the same File System Access path a person's folder does. Screenshots of the dialog, in Night and
 * Day, go to test-results/setup-project/.
 */
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { readServed, serveFolder, starterFiles } from "./opfsProject";

const SHOTS = fileURLToPath(new URL("../test-results/setup-project/", import.meta.url));

const TEAM_ROBOT_PATH = "TeamCode/src/main/java/org/firstinspires/ftc/teamcode/robot/TeamRobot.java";

/** A team's robot class, with the commands and condition it registers, and no import naming a library. */
const TEAM_ROBOT = [
  "package org.firstinspires.ftc.teamcode.robot;",
  "",
  "public class TeamRobot implements ZenithRobot {",
  "    @Override public void registerCommands(AutoFromFile opMode) {",
  '        NamedCommands.register("intakeOn", (args, ctx) -> intake.on());',
  '        NamedCommands.register("score", (args, ctx) -> new Score(NamedCommands.argInt(args, "score", "count")));',
  '        NamedCommands.registerCondition("holdingPiece", intake::hasPiece);',
  "    }",
  "}",
  "",
].join("\n");

/** An FTC SDK repository as a team has it before Zenith: Gradle files and TeamCode, no zenith.json. */
const FTC_REPO: Record<string, string> = {
  "build.gradle": "// The FTC SDK's top-level build file.\n",
  "settings.gradle": "include ':FtcRobotController'\ninclude ':TeamCode'\n",
  "TeamCode/build.gradle": "// TeamCode's build file.\n",
  [TEAM_ROBOT_PATH]: TEAM_ROBOT,
};

const SETUP_FILES = [
  "zenith.json",
  "autos/robot.json",
  "autos/waypoints.json",
  "autos/field/biobuzz.field.json",
  "autos/first-auto.auto.json",
];

async function start(page: Page, files: Record<string, string>, theme: "dark" | "light" = "dark"): Promise<void> {
  await page.addInitScript((given) => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem("zenith.ui", JSON.stringify({ theme: given, tour: { seen: true, coreDone: true, fullDone: false } }));
    }
  }, theme);
  await serveFolder(page, files);
  await page.goto("/");
  await expect(page.getByTestId("canvas-empty")).toBeVisible();
}

/** Opens the served folder with the welcome screen's Open a folder button. */
async function openFolder(page: Page): Promise<void> {
  await page.getByTestId("canvas-open-project").click();
}

/** Whether a file is in the served folder. */
const served = (page: Page, path: string): Promise<boolean> =>
  readServed(page, path).then(
    () => true,
    () => false,
  );

test("opening an FTC repository with no zenith.json shows Set up, not the status-line error", async ({ page }) => {
  await start(page, FTC_REPO);
  await openFolder(page);
  const dialog = page.getByTestId("setup-project");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Set up Zenith in robot-repo");
  await expect(dialog).toContainText("robot-repo has no zenith.json, so Zenith is not set up there yet.");
  await expect(page.getByText("Could not read zenith.json")).toHaveCount(0);
  await expect(page.getByTestId("canvas-empty")).toBeVisible();

  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((given) => {
      document.documentElement.dataset["theme"] = given;
    }, theme);
    await page.screenshot({ path: `${SHOTS}setup-question-${theme === "dark" ? "night" : "day"}.png` });
  }
});

test("Set up prefills TeamRobot and the scanned commands, and leaves the library unchosen with no import", async ({ page }) => {
  await start(page, FTC_REPO);
  await openFolder(page);
  await expect(page.getByTestId("setup-project")).toBeVisible();
  await expect(page.getByTestId("setup-robot-class")).toHaveValue("org.firstinspires.ftc.teamcode.robot.TeamRobot");
  await expect(page.getByTestId("setup-robot-class-note")).toContainText("Found in TeamCode: it implements ZenithRobot.");
  await expect(page.getByTestId("setup-commands")).toContainText("2 commands (intakeOn, score) and 1 condition (holdingPiece)");
  // The words of the sentence, not the file's capitalised label (issue #414).
  await expect(page.getByTestId("setup-commands")).toContainText("Each starting value is marked needs measurement.");
  await expect(page.getByTestId("setup-commands")).not.toContainText("NEEDS MEASUREMENT");
  // The library is a three-way choice, and with no import to go by it is left for later.
  await expect(page.getByTestId("setup-library-none")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("setup-library-none")).toHaveText("Decide later");
  await expect(page.getByTestId("setup-library-solverslib")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("setup-library-note")).toContainText("No import names SolversLib or Ivy, so Zenith did not choose one.");
  await expect(page.getByTestId("setup-scan")).toContainText("Read 1 Java or Kotlin file in TeamCode.");
});

test("Set up prefills the library from an import that names it", async ({ page }) => {
  const wiring = "package org.firstinspires.ftc.teamcode.robot;\n\nimport org.horizon36596.zenith.ivy.NamedCommands;\n";
  await start(page, { ...FTC_REPO, "TeamCode/src/main/java/org/firstinspires/ftc/teamcode/robot/Wiring.java": wiring });
  await openFolder(page);
  await expect(page.getByTestId("setup-library-ivy")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("setup-library-note")).toContainText("From the import of org.horizon36596.zenith.ivy.NamedCommands");
});

test("after Set up the folder holds the five files, zenith.json has no sim block, and the project opens writable", async ({ page }) => {
  await start(page, FTC_REPO);
  await openFolder(page);
  await expect(page.getByTestId("setup-project")).toBeVisible();
  await page.getByTestId("setup-run").click();

  const done = page.getByTestId("setup-done");
  await expect(done).toBeVisible();
  await expect(done).toContainText("Zenith is set up in robot-repo");
  await expect(page.getByTestId("setup-gradle")).toContainText("implementation 'com.github.Horizon-36596:zenith:v");
  await page.screenshot({ path: `${SHOTS}setup-done-night.png` });
  await expect(page.getByTestId("status")).toContainText("Set Zenith up in robot-repo and opened it. Save writes there.");

  for (const path of SETUP_FILES) expect(await served(page, path), path).toBe(true);
  const link = JSON.parse(await readServed(page, "zenith.json")) as Record<string, unknown>;
  expect(link["sim"]).toBeUndefined();
  expect(link["deploy"]).toEqual({
    kind: "androidAssets",
    dir: "TeamCode/src/main/assets/autos",
    robotClass: "org.firstinspires.ftc.teamcode.robot.TeamRobot",
  });
  expect(link["codegen"]).toEqual({ package: "org.firstinspires.ftc.teamcode.zenith", dir: "TeamCode/src/main/java" });
  const robot = JSON.parse(await readServed(page, "autos/robot.json")) as { commands: Array<{ name: string; estimateS: unknown }> };
  expect(robot.commands.map((command) => command.name)).toEqual(["intakeOn", "score"]);
  expect(await readServed(page, TEAM_ROBOT_PATH)).toBe(TEAM_ROBOT);

  // The folder is the open project, on the skeleton auto, and Save writes there in place.
  await page.getByTestId("setup-close").click();
  await expect(done).toHaveCount(0);
  await expect(page.getByTestId("toolbar-auto-name")).toContainText("first-auto.auto.json");
  expect(await page.evaluate(`import("/src/state/store.ts").then((m) => m.getState().project.source.kind)`)).toBe("directory");
  await page.evaluate(`import("/src/state/store.ts").then((m) => { const s = m.getState(); m.commit({ ...s.auto, title: "Our first auto" }); })`);
  await expect(page.getByTestId("toolbar-auto-name").getByLabel("Unsaved changes")).toBeVisible();
  await page.getByTestId("field-canvas").focus();
  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("toolbar-auto-name").getByLabel("Unsaved changes")).toHaveCount(0);
  await expect(page.getByTestId("save-choice")).toHaveCount(0);
  expect(await readServed(page, "autos/first-auto.auto.json")).toContain('"title": "Our first auto"');
});

test("Set up never writes over a file already there, and Cancel writes nothing", async ({ page }) => {
  await start(page, { ...FTC_REPO, "autos/robot.json": "{}\n" });
  await openFolder(page);
  await expect(page.getByTestId("setup-taken")).toContainText("robot-repo already has autos/robot.json");
  await expect(page.getByTestId("setup-run")).toBeDisabled();
  await page.getByTestId("setup-cancel").click();
  await expect(page.getByTestId("setup-project")).toHaveCount(0);
  await expect(page.getByTestId("status")).toContainText("Nothing was written to robot-repo.");
  expect(await served(page, "zenith.json")).toBe(false);
  expect(await readServed(page, "autos/robot.json")).toBe("{}\n");
});

test("the palette and the welcome screen say how to set Zenith up", async ({ page }) => {
  await start(page, FTC_REPO);
  // What a folder must hold, and what happens with one that has no zenith.json, is the Open a folder
  // button's hint, not text on the welcome screen (issue #414).
  await expect(page.getByTestId("canvas-empty")).not.toContainText("zenith.json");
  await page.getByTestId("canvas-open-project").hover();
  await expect(page.locator('[role="tooltip"]')).toContainText("Zenith offers to set itself up");
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("set up zenith");
  await page.getByTestId("palette-item-project.setUp").click();
  await expect(page.getByTestId("setup-project")).toBeVisible();
});

/** Screenshots of what is on screen, in Night and Day, and at a phone's width in Night. */
async function shoot(page: Page, name: string): Promise<void> {
  // With no colour transitions, a shot taken right after the theme changes shows the theme it names.
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((given) => {
      document.documentElement.dataset["theme"] = given;
    }, theme);
    await page.screenshot({ path: `${SHOTS}${name}-${theme === "dark" ? "night" : "day"}.png` });
  }
  await page.evaluate(() => {
    document.documentElement.dataset["theme"] = "dark";
  });
  const size = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${SHOTS}${name}-390-night.png` });
  if (size !== null) await page.setViewportSize(size);
}

test("the robot class is a full-width box whose note follows what is typed, and a bad class is refused under it (issue #502)", async ({ page }) => {
  await start(page, { "build.gradle": "// The FTC SDK's top-level build file.\n" });
  await openFolder(page);
  const field = page.getByTestId("setup-robot-class");
  const note = page.getByTestId("setup-robot-class-note");
  await expect(note).toContainText("No class in TeamCode implements ZenithRobot yet. Leave it empty to add it later");
  const box = await field.boundingBox();
  const dialog = await page.getByTestId("setup-project").boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan((dialog?.width ?? 0) * 0.8);
  await shoot(page, "setup-empty-folder");

  await field.fill("Team Robot");
  await expect(note).toContainText("No class in TeamCode implements ZenithRobot, so Zenith cannot check this one.");
  await page.getByTestId("setup-run").click();
  const problem = page.getByTestId("setup-robot-class-problem");
  await expect(problem).toContainText('"Team Robot" is not a fully qualified Java class name');
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByTestId("setup-problem")).toHaveCount(0);
  await shoot(page, "setup-bad-robot-class");
  expect(await served(page, "zenith.json")).toBe(false);
});

/** The starter's autos, robot, field and waypoints in a folder of their own, with no zenith.json. */
function autosWithoutLink(): Record<string, string> {
  const files = starterFiles();
  delete files["zenith.json"];
  return Object.fromEntries(
    Object.entries(files).map(([path, text]) => [path.replace(/^autos\//, "zenith-autos/"), text.replace(/"autos\//g, '"zenith-autos/')]),
  );
}

test("a folder with autos and no zenith.json is offered zenith.json alone, and nothing else changes (issue #496)", async ({ page }) => {
  const autos = autosWithoutLink();
  await start(page, { ...FTC_REPO, ...autos });
  await openFolder(page);
  const dialog = page.getByTestId("setup-project");
  await expect(page.getByTestId("setup-existing")).toHaveText(
    "robot-repo has 1 auto in zenith-autos but no zenith.json. Set up points zenith.json at the autos where they are.",
  );
  await expect(page.getByTestId("setup-files")).toHaveText("It writes only zenith.json, and moves or writes over nothing that is there.");
  await expect(page.getByTestId("setup-commands")).toHaveCount(0);
  await expect(page.getByTestId("setup-run")).toHaveText("Write zenith.json");
  await shoot(page, "setup-in-place");

  await page.getByTestId("setup-run").click();
  await expect(page.getByTestId("setup-done")).toBeVisible();
  await expect(page.getByTestId("setup-written")).toHaveText("Wrote zenith.json.");
  await expect(page.getByTestId("status")).toContainText(
    "Wrote zenith.json in robot-repo, pointing at the autos in zenith-autos, and opened it. Nothing was moved.",
  );
  const link = JSON.parse(await readServed(page, "zenith.json")) as Record<string, unknown>;
  expect(link).toMatchObject({ autosDir: "zenith-autos", robot: "zenith-autos/robot.json", field: "zenith-autos/field/biobuzz.field.json" });
  for (const [path, text] of Object.entries(autos)) expect(await readServed(page, path), path).toBe(text);
  expect(await served(page, "autos/robot.json")).toBe(false);
  await page.getByTestId("setup-close").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("toolbar-auto-name")).toContainText("first-auto.auto.json");
});

test("Set up Zenith on a folder that is already set up says so (issue #502)", async ({ page }) => {
  await start(page, starterFiles());
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("set up zenith");
  await page.getByTestId("palette-item-project.setUp").click();
  await expect(page.getByTestId("status")).toContainText("robot-repo is already set up. Opened it.");
  await expect(page.getByTestId("setup-project")).toHaveCount(0);
});
