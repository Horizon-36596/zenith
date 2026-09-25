/**
 * Captures the public docs screenshots (site/SCREENSHOTS.md) headless, against the starter
 * example only. Writes PNGs straight into site/docs/assets/screenshots/, replacing the 68-byte
 * placeholders. Also writes the CLI and MCP-loop shots, which are styled captures of real text
 * rather than a live page.
 *
 * Usage (from the repo root, PowerShell 5.1):
 *   $env:ZENITH_SHOTS_PORT = '5199'; node apps/web/scripts/capture-screenshots.mjs
 *
 * Runs its own Vite dev server on ZENITH_SHOTS_PORT (default 5199) so it never collides with a
 * server already using this tree's .vite cache, and stops it when done.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(HERE, "..");
const REPO_ROOT = join(WEB_DIR, "..", "..");
const SHOTS_DIR = join(REPO_ROOT, "site", "docs", "assets", "screenshots");
const PORT = Number(process.env["ZENITH_SHOTS_PORT"] ?? "5199");
const BASE_URL = `http://localhost:${String(PORT)}`;

/** Marks the first-run tour as already seen, the same key `apps/web/e2e/qa/helpers.ts` uses. */
async function skipTour(page) {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "zenith.ui",
      JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }),
    );
  });
}

async function waitForFonts(page) {
  await page.evaluate(() => document.fonts.ready);
}

/** A short, fixed settle so a just-finished CSS transition or layout pass is not mid-flight. */
async function settle(page, ms = 350) {
  await page.waitForTimeout(ms);
}

/**
 * Dismisses the status bar overlay (e.g. the "Loaded the bundled example" message every
 * canvas-load-example click raises) so it never sits in a screenshot. Mirrors
 * `apps/web/e2e/qa/helpers.ts`'s `clearStatus`: it is an overlay out of the layout flow, so
 * clearing it never shifts anything else in the shot.
 */
async function clearStatus(page) {
  await page.evaluate(() => import("/src/state/store.ts").then((m) => m.clearStatus()));
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="status"]') === null &&
      document.querySelector('[data-testid="status-leaving"]') === null,
  );
}

// A tiny local stand-in for @playwright/test's `expect(locator).toBeVisible()`, so this script has
// no test runner dependency beyond the `chromium` launcher itself.
async function waitVisible(locator, timeout = 30000) {
  await locator.waitFor({ state: "visible", timeout });
}

async function writePng(buffer, name) {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const path = join(SHOTS_DIR, name);
  writeFileSync(path, buffer);
  const kb = (buffer.length / 1024).toFixed(1);
  console.log(`wrote ${name} (${kb} KB)`);
}

/**
 * Starts the dev server and waits by polling the HTTP port rather than parsing stdout: on Windows,
 * `shell: true` routes output through cmd.exe and the "Local:" line does not reliably show up as a
 * single `data` chunk, so string-matching it is flaky even once the server is actually listening.
 */
function startDevServer() {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "vite", "--port", String(PORT), "--strictPort"], {
      cwd: WEB_DIR,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let log = "";
    child.stdout.on("data", (d) => {
      log += d.toString();
    });
    child.stderr.on("data", (d) => {
      log += d.toString();
    });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`vite exited early with code ${String(code)}\n${log}`));
      }
    });

    const deadline = Date.now() + 30000;
    const poll = async () => {
      if (settled) return;
      try {
        const response = await fetch(BASE_URL);
        if (response.ok || response.status === 404) {
          settled = true;
          resolve(child);
          return;
        }
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline) {
        settled = true;
        child.kill();
        reject(new Error(`vite dev server did not answer within 30s\n${log}`));
        return;
      }
      setTimeout(poll, 300);
    };
    setTimeout(poll, 300);
  });
}

/**
 * Kills the dev server. On Windows `shell: true` runs the command through cmd.exe, so `child.kill()`
 * only kills that wrapper and leaves the actual vite process (and its node child) running; `taskkill
 * /T` kills the whole process tree instead.
 */
async function stopDevServer(child) {
  if (child === undefined) return;
  if (process.platform === "win32" && child.pid !== undefined) {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      killer.on("exit", resolve);
      killer.on("error", resolve);
    });
  } else {
    child.kill();
  }
  await new Promise((resolve) => {
    child.once("exit", resolve);
    setTimeout(resolve, 3000);
  });
}

/** Field-inch to on-canvas CSS pixels, the same maths as `apps/web/e2e/qa/helpers.ts`. */
async function canvasView(page) {
  const canvas = page.getByTestId("field-canvas");
  const box = await canvas.boundingBox();
  const attr = async (name) => Number(await canvas.getAttribute(name));
  return {
    ...box,
    pxPerIn: await attr("data-px-per-in"),
    originXPx: await attr("data-origin-x-px"),
    originYPx: await attr("data-origin-y-px"),
  };
}

async function worldToScreen(page, xIn, yIn) {
  const view = await canvasView(page);
  return { x: view.x + view.originXPx + view.pxPerIn * xIn, y: view.y + view.originYPx - view.pxPerIn * yIn };
}

// ZENITH_SHOTS_ONLY, a comma-separated subset of these names, reruns only those shots (used while
// iterating on one capture instead of the whole set).
const ALL_SHOTS = {
  overview: (b) => shootEditorOverview(b),
  welcome: (b) => shootWelcome(b),
  tourChoice: (b) => shootTourChoice(b),
  titleToolbar: (b) => shootTitleToolbar(b),
  inspectorFindings: (b) => shootInspectorAndFindings(b),
  timeline: (b) => shootTimeline(b),
  palette: (b) => shootPalette(b),
  contextMenu: (b) => shootContextMenu(b),
  measureTool: (b) => shootMeasureTool(b),
  playbackLevels: (b) => shootPlaybackLevels(b),
  headingPiecewise: (b) => shootHeadingPiecewise(b),
  cliValidate: () => shootCliValidate(),
  agentsLoop: () => shootAgentsLoop(),
};

async function main() {
  const only = process.env["ZENITH_SHOTS_ONLY"];
  const names = only === undefined || only === "" ? Object.keys(ALL_SHOTS) : only.split(",");
  const needsServer = names.some((name) => name !== "cliValidate" && name !== "agentsLoop");
  const server = needsServer ? await startDevServer() : undefined;
  const browser = await chromium.launch({ headless: true });
  try {
    for (const name of names) {
      const shoot = ALL_SHOTS[name];
      if (shoot === undefined) throw new Error(`unknown shot: ${name}`);
      await shoot(browser);
    }
  } finally {
    await browser.close();
    await stopDevServer(server);
  }

  console.log(
    "\nSkipped (documented in the SCREENSHOTS.md entry and the capture report):\n" +
      "  review-pr-diff.png       - needs a real GitHub-connected PR/head-vs-base session\n" +
      "  getting-started-smartscreen.png - real Windows SmartScreen chrome, not producible headless",
  );
}

async function newPage(browser, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  context.setDefaultTimeout(45000);
  context.setDefaultNavigationTimeout(45000);
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  page.setDefaultNavigationTimeout(45000);
  return { context, page };
}

async function shootEditorOverview(browser) {
  const { context, page } = await newPage(browser, { width: 1440, height: 900 });
  await skipTour(page);
  await page.goto(BASE_URL);
  await page.getByTestId("canvas-load-example").click();
  await waitVisible(page.getByTestId("step-row-driveOut"));
  await clearStatus(page);
  await waitForFonts(page);
  await settle(page, 600);
  const png = await page.screenshot();
  await writePng(png, "editor-overview.png");
  // Also refreshes the top-level README's illustration, which pointed at a stale, non-public
  // capture; see the commit message for the README.md edit that keeps the path.
  writeFileSync(join(REPO_ROOT, "docs", "images", "editor.png"), png);
  console.log("wrote docs/images/editor.png (copy of editor-overview.png)");
  await context.close();
}

async function shootWelcome(browser) {
  const { context, page } = await newPage(browser, { width: 1280, height: 800 });
  await skipTour(page);
  await page.goto(BASE_URL);
  await waitVisible(page.getByTestId("canvas-empty"));
  await waitForFonts(page);
  await settle(page);
  await writePng(await page.screenshot(), "getting-started-tour-welcome.png");
  await context.close();
}

async function shootTourChoice(browser) {
  const { context, page } = await newPage(browser, { width: 1280, height: 800 });
  // No skipTour: a genuinely first visit auto-loads the example and starts the core tour.
  await page.goto(BASE_URL);
  await waitVisible(page.getByTestId("tour-card"));
  const stops = ["field", "steps", "insert", "inspector", "findings", "run"];
  for (const stop of stops) {
    await waitVisible(page.getByTestId("tour-card"));
    await page.getByTestId("tour-next").click();
  }
  await waitVisible(page.getByTestId("tour-choice"));
  await clearStatus(page);
  await waitForFonts(page);
  await settle(page);
  await writePng(await page.screenshot(), "getting-started-tour-choice.png");
  await context.close();
}

async function shootTitleToolbar(browser) {
  const { context, page } = await newPage(browser, { width: 1280, height: 400 });
  await skipTour(page);
  await page.goto(BASE_URL);
  await page.getByTestId("canvas-load-example").click();
  await waitVisible(page.getByTestId("step-row-driveOut"));
  await clearStatus(page);
  await waitForFonts(page);
  await settle(page);
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: 1280, height: 160 } });
  await writePng(png, "editor-title-toolbar.png");
  await context.close();
}

/**
 * Both editor-inspector-path.png and editor-findings-panel.png come from the same setup used in
 * apps/web/e2e/editor.spec.ts's "a pose edited in the inspector changes the findings" test:
 * driveOut's end is made a literal pose, then moved into the hive's approach margin, which is a
 * real, reproducible finding (not fabricated data) from the shipped example.
 */
async function shootInspectorAndFindings(browser) {
  const { context, page } = await newPage(browser, { width: 1440, height: 900 });
  await skipTour(page);
  await page.goto(BASE_URL);
  await page.getByTestId("canvas-load-example").click();
  await waitVisible(page.getByTestId("step-row-driveOut"));
  await clearStatus(page);
  await waitForFonts(page);

  await page.getByTestId("step-row-driveOut").getByRole("button").first().click();
  await waitVisible(page.getByTestId("inspector"));
  await page.evaluate(() =>
    import("/src/state/store.ts").then((m) => {
      const s = m.getState();
      m.commit({
        ...s.auto,
        steps: s.auto.steps.map((x) =>
          x.id !== "driveOut"
            ? x
            : {
                ...x,
                segments: x.segments.map((seg) => ({
                  ...seg,
                  to: {
                    xIn: -12,
                    yIn: -36,
                    headingRad: 1.5708,
                    provenance: "SET BY HAND: docs screenshot, the scoreSouth waypoint",
                  },
                })),
              },
        ),
      });
    }),
  );
  await waitVisible(page.getByTestId("inspector-to-x-0"));
  await settle(page, 200);

  const inspectorPng = await page.locator('[data-testid="inspector-panel"]').screenshot();
  await writePng(inspectorPng, "editor-inspector-path.png");

  // Move the leg's end up into the hive's approach margin: scorePreload now launches from an
  // illegal approach pose, which is a real error finding, not an invented one.
  const y = page.getByTestId("inspector-to-y-0");
  await y.fill("-12");
  await y.press("Enter");
  await waitVisible(page.getByTestId("findings-list"));
  await settle(page, 400);

  const findingsPanel = page.getByTestId("findings-list").locator("xpath=..");
  const firstRow = findingsPanel.locator('[role="list"] > *').first();
  if ((await firstRow.count()) > 0) await firstRow.hover();
  await settle(page, 150);
  const findingsPng = await findingsPanel.screenshot();
  await writePng(findingsPng, "editor-findings-panel.png");

  await context.close();
}

/**
 * `run.simulate` opens the high-fidelity sim dialog, which reads a robot trace rather than running
 * one itself. The trace fixture the editor's own e2e suite uses
 * (`apps/web/e2e/fixtures/first-auto.trace.json`, read only, never modified) is a trace of the
 * starter example's own first-auto, so loading it here draws a real, reproducible "actual" bar next
 * to the estimate rather than fabricated numbers.
 */
async function shootTimeline(browser) {
  const { context, page } = await newPage(browser, { width: 1440, height: 900 });
  await skipTour(page);
  await page.goto(BASE_URL);
  await page.getByTestId("canvas-load-example").click();
  await waitVisible(page.getByTestId("step-row-driveOut"));
  await clearStatus(page);
  await waitForFonts(page);
  await page.getByTestId("toolbar-auto-name").click();
  await page.getByTestId("open-auto-first-auto.auto.json").click();
  await waitVisible(page.getByTestId("steps-list"));

  await page.getByTestId("toolbar-run.simulate").click();
  await waitVisible(page.getByTestId("simulate"));
  const trace = join(REPO_ROOT, "apps", "web", "e2e", "fixtures", "first-auto.trace.json");
  await page.getByTestId("load-trace").setInputFiles(trace);
  await waitVisible(page.getByTestId("trace-summary"));
  await page.keyboard.press("Escape");

  await waitVisible(page.getByTestId("timeline-actual-track"));
  // Escape closes the sim dialog, but the mouse is still resting over the toolbar's Simulate
  // button underneath it, so its tooltip pops back in; park the pointer somewhere inert first.
  await page.mouse.move(700, 500);
  await settle(page, 400);
  const timelinePng = await page.locator('[aria-label="Timeline"]').screenshot();
  await writePng(timelinePng, "editor-timeline.png");
  await context.close();
}

async function shootPalette(browser) {
  const { context, page } = await newPage(browser, { width: 1440, height: 900 });
  await skipTour(page);
  await page.goto(BASE_URL);
  await page.getByTestId("canvas-load-example").click();
  await waitVisible(page.getByTestId("step-row-driveOut"));
  await clearStatus(page);
  await waitForFonts(page);
  await page.keyboard.press("Control+k");
  await waitVisible(page.getByTestId("palette-input"));
  await page.getByTestId("palette-input").fill("sco");
  await waitVisible(page.getByTestId("palette-results"));
  await settle(page, 200);
  const palettePng = await page.getByRole("dialog", { name: "Command palette" }).screenshot();
  await writePng(palettePng, "editor-command-palette.png");
  await context.close();
}

async function shootContextMenu(browser) {
  const { context, page } = await newPage(browser, { width: 1440, height: 900 });
  await skipTour(page);
  await page.goto(BASE_URL);
  await page.getByTestId("canvas-load-example").click();
  await waitVisible(page.getByTestId("step-row-driveOut"));
  await clearStatus(page);
  await waitForFonts(page);
  // Midpoint of driveOut's line, start (-12, -63) to scoreSouth (-12, -36).
  const at = await worldToScreen(page, -12, -49.5);
  await page.mouse.click(at.x, at.y, { button: "right" });
  await waitVisible(page.getByTestId("canvas-context-menu"));
  await settle(page, 150);
  const menuPng = await page.getByTestId("canvas-context-menu").screenshot();
  await writePng(menuPng, "editor-context-menu.png");
  await context.close();
}

async function shootMeasureTool(browser) {
  const { context, page } = await newPage(browser, { width: 1440, height: 900 });
  await skipTour(page);
  await page.goto(BASE_URL);
  await page.getByTestId("canvas-load-example").click();
  await waitVisible(page.getByTestId("step-row-driveOut"));
  await clearStatus(page);
  await waitForFonts(page);
  await page.getByTestId("toolbar-tool.measure").click();
  const a = await worldToScreen(page, -12, -63);
  const b = await worldToScreen(page, -61, -44);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  const steps = 8;
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
  }
  await settle(page, 200);
  // Centre a crop of up to 900 x 600 on the measurement, kept inside the field, so the line and
  // its readout are in the shot wherever the field lands in the layout.
  const field = await page.getByTestId("field-canvas").boundingBox();
  const clip = cropAround(field, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, Math.min(900, field.width), 600);
  const png = await page.screenshot({ clip });
  await writePng(png, "editor-measure-tool.png");
  await page.mouse.up();
  await context.close();
}

/**
 * A `width` x `height` crop centred on `at`, moved as needed to stay inside `bounds` (the field
 * canvas's box), so the shot shows the field and not a sliver of the panels beside it.
 */
function cropAround(bounds, at, width, height) {
  const x = Math.min(Math.max(bounds.x, at.x - width / 2), bounds.x + bounds.width - width);
  const y = Math.min(Math.max(bounds.y, at.y - height / 2), bounds.y + bounds.height - height);
  return { x, y, width, height };
}

/**
 * The playback control under the timeline's scrubber, with the pointer on Instant sim so its
 * tooltip says what that level is. The crop is the timeline and the tooltip together.
 */
async function shootPlaybackLevels(browser) {
  const { context, page } = await newPage(browser, { width: 1440, height: 900 });
  await skipTour(page);
  await page.goto(BASE_URL);
  await page.getByTestId("canvas-load-example").click();
  await waitVisible(page.getByTestId("step-row-driveOut"));
  await clearStatus(page);
  await waitForFonts(page);
  const instant = page.getByTestId("playback-level-instant");
  await page.waitForFunction(
    () => document.querySelector('[data-testid="playback-level-instant"]')?.getAttribute("aria-disabled") !== "true",
  );
  await instant.hover();
  const tip = page.getByRole("tooltip");
  await waitVisible(tip);
  await settle(page, 300);
  const a = await page.locator('[aria-label="Timeline"]').boundingBox();
  const t = await tip.boundingBox();
  const pad = 12;
  const x = Math.max(0, Math.min(a.x, t.x) - pad);
  const y = Math.max(0, Math.min(a.y, t.y) - pad);
  const right = Math.max(a.x + a.width, t.x + t.width) + pad;
  const bottom = Math.max(a.y + a.height, t.y + t.height) + pad;
  const png = await page.screenshot({ clip: { x, y, width: right - x, height: bottom - y } });
  await writePng(png, "editor-playback-levels.png");
  await context.close();
}

/**
 * A piecewise heading on first-auto's driveOut, the straight leg from (-12, -63) north to
 * scoreSouth (-12, -36): split in the middle on the inspector's track, the first half Constant at
 * 90 degrees and the second Linear from 90 to 180 degrees. Two shots: the inspector's Heading
 * section with the range editor, and the field round the leg with its heading arrows and the tick
 * at the boundary.
 */
async function shootHeadingPiecewise(browser) {
  const { context, page } = await newPage(browser, { width: 1440, height: 900 });
  await skipTour(page);
  await page.goto(BASE_URL);
  await page.getByTestId("canvas-load-example").click();
  await waitVisible(page.getByTestId("step-row-driveOut"));
  await clearStatus(page);
  await waitForFonts(page);
  await page.getByTestId("toolbar-auto-name").click();
  await page.getByTestId("open-auto-first-auto.auto.json").click();
  await waitVisible(page.getByTestId("step-row-driveOut"));
  await clearStatus(page);
  await page.getByTestId("step-row-driveOut").getByRole("button").first().click();
  await waitVisible(page.getByTestId("inspector"));

  const pickMode = async (testId, mode) => {
    await page.getByTestId(testId).click();
    await page.getByTestId(`${testId}-option-${mode}`).click();
    await page.waitForFunction(
      ([id, value]) => document.querySelector(`[data-testid="${id}"]`)?.getAttribute("data-value") === value,
      [testId, mode],
    );
  };
  const setNumber = async (testId, value) => {
    const input = page.getByTestId(testId);
    await input.fill(String(value));
    await input.press("Enter");
  };
  await pickMode("inspector-heading-mode", "piecewise");
  const track = page.getByTestId("heading-track");
  await waitVisible(track);
  const box = await track.boundingBox();
  await track.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await waitVisible(page.getByTestId("heading-range-1"));
  await pickMode("heading-range-0-mode", "constant");
  await setNumber("heading-range-0-constant", 90);
  await pickMode("heading-range-1-mode", "linear");
  await setNumber("heading-range-1-from", 90);
  await setNumber("heading-range-1-to", 180);
  // Enter leaves keyboard focus on the last input, which shows its tooltip; drop the focus and park
  // the pointer so the section is shot with no tooltip over it.
  await page.evaluate(() => document.activeElement?.blur());
  await page.mouse.move(700, 880);
  await page.waitForFunction(() => document.querySelector('[role="tooltip"]') === null);
  await settle(page, 400);

  const section = page.locator('[data-tour="section.heading"]');
  await section.scrollIntoViewIfNeeded();
  await settle(page, 200);
  await writePng(await section.screenshot(), "editor-heading-piecewise.png");

  // Zoom the field to the selected leg (F, with the field focused) so its arrows read at a glance.
  await page.getByTestId("field-canvas").focus();
  await page.keyboard.press("f");
  await settle(page, 500);
  await page.evaluate(() => document.activeElement?.blur());
  await page.mouse.move(700, 880);
  await settle(page, 200);
  const field = await page.getByTestId("field-canvas").boundingBox();
  const mid = await worldToScreen(page, -12, -49.5);
  const clip = cropAround(field, mid, Math.min(640, field.width), Math.min(480, field.height));
  await writePng(await page.screenshot({ clip }), "editor-heading-arrows.png");
  await context.close();
}

/** Styled as a terminal, but the text inside is the real output of `zenith validate`. */
async function shootCliValidate() {
  const raw = await runCli(["validate", "examples/starter/autos/first-auto.auto.json"]);
  // pnpm's own banner lines ("zenith@0.1.0 zenith <cwd>", "tsx packages/cli/src/index.ts ...")
  // print this machine's absolute path and the pnpm plumbing; neither belongs in a public
  // screenshot, so only the CLI's own output survives into the terminal image.
  const output = raw
    .split("\n")
    .filter((line) => !/^>\s|zenith@\d|[A-Za-z]:\\|packages\/cli\/src\/index\.ts/.test(line))
    .join("\n")
    .trim();
  const html = terminalHtml("zenith validate examples/starter/autos/first-auto.auto.json", output);
  await shootStaticHtml(html, "cli-validate-output.png", 900, 500);
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["zenith", "--", ...args], {
      cwd: REPO_ROOT,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      out += d.toString();
    });
    child.on("error", reject);
    child.on("exit", () => resolve(out));
  });
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function terminalHtml(command, output) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #0d1117; font-family: "JetBrains Mono", ui-monospace, monospace; }
  .win { width: 900px; height: 500px; box-sizing: border-box; background: #14181f; border-radius: 10px;
    overflow: hidden; border: 1px solid #262c36; }
  .bar { display: flex; align-items: center; gap: 6px; padding: 10px 12px; background: #1b212b; }
  .dot { width: 11px; height: 11px; border-radius: 50%; }
  .r { background: #ff5f56; } .y { background: #ffbd2e; } .g { background: #27c93f; }
  .title { color: #8b93a1; font-size: 12px; margin-left: 10px; }
  pre { color: #d6deeb; font-size: 13px; line-height: 1.55; padding: 16px 18px; margin: 0;
    white-space: pre-wrap; }
  .prompt { color: #6edb9d; }
</style></head>
<body>
  <div class="win">
    <div class="bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
      <span class="title">zenith</span></div>
    <pre><span class="prompt">&gt; ${escapeHtml(command)}</span>\n${escapeHtml(output.trim())}</pre>
  </div>
</body></html>`;
}

async function shootAgentsLoop() {
  const steps = ["Open project", "Edit the auto", "Validate", "Zero errors"];
  const boxes = steps
    .map(
      (label, i) => `
    <div class="step">
      <div class="box">${escapeHtml(label)}</div>
      ${i < steps.length - 1 ? '<div class="arrow">&#8594;</div>' : ""}
    </div>`,
    )
    .join("");
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #0d1117; font-family: "IBM Plex Sans", ui-sans-serif, sans-serif; }
  .wrap { width: 900px; height: 600px; box-sizing: border-box; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 28px; background: #0d1117; }
  .row { display: flex; align-items: center; }
  .step { display: flex; align-items: center; }
  .box { color: #e6edf3; background: #161b22; border: 1px solid #30363d; border-radius: 8px;
    padding: 18px 22px; font-size: 16px; font-weight: 600; }
  .arrow { color: #58a6ff; font-size: 22px; margin: 0 16px; }
  .caption { color: #8b93a1; font-size: 13px; margin-top: 8px; }
  .loop { color: #58a6ff; font-size: 13px; }
</style></head>
<body>
  <div class="wrap">
    <div class="row">${boxes}</div>
    <div class="loop">the loop repeats from Edit until validate reports zero errors</div>
  </div>
</body></html>`;
  await shootStaticHtml(html, "agents-mcp-loop.png", 900, 600);
}

async function shootStaticHtml(html, name, width, height) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.setContent(html);
    await waitForFonts(page);
    await page.waitForTimeout(150);
    const png = await page.screenshot();
    await writePng(png, name);
    await context.close();
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
