/**
 * The Settings window (issue #97): a large centred modal with the sections on the left, which
 * replaced the account sheet. It opens from the toolbar, the palette and the account button, keeps
 * focus inside and gives it back on close, writes the open project's command library into its
 * zenith.json, remembers the last section, takes part in back and forward, and fills a phone's
 * screen one column at a time.
 */
import { expect, test, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";
import { readServed, serveFolder, starterFiles } from "./opfsProject";

async function start(page: Page, query = "", theme?: string): Promise<void> {
  await page.addInitScript((given) => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem(
        "zenith.ui",
        JSON.stringify({ ...(given === null ? {} : { theme: given }), tour: { seen: true, coreDone: true, fullDone: false } }),
      );
    }
    window.localStorage.removeItem("zenith.cloudFake");
  }, theme ?? null);
  await turnOnFeatures(page);
  await page.goto(`/${query}`);
}

async function signInReviewer(page: Page): Promise<void> {
  await page.getByTestId("toolbar-sign-in").click();
  await page.getByTestId("signin-sheet").getByTestId("fake-demo-reviewer").click();
  await expect(page.getByTestId("toolbar-account")).toContainText("Demonstration reviewer");
  // The reviewer is in no team, so the Teams sheet opens by itself; close it.
  await page.getByTestId("teams-sheet-close").click();
}

test("Settings opens from the toolbar, keeps focus inside, closes on Escape and gives focus back", async ({ page }) => {
  await start(page);
  await page.getByTestId("canvas-load-example").click();
  const settings = page.getByTestId("settings");
  const gear = page.getByTestId("toolbar-settings");

  await gear.click();
  await expect(settings).toBeVisible();
  await expect(settings).toHaveAttribute("role", "dialog");
  await expect(settings).toHaveAttribute("aria-modal", "true");
  // With the cloud off there is no account: only what works without one, Presets, General, Robot,
  // Commands (its switch is on here), Editor and Keyboard.
  await expect(settings.locator('[data-testid^="settings-nav-"]')).toHaveCount(6);
  await expect(page.getByTestId("settings-nav-account")).toHaveCount(0);

  // Tab never leaves the window.
  for (let n = 0; n < 25; n += 1) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.closest('[data-testid="settings"]') !== null)).toBe(true);
  }
  // Keys meant for the editor do nothing behind it: V would pick the select tool, F1 the shortcut sheet.
  await page.keyboard.press("F1");
  await expect(page.getByTestId("shortcuts-overlay")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await expect(gear).toBeFocused();

  // The close button does the same, and so does a click on the dimmed backdrop.
  await gear.click();
  await page.getByTestId("settings-close").click();
  await expect(settings).toHaveCount(0);
  await expect(gear).toBeFocused();
  await gear.click();
  await page.getByTestId("settings-backdrop").click({ position: { x: 5, y: 5 } });
  await expect(settings).toHaveCount(0);
});

test("Editor settings apply at once and the last section is remembered", async ({ page }) => {
  await start(page);
  await page.getByTestId("canvas-load-example").click();
  await page.getByTestId("toolbar-settings").click();
  await page.getByTestId("settings-nav-editor").click();
  await expect(page.getByTestId("settings-section-editor")).toBeVisible();
  await page.getByTestId("settings-theme-choice-light").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByTestId("settings-snap-choice-off").click();
  await expect(page.getByTestId("toolbar-view.snap")).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Escape");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.keyboard.press("Control+,");
  // It opens where it was left.
  await expect(page.getByTestId("settings-section-editor")).toBeVisible();
  await expect(page.getByTestId("settings-theme-choice-light")).toHaveAttribute("aria-pressed", "true");
});

/** The 0.1.2 UX sweep (W1-3): the web app runs no robot repository sim, so it shows no Full sim speed. */
test("General in the web app has no Full sim speed row, and search does not find one", async ({ page }) => {
  await start(page);
  await page.getByTestId("canvas-load-example").click();
  await page.getByTestId("toolbar-settings").click();
  await page.getByTestId("settings-nav-general").click();
  await expect(page.getByTestId("settings-section-general")).toBeVisible();
  await expect(page.getByTestId("settings-section-general")).toContainText("These switches are yours");
  await expect(page.getByTestId("settings-full-sim")).toHaveCount(0);
  await expect(page.getByTestId("settings-sim-speed")).toHaveCount(0);
  await page.getByTestId("settings-search").fill("ultrafast");
  await expect(page.getByTestId("settings-search-count")).toHaveText("Nothing found");
});

test("the command library is chosen for the open project and saved in its zenith.json", async ({ page }) => {
  // The project names no library yet: Zenith never picks one for a team.
  await serveFolder(
    page,
    starterFiles({
      "zenith.json": (text) => text.replace(/\n\s*"commandLibrary": "solverslib",/, ""),
    }),
  );
  await start(page);
  await page.getByTestId("canvas-open-project").click();
  await expect(page.getByTestId("toolbar-auto-name")).toContainText("first-auto.auto.json");

  // The palette finds it by the owner's words for it.
  await page.getByTestId("toolbar-search").click();
  await page.getByTestId("palette-input").fill("command base");
  await page.getByTestId("palette-item-project.commandLibrary").click();
  // The library is the project's, so it is in Robot, under Follower, not with the person's switches in General (issue #414).
  const robot = page.getByTestId("settings-section-robot");
  await expect(robot).toBeVisible();
  // It opens at the Command library row, in view with its control focused, not at the top of Robot
  // (0.1.2 UX sweep, W1-12).
  const row = page.getByTestId("settings-command-library");
  await expect(row).toBeInViewport({ ratio: 1 });
  await expect.poll(() => row.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  const choice = page.getByTestId("settings-command-library-choice");
  await expect(choice.locator('[aria-pressed="true"]')).toHaveCount(0);
  await expect(robot).toContainText("Not set yet");
  await expect(page.getByTestId("settings-pathing-value")).toHaveText("Pedro Pathing");

  await page.getByTestId("settings-command-library-choice-ivy").click();
  await expect(page.getByTestId("settings-command-library-result")).toHaveText("Saved. zenith.json now names Ivy.");
  await expect(page.getByTestId("settings-command-library-choice-ivy")).toHaveAttribute("aria-pressed", "true");
  const writtenText = await readServed(page, "zenith.json");
  const written = JSON.parse(writtenText) as { deploy: { commandLibrary?: string; kind: string } };
  expect(written.deploy.commandLibrary).toBe("ivy");
  // Nothing else in the file changed: only the one line, added where the schema puts it.
  const served = starterFiles({ "zenith.json": (text) => text.replace(/\n\s*"commandLibrary": "solverslib",/, "") })["zenith.json"] ?? "";
  expect(writtenText.split("\n").filter((line) => !served.split("\n").includes(line))).toEqual([`    "commandLibrary": "ivy",`]);
  expect(written.deploy.kind).toBe("androidAssets");

  await page.getByTestId("settings-command-library-choice-solverslib").click();
  await expect(page.getByTestId("settings-command-library-result")).toHaveText("Saved. zenith.json now names SolversLib.");
  expect((JSON.parse(await readServed(page, "zenith.json")) as { deploy: { commandLibrary: string } }).deploy.commandLibrary).toBe(
    "solverslib",
  );
});

test("the read-only example shows its command library and says why it cannot change here", async ({ page }) => {
  await start(page);
  await page.getByTestId("canvas-load-example").click();
  await page.getByTestId("toolbar-settings").click();
  await page.getByTestId("settings-nav-robot").click();
  await expect(page.getByTestId("settings-command-library-value")).toHaveText("SolversLib");
  await expect(page.getByTestId("settings-command-library-choice")).toHaveCount(0);
  // The banner says why, once; the row keeps only its value.
  await expect(page.getByTestId("settings-example-banner")).toContainText("The example is read only. Open your own project to edit these.");
  await expect(page.getByTestId("settings-command-library-why")).toHaveCount(0);
});

test("the example's read-only banner shows on Robot and Commands only, with Open project, and no pane has a summary", async ({
  page,
}) => {
  await start(page);
  await page.getByTestId("canvas-load-example").click();
  await page.getByTestId("toolbar-settings").click();
  const banner = page.getByTestId("settings-example-banner");
  for (const section of ["robot", "commands"]) {
    await page.getByTestId(`settings-nav-${section}`).click();
    await expect(page.getByTestId(`settings-section-${section}`)).toBeVisible();
    await expect(banner).toHaveCount(1);
    await expect(banner).toHaveText(/The example is read only/);
    // No note under the title, and none of the old per-section read-only notes.
    await expect(page.getByText("The example project is read only")).toHaveCount(0);
    await expect(page.getByTestId(`settings-section-${section}`).locator("h3 + p")).toHaveCount(0);
  }
  // General and Editor are the person's own, which the example does not limit, so they have no banner.
  for (const section of ["general", "editor"]) {
    await page.getByTestId(`settings-nav-${section}`).click();
    await expect(page.getByTestId(`settings-section-${section}`)).toBeVisible();
    await expect(banner).toHaveCount(0);
  }

  // Open project… closes Settings and opens the Open project dialog.
  await page.getByTestId("settings-nav-robot").click();
  await page.getByTestId("settings-example-open-project").click();
  await expect(page.getByTestId("settings")).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Open project" })).toBeVisible();
});

test("a project that can be written has no banner, and Theme has no description", async ({ page }) => {
  await serveFolder(page, starterFiles());
  await start(page);
  await page.getByTestId("canvas-open-project").click();
  await expect(page.getByTestId("toolbar-auto-name")).toContainText("first-auto.auto.json");
  await page.getByTestId("toolbar-settings").click();
  await page.getByTestId("settings-nav-general").click();
  await expect(page.getByTestId("settings-section-general")).toBeVisible();
  await expect(page.getByTestId("settings-example-banner")).toHaveCount(0);

  await page.getByTestId("settings-nav-editor").click();
  const theme = page.getByTestId("settings-theme");
  await expect(theme).toBeVisible();
  // The label and the control are all there is: no description line, and no hint in Labels only.
  await expect(theme.locator('[class*="rowDescription"]')).toHaveCount(0);
  await expect(page.getByTestId("settings-ledger-counts").locator('[class*="rowDescription"]')).toHaveCount(0);
});

test("the project rows keep a one-line brief in Labels only, with the rest on a long hover", async ({ page }) => {
  await start(page);
  await page.getByTestId("canvas-load-example").click();
  await page.getByTestId("toolbar-settings").click();
  await page.getByTestId("settings-nav-robot").click();
  const library = page.getByTestId("settings-command-library");
  await expect(library).toContainText("The runtime your code imports");
  await expect(page.getByTestId("settings-pathing")).toContainText("The path follower");
  await library.locator("span", { hasText: /^Command library$/ }).hover();
  await expect(page.locator('[role="tooltip"]')).toContainText("Every auto needs one, even paths only.");
});

test("the account button opens Settings at Account, and back and forward step through its sections", async ({ page }) => {
  await start(page, "?cloud=fake");
  await page.getByTestId("canvas-load-example").click();
  await signInReviewer(page);
  const settings = page.getByTestId("settings");

  // Wherever it was last left, the account button opens Account.
  await page.getByTestId("toolbar-settings").click();
  await page.getByTestId("settings-nav-editor").click();
  await page.keyboard.press("Escape");
  await page.getByTestId("toolbar-account").click();
  await expect(page.getByTestId("settings-section-account")).toBeVisible();
  await expect(page.getByTestId("settings-display-name")).toBeVisible();
  await expect(page.getByTestId("settings-nav-admin")).toBeVisible();
  await expect(page.getByTestId("settings-nav-developer")).toBeVisible();

  await page.getByTestId("settings-nav-general").click();
  await page.getByTestId("settings-nav-admin").click();
  await expect(page.getByTestId("account-admin-dashboard")).toBeVisible();

  await page.keyboard.press("Alt+ArrowLeft");
  await expect(page.getByTestId("settings-section-general")).toBeVisible();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(page.getByTestId("settings-section-account")).toBeVisible();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(settings).toHaveCount(0);
  await page.keyboard.press("Alt+ArrowRight");
  await expect(page.getByTestId("settings-section-account")).toBeVisible();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(page.getByTestId("settings-section-general")).toBeVisible();

  // The admin entry closes Settings and opens the admin page.
  await page.getByTestId("settings-nav-admin").click();
  await page.getByTestId("account-admin-dashboard").click();
  await expect(settings).toHaveCount(0);
  await expect(page.getByTestId("admin-page")).toBeVisible();
});

test("signing out from Settings closes it, and a signed-out Account offers Sign in", async ({ page }) => {
  await start(page, "?cloud=fake");
  await page.getByTestId("canvas-load-example").click();
  await signInReviewer(page);
  await page.getByTestId("toolbar-account").click();
  await page.getByTestId("settings").getByTestId("account-sign-out").click();
  await expect(page.getByTestId("settings")).toHaveCount(0);
  await expect(page.getByTestId("toolbar-sign-in")).toBeVisible();

  await page.getByTestId("toolbar-settings").click();
  await expect(page.getByTestId("settings-nav-teams")).toHaveCount(0);
  await page.getByTestId("settings-nav-account").click();
  await page.getByTestId("settings-sign-in").click();
  await expect(page.getByTestId("settings")).toHaveCount(0);
  await expect(page.getByTestId("signin-sheet")).toBeVisible();
});

test.describe("at 390 px wide", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("Settings fills the screen with the list first, a section over it, and a back control", async ({ page }) => {
    await start(page);
    await page.getByTestId("canvas-load-example").click();
    await page.keyboard.press("Control+,");
    const settings = page.getByTestId("settings");
    await expect(settings).toBeVisible();
    const box = await settings.boundingBox();
    expect(Math.round(box?.width ?? 0)).toBe(390);
    expect(Math.round(box?.height ?? 0)).toBe(844);

    await expect(page.getByTestId("settings-nav-general")).toBeVisible();
    await expect(page.getByTestId("settings-back")).toBeHidden();
    await page.getByTestId("settings-nav-editor").click();
    await expect(page.getByTestId("settings-section-editor")).toBeVisible();
    await expect(page.getByTestId("settings-nav-general")).toBeHidden();
    await expect(page.getByTestId("settings-back")).toBeVisible();
    // Nothing scrolls sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    await page.getByTestId("settings-back").click();
    await expect(page.getByTestId("settings-nav-general")).toBeVisible();
    await expect(page.getByTestId("settings-nav-editor")).toBeFocused();
    await page.getByTestId("settings-close").click();
    await expect(settings).toHaveCount(0);
  });

  test("Presets opens from the list, and back and forward step between it and another section", async ({ page }) => {
    await start(page);
    await page.getByTestId("canvas-load-example").click();
    await page.keyboard.press("Control+,");
    await page.getByTestId("settings-nav-presets").click();
    await expect(page.getByTestId("settings-section-presets")).toBeVisible();
    await expect(page.getByTestId("presets-builtin-essential")).toBeVisible();
    await expect(page.getByTestId("settings-nav-presets")).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    await page.getByTestId("settings-back").click();
    await expect(page.getByTestId("settings-nav-presets")).toBeVisible();
    await expect(page.getByTestId("settings-nav-presets")).toBeFocused();
    await page.getByTestId("settings-nav-editor").click();
    await expect(page.getByTestId("settings-section-editor")).toBeVisible();

    await page.keyboard.press("Alt+ArrowLeft");
    await expect(page.getByTestId("settings-section-presets")).toBeVisible();
    await page.keyboard.press("Alt+ArrowRight");
    await expect(page.getByTestId("settings-section-editor")).toBeVisible();
  });
});
