/**
 * Issue #213 in the real app: `zenith open`'s switches open a folder project at launch and through a
 * second launch, the GitHub sign-in dialog signs in with a fake GitHub CLI, and a clone of a GitHub
 * repository is offered in GitHub mode with its owner, name and base filled in. GitHub's API is
 * answered by Playwright's router, so nothing leaves the computer. Windowless (ZENITH_HEADLESS=1).
 */
import { execFile, execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { closeFirstLoadNotice, seedFirstRunDone } from "./firstRunDone";

const here = fileURLToPath(new URL(".", import.meta.url));
const pkg = join(here, "..");
const starter = join(pkg, "..", "..", "examples", "starter");
const fakeGh = join(here, "fixtures", "fake-gh.cjs");
const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

let app: ElectronApplication;
let page: Page;
let profile = "";
let pid: number | undefined;

const env = (extra: Record<string, string> = {}) => ({
  ...process.env,
  ZENITH_USER_DATA: profile,
  ZENITH_DEV_URL: "",
  ZENITH_HEADLESS: "1",
  ZENITH_TEST_GH: fakeGh,
  ...extra,
});

/** A copy of examples/starter, as a git clone of a GitHub repository when `origin` is given. */
function robotRepo(name: string, origin?: string): string {
  const root = join(profile, name);
  cpSync(starter, root, { recursive: true });
  if (origin !== undefined) {
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: root, windowsHide: true });
    execFileSync("git", ["remote", "add", "origin", origin], { cwd: root, windowsHide: true });
  }
  return root;
}

async function launch(args: string[], extra: Record<string, string> = {}): Promise<void> {
  app = await electron.launch({ executablePath: electronPath, args: [pkg, ...args], env: env(extra) });
  pid = app.process().pid;
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await seedFirstRunDone(page);
}

/** Answers GitHub's API the way an account that can push to example-team/robot would see it. */
async function fakeGitHub(): Promise<string[]> {
  const seen: string[] = [];
  await page.route("https://api.github.com/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    seen.push(`${request.method()} ${url.pathname} ${request.headers()["authorization"] ?? ""}`);
    const headers = { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-expose-headers": "x-oauth-scopes", "x-oauth-scopes": "repo, read:org" };
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: { ...headers, "access-control-allow-headers": "authorization, accept, content-type, x-github-api-version" } });
      return;
    }
    if (url.pathname === "/user") {
      await route.fulfill({ status: 200, headers, body: JSON.stringify({ login: "octocat" }) });
      return;
    }
    if (url.pathname === "/user/repos") {
      const repos = [
        { name: "robot", full_name: "example-team/robot", owner: { login: "example-team" }, default_branch: "main", private: true, html_url: "https://github.com/example-team/robot", permissions: { push: true } },
        { name: "other", full_name: "octocat/other", owner: { login: "octocat" }, default_branch: "main", private: false, html_url: "https://github.com/octocat/other", permissions: { push: true } },
      ];
      await route.fulfill({ status: 200, headers, body: JSON.stringify(repos) });
      return;
    }
    if (url.pathname === "/repos/example-team/robot/branches") {
      const branches = ["main", "develop"].map((name) => ({ name, commit: { sha: "0123456789abcdef0123456789abcdef01234567" }, protected: false }));
      await route.fulfill({ status: 200, headers, body: JSON.stringify(branches) });
      return;
    }
    await route.fulfill({ status: 404, headers, body: JSON.stringify({ message: "Not Found" }) });
  });
  return seen;
}

/** What `zenith open` does while the app runs: start it again, which hands the folder over and quits. */
function secondLaunch(args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const child = execFile(electronPath, [pkg, ...args], { env: env(), windowsHide: true });
    child.once("exit", (exitCode) => {
      resolve(exitCode);
    });
  });
}

async function openSignIn(): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send("zenith:menu", { action: "project.signIn" });
  });
  await expect(page.getByTestId("github-signin")).toBeVisible();
}

test.beforeEach(() => {
  profile = mkdtempSync(join(tmpdir(), "zenith-e2e-github-cli-"));
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

test("zenith open's switches open the folder and the auto at launch, and a second launch hands over another", async () => {
  const first = robotRepo("first-robot");
  const second = robotRepo("second-robot");
  // No reload here: the page takes the launch's request once, on its first load.
  await launch([`--zenith-open=${first}`, "--zenith-auto=first-auto"]);
  await closeFirstLoadNotice(page);
  await expect(page.getByTestId("toolbar-auto-name")).toContainText("first-auto.auto.json");
  // The title bar, not the status line: the status line clears after a few seconds, which a slow
  // second launch can outlast.
  await expect(page.getByRole("banner", { name: "Title bar" })).toContainText("first-robot");

  expect(await secondLaunch([`--zenith-open=${second}`, "--zenith-auto=collect-and-score.auto.json"])).toBe(0);
  await expect(page.getByTestId("toolbar-auto-name")).toContainText("collect-and-score.auto.json");
  await expect(page.getByRole("banner", { name: "Title bar" })).toContainText("second-robot");
  expect(app.windows()).toHaveLength(1);
});

test("a folder with no zenith.json is refused with a sentence, and nothing opens", async () => {
  const empty = join(profile, "not-a-project");
  cpSync(join(starter, "autos"), empty, { recursive: true });
  await launch([`--zenith-open=${empty}`]);
  await closeFirstLoadNotice(page);
  await expect(page.getByTestId("status")).toContainText(`Zenith could not open ${empty}`);
  await expect(page.getByTestId("canvas-empty")).toBeVisible();
});

test("the sign-in dialog signs in with the GitHub CLI, and the token stays out of storage", async () => {
  await launch([]);
  await page.reload();
  await page.waitForSelector("[data-titlebar]");
  const seen = await fakeGitHub();
  await openSignIn();
  await expect(page.getByTestId("github-cli-offer")).toContainText("GitHub CLI is signed in");
  await expect(page.getByTestId("github-signin")).toContainText("GitHub CLI's permissions");
  await page.getByTestId("github-signin-cli").click();
  await expect(page.getByTestId("github-signed-in")).toHaveText("Signed in as octocat with the GitHub CLI.");
  expect(seen).toContain("GET /user Bearer gho_FAKEe2eTOKEN0123456789abcdefghij");
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(stored).not.toContain("gho_FAKE");
});

test("a signed-out GitHub CLI leaves the token form, with how to sign the CLI in", async () => {
  await launch([], { FAKE_GH_SIGNED_OUT: "1" });
  await page.reload();
  await page.waitForSelector("[data-titlebar]");
  await openSignIn();
  await expect(page.getByTestId("github-token")).toBeVisible();
  await expect(page.getByTestId("github-cli-note")).toContainText("gh auth login");
  await expect(page.getByTestId("github-signin-cli")).toHaveCount(0);
});

test("a clone of a GitHub repository is offered in GitHub mode with owner, repo and base filled in", async () => {
  const clone = robotRepo("robot", "https://github.com/example-team/robot.git");
  await launch([]);
  await page.reload();
  await page.waitForSelector("[data-titlebar]");
  expect(await secondLaunch([`--zenith-open=${clone}`])).toBe(0);
  await expect(page.getByTestId("toolbar-auto-name")).toContainText(".auto.json");
  const seen = await fakeGitHub();
  await page.keyboard.press("Control+o");
  await expect(page.getByTestId("open-project-clone-offer")).toBeVisible();
  await expect(page.getByTestId("open-project")).toContainText("robot is a clone of example-team/robot");
  await page.getByTestId("open-project-clone-offer").click();
  await expect(page.getByTestId("github-clone-offer")).toContainText("example-team/robot");
  await page.getByTestId("github-open-signin").click();
  await page.getByTestId("github-signin-cli").click();
  await expect(page.getByTestId("github-signed-in")).toBeVisible();
  await page.getByRole("button", { name: "Open a repository" }).click();
  // Back on the GitHub tab, with the clone's repository picked at its base.
  await expect(page.getByTestId("github-open-clone")).toBeVisible();
  await expect(page.getByTestId("github-repo-list")).toContainText("example-team/robot");
  expect(seen.some((line) => line.startsWith("GET /user/repos Bearer gho_FAKE"))).toBe(true);
  await expect(page.getByTestId("github-repo-search")).toHaveValue("example-team/robot");
  await expect(page.getByTestId("github-base")).toHaveValue("main");
  await expect(page.getByTestId("github-repo-example-team/robot")).toHaveAttribute("aria-selected", "true");
});
