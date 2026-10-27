/**
 * Issue #244: the start ("Start" since issue #409) and "Waypoints" leave the step selections. They show in a
 * Routine view when nothing is selected, the start's section when the start is selected, and the
 * Waypoints list when a waypoint is selected. A step's Inspector is about that step alone.
 *
 * The bundled example opens collect-and-score, which has waypoints and the steps driveOut,
 * shootPreloads (a command) and waitForFull (a wait).
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { editor, fixture, loadExample, openProjectWith, selectStep, skipTour, waitForFonts } from "./qa/helpers";

const inspector = (page: Page): Locator => page.getByTestId("inspector");
const startSection = (page: Page): Locator => page.locator('section[data-fold="routine.start"]');
const listSection = (page: Page): Locator => page.locator('section[data-fold="waypoint.list"]');

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
  await waitForFonts(page);
});

for (const id of ["driveOut", "shootPreloads", "waitForFull"]) {
  test(`with ${id} selected the Inspector has no Start or Waypoints section`, async ({ page }) => {
    await selectStep(page, id);
    await expect(page.getByTestId("inspector-title")).toHaveText(id);
    await expect(startSection(page)).toHaveCount(0);
    await expect(listSection(page)).toHaveCount(0);
    await expect(page.getByTestId("inspector-start-source")).toHaveCount(0);
    await expect(inspector(page)).not.toContainText("Start of the routine");
    await expect(page.getByRole("button", { name: /^Waypoints \d+$/ })).toHaveCount(0);
  });
}

test("with nothing selected the Inspector is the Routine view: Start, and the Waypoints list open", async ({ page }) => {
  expect(await editor(page, "s.selection")).toEqual({});
  await expect(page.getByTestId("inspector-routine-head")).toBeVisible();
  await expect(startSection(page)).toBeVisible();
  await expect(startSection(page).getByRole("button", { name: "Start", exact: true })).toBeVisible();
  // The start's own rows are shown, not folded away.
  await expect(page.getByTestId("inspector-start-source")).toBeVisible();
  // The example has waypoints, so the list is open.
  await expect(listSection(page)).toBeVisible();
  await expect(page.getByTestId("inspector-waypoint-row-start")).toBeVisible();
});

test("the Waypoints list in the Routine view can be folded, and the fold is remembered", async ({ page }) => {
  await listSection(page).getByRole("button", { name: /^Waypoints \d+$/ }).click();
  await expect(page.getByTestId("inspector-waypoint-row-start")).toHaveCount(0);
  expect(await editor(page, "s.prefs.inspectorFolds['waypoint.list']")).toBe(false);
});

test("selecting the start shows the Start section, held open, and no list", async ({ page }) => {
  await page.evaluate(`import("/src/state/store.ts").then((m) => m.setSelection({ start: true }))`);
  await expect(startSection(page)).toBeVisible();
  await expect(page.getByTestId("inspector-start-source")).toBeVisible();
  await expect(page.getByTestId("inspector-routine-head")).toHaveCount(0);
  await expect(listSection(page)).toHaveCount(0);
});

test("selecting the start reopens a Start section that was folded in the Routine view", async ({ page }) => {
  await startSection(page).getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByTestId("inspector-start-source")).toHaveCount(0);
  expect(await editor(page, "s.prefs.inspectorFolds['routine.start']")).toBe(false);
  await page.evaluate(`import("/src/state/store.ts").then((m) => m.setSelection({ start: true }))`);
  await expect(page.getByTestId("inspector-start-source")).toBeVisible();
});

test("selecting a waypoint reopens a Waypoints list that was folded in the Routine view", async ({ page }) => {
  await listSection(page).getByRole("button", { name: /^Waypoints \d+$/ }).click();
  await expect(page.getByTestId("inspector-waypoint-row-scoreSouth")).toHaveCount(0);
  await page.evaluate(`import("/src/state/store.ts").then((m) => m.setSelection({ waypoint: "scoreSouth" }))`);
  await expect(page.getByTestId("inspector-waypoint-row-scoreSouth")).toBeVisible();
  await expect(page.getByTestId("inspector-waypoint-row-scoreSouth")).toHaveAttribute("aria-pressed", "true");
});

test("a project with no waypoints starts the Waypoints list folded", async ({ page }) => {
  // A later entry for waypoints.json replaces the example's, so this project has none.
  const none = JSON.stringify({ formatVersion: 1, waypoints: {} });
  await openProjectWith(page, { "qa-hive-tip.auto.json": fixture("qa-hive-tip.auto.json"), "waypoints.json": none });
  await expect(startSection(page)).toBeVisible();
  const list = listSection(page);
  await expect(list).toBeVisible();
  await expect(list.getByRole("button", { name: "Waypoints 0" })).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("inspector-waypoints")).toHaveCount(0);
});

test("selecting a waypoint shows the Waypoints list with its row open, and no Start", async ({ page }) => {
  await page.evaluate(`import("/src/state/store.ts").then((m) => m.setSelection({ waypoint: "scoreSouth" }))`);
  await expect(page.getByTestId("inspector-waypoint-x")).toBeVisible();
  await expect(listSection(page)).toBeVisible();
  await expect(page.getByTestId("inspector-waypoint-row-scoreSouth")).toHaveAttribute("aria-pressed", "true");
  await expect(startSection(page)).toHaveCount(0);
});

test("Escape from a step goes back to the Routine view", async ({ page }) => {
  await selectStep(page, "driveOut");
  await expect(startSection(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("inspector-routine-head")).toBeVisible();
  await expect(startSection(page)).toBeVisible();
  await expect(listSection(page)).toBeVisible();
});
