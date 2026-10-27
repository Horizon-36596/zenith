/**
 * The desktop app's own shortcuts. The native menu owns them (apps/desktop/src/main/menu.ts
 * registers the Robot menu's accelerators, and index.ts catches F10), not the page's key handler,
 * so a key press runs its action once. They live in one table so the menu, the tooltips, the
 * palette and the shortcut sheet's Desktop group show the same keys, written the way
 * the shortcut table writes them (app/shortcuts.ts).
 *
 * Plain data with no DOM, because the desktop app's main process imports it too.
 */
export const DESKTOP_KEYS = {
  menu: "F10",
  "desktop.sim": "Ctrl F5",
  "desktop.deploy": "Ctrl Shift D",
  "desktop.git": "Ctrl Shift G",
} as const;

export type DesktopKeyId = keyof typeof DESKTOP_KEYS;
