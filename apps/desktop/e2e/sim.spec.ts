/**
 * Runs a real high-fidelity sim through the desktop app against a real robot repository, and checks
 * that the trace comes back and the overlay loads by itself. It needs Java and the repository's
 * Gradle build, so it only runs when ZENITH_SIM_REPO names that repository:
 *
 *   $env:ZENITH_SIM_REPO = "C:\path\to\robot-repo"; pnpm --filter @horizon36596/zenith-desktop test:e2e
 *
 * Point it at a copy of the repository when someone else may be running Gradle in it at the same
 * time. The app runs windowless (ZENITH_HEADLESS=1) on a throwaway profile, and nothing is saved,
 * so the repository is left as it was apart from Gradle's own build folder.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const here = fileURLToPath(new URL(".", import.meta.url));
const pkg = join(here, "..");
const require = createRequire(import.meta.url);
const repo = process.env["ZENITH_SIM_REPO"] ?? "";

test.skip(repo === "", "Set ZENITH_SIM_REPO to a robot repository to run the high-fidelity sim.");
test.setTimeout(15 * 60_000);

let app: ElectronApplication;
let page: Page;
let profile = "";

test.beforeAll(async () => {
  profile = mkdtempSync(join(tmpdir(), "zenith-e2e-sim-"));
  app = await electron.launch({
    executablePath: require("electron") as string,
    args: [pkg],
    env: { ...process.env, ZENITH_USER_DATA: profile, ZENITH_DEV_URL: "", ZENITH_HEADLESS: "1" },
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => {
    localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
  });
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  const pid = app?.process().pid;
  await app?.close().catch(() => undefined);
  if (pid !== undefined && process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      // Already gone.
    }
  }
  rmSync(profile, { recursive: true, force: true });
});

test("a high-fidelity sim runs, streams its output and loads the trace as the overlay", async () => {
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [root] })) as typeof dialog.showOpenDialog;
  }, repo);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send("zenith:menu", { action: "project.openFolder" });
  });
  await expect(page.getByTestId("toolbar-auto-name")).not.toHaveText(/No auto open/, { timeout: 30_000 });
  for (let i = 0; i < 3; i += 1) await page.keyboard.press("Escape");

  const started = Date.now();
  // From the Simulate dialog, as a person would start it.
  await page.getByTestId("toolbar-run.simulate").click();
  await page.getByTestId("run-high-fidelity-sim").click();
  const panel = page.getByTestId("desktop-panel");
  await expect(panel).toHaveAttribute("data-kind", "sim");
  await expect(page.getByTestId("desktop-sim-cancel")).toBeVisible();
  await expect(panel).toHaveAttribute("data-phase", /^(done|failed)$/, { timeout: 14 * 60_000 });
  const seconds = ((Date.now() - started) / 1000).toFixed(0);

  const text = await panel.innerText();
  await panel.getByRole("button", { name: /the sim's output/ }).click();
  const log = await page.getByTestId("desktop-sim-log").innerText().catch(() => "");
  const dir = join(pkg, "test-results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "desktop-sim-panel.txt"), `${seconds} s\n\n${text}\n\n--- log ---\n${log}\n`);
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0]?.webContents.capturePage();
    return image?.toPNG().toString("base64") ?? "";
  });
  writeFileSync(join(dir, "desktop-sim.png"), Buffer.from(png, "base64"));

  // "done" is set only after the trace has been parsed and put on the store, which is what draws the
  // simulated path over the plan; a trace that fails to parse turns the phase to "failed".
  await expect(panel, text).toHaveAttribute("data-phase", "done");
});
