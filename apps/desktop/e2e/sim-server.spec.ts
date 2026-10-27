/**
 * Full sim speed in the built desktop app (site/docs/full-sim-simloop.md, "Full sim speed"): the
 * setting in Settings, General, a Fast run that streams from a sim server and plays while it runs,
 * and an Ultrafast run that plays at once after the auto was saved.
 *
 * The sim server is the real launch path, `java @<args>`, with Zenith's own `findJava`: the args file
 * names e2e/fixtures/FakeSimServer.java, which Java runs from source and which hands everything to
 * fake-sim-server.cjs under Node. So it needs Java 11 or newer, and skips without it. The prepare
 * command and the sim command are the Node fakes beside it. Nothing reaches the network.
 *
 * Screenshots go to ZENITH_E2E_SHOTS when it is set, else to test-results.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { seedFirstRunDone } from "./firstRunDone";

const here = fileURLToPath(new URL(".", import.meta.url));
const pkg = join(here, "..");
const example = join(pkg, "..", "..", "examples", "starter");
const require = createRequire(import.meta.url);
const shots = process.env["ZENITH_E2E_SHOTS"] ?? join(pkg, "test-results");

const hasJava = (() => {
  try {
    execFileSync("java", ["-version"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();

test.skip(!hasJava, "The sim server is started as java @<args>; install Java 11 or newer to run this.");
test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

let app: ElectronApplication;
let page: Page;
let profile = "";
let repo = "";

// The app opens the first auto in the folder, as the smoke test relies on too.
const AUTO = "all-step-kinds.auto.json";

test.beforeAll(async () => {
  profile = mkdtempSync(join(tmpdir(), "zenith-e2e-profile-"));
  repo = mkdtempSync(join(tmpdir(), "zenith-e2e-simserver-"));
  cpSync(example, repo, { recursive: true });
  for (const name of ["fake-sim.cjs", "fake-sim-trace.json", "fake-sim-server.cjs", "fake-sim-prepare.cjs", "FakeSimServer.java"]) {
    cpSync(join(here, "fixtures", name), join(repo, name));
  }
  const linkPath = join(repo, "zenith.json");
  const link = JSON.parse(readFileSync(linkPath, "utf8")) as { sim: Record<string, unknown> };
  link.sim["command"] = "node fake-sim.cjs {auto}";
  // Every path in the args file is relative to the server's working folder, the root: no spaces to quote.
  link.sim["server"] = {
    prepare: "node fake-sim-prepare.cjs build/sim/server.args --log prepare.log -- FakeSimServer.java fake-sim-server.cjs --row-delay-ms 150 --log server.log",
    args: "build/sim/server.args",
    watch: ["TeamCode/src"],
  };
  writeFileSync(linkPath, `${JSON.stringify(link, null, 2)}\n`);

  app = await electron.launch({
    executablePath: require("electron") as string,
    args: [pkg],
    env: { ...process.env, ZENITH_USER_DATA: profile, ZENITH_DEV_URL: "", ZENITH_HEADLESS: "1" },
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await seedFirstRunDone(page);
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [root] })) as typeof dialog.showOpenDialog;
  }, repo);
  await menu("project.openFolder");
  await expect(page.getByTestId("toolbar-auto-name")).not.toHaveText(/No auto open/, { timeout: 30_000 });
  for (let i = 0; i < 3; i += 1) await page.keyboard.press("Escape");
});

test.afterAll(async () => {
  const pid = app?.process().pid;
  const child = app?.process();
  const exited = new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    setTimeout(resolve, 10_000);
  });
  await app?.evaluate(({ app: electronApp }) => {
    electronApp.quit();
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
  rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

async function menu(action: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, command) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send("zenith:menu", command);
  }, { action });
}

/**
 * Saves the page as it is now. Through the page rather than the window's `capturePage`, which in a
 * window that is never shown can hand back an earlier frame.
 */
async function capture(name: string): Promise<void> {
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, name) });
}

const lines = (name: string): string[] =>
  existsSync(join(repo, name)) ? readFileSync(join(repo, name), "utf8").split(/\r?\n/).filter((line) => line !== "") : [];

test("Settings, General offers Full sim speed with what each speed does and costs", async () => {
  await menu("view.settings");
  await page.getByTestId("settings-nav-general").click();
  const row = page.getByTestId("settings-sim-speed");
  await expect(row).toBeVisible();
  await expect(page.getByTestId("settings-sim-speed-choice-fast")).toHaveAttribute("aria-pressed", "true");
  const tiers = page.getByTestId("settings-sim-speed-tiers");
  await expect(tiers).toContainText("Basic");
  await expect(tiers).toContainText("Fast");
  await expect(tiers).toContainText("Ultrafast");
  await expect(page.getByTestId("settings-sim-speed-limit")).toHaveCount(0);
  await row.evaluate((element) => {
    element.scrollIntoView({ block: "center", behavior: "instant" });
  });
  await page.waitForTimeout(300);
  await capture("full-sim-speed-setting.png");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings")).toHaveCount(0);
});

test("a Fast run streams from the sim server and plays while it is simulated", async () => {
  await menu("desktop.sim");
  const panel = page.getByTestId("desktop-panel");
  await expect(panel).toHaveAttribute("data-kind", "sim");
  // Java compiles the fake from source on the first start, so the first rows take a few seconds.
  await expect(page.getByTestId("timeline-simulating")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("playback-level")).toHaveAttribute("data-level", "full");
  await expect(page.getByTestId("desktop-sim-state")).toContainText("Simulating");
  await expect(panel).toHaveAttribute("data-phase", "running");
  // Mid-stream: the timeline shows the part received so far.
  await page.waitForTimeout(1_200);
  await capture("full-sim-streaming.png");
  await expect(panel).toHaveAttribute("data-phase", "done", { timeout: 60_000 });
  await expect(page.getByTestId("timeline-simulating")).toHaveCount(0);
  expect(lines("prepare.log")).toHaveLength(1);
  expect(lines("server.log").filter((line) => line.startsWith("run"))).toEqual(["run r1 all-step-kinds"]);

  // The server stays warm: the next run neither prepares nor starts it again.
  await page.getByRole("button", { name: "Run again" }).click();
  await expect(panel).toHaveAttribute("data-phase", "done", { timeout: 60_000 });
  expect(lines("prepare.log")).toHaveLength(1);
  expect(lines("server.log").filter((line) => line.startsWith("started"))).toHaveLength(1);
});

test("an Ultrafast run of a saved auto plays at once", async () => {
  await menu("view.settings");
  await page.getByTestId("settings-nav-general").click();
  await page.getByTestId("settings-sim-speed-choice-ultrafast").click();
  await expect(page.getByTestId("settings-sim-speed-choice-ultrafast")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");

  // An edit saved elsewhere counts as a save: the auto runs again in the background.
  const before = lines("server.log").filter((line) => line.startsWith("run")).length;
  const path = join(repo, "autos", AUTO);
  writeFileSync(path, readFileSync(path, "utf8").replace('"title": "', '"title": "Saved: '));
  await expect.poll(() => lines("server.log").filter((line) => line.startsWith("run")).length, { timeout: 30_000 }).toBe(before + 1);
  // Let the background run finish before the click.
  await page.waitForTimeout(6_000);

  await menu("desktop.sim");
  const panel = page.getByTestId("desktop-panel");
  await expect(panel).toHaveAttribute("data-phase", "done", { timeout: 5_000 });
  await expect(panel).toContainText("Played the run made when the auto was last saved.");
  expect(lines("server.log").filter((line) => line.startsWith("run"))).toHaveLength(before + 1);
});
