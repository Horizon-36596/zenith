import { defineConfig } from "@playwright/test";

/**
 * The desktop smoke: Playwright drives the real Electron app (`_electron.launch`) against the built
 * `dist/` (run `pnpm --filter @horizon36596/zenith-desktop build` first). It opens a window, so run it when a
 * window appearing on screen is fine.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env["CI"] === undefined ? "list" : "github",
  use: { trace: "retain-on-failure" },
});
