/**
 * Opens the built desktop app, loads the bundled example and sees the field canvas; then opens a
 * copy of examples/starter as a robot repository through the File menu's path, saves in place, and
 * drives each desktop action from the page's own buttons: a high-fidelity sim from the Simulate
 * dialog, a deploy preview, a commit on the work branch, and the unsaved-edits question when another
 * folder is opened over an edit. The native folder picker is replaced in the main process for the
 * test, and the app runs on a throwaway profile, so nothing touches the owner's own settings.
 *
 * Nothing here reaches the network. The sim command is `e2e/fixtures/fake-sim.cjs`, run by Node;
 * the GitHub CLI is left off the PATH and no token variables are passed, so there is no token to
 * check; and the copy's `origin` pushes to a folder that does not exist. The test stops before Push
 * and Open pull request, and only checks that they are offered.
 *
 * The app runs with ZENITH_HEADLESS=1: its window is never shown and never takes focus, so the tests
 * can run while someone is using the computer. Screenshots come from the page itself.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const here = fileURLToPath(new URL(".", import.meta.url));
const pkg = join(here, "..");
const example = join(pkg, "..", "..", "examples", "starter");
const require = createRequire(import.meta.url);

let app: ElectronApplication;
let page: Page;
let profile = "";
let repo = "";

test.beforeAll(async () => {
  profile = mkdtempSync(join(tmpdir(), "zenith-e2e-profile-"));
  repo = mkdtempSync(join(tmpdir(), "zenith-e2e-repo-"));
  cpSync(example, repo, { recursive: true });
  makeRobotRepo(repo);
  // No GitHub: no token variables, and no `gh` on the PATH, since on Windows `gh auth token` also
  // finds a signed-in token in the credential store and the app would then ask GitHub who it is.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(GH_|GITHUB_)/.test(key)) env[key] = value;
  }
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = (env[pathKey] ?? "")
    .split(delimiter)
    .filter((dir) => dir !== "" && !existsSync(join(dir, process.platform === "win32" ? "gh.exe" : "gh")))
    .join(delimiter);
  app = await electron.launch({
    executablePath: require("electron") as string,
    args: [pkg],
    env: {
      ...env,
      GH_CONFIG_DIR: join(profile, "gh-empty"),
      ZENITH_USER_DATA: profile,
      ZENITH_DEV_URL: "",
      ZENITH_HEADLESS: "1",
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  // The first-run tour has its own web tests; here it would only sit over the buttons being driven.
  await page.evaluate(() => {
    localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
  });
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  const pid = app?.process().pid;
  const child = app?.process();
  const exited = new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    setTimeout(resolve, 10_000);
  });
  // app.exit skips the close events, so an edit left unsaved does not hold the teardown up.
  await app?.evaluate(({ app: electronApp }) => {
    electronApp.exit(0);
  }).catch(() => undefined);
  // Wait for the process to go, or the profile is still locked when it is removed below.
  await exited;
  // Nothing may outlive the test: take down the whole tree (GPU, network and renderer helpers too).
  if (pid !== undefined && process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      // Already gone, which is the usual case after exit().
    }
  }
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/**
 * Turns the example copy into a small robot repository: a fake sim command, a git history on main
 * with an origin that cannot be pushed to, and one saved edit to the auto since that commit.
 */
function makeRobotRepo(root: string): void {
  cpSync(join(here, "fixtures", "fake-sim.cjs"), join(root, "fake-sim.cjs"));
  cpSync(join(here, "fixtures", "fake-sim-trace.json"), join(root, "fake-sim-trace.json"));
  const linkPath = join(root, "zenith.json");
  const link = JSON.parse(readFileSync(linkPath, "utf8")) as { sim: { command: string } };
  link.sim.command = "node fake-sim.cjs {auto}";
  writeFileSync(linkPath, `${JSON.stringify(link, null, 2)}\n`);
  writeFileSync(join(root, ".gitignore"), "TeamCode/build/\n");

  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe", windowsHide: true });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Zenith E2E");
  git("config", "user.email", "e2e@horizon36596.org");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "chore: the robot repository as it was");
  git("remote", "add", "origin", "https://github.com/Horizon-36596/zenith-e2e-never-pushed.git");
  // A push, if one ever happened by mistake, fails on this machine instead of reaching GitHub.
  git("remote", "set-url", "--push", "origin", join(root, "no-such-remote.git"));

  const autoPath = join(root, "autos", "all-step-kinds.auto.json");
  const text = readFileSync(autoPath, "utf8");
  writeFileSync(autoPath, text.replace('"title": "Every step kind"', '"title": "Every step kind, edited"'));
}

const gitIn = (root: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();

/** Sends a native menu command the way a click on the menu item does. */
async function menu(action: string, arg?: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, command) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send("zenith:menu", command);
  }, arg === undefined ? { action } : { action, arg });
}

/** Saves what the page has painted, taken from the window's own contents, never from the screen. */
async function capture(name: string): Promise<void> {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0]?.webContents.capturePage();
    return image?.toPNG().toString("base64") ?? "";
  });
  const dir = join(pkg, "test-results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), Buffer.from(png, "base64"));
}

/** Closes the first-run tour if it has opened over the editor. */
async function dismissTour(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await page.keyboard.press("Escape");
}

test("the app opens from zenith://, isolated, and draws the example on the canvas", async () => {
  expect(page.url()).toMatch(/^zenith:\/\/app\//);
  const windowState = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return { visible: win?.isVisible(), focusable: win?.isFocusable() };
  });
  expect(windowState).toEqual({ visible: false, focusable: false });
  const isolation = await page.evaluate(() => {
    // The page's own global: the bridge, and none of Node's or Electron's names.
    const page = globalThis as unknown as { zenithDesktop?: { apiVersion: number }; require?: unknown; process?: unknown };
    return {
      bridge: typeof page.zenithDesktop,
      apiVersion: page.zenithDesktop?.apiVersion,
      node: typeof page.require,
      process: typeof page.process,
    };
  });
  expect(isolation).toEqual({ bridge: "object", apiVersion: 1, node: "undefined", process: "undefined" });

  await dismissTour();
  await menu("project.example");
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await dismissTour();
  const canvas = page.locator("canvas").first();
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(300);
  await expect(page.getByTestId("desktop-menu-button")).toBeVisible();
  await capture("desktop-example.png");
});

test("a robot repository opens in place, saves in place and previews a deploy", async () => {
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [root] })) as typeof dialog.showOpenDialog;
  }, repo);
  await menu("project.openFolder");
  // A folder opens on its first auto by name.
  await expect(page.getByTestId("toolbar-auto-name")).toHaveText("all-step-kinds.auto.json");
  await dismissTour();

  const before = readFileSync(join(repo, "autos", "all-step-kinds.auto.json"), "utf8");
  await menu("run.save");
  await expect.poll(() => readFileSync(join(repo, "autos", "all-step-kinds.auto.json"), "utf8")).toBe(before);

  await menu("desktop.deploy");
  await expect(page.getByTestId("desktop-panel")).toHaveAttribute("data-kind", "deploy");
  await expect(page.getByTestId("desktop-deploy-list")).toBeVisible();
  await expect(page.getByTestId("desktop-deploy-list")).toContainText("TeamCode/src/main/assets/autos/robot.json");
});

test("the Simulate dialog runs the high-fidelity sim and the overlay loads by itself", async () => {
  await page.getByTestId("toolbar-run.simulate").click();
  await page.getByTestId("run-high-fidelity-sim").click();
  const panel = page.getByTestId("desktop-panel");
  await expect(panel).toHaveAttribute("data-kind", "sim");
  await expect(panel).toHaveAttribute("data-phase", "done", { timeout: 30_000 });
  await expect(panel).toContainText("Finished in");
  await expect(panel).toContainText("node fake-sim.cjs all-step-kinds");
  await panel.getByRole("button", { name: /the sim's output/ }).click();
  await expect(page.getByTestId("desktop-sim-log")).toContainText("fake-sim: running all-step-kinds");
  await capture("desktop-sim-fake.png");
});

test("the toolbar's Deploy shows what would change and writes nothing until confirmed", async () => {
  await page.getByTestId("toolbar-desktop.deploy").click();
  const panel = page.getByTestId("desktop-panel");
  await expect(panel).toHaveAttribute("data-kind", "deploy");
  await expect(page.getByTestId("desktop-deploy-list")).toContainText("TeamCode/src/main/assets/autos/robot.json");
  await expect(page.getByTestId("desktop-deploy-confirm")).toBeEnabled();
  expect(() => readFileSync(join(repo, "TeamCode", "src", "main", "assets", "autos", "robot.json"))).toThrow();
});

test("the toolbar's Commit puts the auto on a work branch and stops short of the network", async () => {
  await page.getByTestId("toolbar-desktop.git").click();
  const panel = page.getByTestId("desktop-panel");
  await expect(panel).toHaveAttribute("data-kind", "git");
  await expect(panel).toContainText("auto/all-step-kinds/zenith-e2e", { timeout: 15_000 });
  await expect(panel).toContainText("all-step-kinds.auto.json");
  await page.getByTestId("desktop-commit-summary").fill("retitle for the smoke test");
  await page.getByTestId("desktop-git-commit").click();

  // The app moves to the work branch first and commits after, so wait for the commit itself.
  await expect.poll(() => gitIn(repo, "log", "-1", "--format=%s"), { timeout: 15_000 }).toBe("auto(all-step-kinds): retitle for the smoke test");
  expect(gitIn(repo, "branch", "--show-current")).toBe("auto/all-step-kinds/zenith-e2e");
  expect(gitIn(repo, "log", "-1", "--format=%s", "main")).toBe("chore: the robot repository as it was");
  const committed = gitIn(repo, "show", "--name-only", "--format=", "HEAD").split(/\r?\n/);
  expect(committed).toEqual(expect.arrayContaining(["autos/all-step-kinds.auto.json", "autos/.renders/all-step-kinds.svg"]));
  expect(gitIn(repo, "status", "--porcelain", "--", "autos/all-step-kinds.auto.json")).toBe("");

  // Push is offered for the work branch; the pull request waits for a GitHub sign-in, which this
  // profile does not have. Neither is pressed.
  await expect(page.getByTestId("desktop-git-push")).toBeEnabled();
  await expect(page.getByTestId("desktop-git-pr")).toBeDisabled();
  expect(gitIn(repo, "for-each-ref", "--format=%(refname)", "refs/remotes")).toBe("");
  await capture("desktop-git.png");
});

test("opening another folder over an unsaved edit asks first, and Cancel keeps the edit", async () => {
  const other = mkdtempSync(join(tmpdir(), "zenith-e2e-other-"));
  try {
    cpSync(example, other, { recursive: true });
    const name = page.getByTestId("toolbar-auto-name");
    const unsaved = name.getByLabel("Unsaved changes");
    const onDisk = readFileSync(join(repo, "autos", "all-step-kinds.auto.json"), "utf8");
    await page.getByTestId("desktop-panel").getByRole("button", { name: "Close" }).first().click();

    // An edit: select the first step and delete it.
    await page.locator("[data-testid^='step-row-']").first().getByRole("button").first().click();
    await page.keyboard.press("Delete");
    await expect(unsaved).toHaveCount(1);

    await app.evaluate(({ dialog }, root) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [root] })) as typeof dialog.showOpenDialog;
    }, other);
    await menu("project.openFolder");
    const question = page.getByTestId("unsaved-dialog");
    await expect(question).toContainText("all-step-kinds.auto.json has edits that are not saved.");
    await page.getByTestId("unsaved-cancel").click();

    await expect(question).toHaveCount(0);
    await expect(name).toContainText("all-step-kinds.auto.json");
    await expect(unsaved).toHaveCount(1);
    // A cancelled open is information, not an error, and the first repository is still the one open.
    const status = page.getByTestId("status");
    await expect(status).toHaveAttribute("data-kind", "info");
    await expect(status).toContainText("Kept the unsaved edits in all-step-kinds.auto.json. Nothing else was opened.");
    await expect(page.locator("[data-titlebar]")).toContainText(basename(repo));
    expect(readFileSync(join(repo, "autos", "all-step-kinds.auto.json"), "utf8")).toBe(onDisk);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});
