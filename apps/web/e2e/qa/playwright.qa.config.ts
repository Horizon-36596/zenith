import { defineConfig, devices } from "@playwright/test";
import { VIEWPORT } from "../viewports";

/**
 * The QA suite: every editor behaviour site/docs/editor.md describes, as a newcomer and a power user
 * would meet it. Headless Chromium only, against its own dev server so it never shares the
 * editor's hot-reloading one on 5173.
 *
 * `pnpm --filter @horizon36596/zenith-web exec playwright test -c e2e/qa/playwright.qa.config.ts`
 *
 * Screenshots land in `ZENITH_QA_SHOTS` (default `test-results/qa-shots`).
 *
 * The specs read the editor's store and the canvas's drawing through the Vite dev server's module
 * graph (`helpers.ts`), so they need the dev server, not a static preview.
 *
 * The viewport is the one in e2e/viewports.ts, the same one playwright.config.ts gives these specs.
 */
const port = Number(process.env["ZENITH_QA_PORT"] ?? "5180");

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  outputDir: "../../test-results/qa",
  reporter: process.env["CI"] === undefined ? "list" : "github",
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        headless: true,
        baseURL: `http://localhost:${String(port)}`,
        viewport: VIEWPORT,
        trace: "retain-on-failure",
      },
    },
  ],
  webServer: {
    command: `pnpm exec vite --port ${String(port)} --strictPort`,
    cwd: "../..",
    url: `http://localhost:${String(port)}`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
