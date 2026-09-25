import { defineConfig, devices } from "@playwright/test";
import { VIEWPORT } from "./e2e/viewports";

/**
 * The editor's smoke test. Chromium only: local mode
 * needs the File System Access API, and the example project is the one path that works everywhere.
 *
 * `pnpm --filter @horizon36596/zenith-web test:e2e`, after `npx playwright install chromium` once.
 * `ZENITH_E2E_PORT` moves the dev server off 5173, so a run in a second checkout never reuses (and
 * tests) the first checkout's server.
 *
 * The viewport is the one in e2e/viewports.ts, set after the device spread because a project's `use`
 * replaces the top-level one key by key and Desktop Chrome brings its own. A test that needs another
 * size sets it with `test.use({ viewport })` and names it in its title.
 */
const port = Number(process.env["ZENITH_E2E_PORT"] ?? "5173");

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env["CI"] === undefined ? "list" : "github",
  use: {
    baseURL: `http://localhost:${String(port)}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: VIEWPORT } }],
  webServer: {
    command: `pnpm exec vite --port ${String(port)} --strictPort`,
    url: `http://localhost:${String(port)}`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
