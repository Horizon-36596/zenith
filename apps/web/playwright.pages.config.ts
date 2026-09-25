import { defineConfig, devices } from "@playwright/test";
import { VIEWPORT } from "./e2e/viewports";

/**
 * The public web build's smoke: the app built with base `/zenith/app/` (the path GitHub Pages serves it
 * under) and served from that subpath only, by `e2e-pages/serve.mjs`. Headless Chromium.
 *
 * `pnpm --filter ./apps/web test:e2e:pages`, after `pnpm build` at the root.
 *
 * The viewport is the one in e2e/viewports.ts, set after the device spread as in playwright.config.ts.
 */
export default defineConfig({
  testDir: "./e2e-pages",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env["CI"] === undefined ? "list" : "github",
  use: {
    baseURL: "http://127.0.0.1:4178",
    headless: true,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], headless: true, viewport: VIEWPORT } },
  ],
  webServer: {
    command: "node e2e-pages/serve.mjs 4178",
    url: "http://127.0.0.1:4178/zenith/app/",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
