/**
 * The keyboard on the Inspector's and Settings' own fields (issue #403).
 *
 * A choice opened from the keyboard puts focus on its chosen option, so the arrows walk the options
 * and Enter picks one. The list is hidden until it is placed, and the browser refuses focus to a
 * hidden element, so focus once stayed on the button and the options were out of the keyboard's reach.
 *
 * An arrow pressed in a number field while it holds typed text steps from that text: the press writes
 * once and the field shows what it wrote. It once stepped from the stored value while the typed text
 * stayed on screen, and the blur then wrote the typed text over the step.
 */
import { expect, test } from "@playwright/test";
import { editor, loadExample, selectStep, skipTour } from "./qa/helpers";

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
});

test("a choice opened with ArrowDown focuses its chosen option, and the arrows and Enter pick another", async ({ page }) => {
  await selectStep(page, "driveOut");
  const mode = page.getByTestId("inspector-heading-mode");
  await expect(mode).toHaveAttribute("data-value", "tangent");
  await mode.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("inspector-heading-mode-list")).toBeVisible();
  await expect(page.getByTestId("inspector-heading-mode-option-tangent")).toBeFocused();
  const focusedValue = () =>
    page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? "");
  await page.keyboard.press("ArrowDown");
  const picked = await focusedValue();
  expect(picked).toMatch(/^inspector-heading-mode-option-/);
  expect(picked).not.toBe("inspector-heading-mode-option-tangent");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("inspector-heading-mode-list")).toHaveCount(0);
  await expect(mode).toHaveAttribute("data-value", picked.slice("inspector-heading-mode-option-".length));
  await expect(mode).toBeFocused();
});

test("an arrow in a number field that holds typed text steps from the typed number, as one write", async ({ page }) => {
  await page.getByTestId("toolbar-settings").click();
  await page.getByTestId("settings-nav-editor").click();
  const box = page.getByTestId("settings-editing-nudgeIn");
  await expect(box).toHaveValue("0.50");
  await box.fill("3");
  await box.press("ArrowUp");
  const stepped = await editor<number>(page, "s.prefs.nudgeIn");
  expect(stepped).toBeGreaterThan(3);
  expect(stepped).toBeLessThanOrEqual(4);
  await expect(box).toHaveValue(stepped.toFixed(2));
  // The blur that follows writes nothing more: the field already holds what it shows.
  await box.blur();
  await expect.poll(() => editor<number>(page, "s.prefs.nudgeIn")).toBe(stepped);
  await expect(box).toHaveValue(stepped.toFixed(2));
});
