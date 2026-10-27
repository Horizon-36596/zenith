/**
 * Remembers the main window's size, position and maximised state between runs, and puts it back
 * only where it is still visible: a window saved on a monitor that has since been unplugged comes
 * back centred on the primary one instead of off screen. Whatever it opens with is fitted inside one
 * display's work area, so the title bar and its window controls are always on screen, even on a
 * 1366 by 768 laptop or a 1080p one at 150% scaling (sweep D5).
 */
import type { BrowserWindow, Rectangle } from "electron";
import type { SettingsStore, WindowBounds } from "./settings.js";

export const DEFAULT_SIZE = { width: 1440, height: 900 };
/**
 * The smallest window the app is laid out for. The sweep checked the layout at 1024 by 600, and both
 * numbers sit inside the smallest work area Zenith supports, a 1080p screen at 150% (about 1280 by
 * 672 once the taskbar is taken off).
 */
export const MIN_SIZE = { width: 1024, height: 600 };

/** True when at least a 120 × 80 px corner of `bounds` lies on one of `displays`. */
export function isVisible(bounds: Rectangle, displays: readonly Rectangle[]): boolean {
  return displays.some((area) => {
    const w = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
    const h = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
    return w >= 120 && h >= 80;
  });
}

function overlap(a: Rectangle, b: Rectangle): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** The work area `bounds` overlaps most, as `screen.getDisplayMatching` picks it. */
export function matchingArea(bounds: Rectangle, displays: readonly Rectangle[], primary: Rectangle): Rectangle {
  let best = primary;
  let most = overlap(bounds, primary);
  for (const area of displays) {
    const shared = overlap(bounds, area);
    if (shared > most) {
      best = area;
      most = shared;
    }
  }
  return best;
}

/** The minimum window size on `area`: `MIN_SIZE`, but never larger than the area itself. */
export function minSizeFor(area: Rectangle): { width: number; height: number } {
  return { width: Math.min(MIN_SIZE.width, area.width), height: Math.min(MIN_SIZE.height, area.height) };
}

/** `bounds` shrunk to fit inside `area` (never below the minimum) and moved until all of it is on it. */
export function fitToArea(bounds: Rectangle, area: Rectangle): Rectangle {
  const min = minSizeFor(area);
  const width = Math.min(area.width, Math.max(min.width, Math.round(bounds.width)));
  const height = Math.min(area.height, Math.max(min.height, Math.round(bounds.height)));
  const x = Math.min(Math.max(Math.round(bounds.x), area.x), area.x + area.width - width);
  const y = Math.min(Math.max(Math.round(bounds.y), area.y), area.y + area.height - height);
  return { x, y, width, height };
}

/**
 * The bounds to open with. Saved bounds that are still on a screen are fitted to the work area they
 * overlap most, so a window saved on a bigger monitor or at a lower scaling comes back whole. With
 * nothing saved, or saved bounds that are off every screen, the default size is fitted to the
 * primary work area and centred on it. `minSize` is what the window's minimum should be there.
 */
export function initialBounds(
  saved: WindowBounds | null,
  displays: readonly Rectangle[],
  primary: Rectangle = displays[0] ?? { x: 0, y: 0, ...DEFAULT_SIZE },
): { bounds: Rectangle; maximized: boolean; minSize: { width: number; height: number } } {
  if (saved !== null && isVisible(saved, displays)) {
    const rect = { x: saved.x, y: saved.y, width: saved.width, height: saved.height };
    const area = matchingArea(rect, displays, primary);
    return { bounds: fitToArea(rect, area), maximized: saved.maximized, minSize: minSizeFor(area) };
  }
  const width = Math.min(DEFAULT_SIZE.width, primary.width);
  const height = Math.min(DEFAULT_SIZE.height, primary.height);
  const centred = {
    x: primary.x + Math.floor((primary.width - width) / 2),
    y: primary.y + Math.floor((primary.height - height) / 2),
    width,
    height,
  };
  return { bounds: fitToArea(centred, primary), maximized: false, minSize: minSizeFor(primary) };
}

/** Saves the window's normal (unmaximised) bounds whenever it moves or resizes, debounced. */
export function trackBounds(window: BrowserWindow, settings: SettingsStore): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    if (window.isDestroyed() || window.isMinimized()) return;
    const bounds = window.getNormalBounds();
    settings.update({ bounds: { ...bounds, maximized: window.isMaximized() } });
  };
  const soon = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(save, 400);
  };
  window.on("resize", soon);
  window.on("move", soon);
  window.on("maximize", soon);
  window.on("unmaximize", soon);
  window.on("close", () => {
    if (timer !== null) clearTimeout(timer);
    save();
  });
}
