/**
 * Shorter action tooltips, Save's hint, the empty Steps panel and the example's status line
 * (issue #247, UI_GUIDE section 9.13).
 */
import { expect, test } from "@playwright/test";
import { SHORTCUTS } from "../src/app/shortcuts";
import { loadExample, skipTour } from "./qa/helpers";

test("hovering Save shows its name and key, and one short line saying where it asks", async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
  await page.getByTestId("toolbar-run.save").hover();
  const tip = page.getByRole("tooltip");
  await expect(tip).toContainText("Save");
  await expect(tip).toContainText(SHORTCUTS.save);
  // The example is read only, so the line says where Save asks, in one sentence.
  await expect(tip.locator("span").last()).toHaveText("Read-only project: asks where to save.");
  expect(((await tip.innerText()).match(/\./g) ?? []).length).toBe(1);
});

test("the empty Steps panel says it has no steps, and the empty inspector and Problems give way", async ({ page }) => {
  await skipTour(page);
  await page.goto("/");
  const empty = page.getByTestId("steps-empty");
  await expect(empty).toBeVisible();
  // The title bar says no auto is open; the list does not say it again (UX review, S4).
  await expect(empty).toHaveText("No steps yet");
  await expect(page.getByTestId("toolbar-auto-name")).toHaveText("No auto open");
  await expect(page.getByTestId("inspector-panel")).toBeHidden();
  await expect(page.locator("[data-findings-panel]")).toBeHidden();
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("inspector-panel")).toBeVisible();
  await expect(page.locator("[data-findings-panel]")).toBeVisible();
});

test("loading the example reads \"Example loaded, read only.\" with the reason beside it", async ({ page }) => {
  await skipTour(page);
  await page.goto("/");
  await page.getByTestId("canvas-load-example").click();
  const status = page.getByTestId("status");
  await expect(status).toContainText("Example loaded, read only.");
  await expect(page.getByTestId("status-hint")).toHaveText("Save makes your own copy.");
});
