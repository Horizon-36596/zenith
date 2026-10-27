/**
 * Back and forward between screens (issue #83): the mouse's side buttons and Alt + Left and Alt +
 * Right go to the screen the person was just on and back again, like a browser. A screen is the open
 * auto and the page, sheet or dialog over it; edits are not, so going back never undoes one, and
 * going back to another auto with unsaved edits asks Save, Discard or Cancel first.
 *
 * Playwright's mouse has no side buttons, so the tests dispatch the events a side button sends.
 */
import { expect, test, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";

async function start(page: Page, query = ""): Promise<void> {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
    }
    window.localStorage.removeItem("zenith.cloudFake");
  });
  await turnOnFeatures(page);
  await page.goto(`/${query}`);
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
}

/** One press of a side button: 3 is back, 4 is forward. */
async function sideButton(page: Page, button: 3 | 4): Promise<void> {
  await page.evaluate((which) => {
    const target = document.querySelector("[data-tour='field']") ?? document.body;
    for (const type of ["mousedown", "mouseup", "auxclick"]) {
      target.dispatchEvent(new MouseEvent(type, { button: which, bubbles: true, cancelable: true }));
    }
  }, button);
}

test("the side buttons and Alt + arrows go back and forward through Settings, Teams and the admin page", async ({ page }) => {
  await start(page, "?cloud=fake");
  const settings = page.getByTestId("settings");
  const teams = page.getByTestId("teams-sheet");
  const admin = page.getByTestId("admin-page");

  await page.getByTestId("toolbar-sign-in").click();
  await page.getByTestId("signin-sheet").getByTestId("fake-demo-reviewer").click();
  await expect(page.getByTestId("toolbar-account")).toContainText("Demonstration reviewer");
  // The reviewer is in no team, so the Teams sheet opens by itself; close it.
  await page.getByTestId("teams-sheet-close").click();
  await expect(teams).toHaveCount(0);

  await page.getByTestId("toolbar-account").click();
  await expect(settings).toBeVisible();
  await page.getByTestId("settings-nav-teams").click();
  // Opening the Teams sheet from Settings closes the window in the same step.
  await settings.getByTestId("account-open-teams").click();
  await expect(settings).toHaveCount(0);
  await expect(teams).toBeVisible();
  await page.evaluate(() => {
    window.location.hash = "#/admin";
  });
  await expect(admin).toBeVisible();

  await sideButton(page, 3);
  await expect(admin).toHaveCount(0);
  await expect(teams).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");

  await sideButton(page, 3);
  await expect(teams).toHaveCount(0);
  await expect(page.getByTestId("settings-section-teams")).toBeVisible();

  await sideButton(page, 4);
  await expect(settings).toHaveCount(0);
  await expect(teams).toBeVisible();

  await page.keyboard.press("Alt+ArrowRight");
  await expect(admin).toBeVisible();
  expect(new URL(page.url()).hash).toBe("#/admin");

  // At the newest screen, forward does nothing.
  await sideButton(page, 4);
  await expect(admin).toBeVisible();

  await page.keyboard.press("Alt+ArrowLeft");
  await expect(admin).toHaveCount(0);
  await expect(teams).toBeVisible();

  // Going back never leaves the editor: the auto stays open the whole way.
  await expect(page.getByTestId("toolbar-auto-name")).toContainText("collect-and-score.auto.json");
});

test("going back to another auto never drops an edit without asking, and the shortcut sheet is a screen too", async ({ page }) => {
  await start(page);
  const name = page.getByTestId("toolbar-auto-name");
  const unsaved = name.getByLabel("Unsaved changes");
  const dialog = page.getByTestId("unsaved-dialog");
  const shortcuts = page.getByTestId("shortcuts-overlay");

  await name.click();
  await page.getByTestId("open-auto-first-auto.auto.json").click();
  await expect(name).toContainText("first-auto.auto.json");

  // The shortcut sheet lists the keys, and back closes it the way it came.
  await page.keyboard.press("F1");
  await expect(shortcuts).toBeVisible();
  await expect(shortcuts).toContainText("Alt + ← →");
  await sideButton(page, 3);
  await expect(shortcuts).toHaveCount(0);
  await expect(name).toContainText("first-auto.auto.json");

  // An edit is not a screen: back goes to the other auto, and asks first because of the edit.
  const firstRow = page.locator("[data-testid^='step-row-']").first();
  await firstRow.getByRole("button").first().click();
  await page.keyboard.press("Delete");
  await expect(unsaved).toHaveCount(1);

  await sideButton(page, 3);
  await expect(dialog).toBeVisible();
  await page.getByTestId("unsaved-cancel").click();
  await expect(dialog).toHaveCount(0);
  await expect(name).toContainText("first-auto.auto.json");
  await expect(unsaved).toHaveCount(1);

  // The step that was refused can be taken again, and Discard is the person's choice.
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(dialog).toBeVisible();
  await page.getByTestId("unsaved-discard").click();
  await expect(name).toContainText("collect-and-score.auto.json");
  await expect(unsaved).toHaveCount(0);

  await sideButton(page, 4);
  await expect(name).toContainText("first-auto.auto.json");
  await expect(unsaved).toHaveCount(0);
});
