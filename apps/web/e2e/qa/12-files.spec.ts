/**
 * QA 12, files (site/docs/editor.md, site/docs/file-format.md): the bundled example opens
 * and lists its autos; the title bar's auto name switches between them; Save on the web,
 * where the example is read only, downloads the canonical file; a formatVersion 1 file migrates on
 * load; and edits are not thrown away without a word when another auto is opened.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { editor, loadExample, openProjectWith, rowIds, shot, skipTour } from "./helpers";

const MIGRATE = fileURLToPath(new URL("../../../../packages/schema/fixtures/migrate/", import.meta.url));
const EXAMPLE_AUTOS = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));

test.beforeEach(async ({ page }) => {
  await skipTour(page);
});

test("the bundled example opens collect-and-score and lists all four of its autos", async ({ page }) => {
  await loadExample(page);
  await expect(page.getByTestId("toolbar-auto-name")).toContainText("collect-and-score.auto.json");
  expect(await rowIds(page)).toEqual([
    "driveOut",
    "scorePreload",
    "toGarden",
    "sweepGarden",
    "waitForFull",
    "stopIntake",
    "returnToScore",
    "driveBack",
    "clearThenSpinUp",
    "clearGarden",
    "readyLauncher",
    "scoreCollected",
  ]);
  // The example is read only and clean when it opens.
  expect(await editor<boolean>(page, "m.isDirty(s)")).toBe(false);
  await page.getByTestId("toolbar-auto-name").click();
  for (const name of [
    "first-auto.auto.json",
    "collect-and-score.auto.json",
    "all-step-kinds.auto.json",
    "cycle-and-park.auto.json",
  ]) {
    await expect(page.getByTestId(`open-auto-${name}`)).toBeVisible();
  }
  await shot(page, "12-open-dialog");
  await page.keyboard.press("Escape");
});

test("the auto name opens the others in turn, and each one loads its own steps", async ({ page }) => {
  await loadExample(page);
  const seen = new Map<string, string[]>();
  for (const name of ["first-auto.auto.json", "all-step-kinds.auto.json", "collect-and-score.auto.json"]) {
    await page.getByTestId("toolbar-auto-name").click();
    await page.getByTestId(`open-auto-${name}`).click();
    await expect(page.getByTestId("toolbar-auto-name")).toContainText(name);
    const want = (JSON.parse(readFileSync(join(EXAMPLE_AUTOS, name), "utf8")) as { steps: Array<{ id: string }> }).steps.map((step) => step.id);
    await expect.poll(async () => (await rowIds(page)).filter((id) => want.includes(id)).length).toBe(want.length);
    seen.set(name, await rowIds(page));
    expect(await editor<boolean>(page, "m.isDirty(s)"), `${name} opens clean`).toBe(false);
    await shot(page, `12-open-${name.replace(".auto.json", "")}`);
  }
  expect(new Set([...seen.values()].map((ids) => ids.join(","))).size).toBe(3);
});

test("Save on the read-only example downloads the canonical file and clears the unsaved dot", async ({ page }) => {
  await loadExample(page);
  // Make a change so there is something to save: move the driveOut end off its waypoint.
  await page.evaluate(`import("/src/state/store.ts").then((m) => { const s = m.getState(); m.commit({ ...s.auto, steps: s.auto.steps.map((x) => x.id !== "driveOut" ? x : { ...x, segments: x.segments.map((seg) => ({ ...seg, to: { xIn: -12, yIn: -30, headingRad: 1.5708, provenance: "SET BY HAND: QA edit" } })) }) }); })`);
  await expect(page.getByTestId("toolbar-auto-name").getByLabel("Unsaved changes")).toBeVisible();
  const download = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  const file = await download;
  expect(file.suggestedFilename()).toBe("collect-and-score.auto.json");
  const path = await file.path();
  const text = readFileSync(path, "utf8");
  const saved = JSON.parse(text) as { formatVersion: number; steps: Array<{ id: string; segments?: Array<{ to: { yIn: number } }> }> };
  expect(saved.formatVersion).toBe(3);
  expect(saved.steps.find((step) => step.id === "driveOut")?.segments?.[0]?.to.yIn).toBe(-30);
  // The text is canonical: exactly what the app thinks it wrote.
  expect(text).toBe(await editor<string>(page, "s.savedCanonical"));
  await expect(page.getByTestId("toolbar-auto-name").getByLabel("Unsaved changes")).toHaveCount(0);
  await shot(page, "12-saved-download");
});

test("a formatVersion 1 auto migrates to version 3 on load and saves as version 3", async ({ page }) => {
  await openProjectWith(page, { "migrate.auto.json": readFileSync(join(MIGRATE, "auto.v1.json"), "utf8") });
  expect(await editor<number>(page, "s.auto.formatVersion")).toBe(3);
  expect(await rowIds(page)).toEqual(expect.arrayContaining(["leg1", "group", "leg2", "pause", "choose"]));
  const want = JSON.parse(readFileSync(join(MIGRATE, "auto.v3.json"), "utf8")) as unknown;
  const download = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  const saved = JSON.parse(readFileSync(await (await download).path(), "utf8")) as unknown;
  expect(saved).toEqual(want);
  await shot(page, "12-migrated-v1");
});

test("opening another auto with unsaved edits does not throw them away without asking", async ({ page }) => {
  await loadExample(page);
  await page.evaluate(`import("/src/state/store.ts").then((m) => { const s = m.getState(); m.commit({ ...s.auto, name: "edited" }); })`);
  expect(await editor<boolean>(page, "m.isDirty(s)")).toBe(true);
  await page.getByTestId("toolbar-auto-name").click();
  await page.getByTestId("open-auto-first-auto.auto.json").click();
  await page.waitForTimeout(500);
  // Either the switch is held behind a question, or the edit is still here.
  const asked = await page.getByRole("alertdialog").or(page.getByRole("dialog").filter({ hasText: /unsaved|discard/i })).count();
  const kept = (await editor<string | null>(page, "s.auto?.name ?? null")) === "edited";
  expect(asked > 0 || kept, "the unsaved edit was either kept or the app asked first").toBe(true);
});

test("closing the tab with unsaved edits asks first", async ({ page }) => {
  await loadExample(page);
  await page.evaluate(`import("/src/state/store.ts").then((m) => { const s = m.getState(); m.commit({ ...s.auto, name: "edited" }); })`);
  let prompted = false;
  page.on("dialog", (dialog) => {
    prompted = dialog.type() === "beforeunload";
    void dialog.dismiss();
  });
  await page.close({ runBeforeUnload: true });
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(prompted).toBe(true);
});
