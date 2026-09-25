/**
 * Closing the window, or quitting, with unsaved edits asks Save, Discard or Cancel first (QA-12),
 * and a clean close asks nothing. Each test starts its own copy of the built app, since two of them
 * end it. Windowless, as every desktop test is (ZENITH_HEADLESS=1): the close is requested from the
 * main process, the way the title bar's X, Alt+F4 and the taskbar request it.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const pkg = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const require = createRequire(import.meta.url);

let app: ElectronApplication;
let page: Page;
let profile = "";
let pid: number | undefined;

test.beforeEach(async () => {
  profile = mkdtempSync(join(tmpdir(), "zenith-e2e-close-"));
  app = await electron.launch({
    executablePath: require("electron") as string,
    args: [pkg],
    env: { ...process.env, ZENITH_USER_DATA: profile, ZENITH_DEV_URL: "", ZENITH_HEADLESS: "1" },
  });
  pid = app.process().pid;
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => {
    localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
  });
  await page.reload();
  await page.waitForSelector("[data-titlebar]");
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send("zenith:menu", { action: "project.example" });
  });
  await expect(page.getByTestId("toolbar-auto-name")).toContainText(".auto.json");
});

test.afterEach(async () => {
  const child = app.process();
  const exited = new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    setTimeout(resolve, 10_000);
  });
  // app.exit skips the close events, so an edit left unsaved does not hold the teardown up.
  await app.evaluate(({ app: electronApp }) => {
    electronApp.exit(0);
  }).catch(() => undefined);
  // Wait for the process to go, or the profile is still locked when it is removed below.
  await exited;
  if (pid !== undefined && process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      // Already gone, which is what the closing tests expect.
    }
  }
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const unsaved = () => page.getByTestId("toolbar-auto-name").getByLabel("Unsaved changes");

async function makeAnEdit(): Promise<void> {
  await page.locator("[data-testid^='step-row-']").first().getByRole("button").first().click();
  await page.keyboard.press("Delete");
  await expect(unsaved()).toHaveCount(1);
}

/** What the title bar's X does. */
async function requestClose(): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close();
  });
}

const windowCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

test("closing or quitting with an unsaved edit asks, and Cancel keeps the window and the edit", async () => {
  await makeAnEdit();
  const question = page.getByTestId("unsaved-dialog");

  await requestClose();
  await expect(question).toContainText("has edits that are not saved.");
  await expect(question).toContainText("Closing Zenith now would lose them.");
  await page.getByTestId("unsaved-cancel").click();
  await expect(question).toHaveCount(0);
  expect(await windowCount()).toBe(1);
  await expect(unsaved()).toHaveCount(1);

  // File > Exit is app.quit(): held the same way.
  await app.evaluate(({ app: electronApp }) => {
    electronApp.quit();
  });
  await expect(question).toBeVisible();
  await page.getByTestId("unsaved-cancel").click();
  await expect(question).toHaveCount(0);
  expect(await windowCount()).toBe(1);
  await expect(unsaved()).toHaveCount(1);
});

test("Discard closes the window with the edit unsaved", async () => {
  await makeAnEdit();
  // The window closing is the page closing; the process itself may outlive it while Playwright is attached.
  const closed = page.waitForEvent("close", { timeout: 15_000 });
  await requestClose();
  // The click closes the page under it, which Playwright can report as a failed click.
  await page.getByTestId("unsaved-discard").click().catch((error: unknown) => {
    if (!page.isClosed()) throw error;
  });
  await closed;
});

test("a close with nothing unsaved asks nothing and closes", async () => {
  await expect(unsaved()).toHaveCount(0);
  // The window closing is the page closing; the process itself may outlive it while Playwright is attached.
  const closed = page.waitForEvent("close", { timeout: 15_000 });
  await requestClose();
  await closed;
});
