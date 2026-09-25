/**
 * The window sizes the e2e suites use, in one place.
 *
 * `VIEWPORT` is the size every test runs at unless it sets another with `test.use({ viewport })` or
 * `page.setViewportSize`. Every Playwright config for the web app sets it after the device spread
 * (a project's `use` replaces the top-level one key by key, and Desktop Chrome brings its own), and
 * apps/web/test/playwright-configs.test.ts fails if one does not. It is the smaller of the two sizes
 * the layout is designed for, so a layout that fits here fits on the larger screen too.
 *
 * `LAYOUT_SIZES` are the two sizes the layout checks (the visual pass, the tour, the shortcut sheet)
 * run at on purpose, each named in the test's title.
 */
export const VIEWPORT = { width: 1280, height: 720 } as const;

export const LARGE_VIEWPORT = { width: 1440, height: 900 } as const;

export const LAYOUT_SIZES = [LARGE_VIEWPORT, VIEWPORT] as const;
