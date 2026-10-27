/**
 * Shared helpers for the QA suite (`playwright.qa.config.ts`).
 *
 * Two probes make the canvas and the store testable from outside without touching app code:
 *
 * - `editor(page, expr)` evaluates an expression against the live store, imported through the Vite
 *   dev server's module graph (`/src/state/store.ts` is the same module instance the app uses).
 * - `installCanvasProbe(page)` wraps the 2D context before the app loads and records, for the most
 *   recent frame of the field canvas, every closed four-corner polygon it filled or stroked and
 *   every string it drew. The robot outline is the only live shape the size of the robot, so a
 *   frame's robot outlines, and so any ghosts, can be counted and measured.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { withoutFolderPickerFromTheStart } from "../saveExample";

export const SHOTS_DIR = process.env["ZENITH_QA_SHOTS"] ?? join(process.cwd(), "test-results", "qa-shots");

/** Saves a full-page screenshot as `<name>.png` in the shots folder. */
export async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOTS_DIR, `${name}.png`) });
}

/**
 * Marks the first-run tour as done before the app reads its preferences, and turns every feature
 * switch on unless something set them first, so the QA suite sees everything it was written for. It
 * acts only while the stored preferences have no tour yet, so a reload keeps what the test changed.
 */
export async function skipTour(page: Page, extra: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript((prefs) => {
    let stored: Record<string, unknown> | null = null;
    try {
      stored = JSON.parse(window.localStorage.getItem("zenith.ui") ?? "null") as Record<string, unknown> | null;
    } catch {
      stored = null;
    }
    if (stored !== null && stored["tour"] !== undefined) return;
    window.localStorage.setItem(
      "zenith.ui",
      JSON.stringify({
        ...(stored ?? {}),
        tour: { seen: true, coreDone: true, fullDone: false },
        // Full sim too, which Settings does not list (issue #207).
        features: stored?.["features"] ?? { partners: true, ledger: true, commands: true, fullSim: true },
        ...prefs,
      }),
    );
  }, extra);
}

/**
 * Answers the first-run preset card with `preset`, which applies it and starts the core tour. A spec
 * that wants the tour on a fresh profile calls this after `page.goto("/")`; a spec that seeds
 * `tour.seen` never sees the card. Full turns every switch on, so it is the one for a walk of every
 * stop.
 */
export async function choosePreset(page: Page, preset: "basic" | "essential" | "full" = "essential"): Promise<void> {
  await expect(page.getByTestId("preset-card")).toBeVisible();
  await page.getByTestId(`preset-card-${preset}`).click();
  await expect(page.getByTestId("preset-card")).toHaveCount(0);
}

/** Opens the app and loads the bundled example from the welcome screen. */
export async function loadExample(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
}

/**
 * Puts the open collect-and-score on the wide route issue #365 first gave it: round the west of the
 * hive frame wider than it has to, on RED's side of the centre line, so the optimizer has a faster
 * toOtherSide to find. The shipped route is already as fast as the optimizer gets it (issue #367).
 * The route is `packages/core/test-fixtures/wide-collect-and-score.auto.json`.
 */
export async function useWideRoute(page: Page): Promise<void> {
  const file = fileURLToPath(new URL("../../../../packages/core/test-fixtures/wide-collect-and-score.auto.json", import.meta.url));
  const wide = JSON.parse(readFileSync(file, "utf8")) as unknown;
  await page.evaluate(
    `import("/src/state/store.ts").then((m) => { m.commit(${JSON.stringify(wide)}); })`,
  );
}

/**
 * Waits for the self-hosted webfonts (Jost, IBM Plex Sans, JetBrains Mono, `styles/fonts.css`) to
 * finish loading. `font-display: swap` paints with a fallback font first, so any layout or contrast
 * measurement taken before this resolves is measuring fallback metrics, not the shipped fonts —
 * fallback metrics differ enough between platforms to tip a tight layout into scrolling.
 */
export async function waitForFonts(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
}

/**
 * Switches to another auto in the open project through the toolbar's picker. The bundled example
 * opens `collect-and-score.auto.json`, which has a marker and a deadline group with a sequence in
 * it; `first-auto.auto.json` is three steps, and `all-step-kinds.auto.json` has every step kind.
 */
export async function openAutoNamed(page: Page, fileName: string): Promise<void> {
  await page.getByTestId("toolbar-auto-name").click();
  await page.getByTestId(`open-auto-${fileName}`).click();
  await expect(page.getByTestId("toolbar-auto-name")).toContainText(fileName);
}

/** Evaluates `expr` with `s` bound to the store's state and `m` to the store module. */
export async function editor<T>(page: Page, expr: string): Promise<T> {
  return (await page.evaluate(
    `import("/src/state/store.ts").then((m) => { const s = m.getState(); return (${expr}); })`,
  )) as T;
}

/** The ids of the rows in the steps list, top to bottom. */
export const rowIds = async (page: Page): Promise<string[]> =>
  page
    .getByTestId("steps-list")
    .locator('[data-testid^="step-row-"]')
    .evaluateAll((rows) => rows.map((row) => (row.getAttribute("data-testid") ?? "").slice("step-row-".length)));

/** Clicks a step's row to select it. */
export async function selectStep(page: Page, id: string): Promise<void> {
  await page.getByTestId(`step-row-${id}`).getByRole("button").first().click();
}

/**
 * The problems panel's rows for one finding code, matched on the row's `data-code`. Filtering the
 * rows by the code as text also matches any row whose sentence or fix button contains the word, such
 * as a STRAFE_FRACTION row's "Find a faster heading" for HEADING, or a HEADING_MISSING row.
 */
export const findingRows = (page: Page, code: string): Locator =>
  page.locator(`[data-testid="finding-row"][data-code="${code}"]`);

/**
 * Opens the selected step's Advanced section (issues #239 and #431), where a command's Give up
 * after, the stay-inside box and rejoin entries and the full sim's row sit. It stays open for the
 * rest of the page's life, as the person's fold is remembered. A step with nothing rare has no
 * Advanced, such as a path with Commands off, whose time limit is in Speed: then there is nothing to
 * open, and the helper waits for the step's Notes, the section after it, to be sure.
 */
export async function openMore(page: Page): Promise<void> {
  const inspector = page.getByTestId("inspector");
  await expect(inspector.locator('section[data-fold="step.notes"]')).toBeVisible();
  const head = inspector.locator('section[data-fold="step.more"] button[aria-expanded]').first();
  if ((await head.count()) === 0) return;
  if ((await head.getAttribute("aria-expanded")) === "false") await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");
}

export interface CanvasView {
  x: number;
  y: number;
  width: number;
  height: number;
  pxPerIn: number;
  originXPx: number;
  originYPx: number;
}

/** The view the canvas publishes on its element. */
export async function canvasView(page: Page): Promise<CanvasView> {
  const canvas = page.getByTestId("field-canvas");
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("the canvas has no box");
  const attr = async (name: string): Promise<number> => Number(await canvas.getAttribute(name));
  return {
    ...box,
    pxPerIn: await attr("data-px-per-in"),
    originXPx: await attr("data-origin-x-px"),
    originYPx: await attr("data-origin-y-px"),
  };
}

/** Where a field inch sits on the page. The example field has +x right and +y up the screen. */
export async function worldToScreen(page: Page, xIn: number, yIn: number): Promise<{ x: number; y: number }> {
  const view = await canvasView(page);
  return { x: view.x + view.originXPx + view.pxPerIn * xIn, y: view.y + view.originYPx - view.pxPerIn * yIn };
}

/** Canvas-local CSS pixels to field inches. */
export function localToWorld(view: CanvasView, xPx: number, yPx: number): { xIn: number; yIn: number } {
  return { xIn: (xPx - view.originXPx) / view.pxPerIn, yIn: (view.originYPx - yPx) / view.pxPerIn };
}

/** A pointer drag from one field point to another, in several moves, with keys held throughout. */
export async function dragWorld(
  page: Page,
  from: { xIn: number; yIn: number },
  to: { xIn: number; yIn: number },
  options: { keys?: string[]; steps?: number; release?: boolean } = {},
): Promise<void> {
  const a = await worldToScreen(page, from.xIn, from.yIn);
  const b = await worldToScreen(page, to.xIn, to.yIn);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (const key of options.keys ?? []) await page.keyboard.down(key);
  const steps = options.steps ?? 8;
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
  }
  if (options.release === false) return;
  await page.mouse.up();
  for (const key of [...(options.keys ?? [])].reverse()) await page.keyboard.up(key);
}

export interface ProbePolygon {
  op: "fill" | "stroke";
  style: string;
  lineWidth: number;
  alpha: number;
  pts: Array<[number, number]>;
}

export interface ProbeFrame {
  frames: number;
  polygons: ProbePolygon[];
  /** Two-point dashed strokes: the rubber band, measure and snap guides. */
  dashes: Array<[[number, number], [number, number]]>;
  texts: string[];
}

/**
 * Records the field canvas's drawing, one frame at a time (a frame starts at the full clear the
 * live layer does first). Must be called before `page.goto`.
 */
export async function installCanvasProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Ctx = CanvasRenderingContext2D & { __pts?: Array<[number, number]>; __closed?: boolean };
    const proto = CanvasRenderingContext2D.prototype as Ctx;
    const probe = {
      frames: 0,
      polygons: [] as unknown[],
      dashes: [] as unknown[],
      texts: [] as string[],
    };
    (window as unknown as { __qaCanvas: typeof probe }).__qaCanvas = probe;
    const isField = (ctx: Ctx): boolean => ctx.canvas.getAttribute("data-testid") === "field-canvas";
    const beginPath = proto.beginPath;
    const moveTo = proto.moveTo;
    const lineTo = proto.lineTo;
    const closePath = proto.closePath;
    const fill = proto.fill;
    const stroke = proto.stroke;
    const clearRect = proto.clearRect;
    const fillText = proto.fillText;
    proto.beginPath = function (this: Ctx) {
      this.__pts = [];
      this.__closed = false;
      beginPath.call(this);
    };
    proto.moveTo = function (this: Ctx, x: number, y: number) {
      (this.__pts ??= []).push([x, y]);
      moveTo.call(this, x, y);
    };
    proto.lineTo = function (this: Ctx, x: number, y: number) {
      (this.__pts ??= []).push([x, y]);
      lineTo.call(this, x, y);
    };
    proto.closePath = function (this: Ctx) {
      this.__closed = true;
      closePath.call(this);
    };
    const record = (ctx: Ctx, op: "fill" | "stroke"): void => {
      if (isField(ctx) && op === "stroke" && ctx.__pts?.length === 2 && ctx.getLineDash().length > 0) {
        probe.dashes.push([ctx.__pts[0], ctx.__pts[1]]);
        return;
      }
      if (!isField(ctx) || ctx.__closed !== true || ctx.__pts?.length !== 4) return;
      probe.polygons.push({
        op,
        style: String(op === "fill" ? ctx.fillStyle : ctx.strokeStyle),
        lineWidth: ctx.lineWidth,
        alpha: ctx.globalAlpha,
        pts: ctx.__pts.map((p) => [p[0], p[1]]),
      });
    };
    proto.fill = function (this: Ctx, ...args: unknown[]) {
      record(this, "fill");
      (fill as (...a: unknown[]) => void).apply(this, args);
    };
    proto.stroke = function (this: Ctx, ...args: unknown[]) {
      record(this, "stroke");
      (stroke as (...a: unknown[]) => void).apply(this, args);
    };
    proto.clearRect = function (this: Ctx, x: number, y: number, w: number, h: number) {
      if (isField(this) && x === 0 && y === 0) {
        probe.frames += 1;
        probe.polygons = [];
        probe.dashes = [];
        probe.texts = [];
      }
      clearRect.call(this, x, y, w, h);
    };
    proto.fillText = function (this: Ctx, text: string, x: number, y: number, maxWidth?: number) {
      if (isField(this)) probe.texts.push(text);
      if (maxWidth === undefined) fillText.call(this, text, x, y);
      else fillText.call(this, text, x, y, maxWidth);
    };
  });
}

/** The most recent complete frame of the field canvas. */
export async function lastFrame(page: Page): Promise<ProbeFrame> {
  return page.evaluate(() => {
    const probe = (window as unknown as { __qaCanvas: ProbeFrame }).__qaCanvas;
    return { frames: probe.frames, polygons: [...probe.polygons], dashes: [...probe.dashes], texts: [...probe.texts] };
  });
}

/**
 * The canvas's latest frame once pending draws have run: the canvas only draws when something
 * changed, so this waits two animation frames rather than for a new one.
 */
export async function nextFrame(page: Page): Promise<ProbeFrame> {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)))),
  );
  return lastFrame(page);
}

const dist = (a: [number, number], b: [number, number]): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Polygons whose sides are the robot body's length and width at this scale, deduplicated. */
export function robotOutlines(
  frame: ProbeFrame,
  pxPerIn: number,
  lengthIn = 18,
  widthIn = 18,
): Array<Array<[number, number]>> {
  const found: Array<Array<[number, number]>> = [];
  for (const polygon of frame.polygons) {
    const [a, b, c] = polygon.pts as [[number, number], [number, number], [number, number]];
    const sides = [dist(a, b) / pxPerIn, dist(b, c) / pxPerIn].sort((x, y) => x - y);
    const want = [widthIn, lengthIn].sort((x, y) => x - y);
    if (Math.abs((sides[0] ?? 0) - (want[0] ?? 0)) > 0.25 || Math.abs((sides[1] ?? 0) - (want[1] ?? 0)) > 0.25) continue;
    const same = found.some((other) => polygon.pts.every((p) => other.some((q) => dist(p, q) < 0.5)));
    if (!same) found.push(polygon.pts);
  }
  return found;
}

/** The centre of a four-corner polygon, in field inches. */
export function polygonCentreIn(view: CanvasView, pts: Array<[number, number]>): { xIn: number; yIn: number } {
  const x = pts.reduce((sum, p) => sum + p[0], 0) / pts.length;
  const y = pts.reduce((sum, p) => sum + p[1], 0) / pts.length;
  return localToWorld(view, x, y);
}

/** The WCAG contrast ratio of two CSS colours the page has already resolved to rgb(). */
export function contrast(fg: string, bg: string): number {
  const parse = (colour: string): [number, number, number, number] => {
    const parts = colour.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0];
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
  };
  const lum = ([r, g, b]: [number, number, number, number]): number => {
    const channel = (value: number): number => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const f = parse(fg);
  const b = parse(bg);
  // Composite a translucent foreground over the background.
  const a = f[3];
  const mixed: [number, number, number, number] = [
    f[0] * a + b[0] * (1 - a),
    f[1] * a + b[1] * (1 - a),
    f[2] * a + b[2] * (1 - a),
    1,
  ];
  const l1 = lum(mixed);
  const l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/**
 * Marks a test as covering a bug found in QA and not yet fixed: it is expected to fail, and turns
 * red ("expected to fail, but passed") the moment the fix lands, which is the cue to delete the call.
 * The id is the row in the QA report.
 */
export function knownBug(id: string, what: string): void {
  test.fail(true, `${id}: ${what}`);
}

const EXAMPLE_DIR = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
export const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));

/**
 * Opens a copy of the bundled example project with extra autos in it, through the "pick files"
 * fallback every browser without the File System Access API uses. `autos` maps a file name to its
 * text; the first one listed is the one that opens.
 */
export async function openProjectWith(page: Page, autos: Record<string, string>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "zenith-qa-"));
  const files: Array<[string, string]> = [
    ["zenith.json", readFileSync(join(EXAMPLE_DIR, "zenith.json"), "utf8")],
    ["robot.json", readFileSync(join(EXAMPLE_DIR, "autos/robot.json"), "utf8")],
    ["biobuzz.field.json", readFileSync(join(EXAMPLE_DIR, "autos/field/biobuzz.field.json"), "utf8")],
    ["waypoints.json", readFileSync(join(EXAMPLE_DIR, "autos/waypoints.json"), "utf8")],
    ...Object.entries(autos),
  ];
  const paths = files.map(([name, text]) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  });
  await withoutFolderPickerFromTheStart(page);
  await page.goto("/");
  await page.getByTestId("canvas-open-other").click();
  await page.getByTestId("open-project-files").setInputFiles(paths);
  const first = Object.keys(autos)[0] ?? "";
  const picker = page.getByTestId(`open-auto-${first}`);
  if (!(await page.getByTestId("toolbar-auto-name").innerText()).includes(first) && (await picker.count()) > 0) {
    await picker.click();
  }
  await expect(page.getByTestId("toolbar-auto-name")).toContainText(first);
}

/**
 * Clears the status bar, lets its fade-out finish, and waits two animation frames. The bar is an
 * overlay that never moves the layout (UI_GUIDE layout rule 8), so no test needs this for
 * correctness any more; the specs that once raced the bar's 6 s timeout (the wall-snap drags and
 * the help sweep) still call it so their screenshots show no bar.
 */
export async function clearStatus(page: Page): Promise<void> {
  await editor(page, "m.clearStatus()");
  await expect(page.getByTestId("status")).toHaveCount(0);
  await expect(page.getByTestId("status-leaving")).toHaveCount(0);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** A fixture auto's text. */
export const fixture = (name: string): string => readFileSync(join(FIXTURES_DIR, name), "utf8");

/**
 * Evaluates `expr` with `c` bound to `@horizon36596/zenith-core` (the very module instance the app runs, found
 * among the page's loaded scripts), `s` to the store's state and `m` to the store module.
 */
export async function withCore<T>(page: Page, expr: string): Promise<T> {
  return (await page.evaluate(`(async () => {
    const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/packages/core/") && /index\.(js|ts)$/.test(n.split("?")[0]));
    if (url === undefined) throw new Error("@horizon36596/zenith-core is not among the page's modules");
    const c = await import(url);
    const m = await import("/src/state/store.ts");
    const s = m.getState();
    return (${expr});
  })()`)) as T;
}
