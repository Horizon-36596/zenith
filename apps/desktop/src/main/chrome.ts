/**
 * The desktop window's own chrome, from apps/web/UI_GUIDE.md sections 3, 4.1 and 9.1: the web
 * build's title bar becomes the window's title bar, with Windows' own controls drawn over it by
 * Electron's `titleBarOverlay`, and a 1 px Horizon gradient hairline runs round the whole window
 * edge. The web build draws neither (the browser is its frame), so the desktop app adds them.
 *
 * Colours are the tokens in apps/web/src/styles/tokens.css. The title bar stays on the night ground
 * in both themes (UI_GUIDE section 4), so the overlay's colours are fixed.
 */

/** `--bg-chrome`, `--text-hi` (dark theme) and `--titlebar-h`. */
export const TITLE_BAR = { color: "#17061d", symbolColor: "#faf6fb", height: 36 } as const;

/**
 * The title bar the shell renders (`TitleBar` in apps/web/src/panels/Toolbar.tsx). Scoped under
 * `:root` so these rules outrank the bar's own single-class styles, which set its padding too.
 */
const BAR = ":root [data-titlebar]";

/**
 * Inserted into the page with `webContents.insertCSS`, so it needs no change to the web build and no
 * inline style under the Content-Security-Policy. It only uses tokens the web build defines, with
 * the literal values as fallbacks.
 */
export const DESKTOP_CSS = `
html::after {
  content: "";
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  pointer-events: none;
  padding: var(--frame-edge-w, 1px);
  background: var(--brand-gradient, linear-gradient(90deg, #ffcb5c 0%, #f86a43 55%, #b13848 100%));
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
}
${BAR} {
  -webkit-app-region: drag;
  -webkit-user-select: none;
  user-select: none;
  /* The window controls, then the menu button (desktopPanel.tsx), then the usual gutter. */
  padding-right: calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + 40px + var(--space-4, 16px));
}
${BAR} :is(button, a, input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])) {
  -webkit-app-region: no-drag;
}
`;
