/**
 * Optimize path in the built app (issue #434), the way the deployed beta runs it: a production build,
 * served under /zenith/app/, with the optimizer in its own module worker chunk. On the example's
 * first-auto, the toolbar's Optimize runs on park in that worker and ends on its own result, not
 * at the 5 s safety stop: with the old budget of 750 evaluations a typical step took 7 to 9 s and
 * nearly every run in the editor ended "Stopped early". Apply then writes the route, and the route
 * it writes adds no note that its own poses carry no provenance.
 */
import { expect, test } from "@playwright/test";

const BASE = "/zenith/app/";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem(
        "zenith.ui",
        JSON.stringify({ version: 1, tour: { seen: true, coreDone: true, fullDone: false }, features: { partners: false, ledger: false, commands: true, optimizer: true, fullSim: false } }),
      );
    }
  });
});

test("Optimize path runs in the built worker, ends on its own result and applies a route that adds no provenance note", async ({ page }) => {
  const workers: string[] = [];
  page.on("worker", (worker) => workers.push(new URL(worker.url()).pathname));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto(BASE);
  await page.getByTestId("canvas-load-example").click();
  await page.getByTestId("toolbar-auto-name").click();
  await page.getByTestId("open-auto-first-auto.auto.json").click();
  await expect(page.getByTestId("toolbar-auto-name")).toContainText("first-auto.auto.json");
  await page.getByTestId("step-row-park").click();

  await page.getByTestId("toolbar-path.optimize").click();
  const card = page.getByTestId("optimize-card");
  await expect(card).toHaveAttribute("data-phase", "running");
  await expect(card).toHaveAttribute("data-phase", "result", { timeout: 15_000 });
  // Its own result: the safety stop did not end it, so there is no Search longer.
  await expect(card).toHaveAttribute("data-status", "improved");
  await expect(page.getByTestId("optimize-continue")).toHaveCount(0);
  await expect(page.getByTestId("optimize-stopped")).toHaveCount(0);
  await expect(page.getByTestId("optimize-status")).toContainText("faster in the instant sim");
  // The route's own poses are labelled, so it adds no "where did this come from?" note.
  await expect(page.getByTestId("optimize-added-item").filter({ hasText: "where did this come from" })).toHaveCount(0);

  await page.getByTestId("optimize-apply").click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("status")).toContainText("Optimized park:");
  await expect(page.locator('[data-testid="finding-row"][data-code="PROVENANCE"]')).toHaveCount(0);

  // It ran in the build's own worker chunk, under the base path.
  expect(workers.some((path) => path.startsWith(`${BASE}assets/worker-`) && path.endsWith(".js"))).toBe(true);
  expect(errors).toEqual([]);
});
