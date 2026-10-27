/**
 * Settings, Robot (issue #313): a provenance menu opened from a Robot value is drawn over the
 * Settings window, so a pointer and the keyboard both reach it, and the window's focus trap still
 * holds while it is open. The close button's hint does not say everything is saved while Robot holds
 * an unsaved change.
 */
import { expect, test, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";
import { openServedFolder, readServed, serveFolder, starterFiles } from "./opfsProject";

const MENU = "settings-robot-maxForward-provenance-menu";
const ITEM = "menu-provenance-set-by-hand";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
    }
    window.localStorage.removeItem("zenith.cloudFake");
  });
  await turnOnFeatures(page, { ledger: true, commands: true });
  await serveFolder(page, starterFiles());
  await page.goto("/");
  await openServedFolder(page);
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
});

async function openRobot(page: Page): Promise<void> {
  await page.getByTestId("toolbar-settings").click();
  await page.getByTestId("settings-nav-robot").click();
  await expect(page.getByTestId("settings-section-robot")).toBeVisible();
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  return errors;
}

async function openMenu(page: Page): Promise<void> {
  if (!(await page.getByTestId("settings-section-robot").isVisible())) await openRobot(page);
  await page.getByTestId("settings-robot-maxForward-provenance").click();
  await expect(page.getByTestId(MENU)).toBeVisible();
  await expect(page.getByTestId(ITEM)).toBeVisible();
}

const activeTestId = (page: Page): Promise<string | null> =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.closest("[data-testid]")?.getAttribute("data-testid") ?? null);

test("the provenance menu draws over the Settings window and a click on an item chooses it", async ({ page }) => {
  const errors = watchErrors(page);
  await openMenu(page);
  const onTop = await page.evaluate((testid) => {
    const item = document.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
    if (item === null) return "missing";
    const box = item.getBoundingClientRect();
    const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return top !== null && item.contains(top) ? "item" : (top?.closest("[data-testid]")?.getAttribute("data-testid") ?? "nothing");
  }, ITEM);
  expect(onTop, "the element on top at the menu item").toBe("item");

  await page.getByTestId(ITEM).click();
  await expect(page.getByTestId(MENU)).toHaveCount(0);
  await expect(page.getByTestId("settings")).toBeVisible();
  await expect(page.getByTestId("settings-robot-save-bar")).toContainText("Unsaved changes");
  expect(errors, "page and console errors").toEqual([]);
});

test("the provenance menu works from the keyboard and Save robot.json writes the choice", async ({ page }) => {
  const errors = watchErrors(page);
  await openRobot(page);
  await page.getByTestId("settings-robot-maxForward-provenance").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId(MENU)).toBeVisible();
  // The menu focuses the checked label as it opens; the window's focus guard leaves it there.
  await expect.poll(() => activeTestId(page)).toMatch(/^menu-provenance-/);
  await page.getByTestId(ITEM).focus();
  expect(await activeTestId(page)).toBe(ITEM);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId(MENU)).toHaveCount(0);
  await expect(page.getByTestId("settings-robot-save-bar")).toContainText("Unsaved changes");
  await page.getByTestId("settings-robot-save").click();
  await expect(page.getByTestId("settings-robot-result")).toHaveText("Saved robot.json to autos/robot.json.");
  const written = JSON.parse(await readServed(page, "autos/robot.json")) as {
    kinematics: { maxForwardVelInPerS: { provenance?: string } };
  };
  expect(written.kinematics.maxForwardVelInPerS.provenance).toMatch(/^SET BY HAND/);
  expect(errors, "page and console errors").toEqual([]);
});

test("Escape and Tab close the provenance menu and keep focus inside the Settings window", async ({ page }) => {
  const errors = watchErrors(page);
  const chip = page.getByTestId("settings-robot-maxForward-provenance");
  await openMenu(page);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId(MENU)).toHaveCount(0);
  // Escape closed only the menu, not the window behind it.
  await expect(page.getByTestId("settings")).toBeVisible();
  await expect(chip).toBeFocused();

  await openMenu(page);
  // Tab past the last item leaves the menu: it closes and focus goes back to the chip, in the window.
  const items = page.getByTestId(MENU).locator('[role="menuitemradio"], [role="menuitem"]');
  await items.last().focus();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId(MENU)).toHaveCount(0);
  await expect(chip).toBeFocused();
  expect(await page.evaluate(() => document.querySelector('[data-testid="settings"]')?.contains(document.activeElement) ?? false)).toBe(true);
  expect(errors, "page and console errors").toEqual([]);
});

test("the close hint names the unsaved robot.json instead of saying everything is saved", async ({ page }) => {
  const errors = watchErrors(page);
  await openRobot(page);
  const close = page.getByTestId("settings-close");
  await close.hover();
  await expect(page.getByRole("tooltip")).toContainText("Everything here is already saved.");
  await page.mouse.move(0, 0);

  const speed = page.getByTestId("settings-robot-maxForward");
  await speed.fill("72");
  await speed.press("Enter");
  await expect(page.getByTestId("settings-robot-save-bar")).toContainText("Unsaved changes");
  await close.hover();
  const tip = page.getByRole("tooltip");
  await expect(tip).toContainText("Robot has unsaved changes to autos/robot.json, so closing asks whether to save them.");
  await expect(tip).not.toContainText("already saved");
  await page.mouse.move(0, 0);

  await page.getByTestId("settings-robot-discard").click();
  await close.hover();
  await expect(page.getByRole("tooltip")).toContainText("Everything here is already saved.");
  expect(errors, "page and console errors").toEqual([]);
});

test("Tab out of the Help menu, or Escape, leaves focus on the help button", async ({ page }) => {
  const errors = watchErrors(page);
  const help = page.getByTestId("toolbar-help");
  const menu = page.getByTestId("help-menu");
  const items = menu.locator('[role="menuitem"], [role="menuitemradio"]');
  await help.focus();
  await page.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  await items.last().focus();
  await page.keyboard.press("Tab");
  await expect(menu).toHaveCount(0);
  await expect(help).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  await expect.poll(() => activeTestId(page)).toMatch(/^menu-/);
  await page.keyboard.press("Shift+Tab");
  await expect(menu).toHaveCount(0);
  await expect(help).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(help).toBeFocused();
  expect(errors, "page and console errors").toEqual([]);
});
