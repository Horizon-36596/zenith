/**
 * The desktop window's own chrome, from apps/web/UI_GUIDE.md sections 3, 4.1 and 9.1: the web
 * build's title bar becomes the window's title bar, with Windows' own controls drawn over it by
 * Electron's `titleBarOverlay`. The web build has no title bar of its own to drag (the browser is its
 * frame), so the desktop app adds the drag region here. The window has no gradient edge: the owner
 * ruled it out.
 *
 * Colours are the tokens in apps/web/src/styles/tokens.css. The title bar stays on the night ground
 * in both themes (UI_GUIDE section 4), so the overlay's colours are fixed.
 */

/** `--bg-chrome`, `--text-hi` (dark theme) and `--titlebar-h`. */
export const TITLE_BAR = { color: "#17061d", symbolColor: "#faf6fb", height: 36 } as const;

/**
 * The title bar's menu button (desktopPanel.tsx): its width, and the gap between it and the window
 * controls. Emitted below as `--desktop-menu-w` and `--desktop-menu-inset`, which the button and the
 * bar's padding both read, so the space the bar keeps for it is always the button's own size.
 */
export const MENU_BUTTON = { width: 36, inset: 4 } as const;

/**
 * The title bar the shell renders (`TitleBar` in apps/web/src/panels/Toolbar.tsx). Scoped under
 * `:root` so these rules outrank the bar's own single-class styles, which set its padding too.
 */
const BAR = ":root [data-titlebar]";

/**
 * Inserted into the page with `webContents.insertCSS`, so it needs no change to the web build and no
 * inline style under the Content-Security-Policy. It only uses tokens the web build defines, with
 * the literal values as fallbacks.
 *
 * Page zoom (Ctrl+- and Ctrl+=) scales the page but not the window controls, which keep their size
 * in device pixels. Chromium reports the controls' area in CSS pixels at the
 * current zoom, through the `titlebar-area-*` environment variables, and updates them on every zoom
 * change, so everything here is measured from them rather than from a fixed number: the bar is never
 * shorter than the controls (zoomed out, they would otherwise hang over the toolbar below it), and
 * its right padding is always the controls' width. Zoomed in, the controls are shorter than the bar
 * and the bar keeps its own height. Outside the desktop app the variables are undefined and the
 * fallbacks leave the web build's sizes alone.
 */
export const DESKTOP_CSS = `
html:root:root {
  --titlebar-h: max(${String(TITLE_BAR.height)}px, env(titlebar-area-height, 0px));
  --desktop-menu-w: ${String(MENU_BUTTON.width)}px;
  --desktop-menu-inset: ${String(MENU_BUTTON.inset)}px;
}
${BAR} {
  -webkit-app-region: drag;
  -webkit-user-select: none;
  user-select: none;
  /* The window controls, then the menu button (desktopPanel.tsx), then the usual gutter. */
  padding-right: calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + var(--desktop-menu-inset) + var(--desktop-menu-w) + var(--space-4, 16px));
}
${BAR} :is(button, a, input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])) {
  -webkit-app-region: no-drag;
}
`;
