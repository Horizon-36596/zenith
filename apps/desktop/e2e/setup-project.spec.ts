/**
 * Set up Zenith in a robot repository with no zenith.json, in the desktop app (issue #159): Open
 * folder on such a folder shows Set up instead of refusing it, and Set up writes the five files
 * through the main process, which builds zenith.json itself, then opens the folder. The native
 * folder picker is answered from the main process. Windowless, like every desktop test
 * (ZENITH_HEADLESS=1).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { seedFirstRunDone } from "./firstRunDone";

const pkg = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const require = createRequire(import.meta.url);

const TEAM_ROBOT_PATH = "TeamCode/src/main/java/org/firstinspires/ftc/teamcode/robot/TeamRobot.java";
const TEAM_ROBOT = [
  "package org.firstinspires.ftc.teamcode.robot;",
  "",
  "import org.horizon36596.zenith.solverslib.ZenithRobot;",
  "",
  "public class TeamRobot implements ZenithRobot {",
  "    @Override public void registerCommands(AutoFromFile opMode) {",
  '        NamedCommands.register("intakeOn", (args, ctx) -> intake.on());',
  "    }",
  "}",
  "",
].join("\n");

let app: ElectronApplication;
let page: Page;
let profile = "";
let pid: number | undefined;

test.beforeEach(async () => {
  profile = mkdtempSync(join(tmpdir(), "zenith-e2e-setup-"));
  app = await electron.launch({
    executablePath: require("electron") as string,
    args: [pkg],
    env: { ...process.env, ZENITH_USER_DATA: profile, ZENITH_DEV_URL: "", ZENITH_HEADLESS: "1" },
  });
  pid = app.process().pid;
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await seedFirstRunDone(page);
  await page.reload();
  await page.waitForSelector("[data-titlebar]");
});

test.afterEach(async () => {
  const child = app.process();
  const exited = new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    setTimeout(resolve, 10_000);
  });
  await app.evaluate(({ app: electronApp }) => {
    electronApp.exit(0);
  }).catch(() => undefined);
  await exited;
  if (pid !== undefined && process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      // Already gone.
    }
  }
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("Open folder on a repository with no zenith.json sets Zenith up there through main, and opens it", async () => {
  const repo = join(profile, "team-repo");
  mkdirSync(join(repo, "TeamCode/src/main/java/org/firstinspires/ftc/teamcode/robot"), { recursive: true });
  writeFileSync(join(repo, "build.gradle"), "// The FTC SDK's top-level build file.\n");
  writeFileSync(join(repo, TEAM_ROBOT_PATH), TEAM_ROBOT);
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [chosen] })) as typeof dialog.showOpenDialog;
  }, repo);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send("zenith:menu", { action: "project.openFolder" });
  });

  await expect(page.getByTestId("setup-project")).toBeVisible();
  await expect(page.getByText("has no zenith.json, so it is not a robot repository")).toHaveCount(0);
  await expect(page.getByTestId("setup-robot-class")).toHaveValue("org.firstinspires.ftc.teamcode.robot.TeamRobot");
  await expect(page.getByTestId("setup-library-solverslib")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("setup-commands")).toContainText("intakeOn");
  await page.getByTestId("setup-run").click();

  await expect(page.getByTestId("setup-done")).toBeVisible();
  for (const path of ["zenith.json", "autos/robot.json", "autos/waypoints.json", "autos/field/biobuzz.field.json", "autos/first-auto.auto.json"]) {
    expect(existsSync(join(repo, path)), path).toBe(true);
  }
  const link = JSON.parse(readFileSync(join(repo, "zenith.json"), "utf8")) as Record<string, unknown>;
  expect(link["sim"]).toBeUndefined();
  expect(link["deploy"]).toMatchObject({ commandLibrary: "solverslib", robotClass: "org.firstinspires.ftc.teamcode.robot.TeamRobot" });
  expect(readFileSync(join(repo, TEAM_ROBOT_PATH), "utf8")).toBe(TEAM_ROBOT);

  await page.getByTestId("setup-close").click();
  await expect(page.getByTestId("toolbar-auto-name")).toContainText("first-auto.auto.json");
  await expect(page.locator("[data-titlebar]")).toContainText("team-repo");
});
