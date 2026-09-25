/**
 * Remembers the main window's size, position and maximised state between runs, and puts it back
 * only where it is still visible: a window saved on a monitor that has since been unplugged comes
 * back centred on the primary one instead of off screen.
 */
import type { BrowserWindow, Rectangle } from "electron";
import type { SettingsStore, WindowBounds } from "./settings.js";

export const DEFAULT_SIZE = { width: 1440, height: 900 };
export const MIN_SIZE = { width: 1024, height: 680 };

/** True when at least a 120 × 80 px corner of `bounds` lies on one of `displays`. */
export function isVisible(bounds: Rectangle, displays: readonly Rectangle[]): boolean {
  return displays.some((area) => {
    const w = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
    const h = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
    return w >= 120 && h >= 80;
  });
}

/** The bounds to open with: the saved ones when they are still on a screen, else the default size. */
export function initialBounds(
  saved: WindowBounds | null,
  displays: readonly Rectangle[],
): { bounds: Partial<Rectangle> & { width: number; height: number }; maximized: boolean } {
  if (saved !== null && isVisible(saved, displays)) {
    return {
      bounds: {
        x: saved.x,
        y: saved.y,
        width: Math.max(MIN_SIZE.width, saved.width),
        height: Math.max(MIN_SIZE.height, saved.height),
      },
      maximized: saved.maximized,
    };
  }
  return { bounds: { ...DEFAULT_SIZE }, maximized: false };
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
