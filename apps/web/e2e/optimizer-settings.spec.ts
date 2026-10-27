/**
 * The optimizer's settings (issue #305): the Optimize path switch in Settings, General, which is off in
 * Basic and on otherwise, and the rows in Settings, Editor that appear with it: the robot's safety
 * margin, shown and explained but never a person's setting, and the card's remembered options.
 */
import { expect, test, type Page } from "@playwright/test";

const TOUR_SEEN = { tour: { seen: true, coreDone: true, fullDone: false } };

/** Stores `prefs` before the page loads, once, so a reload keeps whatever the test changed. */
async function storePrefs(page: Page, prefs: Record<string, unknown>): Promise<void> {
  await page.addInitScript((stored: Record<string, unknown>) => {
    if (window.localStorage.getItem("zenith.ui") === null) window.localStorage.setItem("zenith.ui", JSON.stringify(stored));
    window.localStorage.removeItem("zenith.cloudFake");
  }, prefs);
}

async function loadExample(page: Page): Promise<void> {
  await page.goto("/?cloud=fake");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
}

async function openSection(page: Page, section: "general" | "editor"): Promise<void> {
  await page.getByTestId("toolbar-settings").click();
  await page.getByTestId(`settings-nav-${section}`).click();
  await expect(page.getByTestId(`settings-section-${section}`)).toBeVisible();
}

test("Optimize path is on by default, its rows show the robot's margin and keep the card's options", async ({ page }) => {
  await storePrefs(page, TOUR_SEEN);
  await loadExample(page);

  await openSection(page, "general");
  await expect(page.getByTestId("settings-feature-optimizer-choice-on")).toHaveAttribute("aria-pressed", "true");

  await page.getByTestId("settings-nav-editor").click();
  const group = page.getByTestId("settings-optimize");
  await expect(group).toBeVisible();
  // The margin is the robot's, read only here, with the helper text about Pedro's drift and the instant sim.
  await expect(page.getByTestId("settings-optimize-margin-value")).toHaveText("1 in");
  const margin = page.getByTestId("settings-optimize-margin");
  await expect(margin).toContainText("2.5 in");
  await expect(margin).toContainText("instant sim");
  // The margin row has nothing to type into; the only inputs in the group are the two heading holds (issue #448).
  await expect(margin.locator("input")).toHaveCount(0);
  await expect(group.locator("input")).toHaveCount(2);

  await expect(page.getByTestId("settings-optimize-scorer-choice-sim")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("settings-optimize-split-choice-on")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("settings-optimize-ranges-choice-on")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("settings-optimize-scorer-choice-estimate").click();
  await page.getByTestId("settings-optimize-split-choice-off").click();

  await page.reload();
  await page.getByTestId("canvas-load-example").click();
  await openSection(page, "editor");
  await expect(page.getByTestId("settings-optimize-scorer-choice-estimate")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("settings-optimize-split-choice-off")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("settings-optimize-ranges-choice-on")).toHaveAttribute("aria-pressed", "true");
  const saved = await page.evaluate(() => JSON.parse(window.localStorage.getItem("zenith.ui") ?? "{}") as Record<string, unknown>);
  expect(saved["optimizeScorer"]).toBe("estimate");
  expect(saved["optimizeAllowSplit"]).toBe(false);
  expect(Object.keys(saved).filter((key) => /margin/i.test(key))).toEqual([]);
});

test("the heading holds start off, keep a typed length across a reload, and refuse one past the field's side (issues #448, #502)", async ({ page }) => {
  await storePrefs(page, TOUR_SEEN);
  await loadExample(page);
  await openSection(page, "editor");
  const holdEnd = page.getByTestId("settings-editing-optimizeHoldEndHeadingIn");
  const holdStart = page.getByTestId("settings-editing-optimizeHoldStartHeadingIn");
  await expect(holdStart).toHaveValue("0");
  await expect(holdEnd).toHaveValue("0");
  await holdEnd.fill("12");
  await holdEnd.press("Enter");
  // A length past the field's side is refused with the range, never clamped in silence (#520), so
  // the most a hold takes is the field's side.
  await holdStart.fill("500");
  await holdStart.press("Enter");
  await expect(page.getByTestId("status")).toContainText("runs 0 to 144 in.");
  await expect(holdStart).toHaveValue("0");
  await holdStart.fill("144");
  await holdStart.press("Enter");

  await page.reload();
  await page.getByTestId("canvas-load-example").click();
  await openSection(page, "editor");
  await expect(page.getByTestId("settings-editing-optimizeHoldEndHeadingIn")).toHaveValue("12");
  await expect(page.getByTestId("settings-editing-optimizeHoldStartHeadingIn")).toHaveValue("144");
  const saved = await page.evaluate(() => JSON.parse(window.localStorage.getItem("zenith.ui") ?? "{}") as Record<string, unknown>);
  expect([saved["optimizeHoldStartHeadingIn"], saved["optimizeHoldEndHeadingIn"]]).toEqual([144, 12]);
});

/**
 * The 0.1.2 UX sweep (W1-15): "Hold start heading 0 in" read as a heading in inches. The labels say
 * "for", and With descriptions shows each hold's line under its label, as the other rows do.
 */
test("the heading holds read as lengths, and With descriptions shows what each does", async ({ page }) => {
  await storePrefs(page, { ...TOUR_SEEN, descriptions: "full" });
  await loadExample(page);
  await openSection(page, "editor");
  const start = page.getByTestId("settings-row-optimizeHoldStartHeadingIn");
  const end = page.getByTestId("settings-row-optimizeHoldEndHeadingIn");
  await expect(start).toContainText("Hold start heading for");
  await expect(end).toContainText("Hold end heading for");
  await expect(start).toContainText("How far the route keeps its starting heading");
  await expect(end).toContainText("How far before the end the heading is reached");
});

test("turning the switch off takes the Optimize rows out of Settings, Editor and keeps the choices", async ({ page }) => {
  await storePrefs(page, { ...TOUR_SEEN, optimizeScorer: "estimate" });
  await page.goto("/?cloud=fake");

  await openSection(page, "general");
  await page.getByTestId("settings-feature-optimizer-choice-off").click();
  await expect(page.getByTestId("settings-feature-optimizer-choice-off")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("settings-nav-editor").click();
  await expect(page.getByTestId("settings-section-editor")).toBeVisible();
  await expect(page.getByTestId("settings-optimize")).toHaveCount(0);

  await page.getByTestId("settings-nav-general").click();
  await page.getByTestId("settings-feature-optimizer-choice-on").click();
  await page.getByTestId("settings-nav-editor").click();
  await expect(page.getByTestId("settings-optimize-scorer-choice-estimate")).toHaveAttribute("aria-pressed", "true");
  // With no project open there is no robot to read a margin from.
  await expect(page.getByTestId("settings-optimize-margin-value")).toHaveText("No project open");
});

test("the Basic preset leaves Optimize path off until someone turns it on", async ({ page }) => {
  await storePrefs(page, { ...TOUR_SEEN, preset: { id: "basic", chosen: true } });
  await page.goto("/?cloud=fake");
  await openSection(page, "general");
  await expect(page.getByTestId("settings-feature-optimizer-choice-off")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("settings-feature-optimizer-choice-on").click();
  await expect(page.getByTestId("settings-feature-optimizer-choice-on")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("settings-nav-editor").click();
  await expect(page.getByTestId("settings-optimize")).toBeVisible();
});
