/**
 * The frame every box over the editor shares (UI_GUIDE 9.14): a dialog without a Cancel has one
 * Lucide X, "Close" with Esc in its tooltip, at the right end of its title row, and a dialog keeps
 * its top edge where it is when its content grows.
 */
import { expect, test } from "@playwright/test";
import { turnOnFeatures } from "./features";

test("the shortcut sheet has one close, and Esc closes it too", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
  });
  await turnOnFeatures(page);
  await page.goto("/");
  await page.getByTestId("canvas-load-example").click();
  const sheet = page.getByTestId("shortcuts-overlay");

  await page.keyboard.press("F1");
  await expect(sheet).toBeVisible();
  const close = sheet.getByTestId("shortcuts-overlay-close");
  await close.hover();
  await expect(page.getByRole("tooltip")).toContainText("Close");
  await expect(page.getByRole("tooltip")).toContainText("Esc");
  await close.click();
  await expect(sheet).toHaveCount(0);

  await page.keyboard.press("F1");
  await expect(sheet).toBeVisible();
  const top = (await sheet.boundingBox())?.y ?? 0;
  await page.getByTestId("shortcuts-sheet").getByRole("tab", { name: "Mouse" }).click();
  expect((await sheet.boundingBox())?.y ?? -1).toBe(top);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
});
