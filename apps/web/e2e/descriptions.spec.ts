/**
 * Issue #238: the Descriptions option and its one-time hint (UI_GUIDE section 9.13).
 *
 * - Settings, Editor, Appearance, Descriptions switches between Labels only and With descriptions
 *   at once, with no reload: the Settings row's own brief and the Inspector's described rows follow.
 * - Labels only is the default (decision desc-default), and the hint stays the same in both modes.
 * - The empty Inspector has no one-time hint since issue #409.
 */
import { expect, test, type Page } from "@playwright/test";
import { editor, loadExample, selectStep, skipTour } from "./qa/helpers";

const tooltips = (page: Page) => page.locator('[role="tooltip"]');

test("the Settings control switches descriptions live, without a reload", async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
  await selectStep(page, "driveOut");
  const briefs = page.getByTestId("inspector").getByTestId("row-brief");
  await expect(page.getByTestId("inspector-estimate")).toBeVisible();
  // Labels only by default: no brief under any label.
  await expect(briefs).toHaveCount(0);

  await page.getByTestId("toolbar-settings").click();
  await page.getByTestId("settings-nav-editor").click();
  const row = page.getByTestId("settings-descriptions");
  await expect(page.getByTestId("settings-descriptions-choice-compact")).toHaveAttribute("aria-pressed", "true");
  await expect(row.getByTestId("row-brief")).toHaveCount(0);

  await page.getByTestId("settings-descriptions-choice-full").click();
  await expect(page.getByTestId("settings-descriptions-choice-full")).toHaveAttribute("aria-pressed", "true");
  await expect(row.getByTestId("row-brief")).toHaveText("A short line under each label, as here");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-section-editor")).toHaveCount(0);

  // The Inspector follows at once.
  await expect(briefs.first()).toHaveText("How long the plan expects this step to take");
  const brief = await briefs.first().boundingBox();
  expect(brief?.height ?? 0, "the brief is one line").toBeLessThan(24);
  // The hint is the brief and the more in this mode too.
  await page.getByTestId("inspector-estimate").hover();
  await expect(tooltips(page)).toContainText("How long the plan expects this step to take. 'at most' means");

  // And back again from the palette's action.
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Descriptions");
  await page.getByTestId("palette-item-view.descriptions").click();
  await expect(briefs).toHaveCount(0);
});

/** Issue #409 (CV-34, S33): the Routine view no longer carries the one-time hint, in either mode. */
test("the Routine view shows no one-time hint, on a first session or after a step", async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
  await expect(page.getByTestId("inspector-routine-head")).toBeVisible();
  await expect(page.getByTestId("descriptions-hint")).toHaveCount(0);
  await selectStep(page, "driveOut");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("inspector-routine-head")).toBeVisible();
  await expect(page.getByTestId("descriptions-hint")).toHaveCount(0);
  await editor(page, `m.setPrefs({ descriptions: "full" })`);
  await expect(page.getByTestId("descriptions-hint")).toHaveCount(0);
});
