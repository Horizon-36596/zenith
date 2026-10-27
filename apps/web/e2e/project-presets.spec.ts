/**
 * Project presets (issue #484): a preset kept in the
 * project's `autos/presets/` folder is listed for everyone who opens it. Applying it keeps a linked
 * copy in Your presets, and applying it again after the file changed updates that copy. Add to
 * project writes one of the person's presets there, and Update in project asks before it replaces a
 * different file. The example cannot hold presets, and says why.
 */
import { expect, test, type Page } from "@playwright/test";
import { openServedFolder, readServed, serveFolder, starterFiles } from "./opfsProject";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
    }
    window.localStorage.removeItem("zenith.cloudFake");
  });
});

const PRESET_PATH = "autos/presets/Drive team.zenith-preset.json";

const presetText = (settings: Record<string, unknown>, description = ""): string =>
  `${JSON.stringify({ kind: "zenith-preset", presetVersion: 1, name: "Drive team", description, basedOn: "essential", settings }, null, 2)}\n`;

/** The page's feature switches, as the store has them now. */
const features = (page: Page) =>
  page.evaluate(`import("/src/state/store.ts").then((s) => s.getState().prefs.features)`) as Promise<Record<string, boolean>>;

/** Writes a file into the served folder, the way a teammate's commit pulled with git would. */
async function writeServed(page: Page, path: string, text: string): Promise<void> {
  await page.evaluate(
    async ({ wanted, body }) => {
      let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("robot-repo");
      const parts = wanted.split("/");
      const name = parts.pop() as string;
      for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writable.write(body);
      await writable.close();
    },
    { wanted: path, body: text },
  );
}

async function openFolder(page: Page, files: Record<string, string>): Promise<void> {
  await serveFolder(page, files);
  await page.goto("/");
  await openServedFolder(page);
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
}

async function openPresets(page: Page): Promise<void> {
  await page.getByTestId("toolbar-settings").click();
  await page.getByTestId("settings-nav-presets").click();
  await expect(page.getByTestId("settings-section-presets")).toBeVisible();
}

async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-section-presets")).toHaveCount(0);
}

test("a teammate applies the project's preset, and applying it again after it changed updates their copy", async ({ page }) => {
  await openFolder(page, { ...starterFiles(), [PRESET_PATH]: presetText({ "features.ledger": true, "features.partners": true }) });
  await openPresets(page);

  const row = page.getByTestId("presets-project-Drive team");
  await expect(row).toContainText("Based on Essential.");
  await row.getByTestId("presets-project-apply").click();
  await expect(page.getByTestId("status")).toContainText(/Applied Drive team: (\d+ settings?|no settings) changed\./);
  await expect(row.getByTestId("presets-project-in-use")).toBeVisible();
  expect(await features(page)).toMatchObject({ ledger: true, partners: true });
  // The copy is in Your presets, and says where it came from.
  await expect(page.getByTestId("presets-user-Drive team")).toContainText("From this project.");

  // A teammate changes the file, and this person pulls it: the row says so.
  await writeServed(page, PRESET_PATH, presetText({ "features.ledger": false, "features.partners": true }, "Ledger off for now."));
  await closeSettings(page);
  await openPresets(page);
  await expect(row).toContainText("Changed in the project since you applied it.");
  await row.getByTestId("presets-project-apply").click();
  await expect(row.getByTestId("presets-project-in-use")).toBeVisible();
  expect(await features(page)).toMatchObject({ ledger: false, partners: true });
  // Still one copy, now up to date.
  await expect(page.getByTestId("presets-user-Drive team")).toContainText("Ledger off for now.");
  await expect(page.getByTestId("presets-user-Drive team (2)")).toHaveCount(0);

  // Renamed, the copy still points at its own file: Update in project would write that file, and it matches.
  const copy = page.getByTestId("presets-user-Drive team");
  // A preset's actions past Apply are in its row menu (UI_GUIDE 9.10).
  await copy.getByTestId("presets-user-menu-Drive team").click();
  await page.getByTestId("menu-presets-rename").click();
  await page.getByTestId("presets-rename-name").fill("Ours");
  await page.getByTestId("presets-rename-confirm").click();
  const ours = page.getByTestId("presets-user-Ours");
  await expect(ours).toContainText("From this project.");
  await ours.getByTestId("presets-user-menu-Ours").click();
  await expect(page.getByTestId("menu-presets-add-to-project")).toHaveText("Update in project");
  await expect(page.getByTestId("menu-presets-add-to-project")).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(row.getByTestId("presets-project-in-use")).toBeVisible();
});

test("Add to project writes the preset into the folder, and Update in project asks before replacing it", async ({ page }) => {
  await openFolder(page, starterFiles());
  await openPresets(page);
  await expect(page.getByTestId("presets-project-none")).toContainText("Use Add to project");

  await page.getByTestId("presets-save").click();
  await page.getByTestId("presets-save-name").fill("Drive team");
  await page.getByTestId("presets-save-confirm").click();
  const mine = page.getByTestId("presets-user-Drive team");
  const menu = mine.getByTestId("presets-user-menu-Drive team");
  await menu.click();
  await page.getByTestId("menu-presets-add-to-project").click();
  await expect(page.getByTestId("status")).toContainText(`Added Drive team in the project, at ${PRESET_PATH}. Commit it so your teammates get it.`);
  expect(JSON.parse(await readServed(page, PRESET_PATH))).toMatchObject({ kind: "zenith-preset", presetVersion: 1, name: "Drive team" });

  // The project lists it, in use, and the button has nothing to update.
  await expect(page.getByTestId("presets-project-Drive team").getByTestId("presets-project-in-use")).toBeVisible();
  const add = page.getByTestId("menu-presets-add-to-project");
  await menu.click();
  await expect(add).toHaveText("Update in project");
  await expect(add).toBeDisabled();
  await page.keyboard.press("Escape");

  // Change a setting and keep it in the preset: Update in project asks first, then writes it.
  await page.getByTestId("settings-nav-general").click();
  await page.getByTestId("settings-feature-ledger-choice-on").click();
  await page.getByTestId("settings-nav-presets").click();
  await page.getByTestId("presets-update-current").click();
  await menu.click();
  await expect(add).toBeEnabled();
  await add.click();
  await expect(page.getByTestId("presets-replace-ask")).toContainText("The project already has Drive team.zenith-preset.json.");
  await page.getByTestId("presets-replace-confirm").click();
  await expect(page.getByTestId("status")).toContainText("Updated Drive team in the project");
  await expect
    .poll(async () => (JSON.parse(await readServed(page, PRESET_PATH)) as { settings: Record<string, unknown> }).settings["features.ledger"])
    .toBe(true);
});

test("the example cannot hold presets, and Add to project says why", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await openPresets(page);
  await expect(page.getByTestId("presets-project-none")).toContainText("This project has no presets.");
  await page.getByTestId("presets-save").click();
  await page.getByTestId("presets-save-name").fill("Mine");
  await page.getByTestId("presets-save-confirm").click();
  await page.getByTestId("presets-user-Mine").getByTestId("presets-user-menu-Mine").click();
  await expect(page.getByTestId("menu-presets-add-to-project")).toBeDisabled();
});
