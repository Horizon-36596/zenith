/**
 * QA 19, the editor items of the pre-beta UX sweep of 2026-09-28,
 * through the real app:
 *
 * - A11: New auto starts a blank, unsaved auto in the open project, from the palette and from the
 *   open-project dialog;
 * - A12: switching a tangent path to Constant or Linear keeps the heading the path has now;
 * - A14: the Ledger's end rows say what each holder holds;
 * - A17: the Partners panel calls a partner's file a share file;
 * - A20: an auto written in an older format says, on opening, that saving writes the new one.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { editor, loadExample, openProjectWith, selectStep, shot, skipTour } from "./helpers";

test.beforeEach(async ({ page }) => {
  await skipTour(page);
});

async function pickMode(page: Page, mode: string): Promise<void> {
  await page.getByTestId("inspector-heading-mode").click();
  await page.getByTestId(`inspector-heading-mode-option-${mode}`).click();
  await expect(page.getByTestId("inspector-heading-mode")).toHaveAttribute("data-value", mode);
}

test("A11: New auto, found by searching the palette for new, opens a blank unsaved auto", async ({ page }) => {
  await loadExample(page);
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("new");
  const item = page.getByTestId("palette-item-project.newAuto");
  await expect(item).toBeVisible();
  await item.click();

  await expect(page.getByTestId("toolbar-auto-name")).toContainText("new-auto.auto.json");
  await expect(page.getByTestId("toolbar-auto-name").getByLabel("Unsaved changes")).toBeVisible();
  await expect(page.getByTestId("status")).toContainText("Started new-auto.auto.json");
  // The example is read only, so the line says Save asks where to put it.
  await expect(page.getByTestId("status")).toContainText("Save asks where to put it");
  expect(await editor<number>(page, "s.auto.steps.length")).toBeGreaterThan(0);
  await shot(page, "19-new-auto");
});

test("A11: the open-project dialog has New auto too", async ({ page }) => {
  await loadExample(page);
  await page.keyboard.press("Control+o");
  await page.getByTestId("open-project-new-auto").click();
  await expect(page.getByTestId("open-project")).toHaveCount(0);
  await expect(page.getByTestId("toolbar-auto-name")).toContainText("new-auto.auto.json");
});

test("A12: Constant and Linear start from the heading a tangent path has now, not 0", async ({ page }) => {
  await loadExample(page);
  // driveOut runs straight north from start to scoreSouth with a tangent heading, so it faces 90°.
  await selectStep(page, "driveOut");
  await expect(page.getByTestId("inspector-heading-mode")).toHaveAttribute("data-value", "tangent");
  await pickMode(page, "constant");
  await expect(page.getByTestId("inspector-heading-constant")).toHaveValue(/^90(\.0)?$/);

  await page.getByTestId("field-canvas").focus();
  await page.keyboard.press("Control+z");
  await expect(page.getByTestId("inspector-heading-mode")).toHaveAttribute("data-value", "tangent");
  await pickMode(page, "linear");
  await expect(page.getByTestId("inspector-heading-from")).toHaveValue(/^90(\.0)?$/);
  await expect(page.getByTestId("inspector-heading-to")).toHaveValue(/^90(\.0)?$/);
});

test("A14: the Ledger's end rows say what each holder holds", async ({ page }) => {
  await loadExample(page);
  await page.getByTestId("ledger-panel-fold").click();
  const robotRow = page.getByTestId("ledger-end-robot");
  await expect(robotRow).toBeVisible();
  await expect(robotRow).toContainText(/empty|\d/);
  await expect(robotRow).toHaveAttribute("title", /robot: (empty|\d)/);
});

test("A17: the Partners panel calls a partner's file a share file", async ({ page }) => {
  await loadExample(page);
  await page.getByTestId("partners-panel-fold").click();
  const body = page.getByTestId("partners-body");
  await expect(body).toContainText("share file");
  await expect(body).not.toContainText("projection to see");
  await expect(page.getByTestId("partners-load")).toHaveText("Load share file…");
});

test("A20: an auto in an older format says that saving writes the new format", async ({ page }) => {
  const old = readFileSync(
    fileURLToPath(new URL("../../../../packages/schema/fixtures/migrate/auto.v2.json", import.meta.url)),
    "utf8",
  );
  await openProjectWith(page, { "old.auto.json": old });
  const status = page.getByTestId("status");
  await expect(status).toContainText("old.auto.json");
  await expect(status).toContainText("auto format 2");
  await expect(status).toContainText("Saving writes it in format 4");
  await shot(page, "19-older-format");
});
