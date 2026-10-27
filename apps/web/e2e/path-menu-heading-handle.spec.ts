/**
 * Issue #320: a right-click on the selected step's line where its heading arrow handle is drawn gives the
 * path's menu, not the empty-field one. "Load example" opens the starter's collect-and-score auto: with
 * driveOut selected, its start heading handle sits on its line about 7 to 14 in north of the start.
 */
import { expect, test, type Page } from "@playwright/test";
import { loadExample, selectStep, skipTour, worldToScreen } from "./qa/helpers";

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
});

async function menuLabels(page: Page, yIn: number): Promise<string[]> {
  const at = await worldToScreen(page, -12, yIn);
  await page.mouse.click(at.x, at.y, { button: "right" });
  const menu = page.getByTestId("canvas-context-menu");
  const labels = (await menu.count()) > 0 ? await menu.getByRole("menuitem").allInnerTexts() : [];
  await page.keyboard.press("Escape");
  return labels;
}

for (const yIn of [-52, -45]) {
  test(`with driveOut selected, a right-click on its line at y = ${String(yIn)} gives the path menu`, async ({ page }) => {
    await selectStep(page, "driveOut");
    const labels = await menuLabels(page, yIn);
    expect(labels.some((label) => label.startsWith("Make curve")), `menu was: ${labels.join(" | ")}`).toBe(true);
    expect(labels.some((label) => label.startsWith("Add a path to here"))).toBe(false);
  });
}
