/**
 * The Read more link on a pinned ? tip (issue #226): the hover bubble is a tooltip and holds no
 * link, so a click that pins it shows a link to the tip's docs page and heading, which opens in a
 * new tab.
 */
import { expect, test } from "@playwright/test";
import { loadExample, skipTour, waitForFonts } from "./qa/helpers";

const DOCS = "https://libraries.horizon36596.org/zenith/";

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
  await waitForFonts(page);
});

test("a hovered tip is a tooltip with no link", async ({ page }) => {
  await page.getByTestId("help-timeline").hover();
  const bubble = page.getByTestId("help-bubble");
  await expect(bubble).toBeVisible();
  await expect(bubble).toHaveAttribute("role", "tooltip");
  await expect(bubble.getByRole("link")).toHaveCount(0);
});

test("pinning the Timeline tip shows a Read more link to its docs heading", async ({ page }) => {
  await page.getByTestId("help-timeline").click();
  const bubble = page.getByTestId("help-bubble");
  await expect(bubble).toHaveAttribute("data-pinned", "true");
  const link = bubble.getByRole("link", { name: /Read more/ });
  await expect(link).toHaveAttribute("href", `${DOCS}editor/#timeline-and-playback`);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);
});

test("the link is reached by Tab from the pinned ? and does not close the tip", async ({ page }) => {
  const help = page.getByTestId("help-timeline");
  await help.focus();
  await page.keyboard.press("Enter");
  const bubble = page.getByTestId("help-bubble");
  await expect(bubble).toHaveAttribute("data-pinned", "true");
  const inBubble = bubble.locator("a, button");
  const count = await inBubble.count();
  const link = bubble.getByRole("link", { name: /Read more/ });
  // The bubble is portaled to the end of the body; Tab from the ? must still enter it.
  await page.keyboard.press("Tab");
  await expect(inBubble.first()).toBeFocused();
  for (let i = 1; i < count; i += 1) await page.keyboard.press("Tab");
  await expect(link).toBeFocused();
  await expect(bubble).toBeVisible();

  // Tab past the last link goes on to what follows the ?, not off the end of the page.
  await page.keyboard.press("Tab");
  const after = await page.evaluate(() => {
    const active = document.activeElement;
    const tip = document.querySelector('[data-testid="help-bubble"]');
    return { body: active === document.body, inBubble: tip?.contains(active) === true };
  });
  expect(after).toEqual({ body: false, inBubble: false });
});

test("Shift Tab returns from the bubble to the ?, and Escape in it closes it and refocuses the ?", async ({ page }) => {
  const help = page.getByTestId("help-timeline");
  await help.focus();
  await page.keyboard.press("Enter");
  const bubble = page.getByTestId("help-bubble");
  await page.keyboard.press("Tab");
  await expect(bubble.locator("a, button").first()).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(help).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Escape");
  await expect(bubble).toHaveCount(0);
  await expect(help).toBeFocused();
});