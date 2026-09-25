/**
 * QA 11, the problems panel (UI_GUIDE section 9.7, site/docs/checks-and-findings.md): rows are not
 * tinted, the severity is the icon; the code chip has a tooltip that says what the code means and
 * how to fix it; the selected step's findings carry a "How to fix" line; clicking a row selects its
 * step; the severity counts filter the list.
 */
import { expect, test, type Page } from "@playwright/test";
import { editor, knownBug, loadExample, shot, skipTour } from "./helpers";

/**
 * The example's autos validate clean. collect-and-score, the one it opens, raises one finding,
 * TIME_BUDGET on `total`, an info that is not on a step. Running its sweepGarden leg at 0.8 adds
 * SWEEP_SPEED, a warning on a real step, so the panel has two severities and a row to click.
 */
test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
  await page.evaluate(
    `import("/src/state/store.ts").then((m) => { const s = m.getState(); m.commit({ ...s.auto, steps: s.auto.steps.map((x) => x.id !== "sweepGarden" ? x : { ...x, speedFraction: 0.8 }) }); })`,
  );
  await expect(page.getByTestId("finding-row").filter({ hasText: "SWEEP_SPEED" })).toHaveCount(1);
  await expect(page.getByTestId("finding-row").filter({ hasText: "TIME_BUDGET" })).toHaveCount(1);
});

const findings = (page: Page) =>
  editor<Array<{ code: string; severity: string; stepId?: string; message: string }>>(page, "m.currentDerived().findings");

test("rows are not tinted by severity: an idle row has the panel's own background", async ({ page }) => {
  await page.mouse.move(2, 2);
  const colours = await page.getByTestId("finding-row").evaluateAll((rows) =>
    rows.map((row) => ({ severity: row.getAttribute("data-severity"), bg: getComputedStyle(row).backgroundColor, selected: row.getAttribute("data-selected") })),
  );
  expect(colours.length).toBeGreaterThan(0);
  for (const row of colours.filter((c) => c.selected !== "true")) {
    expect(row.bg, `${row.severity ?? ""} row`).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  }
  // The icon carries the colour instead, and differs by severity.
  const iconColours = await page.getByTestId("finding-row").evaluateAll((rows) =>
    Object.fromEntries(rows.map((row) => [row.getAttribute("data-severity"), getComputedStyle(row.querySelector("svg") as Element).color])),
  );
  const distinct = new Set(Object.values(iconColours));
  expect(distinct.size).toBe(Object.keys(iconColours).length);
  await shot(page, "11-problems");
});

test("every code chip has a tooltip with what it means and how to fix it", async ({ page }) => {
  const codes = await page.getByTestId("finding-code").allTextContents();
  const unique = [...new Set(codes.map((code) => code.trim()))];
  expect(unique.length).toBeGreaterThan(0);
  for (const code of unique) {
    const chip = page.getByTestId("finding-code").filter({ hasText: code }).first();
    await chip.hover();
    const tip = page.getByRole("tooltip");
    await expect(tip, `${code} tooltip`).toBeVisible();
    await expect(tip, `${code} tooltip has a how-to-fix`).toContainText("How to fix:");
    await expect(tip).not.toContainText(new RegExp(`^${code}$`));
    await page.mouse.move(2, 2);
  }
  // The chip is focusable and its tooltip opens on keyboard focus as well.
  await page.getByTestId("finding-code").first().focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("finding-code").first()).toBeFocused();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await shot(page, "11-code-tooltip");
});

test("clicking a row selects its step and shows the how-to-fix line on that step's rows", async ({ page }) => {
  // SWEEP_SPEED on sweepGarden, from the beforeEach, is the finding on a real step to click.
  const ids = await editor<string[]>(page, "s.auto.steps.map((x) => x.id)");
  const all = await findings(page);
  const withStep = all.filter((finding) => finding.stepId !== undefined && ids.includes(finding.stepId));
  expect(withStep.length).toBeGreaterThan(0);
  await expect(page.getByTestId("finding-how-to")).toHaveCount(0);
  const target = withStep[0];
  const row = page.getByTestId("finding-row").filter({ hasText: target?.message.slice(0, 30) ?? "" }).first();
  await row.click();
  expect(await editor<string | undefined>(page, "s.selection.stepId")).toBe(target?.stepId);
  await expect(row).toHaveAttribute("data-selected", "true");
  await expect(row.getByTestId("finding-how-to")).toContainText(/How to fix: \S/);
  await expect(page.getByTestId(`step-row-${target?.stepId ?? ""}`)).toHaveAttribute("data-selected", "true");
  await shot(page, "11-problems-selected");
});

test("every finding the example raises has a how-to-fix line once its step is selected", async ({ page }) => {
  const all = await findings(page);
  for (const finding of all.filter((f) => f.stepId !== undefined)) {
    await page.evaluate(`import("/src/state/store.ts").then((m) => m.selectStep(${JSON.stringify(finding.stepId)}))`);
    // Two steps can raise the same message; the selected one is the row marked selected.
    const row = page.getByTestId("finding-row").filter({ hasText: finding.code }).filter({ hasText: finding.message.slice(0, 30) });
    const selected = row.and(page.locator('[data-selected="true"]'));
    await expect(selected.first().getByTestId("finding-how-to"), `${finding.code} on ${finding.stepId ?? ""}`).toContainText("How to fix:");
  }
});

test("a finding row can be selected from the keyboard", async ({ page }) => {
  const chip = page.getByTestId("finding-code").first();
  await chip.focus();
  const before = await editor<string | undefined>(page, "s.selection.stepId");
  await page.keyboard.press("Enter");
  const after = await editor<string | undefined>(page, "s.selection.stepId");
  expect(after).not.toBe(before);
  expect(after).toBeDefined();
});

test("the severity counts filter the list and toggle back", async ({ page }) => {
  const all = await findings(page);
  const severities = [...new Set(all.map((finding) => finding.severity))];
  for (const severity of severities) {
    const toggle = page.getByTestId(`findings-count-${severity}`);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    const shown = await page.getByTestId("finding-row").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-severity")));
    expect(new Set(shown)).toEqual(new Set([severity]));
    expect(shown.length).toBe(all.filter((finding) => finding.severity === severity).length);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
  }
  await expect(page.getByTestId("finding-row")).toHaveCount(all.length);
});
