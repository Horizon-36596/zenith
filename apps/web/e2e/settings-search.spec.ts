/**
 * The Settings search (issue #430): a box under the title that filters the rows of every section at
 * once, marks the words that matched, shows each match under its section's name, says when nothing
 * matches, is emptied by Escape and focused by the find key, and leaves the Keyboard pane's own key
 * filter and the palette's jump to a switch alone.
 */
import { expect, test, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";

async function start(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
    }
    window.localStorage.removeItem("zenith.cloudFake");
  });
  await turnOnFeatures(page);
  await page.goto("/");
  await page.getByTestId("canvas-load-example").click();
}

async function openSettings(page: Page): Promise<void> {
  await page.getByTestId("toolbar-settings").click();
  await expect(page.getByTestId("settings")).toBeVisible();
}

test("typing filters every section at once, marks the words and shows each match under its section", async ({ page }) => {
  await start(page);
  await openSettings(page);
  const box = page.getByTestId("settings-search");
  await expect(box).toBeVisible();

  await box.fill("grid");
  await expect(page.getByTestId("settings-section-search")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Search results" })).toBeVisible();
  const editor = page.getByTestId("settings-results-editor");
  await expect(editor.getByRole("heading", { name: /Editor/ })).toBeVisible();
  const result = page.getByTestId("settings-result-display.fieldGrid");
  await expect(result).toBeVisible();
  // The words that matched are marked, in the label.
  await expect(result.locator("mark").first()).toHaveText("Grid");
  // The section list says how many each section has, and the pane's sections are not drawn.
  await expect(page.getByTestId("settings-count-editor")).toBeVisible();
  await expect(page.getByTestId("settings-section-editor")).toHaveCount(0);
  await expect(page.getByTestId("settings-results-status")).toHaveText(/settings? match/);

  // A match in another section shows under that one: Robot's track width, with a word of its group.
  await box.fill("track width");
  await expect(page.getByTestId("settings-results-robot").getByTestId("settings-result-settings-robot-trackWidth")).toBeVisible();
  await expect(page.getByTestId("settings-results-editor")).toHaveCount(0);

  // More than one section at once, and every word has to match.
  await box.fill("optimize");
  await expect(page.getByTestId("settings-results-editor")).toBeVisible();
  await box.fill("optimize banana");
  await expect(page.getByTestId("settings-no-results")).toBeVisible();
});

test("a choice's name, a keyword and a different case all find the row", async ({ page }) => {
  await start(page);
  await openSettings(page);
  const box = page.getByTestId("settings-search");
  await box.fill("TANGENT");
  await expect(page.getByTestId("settings-result-editing.defaultHeading")).toBeVisible();
  await box.fill("dark mode");
  await expect(page.getByTestId("settings-result-display.theme")).toBeVisible();
  await box.fill("rebind");
  await expect(page.getByTestId("settings-results-keyboard")).toBeVisible();
});

test("a search with no match says so, and clearing it brings the section back", async ({ page }) => {
  await start(page);
  await openSettings(page);
  await page.getByTestId("settings-nav-general").click();
  await page.getByTestId("settings-search").fill("zzzzqq");
  const none = page.getByTestId("settings-no-results");
  await expect(none).toBeVisible();
  await expect(none).toContainText("No settings match");
  await expect(none).toContainText("zzzzqq");
  await expect(page.getByTestId("settings-search-count")).toHaveText("Nothing found");
  await expect(page.getByTestId("settings-results-status")).toHaveText("No settings match.");
  await page.getByTestId("settings-search-clear").click();
  await expect(page.getByTestId("settings-search")).toHaveValue("");
  await expect(page.getByTestId("settings-search")).toBeFocused();
  await expect(page.getByTestId("settings-section-general")).toBeVisible();
});

test("Escape empties the box first, and the window closes on the next one", async ({ page }) => {
  await start(page);
  await openSettings(page);
  const box = page.getByTestId("settings-search");
  await box.fill("grid");
  await expect(page.getByTestId("settings-results")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(box).toHaveValue("");
  await expect(page.getByTestId("settings")).toBeVisible();
  await expect(page.getByTestId("settings-results")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings")).toHaveCount(0);

  // From a result, too: the box is emptied and takes focus.
  await openSettings(page);
  await page.getByTestId("settings-search").fill("grid");
  await page.getByTestId("settings-result-display.fieldGrid").focus();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-search")).toHaveValue("");
  await expect(page.getByTestId("settings-search")).toBeFocused();
  await expect(page.getByTestId("settings")).toBeVisible();
});

test("the find key focuses the box, from anywhere in the window, and selects what is in it", async ({ page }) => {
  await start(page);
  await openSettings(page);
  await page.getByTestId("settings-nav-editor").focus();
  await page.keyboard.press("Control+f");
  await expect(page.getByTestId("settings-search")).toBeFocused();
  await page.keyboard.type("snap");
  await expect(page.getByTestId("settings-result-editing.snap")).toBeVisible();
  await page.getByTestId("settings-result-editing.snap").focus();
  await page.keyboard.press("Control+f");
  await expect(page.getByTestId("settings-search")).toBeFocused();
  // What was typed is selected, so the next word replaces it.
  await page.keyboard.type("theme");
  await expect(page.getByTestId("settings-search")).toHaveValue("theme");
});

test("choosing a result opens its section at that row with its control focused, by click, Enter and the arrow keys", async ({ page }) => {
  await start(page);
  await openSettings(page);
  const box = page.getByTestId("settings-search");

  await box.fill("grid");
  await page.getByTestId("settings-result-display.fieldGrid").click();
  await expect(page.getByTestId("settings-section-editor")).toBeVisible();
  await expect(box).toHaveValue("");
  await expect(page.getByTestId("settings-field-grid-choice")).toBeFocused();

  // Enter in the box opens the first match.
  await box.fill("measure");
  await box.press("Enter");
  await expect(page.getByTestId("settings-section-editor")).toBeVisible();
  await expect(page.getByTestId("settings-results")).toHaveCount(0);

  // ArrowDown moves into the results, ArrowUp from the first goes back to the box.
  await box.fill("grid");
  await box.press("ArrowDown");
  await expect(page.locator("button[data-result]").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("button[data-result]").nth(1)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(box).toBeFocused();
});

test("a searched row in Robot, General and Keyboard lands on its control", async ({ page }) => {
  await start(page);
  await openSettings(page);
  const box = page.getByTestId("settings-search");

  await box.fill("track width");
  await page.getByTestId("settings-result-settings-robot-trackWidth").click();
  await expect(page.getByTestId("settings-section-robot")).toBeVisible();
  // The example's robot is read only, so the number is text: it is in view, and nothing in it takes focus.
  await expect(page.getByTestId("settings-robot-trackWidth")).toBeInViewport();

  await box.fill("step groups");
  await page.getByTestId("settings-result-features.groups").click();
  await expect(page.getByTestId("settings-section-general")).toBeVisible();
  await expect(page.getByTestId("settings-feature-groups-choice").locator('[aria-pressed="true"]')).toBeFocused();

  await box.fill("shortcut");
  await page.getByTestId("settings-result-keyboard-filter").click();
  await expect(page.getByTestId("settings-section-keyboard")).toBeVisible();
  await expect(page.getByTestId("keyboard-filter")).toBeFocused();
});

test("the Keyboard pane's own key filter still works beside it", async ({ page }) => {
  await start(page);
  await openSettings(page);
  await page.getByTestId("settings-nav-keyboard").click();
  const before = await page.locator('[data-testid^="keyboard-row-"]').count();
  await page.getByTestId("keyboard-filter").fill("Validate");
  await expect.poll(async () => page.locator('[data-testid^="keyboard-row-"]').count()).toBeLessThan(before);
  await expect(page.getByTestId("keyboard-row-run.validate")).toBeVisible();
  // The settings search is separate: the filter's words do not leak into it.
  await expect(page.getByTestId("settings-search")).toHaveValue("");
});

test("the palette's jump to a switch that is off still opens Settings at that switch", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "zenith.ui",
      JSON.stringify({
        tour: { seen: true, coreDone: true, fullDone: false },
        features: { partners: false, ledger: false, commands: false },
        version: 1,
      }),
    );
    window.localStorage.removeItem("zenith.cloudFake");
  });
  await page.goto("/");
  await page.getByTestId("canvas-load-example").click();
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("parallel");
  await page.getByTestId("palette-off:insert.parallel").click();
  await expect(page.getByTestId("settings-section-general")).toBeVisible();
  await expect(page.locator("[data-setting='features.commands'] :focus")).toHaveCount(1);
  // The search is there, empty, and the section is not covered by it.
  await expect(page.getByTestId("settings-search")).toHaveValue("");
});

test("every row the search lists has a place to land in its section", async ({ page }) => {
  await start(page);
  await openSettings(page);
  const { searchRows } = await import("../src/settings/search");
  const sections = ["presets", "general", "robot", "commands", "editor", "keyboard"] as const;
  const missing: string[] = [];
  for (const section of sections) {
    await page.getByTestId(`settings-nav-${section}`).click();
    await expect(page.getByTestId(`settings-section-${section}`)).toBeVisible();
    for (const row of searchRows().filter((one) => one.section === section)) {
      const found = await page.evaluate(
        (targets) =>
          targets.some(
            (target) => document.querySelector(`[data-setting="${target}"]`) !== null || document.querySelector(`[data-testid="${target}"]`) !== null,
          ),
        row.target.split("|"),
      );
      if (!found) missing.push(`${section}: ${row.key}`);
    }
  }
  // Field view is drawn only while the field has a picture of its own; nothing else may be missing.
  expect(missing).toEqual(["editor: display.fieldView"]);
});

test.describe("at a phone's width", () => {
  test.use({ viewport: { width: 390, height: 780 } });

  test("the box tops the list, the results take the screen, and a result opens its section", async ({ page }) => {
    await start(page);
    await page.keyboard.press("Control+,");
    await expect(page.getByTestId("settings")).toBeVisible();
    const box = page.getByTestId("settings-search");
    await expect(box).toBeVisible();
    await box.fill("theme");
    await expect(page.getByTestId("settings-result-display.theme")).toBeVisible();
    await expect(box).toBeVisible();
    await page.getByTestId("settings-result-display.theme").click();
    await expect(page.getByTestId("settings-section-editor")).toBeVisible();
    // The find key brings back the list's screen, with the box focused.
    await page.keyboard.press("Control+f");
    await expect(box).toBeFocused();
  });
});
