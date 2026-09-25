/**
 * The tooltip rules the Insert menu broke (UI_GUIDE section 9.4): focus opens a tooltip only when it
 * came from the keyboard, so a menu that focuses its first item as a click opens it pops nothing,
 * and at most one tooltip is ever on screen, because opening one closes the one before it.
 */
import { expect, test, type Page } from "@playwright/test";
import { loadExample, skipTour, waitForFonts } from "./qa/helpers";

const tooltips = (page: Page) => page.locator('[role="tooltip"]');

/** The most tooltips seen on screen at once over `ms`, sampled every animation frame. */
async function mostAtOnce(page: Page, ms: number): Promise<number> {
  return page.evaluate(
    (duration) =>
      new Promise<number>((resolve) => {
        let most = 0;
        const end = performance.now() + duration;
        const tick = () => {
          most = Math.max(most, document.querySelectorAll('[role="tooltip"]').length);
          if (performance.now() < end) requestAnimationFrame(tick);
          else resolve(most);
        };
        tick();
      }),
    ms,
  );
}

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
  await waitForFonts(page);
});

test("opening the Insert menu with the mouse shows no tooltip until something is hovered", async ({ page }) => {
  await page.getByTestId("insert-step").click();
  await expect(page.getByTestId("insert-menu")).toBeVisible();
  // The menu focused its first item, Path, as it opened; that focus came from code, not the keyboard.
  await expect(page.getByTestId("insert-kind-path")).toBeFocused();
  expect(await mostAtOnce(page, 800)).toBe(0);

  // Hovering an item opens its tooltip, and only that one.
  await page.getByTestId("insert-kind-wait").hover();
  await expect(tooltips(page)).toHaveCount(1);
  await expect(tooltips(page)).toContainText("Wait");
  expect(await mostAtOnce(page, 500)).toBe(1);

  // Moving to the next item swaps the tooltip; there are never two.
  await page.getByTestId("insert-kind-sequence").hover();
  await expect(tooltips(page)).toContainText("Sequence");
  expect(await mostAtOnce(page, 500)).toBe(1);
});

test("opening the Insert menu from the keyboard shows the focused item's tooltip, and only that one", async ({
  page,
}) => {
  await page.getByTestId("insert-step").focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByTestId("insert-step")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("insert-kind-path")).toBeFocused();
  await expect(tooltips(page)).toHaveCount(1);
  await expect(tooltips(page)).toContainText("Path");

  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("insert-kind-command")).toBeFocused();
  await expect(tooltips(page)).toContainText("Command");
  expect(await mostAtOnce(page, 500)).toBe(1);
});

test("a tooltip opened by keyboard focus closes the one open under the mouse", async ({ page }) => {
  await page.getByTestId("toolbar-tool.marker").hover();
  await expect(tooltips(page)).toContainText("Marker");

  // Tab from the Select tool onto the next toolbar button while the pointer stays on Marker.
  await page.getByTestId("toolbar-tool.select").focus();
  await page.keyboard.press("Tab");
  await expect(tooltips(page)).toHaveCount(1);
  await expect(tooltips(page)).not.toContainText("Marker");
});
