import { availableParallelism } from "node:os";
import { defineConfig, devices } from "@playwright/test";
import { betaNoticeSeen } from "./e2e/betaNotice";
import { VIEWPORT } from "./e2e/viewports";

/**
 * The editor's smoke test. Chromium only: local mode
 * needs the File System Access API, and the example project is the one path that works everywhere.
 *
 * `pnpm --filter @horizon36596/zenith-web test:e2e`, after `npx playwright install chromium` once.
 * `ZENITH_E2E_PORT` moves the dev server off 5173, so a run in a second checkout never reuses (and
 * tests) the first checkout's server.
 *
 * Spec files run in parallel, one worker each, and the tests inside a file run in order on one worker.
 * `ZENITH_E2E_WORKERS` sets the count; unset, it is half the cores, from 1 to 8 (the same rule as
 * `defaultWebWorkers` in scripts/ship-batch.mjs, which a test keeps in step). Every test gets its own
 * browser context, so storage is never shared; the one dev server is. `--workers=1` gives the old
 * serial run, which is the way to tell a test that is not parallel-safe from one that is just broken.
 *
 * The viewport is the one in e2e/viewports.ts, set after the device spread because a project's `use`
 * replaces the top-level one key by key and Desktop Chrome brings its own. A test that needs another
 * size sets it with `test.use({ viewport })` and names it in its title.
 *
 * `pnpm ship` runs the suite in two passes. It names the load-sensitive specs (SERIAL_WEB_SPECS in
 * scripts/ship-batch.mjs, globs relative to e2e/) in `ZENITH_E2E_SERIAL_SPECS`; with
 * `ZENITH_E2E_PASS=parallel` they are left out, and with `ZENITH_E2E_PASS=serial` they are the only
 * specs, run on one worker. Without `ZENITH_E2E_PASS` every spec runs.
 */
const port = Number(process.env["ZENITH_E2E_PORT"] ?? "5173");
const asked = Number(process.env["ZENITH_E2E_WORKERS"] ?? "");
const workers = Number.isInteger(asked) && asked >= 1 ? asked : Math.min(8, Math.max(1, Math.floor(availableParallelism() / 2)));
const serialSpecs = (process.env["ZENITH_E2E_SERIAL_SPECS"] ?? "").split(",").map((spec) => spec.trim()).filter((spec) => spec !== "");
const pass = process.env["ZENITH_E2E_PASS"];
const split = serialSpecs.length === 0 ? {} : pass === "parallel" ? { testIgnore: serialSpecs } : pass === "serial" ? { testMatch: serialSpecs } : {};

export default defineConfig({
  testDir: "./e2e",
  ...split,
  // Pays the dev server's cold compile once, before the first test's timeout starts.
  globalSetup: "./e2e/warm-start.ts",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers,
  reporter: process.env["CI"] === undefined ? "list" : "github",
  use: {
    baseURL: `http://localhost:${String(port)}`,
    // Every context, the page fixture's and any `browser.newContext()`, starts with the beta notice
    // dismissed for this version (e2e/betaNotice.ts); beta-notice.spec.ts turns it off.
    storageState: betaNoticeSeen(`http://localhost:${String(port)}`),
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
