/**
 * The window controls never cover Zenith's own controls, at any page zoom.
 * Windows draws its minimise, maximise and close buttons over the title bar at a fixed size in
 * device pixels, while Ctrl+- and Ctrl+= scale the page. Zoomed out, the buttons once hung over the
 * toolbar's right end. At each zoom factor from 50 % to 200 % this reads the area Chromium leaves for
 * the page (`navigator.windowControlsOverlay`, in CSS pixels at that zoom) and checks every button in
 * the title bar and the toolbar against the buttons' corner: the rightmost title bar control ends left
 * of it, and nothing in the toolbar reaches into it.
 *
 * Windowless, as every desktop test is (ZENITH_HEADLESS=1). The page's own capture does not include
 * the native buttons, so the screenshots outline where Windows draws them.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { seedFirstRunDone } from "./firstRunDone";

const pkg = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const require = createRequire(import.meta.url);

let app: ElectronApplication;
let page: Page;
let profile = "";
let pid: number | undefined;

test.beforeAll(async () => {
  profile = mkdtempSync(join(tmpdir(), "zenith-e2e-zoom-"));
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
  await expect(page.getByTestId("toolbar-auto-name")).toContainText(".auto.json");
});

test.afterAll(async () => {
  const child = app?.process();
  const exited = new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    setTimeout(resolve, 10_000);
  });
  await app?.evaluate(({ app: electronApp }) => {
    electronApp.exit(0);
  }).catch(() => undefined);
  // Wait for the process to go, or the profile is still locked when it is removed below.
  await exited;
  if (pid !== undefined && process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      // Already gone, which is the usual case after exit().
    }
  }
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Layout {
  /** Where the window controls are, in CSS pixels: the title bar's corner the page is not given. */
  controls: Box;
  titleBar: Box;
  menuButton: Box;
  /** Every visible button in the title bar and the toolbar, by its test id or label. */
  buttons: Array<{ name: string } & Box>;
}

/** From 50 % to 200 %, the range Ctrl+- and Ctrl+= are checked over. */
const FACTORS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

async function zoomTo(factor: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, f) => {
    BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(f);
  }, factor);
  // Wait until the page has laid out at the new factor: its width in CSS pixels is the window's
  // over the zoom.
  const windowWidth = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getContentBounds().width ?? 0);
  await expect
    .poll(async () => {
      const width = await page.evaluate(() => (globalThis as unknown as { innerWidth: number }).innerWidth);
      return Math.abs(width - windowWidth / factor);
    })
    .toBeLessThan(2);
}

async function layout(): Promise<Layout> {
  return page.evaluate(() => {
    // The page's own window; this project's TypeScript has no DOM library.
    interface Rect {
      left: number;
      top: number;
      right: number;
      bottom: number;
      width: number;
      height: number;
      x: number;
      y: number;
    }
    interface El {
      getBoundingClientRect(): Rect;
      getAttribute(name: string): string | null;
    }
    const view = globalThis as unknown as {
      innerWidth: number;
      document: { querySelector(selector: string): El | null; querySelectorAll(selector: string): El[] };
      navigator: { windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect(): Rect } };
    };
    const overlay = view.navigator.windowControlsOverlay;
    if (overlay === undefined || !overlay.visible) throw new Error("The window has no controls overlay.");
    const area = overlay.getTitlebarAreaRect();
    const box = (element: El | null): Box => {
      if (element === null) throw new Error("An element the test reads is missing.");
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    };
    const buttons = [
      ...view.document.querySelectorAll("[data-titlebar] button, [data-testid='toolbar'] button"),
      view.document.querySelector("[data-testid='desktop-menu-button']"),
    ]
      .filter((element): element is El => element !== null)
      .map((element) => ({
        name: element.getAttribute("data-testid") ?? element.getAttribute("aria-label") ?? "a button",
        ...box(element),
      }))
      .filter((button) => button.right > button.left && button.bottom > button.top);
    return {
      controls: { left: area.x + area.width, top: area.y, right: view.innerWidth, bottom: area.y + area.height },
      titleBar: box(view.document.querySelector("[data-titlebar]")),
      menuButton: box(view.document.querySelector("[data-testid='desktop-menu-button']")),
      buttons,
    };
  });
}

/** Saves the page's own capture with the window controls' corner outlined, since it cannot show them. */
async function capture(name: string, controls: Box): Promise<void> {
  await page.evaluate((corner) => {
    const view = globalThis as unknown as {
      document: { createElement(tag: string): { id: string; style: { cssText: string } }; body: { append(node: unknown): void } };
    };
    const marker = view.document.createElement("div");
    marker.id = "e2e-window-controls";
    marker.style.cssText = `position:fixed;z-index:2147483647;pointer-events:none;left:${String(corner.left)}px;top:${String(corner.top)}px;width:${String(corner.right - corner.left)}px;height:${String(corner.bottom - corner.top)}px;outline:2px dashed #ffcb5c;outline-offset:-2px;background:rgb(255 203 92 / 18%)`;
    view.document.body.append(marker);
  }, controls);
  // The right end of the title bar and the toolbar, in window pixels. A window that is never shown
  // can hand back its last frame, from before the zoom, so it is told to repaint and captured twice.
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win === undefined) return "";
    const { width } = win.getContentBounds();
    const rect = { x: Math.max(0, width - 720), y: 0, width: Math.min(720, width), height: 200 };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 400));
    win.webContents.invalidate();
    await settle();
    await win.webContents.capturePage(rect);
    await settle();
    return (await win.webContents.capturePage(rect)).toPNG().toString("base64");
  });
  await page.evaluate(() => {
    const view = globalThis as unknown as { document: { getElementById(id: string): { remove(): void } | null } };
    view.document.getElementById("e2e-window-controls")?.remove();
  });
  const dir = join(pkg, "test-results", "titlebar-zoom");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), Buffer.from(png, "base64"));
}

const overlaps = (a: Box, b: Box): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

for (const factor of FACTORS) {
  test(`at ${String(Math.round(factor * 100))} % zoom the window controls cover none of Zenith's controls`, async () => {
    await zoomTo(factor);
    const { controls, titleBar, menuButton, buttons } = await layout();

    // The corner is really there, and it is the window controls' fixed size scaled by the zoom.
    expect(controls.right - controls.left).toBeGreaterThan(0);
    expect(controls.bottom).toBeGreaterThan(0);

    // The title bar is never shorter than the controls, so the toolbar starts below them.
    expect(titleBar.bottom).toBeGreaterThanOrEqual(controls.bottom - 0.5);
    // The rightmost title bar control, the menu button, ends left of them, and not far left.
    expect(menuButton.right).toBeLessThanOrEqual(controls.left + 0.5);
    expect(controls.left - menuButton.right).toBeLessThan(16);

    expect(buttons.length).toBeGreaterThan(5);
    const covered = buttons.filter((button) => overlaps(button, controls)).map((button) => button.name);
    expect(covered).toEqual([]);

    if (factor === 0.5 || factor === 1 || factor === 1.75) {
      await capture(`titlebar-zoom-${String(Math.round(factor * 100))}.png`, controls);
    }
  });
}

test("back at 100 % the title bar is its usual 36 px", async () => {
  await zoomTo(1);
  const { titleBar } = await layout();
  // On a display scaled to about 195 % the layout rounds to device pixels, so the height comes back
  // as 35.9936 rather than 36. A tolerance of 0.05 px still fails for a bar of a really different height.
  expect(titleBar.bottom - titleBar.top).toBeCloseTo(36, 1);
});
