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

  // ArrowDown moves to the next item, whichever kind the menu lists second, and that item's own
  // tooltip replaces Path's.
  await page.keyboard.press("ArrowDown");
  const next = page.getByTestId("insert-menu").getByRole("menuitem").nth(1);
  await expect(next).toBeFocused();
  await expect(page.getByTestId("insert-kind-path")).not.toBeFocused();
  const title = (await next.innerText()).split("\n")[0]?.trim() ?? "";
  expect(title).not.toBe("");
  await expect(tooltips(page)).toHaveCount(1);
  await expect(tooltips(page)).toContainText(title);
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

/**
 * The 0.1.2 UX sweep (W1-17): at 900 by 700 the Settings window opens with its Close button right
 * under the pointer that clicked the Settings button, and Close's tooltip popped up over the preset
 * buttons though the pointer never moved. A tooltip opens on hover only once the pointer moves on
 * its trigger.
 */
test("a control that appears under a still pointer shows no tooltip until the pointer moves", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const settings = page.getByTestId("toolbar-settings");
  const at = await settings.boundingBox();
  if (at === null) throw new Error("Settings has no box");
  const x = at.x + at.width / 2;
  const y = at.y + at.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
  const close = page.getByTestId("settings-close");
  await expect(close).toBeVisible();
  // The case the sweep saw: Close sits where the pointer already is.
  const box = await close.boundingBox();
  if (box === null) throw new Error("Close has no box");
  expect(x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height).toBe(true);
  expect(await mostAtOnce(page, 900)).toBe(0);

  // A real move on Close opens its tooltip as before.
  await page.mouse.move(x + 2, y + 1);
  await expect(tooltips(page)).toContainText("Close");
});
