/**
 * Saving the read-only example in the desktop app (issue #103): Save asks whether to save the full
 * project or just this auto, and both write into a folder picked in the native dialog (answered
 * here from the main process), which then opens as the current project. Windowless, like every
 * desktop test (ZENITH_HEADLESS=1).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { seedFirstRunDone } from "./firstRunDone";

const pkg = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const starter = join(pkg, "..", "..", "examples", "starter");
const require = createRequire(import.meta.url);
const read = (path: string): string => readFileSync(join(starter, path), "utf8").replace(/\r\n/g, "\n");

let app: ElectronApplication;
let page: Page;
let profile = "";
let pid: number | undefined;

test.beforeEach(async () => {
  profile = mkdtempSync(join(tmpdir(), "zenith-e2e-save-example-"));
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
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send("zenith:menu", { action: "project.example" });
  });
  await expect(page.getByTestId("toolbar-auto-name")).toContainText("collect-and-score.auto.json");
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

/** Answers the next native folder pickers with `folder`. */
async function answerFolder(folder: string): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [chosen] })) as typeof dialog.showOpenDialog;
  }, folder);
}

test("Save the full project writes the example into the folder picked and opens it", async () => {
  const folder = join(profile, "new-robot");
  mkdirSync(folder);
  await answerFolder(folder);
  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("save-choice-project")).toHaveText("Save project…");
  await page.getByTestId("save-choice-project").click();
  await expect(page.getByTestId("status")).toContainText("Saved the project to new-robot and opened it.");
  for (const path of [
    "autos/robot.json",
    "autos/field/biobuzz.field.json",
    "autos/waypoints.json",
    "autos/first-auto.auto.json",
    "autos/collect-and-score.auto.json",
  ]) {
    expect(readFileSync(join(folder, path), "utf8"), path).toBe(read(path));
  }
  // zenith.json is the example's without its sim command, robot class and command library (issue #159).
  const link = JSON.parse(readFileSync(join(folder, "zenith.json"), "utf8")) as Record<string, unknown>;
  const example = JSON.parse(read("zenith.json")) as Record<string, unknown>;
  const { sim: _sim, deploy: exampleDeploy, ...exampleRest } = example;
  const { robotClass: _robotClass, commandLibrary: _commandLibrary, ...deployRest } = exampleDeploy as Record<string, unknown>;
  expect(link).toEqual({ ...exampleRest, deploy: deployRest });
  await expect(page.getByTestId("toolbar-auto-name")).toContainText("collect-and-score.auto.json");
  await expect(page.locator("[data-titlebar]")).toContainText("new-robot");
});

test("Save just this auto writes into the picked project's autos folder, never over an auto there", async () => {
  const repo = join(profile, "robot-repo");
  mkdirSync(join(repo, "autos", "field"), { recursive: true });
  for (const path of ["zenith.json", "autos/robot.json", "autos/field/biobuzz.field.json", "autos/waypoints.json"]) {
    writeFileSync(join(repo, path), read(path));
  }
  await answerFolder(repo);
  await page.keyboard.press("Control+s");
  await page.getByTestId("save-choice-auto").click();
  await expect(page.getByTestId("status")).toContainText(
    `Saved ${basename(repo)}/autos/collect-and-score.auto.json and opened ${basename(repo)}.`,
  );
  expect(readFileSync(join(repo, "autos", "collect-and-score.auto.json"), "utf8")).toBe(read("autos/collect-and-score.auto.json"));

  // Back on the example, a second save into the same project is refused rather than written over.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send("zenith:menu", { action: "project.example" });
  });
  await expect(page.getByTestId("status")).toContainText("Example loaded, read only.");
  await page.keyboard.press("Control+s");
  await page.getByTestId("save-choice-auto").click();
  await expect(page.getByTestId("status")).toContainText("robot-repo already has autos/collect-and-score.auto.json, so nothing was written.");
});

test("Save just this auto picks the project, asks about the waypoints it lacks, and adds them only when asked to (issue #158)", async () => {
  const repo = join(profile, "team-repo");
  mkdirSync(join(repo, "autos", "field"), { recursive: true });
  for (const path of ["zenith.json", "autos/robot.json", "autos/field/biobuzz.field.json"]) {
    writeFileSync(join(repo, path), read(path));
  }
  // The team's own waypoints: its measured start, 48 in east of the example's, and scoreSouth.
  const starter = JSON.parse(read("autos/waypoints.json")) as { waypoints: Record<string, unknown> };
  const theirs = {
    ...starter,
    waypoints: {
      start: { xIn: 36, yIn: -63, headingRad: 1.5708, provenance: "MEASURED: our start tile" },
      scoreSouth: starter.waypoints["scoreSouth"],
    },
  };
  writeFileSync(join(repo, "autos", "waypoints.json"), `${JSON.stringify(theirs, null, 2)}\n`);
  await answerFolder(repo);
  await page.keyboard.press("Control+s");
  await page.getByTestId("save-choice-auto").click();

  await expect(page.getByTestId("waypoint-check")).toBeVisible();
  await expect(page.getByTestId("waypoint-check-row-start")).toContainText("x 36.00 in, y -63.00 in, 90.0°");
  await expect(page.getByTestId("waypoint-check-row-scoreNorth")).toContainText("Not in team-repo");
  expect(existsSync(join(repo, "autos", "collect-and-score.auto.json"))).toBe(false);
  await page.getByTestId("waypoint-check-add").click();

  await expect(page.getByTestId("status")).toContainText(
    "Saved team-repo/autos/collect-and-score.auto.json, added 5 waypoints to team-repo/autos/waypoints.json and opened team-repo.",
  );
  const waypoints = JSON.parse(readFileSync(join(repo, "autos", "waypoints.json"), "utf8")) as {
    waypoints: Record<string, { provenance?: string }>;
  };
  expect(Object.keys(waypoints.waypoints)).toEqual([
    "start",
    "scoreSouth",
    "flowerNorthApproach",
    "flowerNorthPickup",
    "scoreNorth",
    "gardenSweepStart",
    "gardenSweepEnd",
  ]);
  expect(waypoints.waypoints["start"]?.provenance).toBe("MEASURED: our start tile");
  const saved = readFileSync(join(repo, "autos", "collect-and-score.auto.json"), "utf8");
  expect(saved).not.toContain('"ref": "start"');
  await expect(page.locator("[data-titlebar]")).toContainText("team-repo");
});
