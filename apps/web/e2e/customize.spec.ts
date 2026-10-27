/**
 * Settings, Presets (issue #284): the preset in use and the changes since, derived and never stored;
 * picking another preset while there are changes asks first; a built-in never changes keys, and a user
 * preset with keys asks before it replaces them; and a preset saved, exported and imported again gives
 * back exactly the same settings.
 */
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { loadExample, skipTour } from "./qa/helpers";

/** Every setting a preset carries, as the page has it now (`currentValues`). */
const presetValues = (page: Page) =>
  page.evaluate(`Promise.all([import("/src/state/store.ts"), import("/src/settings/presets.ts")]).then(([s, p]) => p.currentValues(s.getState().prefs))`) as Promise<
    Record<string, unknown>
  >;

const storedKeys = (page: Page) =>
  page.evaluate(() => (JSON.parse(window.localStorage.getItem("zenith.ui") ?? "{}") as { keys?: unknown }).keys ?? {});

async function openPresets(page: Page): Promise<void> {
  await page.getByTestId("toolbar-settings").click();
  await page.getByTestId("settings-nav-presets").click();
  await expect(page.getByTestId("settings-section-presets")).toBeVisible();
}

/** Applies a built-in, letting any changes go when it asks. */
async function applyBuiltIn(page: Page, id: string): Promise<void> {
  await page.getByTestId(`presets-apply-${id}`).click();
  const ask = page.getByTestId("presets-ask-changes");
  if (await ask.isVisible()) await page.getByTestId("presets-ask-replace").click();
  await expect(page.getByTestId(`presets-in-use-${id}`)).toBeVisible();
}

/** The one line above the list, present only while the settings are not exactly the preset's own: "Using Basic (edited)". */
const summary = (page: Page) => page.getByTestId("presets-summary-text");

test("one change after Basic reads 'Using Basic (edited)', setting it back clears it, and a row's Revert undoes it", async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
  await openPresets(page);

  // The seeded switches turn Ledger and Partners on, so Essential has changes and Basic asks first.
  await page.getByTestId("presets-apply-basic").click();
  await expect(page.getByTestId("presets-ask-changes")).toContainText("You changed 2 settings from Essential.");
  await page.getByTestId("presets-ask-cancel").click();
  await expect(page.getByTestId("presets-ask-changes")).toHaveCount(0);
  await expect(summary(page)).toHaveText("Using Essential (edited)");
  await applyBuiltIn(page, "basic");
  // Nothing is edited, so there is no line: the row says In use, with a check.
  await expect(summary(page)).toHaveCount(0);
  await expect(page.getByTestId("presets-in-use-basic")).toContainText("In use");
  await expect(page.getByTestId("presets-in-use-essential")).toHaveCount(0);
  // Applying says so in the status line, which describes the latest action.
  await expect(page.getByTestId("status")).toContainText(/Applied Basic: (\d+ settings?|no settings) changed\./);

  await page.getByTestId("settings-nav-general").click();
  await page.getByTestId("settings-feature-ledger-choice-on").click();
  await page.getByTestId("settings-nav-presets").click();
  await expect(summary(page)).toHaveText("Using Basic (edited)");
  await page.getByTestId("presets-show-changes").click();
  await expect(page.getByTestId("presets-change-features.ledger")).toContainText("Now On. Basic has Off.");

  await page.getByTestId("settings-nav-general").click();
  await page.getByTestId("settings-feature-ledger-choice-off").click();
  await page.getByTestId("settings-nav-presets").click();
  await expect(summary(page)).toHaveCount(0);

  await page.getByTestId("settings-nav-general").click();
  await page.getByTestId("settings-feature-ledger-choice-on").click();
  await page.getByTestId("settings-nav-presets").click();
  await page.getByTestId("presets-show-changes").click();
  await page.getByTestId("presets-revert-features.ledger").click();
  await expect(summary(page)).toHaveCount(0);
  // Changes are derived: nothing about them is stored.
  const stored = await page.evaluate(() => window.localStorage.getItem("zenith.ui") ?? "");
  expect(stored).not.toContain("changes");
});

test("save, export and import a preset, and applying the import gives back the same settings", async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
  await openPresets(page);
  await applyBuiltIn(page, "full");

  // A setting Full sets, and a toolbar button, which no built-in sets, so only the first is a change.
  await page.getByTestId("settings-nav-editor").click();
  await page.getByTestId("settings-toolbar-run.validate").click();
  await page.getByTestId("settings-nav-general").click();
  await page.getByTestId("settings-feature-partners-choice-off").click();
  await page.getByTestId("settings-nav-presets").click();
  await expect(summary(page)).toHaveText("Using Full (edited)");

  await page.getByTestId("presets-save").click();
  await expect(page.getByTestId("presets-save-keys"), "no custom key, so no Include my keys").toHaveCount(0);
  await page.getByTestId("presets-save-name").fill("Basic");
  await page.getByTestId("presets-save-confirm").click();
  await expect(page.getByTestId("presets-save-error")).toContainText("built-in");
  await page.getByTestId("presets-save-name").fill("Drive team");
  await page.getByTestId("presets-save-confirm").click();
  await expect(page.getByTestId("presets-user-Drive team").getByTestId("presets-in-use")).toBeVisible();
  await expect(summary(page)).toHaveCount(0);
  const saved = await presetValues(page);

  const mine = page.getByTestId("presets-user-Drive team");
  const downloading = page.waitForEvent("download");
  await mine.getByTestId("presets-user-menu-Drive team").click();
  await page.getByTestId("menu-presets-export").click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("Drive team.zenith-preset.json");
  const path = await download.path();
  const text = await readFile(path, "utf8");
  expect(JSON.parse(text)).toMatchObject({ kind: "zenith-preset", presetVersion: 1, name: "Drive team", basedOn: "full" });

  await applyBuiltIn(page, "basic");
  expect(await presetValues(page)).not.toEqual(saved);
  const beforeImport = await presetValues(page);

  const choosing = page.waitForEvent("filechooser");
  await page.getByTestId("presets-import").click();
  const chooser = await choosing;
  await chooser.setFiles(path);
  const note = page.getByTestId("presets-import-note");
  await expect(note).toContainText("Added Drive team (2). Nothing changed yet");
  await expect(note).toContainText("Its name was taken");
  // An import applies nothing.
  expect(await presetValues(page)).toEqual(beforeImport);
  await expect(page.getByTestId("presets-in-use-basic")).toBeVisible();

  await page.getByTestId("presets-user-Drive team (2)").getByTestId("presets-apply").click();
  await expect(page.getByTestId("presets-user-Drive team (2)").getByTestId("presets-in-use")).toBeVisible();
  expect(await presetValues(page)).toEqual(saved);
});

test("a built-in never changes keys, and a user preset's keys replace them only after the ask", async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.presets") !== null) return;
    window.localStorage.setItem(
      "zenith.presets",
      JSON.stringify({
        version: 1,
        presets: [
          { id: "user:keys", name: "Drive keys", description: "", basedOn: "full", settings: {}, keys: { "run.validate": "Ctrl E" } },
          { id: "user:broken", name: 12, basedOn: "full", settings: {} },
          { id: "user:scouts", name: "Scouts", description: "", basedOn: "basic", settings: {} },
        ],
      }),
    );
  });
  await skipTour(page, { keys: { "tool.measure": null } });
  await loadExample(page);
  await openPresets(page);

  // The broken preset is dropped, and the two others are kept.
  await expect(page.getByTestId("presets-user-Drive keys")).toBeVisible();
  await expect(page.getByTestId("presets-user-Scouts")).toBeVisible();
  await expect(page.getByTestId("presets-mine")).toContainText("2 of 20");

  await applyBuiltIn(page, "basic");
  expect(await storedKeys(page)).toEqual({ "tool.measure": null });

  await page.getByTestId("presets-user-Drive keys").getByTestId("presets-apply").click();
  await expect(page.getByTestId("presets-ask-keys")).toContainText("Drive keys has keys of its own.");
  await page.getByTestId("presets-ask-cancel").click();
  expect(await storedKeys(page)).toEqual({ "tool.measure": null });
  await expect(page.getByTestId("presets-in-use-basic")).toBeVisible();

  await page.getByTestId("presets-user-Drive keys").getByTestId("presets-apply").click();
  await page.getByTestId("presets-ask-keys-keep").click();
  await expect(page.getByTestId("presets-user-Drive keys").getByTestId("presets-in-use")).toBeVisible();
  expect(await storedKeys(page)).toEqual({ "tool.measure": null });

  // Back on Basic, the same pick asks about the keys again, and Replace my keys takes them.
  await applyBuiltIn(page, "basic");
  await page.getByTestId("presets-user-Drive keys").getByTestId("presets-apply").click();
  await page.getByTestId("presets-ask-keys-replace").click();
  expect(await storedKeys(page)).toEqual({ "run.validate": "Ctrl E" });

  // Deleting the preset in use keeps the settings and names the built-in it was based on.
  const row = page.getByTestId("presets-user-Drive keys");
  await row.getByTestId("presets-user-menu-Drive keys").click();
  await page.getByTestId("menu-presets-delete").click();
  // The ask is the one confirm row: Cancel on the left, Delete as the primary on the right.
  await expect(row.getByTestId("presets-delete-ask").getByRole("button")).toHaveText(["Cancel", "Delete"]);
  await row.getByTestId("presets-delete-confirm").click();
  await expect(summary(page)).toHaveText("Using Custom (based on Full)");
  expect(await storedKeys(page)).toEqual({ "run.validate": "Ctrl E" });
});

test("the ask after Apply on a row far down the pane is drawn under that row, in view, with the focus on Cancel", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.presets") !== null) return;
    const presets = Array.from({ length: 8 }, (_, index) => ({
      id: `user:p${String(index + 1)}`,
      name: `Preset ${String(index + 1)}`,
      description: "",
      basedOn: "basic",
      settings: {},
      ...(index === 6 ? { keys: { "run.validate": "Ctrl E" } } : {}),
    }));
    window.localStorage.setItem("zenith.presets", JSON.stringify({ version: 1, presets }));
  });
  await skipTour(page);
  await loadExample(page);
  await openPresets(page);

  // The seeded Essential has 2 changes, so Apply on Preset 7 asks about them first.
  const row = page.getByTestId("presets-user-Preset 7");
  await row.getByTestId("presets-apply").scrollIntoViewIfNeeded();
  await row.getByTestId("presets-apply").click();
  const changes = row.getByTestId("presets-ask-changes");
  await expect(changes).toContainText("You changed 2 settings from Essential.");
  await expect(changes).toBeInViewport();
  // Cancel comes first and takes the focus, as in every question (UI_GUIDE 9.14).
  await expect(row.getByTestId("presets-ask-changes").getByRole("button")).toHaveText(["Cancel", "Replace them", "Save them as a preset…"]);
  await expect(row.getByTestId("presets-ask-cancel")).toBeFocused();
  await expect(page.getByTestId("presets-current").getByTestId("presets-ask-changes")).toHaveCount(0);

  // Replace them leads to the keys ask, in the same place and in view too.
  await row.getByTestId("presets-ask-replace").click();
  const keys = row.getByTestId("presets-ask-keys");
  await expect(keys).toContainText("Preset 7 has keys of its own.");
  await expect(keys).toBeInViewport();
  await expect(row.getByTestId("presets-ask-cancel")).toBeFocused();
  await row.getByTestId("presets-ask-keys-keep").click();
  await expect(row.getByTestId("presets-in-use")).toBeVisible();

  // Save them as a preset opens the save form under the row as well, and saving then applies the pick.
  await page.getByTestId("settings-nav-general").click();
  await page.getByTestId("settings-feature-ledger-choice-on").click();
  await page.getByTestId("settings-nav-presets").click();
  const last = page.getByTestId("presets-user-Preset 8");
  await last.getByTestId("presets-apply").scrollIntoViewIfNeeded();
  await last.getByTestId("presets-apply").click();
  await expect(last.getByTestId("presets-ask-changes")).toBeInViewport();
  await last.getByTestId("presets-ask-save").click();
  await expect(last.getByTestId("presets-save-form")).toBeInViewport();
  await expect(last.getByTestId("presets-save-name")).toBeFocused();
  await last.getByTestId("presets-save-name").fill("With ledger");
  await last.getByTestId("presets-save-confirm").click();
  await expect(last.getByTestId("presets-in-use")).toBeVisible();
  await expect(page.getByTestId("presets-user-With ledger")).toBeVisible();
});

// UX review, S5: a refused file is named, and its reason is an error line in Settings' own type,
// not a line of the report list, which is set in mono.
test("importing a file that is not a preset names it on one error line", async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
  await openPresets(page);
  const choosing = page.waitForEvent("filechooser");
  await page.getByTestId("presets-import").click();
  const chooser = await choosing;
  await chooser.setFiles({ name: "notes.json", mimeType: "application/json", buffer: Buffer.from('{"kind":"zenith-auto"}') });
  const note = page.getByTestId("presets-import-note");
  await expect(note).toHaveText("notes.json is not a Zenith preset file. Pick a .zenith-preset.json file made by Export.");
  await expect(note).toHaveAttribute("role", "alert");
  const font = await note.evaluate((element) => getComputedStyle(element).fontFamily);
  expect(font).not.toMatch(/mono/i);
});
