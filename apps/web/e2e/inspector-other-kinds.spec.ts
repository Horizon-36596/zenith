/**
 * Issue #242: the command, wait, transfer, marker, piecewise, envelope, sequence and branch
 * Inspectors, decluttered.
 *
 * - A command's summary is the Command row's hint and each option's hint, never a paragraph, and a
 *   `stationary` command shows an anchor beside its estimate, "Stands still" in its tooltip (issue
 *   #431). With shootPreloads selected the Inspector holds at most 320 px (it was 780).
 * - A wait for a condition shows its cap once, as its Give up after row (issue #409), or a warning
 *   chip when the step has no Timeout, in both description modes.
 * - A transfer has a quiet "Planner only" icon in its header and a closed Counts fold that the
 *   Ledger switch gates.
 * - A selected marker has one At row with a unit select and no Placed by row, and its bin is in the
 *   header.
 * - A piecewise range is one 24 px row (its number, span, mode and angles, with scissors and a bin
 *   on hover) with no border, which unfolds to its own rows.
 * - A drawn envelope shows its provenance once, as a chip, with Lasts at most, Corner and Size rows.
 * - Sequence and Branch have no paragraph: their text is the hint on Steps and on the guess chip.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { LARGE_VIEWPORT } from "./viewports";
import { editor, loadExample, openAutoNamed, selectStep, skipTour, waitForFonts } from "./qa/helpers";

const inspector = (page: Page): Locator => page.getByTestId("inspector");

/**
 * How tall what the Inspector holds is. Its scroll area is as tall as the panel, 780 px at 1440x900,
 * so the content's own height is the Inspector element's: it was 780 and more for a command.
 */
const contentHeight = (page: Page) => inspector(page).evaluate((node) => node.scrollHeight);

/** Elements styled as an Inspector note: a paragraph of always-visible prose. */
const noteCount = (page: Page) =>
  inspector(page)
    .locator("*")
    .evaluateAll((all) => all.filter((node) => [...node.classList].some((name) => /^_?note(_|$)/.test(name))).length);

/** A row's hint text, which is hidden beside its control and is the control's description. */
const hintOf = (row: Locator): Locator => row.locator("span[hidden]").first();

const setDescriptions = (page: Page, mode: "compact" | "full") =>
  editor(page, `m.setPrefs({ descriptions: ${JSON.stringify(mode)} })`);

const STEP = (id: string): string => `s.auto.steps.find((x) => x.id === ${JSON.stringify(id)})`;

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
  await waitForFonts(page);
});

test.describe("at 1440x900", () => {
  test.use({ viewport: LARGE_VIEWPORT });

  test("shootPreloads holds at most 320 px, shows no paragraph and says it stands still", async ({ page }) => {
    await selectStep(page, "shootPreloads");
    await expect(page.getByTestId("inspector-command-name")).toBeVisible();
    expect(await contentHeight(page)).toBeLessThanOrEqual(320);
    expect(await noteCount(page)).toBe(0);
    await expect(page.getByTestId("inspector-command-summary")).toHaveCount(0);
    await expect(page.getByTestId("inspector-head").getByTestId("inspector-stands-still")).toHaveText("Stands still");
    // The summary is the hint of the Command row.
    const summary = await editor<string>(
      page,
      `s.project.robot.commands.find((c) => c.name === ${STEP("shootPreloads")}.name).summary`,
    );
    await expect(hintOf(page.getByTestId("inspector-command-name-row"))).toHaveText(summary);
    // A command that is not stationary does not say so.
    await editor(page, `m.commit({ ...s.auto, steps: s.auto.steps.map((x) => x.id === "shootPreloads" ? { ...x, name: "intakeOn", args: undefined } : x) })`);
    await expect(page.getByTestId("inspector-stands-still")).toHaveCount(0);
  });
});

test("the cap is the Give up after row, and no Timeout shows a warning chip in both description modes", async ({ page }) => {
  await selectStep(page, "waitForFull");
  // The cap shows once, in its own row under Until (issue #409), not as a suffix on Until.
  await expect(page.getByTestId("inspector-wait-cap")).toHaveCount(0);
  await expect(page.getByTestId("inspector-timeout")).toHaveValue("1.00");
  await expect(page.getByTestId("inspector-wait-no-timeout")).toHaveCount(0);
  expect(await noteCount(page)).toBe(0);

  await editor(page, `m.commit({ ...s.auto, steps: s.auto.steps.map((x) => x.id === "waitForFull" ? { ...x, timeoutS: undefined } : x) })`);
  for (const mode of ["compact", "full"] as const) {
    await setDescriptions(page, mode);
    const warning = page.getByTestId("inspector-wait-no-timeout");
    await expect(warning, mode).toHaveText("No time limit: may wait to the end");
  }
  // Setting a Timeout takes the warning away.
  await page.getByTestId("inspector-timeout").fill("2");
  await page.getByTestId("inspector-timeout").press("Enter");
  await expect(page.getByTestId("inspector-timeout")).toHaveValue("2.00");
  await expect(page.getByTestId("inspector-wait-no-timeout")).toHaveCount(0);
});

test("with no Timeout, Give up after stays readable above its warning at the Inspector's narrowest", async ({ page }) => {
  await editor(page, `m.setPrefs({ panelRightW: 240 })`);
  await editor(page, `m.commit({ ...s.auto, steps: s.auto.steps.map((x) => x.id === "waitForFull" ? { ...x, timeoutS: undefined } : x) })`);
  await selectStep(page, "waitForFull");
  const field = page.getByTestId("inspector-timeout");
  await expect(field).toHaveAttribute("placeholder", "Never");
  await expect(page.getByTestId("inspector-wait-no-timeout")).toBeVisible();
  // The box shows the whole of "none": it was squeezed to about 20 px, which showed only its "n".
  const fits = await field.evaluate((input) => {
    const box = input as HTMLInputElement;
    const style = getComputedStyle(box);
    const context = document.createElement("canvas").getContext("2d");
    if (context === null) return false;
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const room = box.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return room >= context.measureText(box.placeholder).width;
  });
  expect(fits).toBe(true);
  // The warning sits under the box, not over it.
  const box = await field.boundingBox();
  const chip = await page.getByTestId("inspector-wait-no-timeout").boundingBox();
  expect(chip !== null && box !== null && chip.y >= box.y + box.height - 1).toBe(true);
  // And it wraps inside the Inspector rather than running past its edge.
  const panel = await inspector(page).boundingBox();
  expect(chip !== null && panel !== null && chip.x + chip.width <= panel.x + panel.width).toBe(true);
});

test("a transfer has a Planner only icon in its header and a closed Counts fold the Ledger switch gates", async ({ page }) => {
  await page.getByTestId("insert-step").click();
  await page.getByTestId("insert-kind-transfer").click();
  await expect(page.getByTestId("inspector-transfer-from")).toBeVisible();
  await expect(page.getByTestId("inspector-head").getByTestId("inspector-transfer-planner-only")).toHaveText("Planner only");
  expect(await noteCount(page)).toBe(0);
  const counts = inspector(page).locator('section[data-fold="transfer.counts"]');
  await expect(counts.locator("button[aria-expanded]").first()).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("inspector-transfer-moved")).toHaveCount(0);
  await counts.locator("button[aria-expanded]").first().click();
  await expect(page.getByTestId("inspector-transfer-moved")).toBeVisible();
  await expect(page.getByTestId("inspector-transfer-from-count")).toBeVisible();

  // With the Ledger switch off the fold is gone.
  await editor(page, `m.setPrefs({ features: { ...s.prefs.features, ledger: false } })`);
  await expect(counts).toHaveCount(0);
  await expect(page.getByTestId("inspector-transfer-planner-only")).toBeVisible();
  await expect(page.getByTestId("inspector-transfer-from")).toBeVisible();
});

test("a selected marker has one At row and no Placed by row, with its bin in the header", async ({ page }) => {
  await editor(
    page,
    `m.commit({ ...s.auto, steps: s.auto.steps.map((x) => x.id === "driveOut" ? { ...x, markers: [{ at: { t: 0.5 }, command: { name: "intakeOn" } }] } : x) })`,
  );
  await editor(page, `m.setSelection({ stepId: "driveOut", markerIndex: 0 })`);
  await expect(page.getByTestId("inspector-marker-command")).toBeVisible();
  await expect(page.getByTestId("inspector-marker-placed-by")).toHaveCount(0);
  await expect(page.getByTestId("inspector-marker-summary")).toHaveCount(0);
  const at = page.getByTestId("inspector-marker-at");
  const unit = page.getByTestId("inspector-marker-at-unit");
  // A share of the path reads as a percent (issue #409).
  await expect(at).toHaveValue("50");
  await expect(unit).toHaveValue("t");
  await expect(unit.locator("option")).toHaveText(["% along", "in from start", "in from end"]);

  // The number shown stays as it is, fitted to the new unit's range: 50 in from the end of the
  // 27 in driveOut is its whole length (W2-11).
  await unit.selectOption("distanceFromEndIn");
  await expect
    .poll(() => editor<number>(page, `${STEP("driveOut")}.markers[0].at.distanceFromEndIn`))
    .toBeCloseTo(27, 1);
  await at.fill("12");
  await at.press("Enter");
  await expect.poll(() => editor<unknown>(page, `${STEP("driveOut")}.markers[0].at`)).toEqual({ distanceFromEndIn: 12 });
  await unit.selectOption("t");
  await expect.poll(() => editor<unknown>(page, `${STEP("driveOut")}.markers[0].at`)).toEqual({ t: 0.12 });

  // The bin is the selection header's one action, with no Remove marker button under the rows.
  await expect(page.getByTestId("inspector-head").getByTestId("inspector-marker-remove")).toHaveCount(1);
  await expect(inspector(page).getByTestId("inspector-marker-remove")).toHaveCount(0);
  await page.getByTestId("inspector-marker-remove").click();
  await expect(page.getByTestId("inspector-marker-command")).toHaveCount(0);
  expect(await editor<unknown>(page, `${STEP("driveOut")}.markers`)).toEqual([]);
});

test("a piecewise range is one numbered 24 px row with scissors and a bin, no border, and its rows unfold under it", async ({ page }) => {
  await editor(
    page,
    `m.commit({ ...s.auto, steps: s.auto.steps.map((x) => x.id === "driveOut" ? { ...x, heading: { mode: "piecewise", ranges: [
      { startT: 0, endT: 0.35, heading: { mode: "tangent" } },
      { startT: 0.35, endT: 1, heading: { mode: "constant", headingRad: 1 } } ] } } : x) })`,
  );
  await selectStep(page, "driveOut");
  for (const index of [0, 1]) {
    const range = page.getByTestId(`heading-range-${String(index)}`);
    await expect(range).toBeVisible();
    const borders = await range.evaluate((node) => {
      const style = getComputedStyle(node);
      return [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth];
    });
    expect(borders, `range ${String(index)}`).toEqual(["0px", "0px", "0px", "0px"]);
    const head = page.getByTestId(`heading-range-${String(index)}-head`);
    expect((await head.boundingBox())?.height, `range ${String(index)}`).toBe(24);
    await expect(head.getByTestId(`heading-range-${String(index)}-split`)).toHaveCount(1);
    await expect(head.getByTestId(`heading-range-${String(index)}-delete`)).toHaveCount(1);
  }
  // Its number, its span, its mode, and its angles; a range the path decides says so in words.
  await expect(page.getByTestId("heading-range-0-head")).toHaveText(/^1\s*0–35%\s*Tangent\s*follows the path$/);
  await expect(page.getByTestId("heading-range-1-head")).toHaveText(/^2\s*35–100%\s*Constant\s*57\.3°$/);
  // Its rows unfold under it on a click, with their values on the 120 px column.
  await expect(page.getByTestId("heading-range-1-constant")).toHaveCount(0);
  await page.getByTestId("heading-range-1-toggle").click();
  await expect(page.getByTestId("heading-range-1-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("heading-range-1-constant")).toHaveValue("57.3");
  const [modeX, rowValueX] = await Promise.all([
    page.getByTestId("heading-range-1-mode").evaluate((node) => node.getBoundingClientRect().left),
    page.getByTestId("inspector-heading-mode").evaluate((node) => node.getBoundingClientRect().left),
  ]);
  expect(Math.abs(modeX - rowValueX)).toBeLessThanOrEqual(1);
  // The scissors and the bin show on the row's hover, and on keyboard focus.
  const actions = (index: number) =>
    page.getByTestId(`heading-range-${String(index)}-split`).evaluate((button) => getComputedStyle(button.closest('[class*="rangeActions"]') as HTMLElement).opacity);
  await page.mouse.move(5, 5);
  await expect.poll(() => actions(0)).toBe("0");
  await page.getByTestId("heading-range-0-head").hover();
  await expect.poll(() => actions(0)).toBe("1");
  await page.mouse.move(5, 5);
  await page.getByTestId("heading-range-0-toggle").focus();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("heading-range-0-split")).toBeFocused();
  await expect.poll(() => actions(0)).toBe("1");
});

test("a drawn envelope shows its provenance once, as a chip, with Lasts at most, Corner and Size", async ({ page }) => {
  await selectStep(page, "shootPreloads");
  await editor(
    page,
    `m.commit({ ...s.auto, steps: s.auto.steps.map((x) => x.id === "shootPreloads" ? { ...x, envelope: { polygon: [{ xIn: -24, yIn: -48 }, { xIn: 0, yIn: -48 }, { xIn: 0, yIn: -24 }, { xIn: -24, yIn: -24 }], maxDurationS: 2.6, provenance: "SET FROM EDITOR: drawn on the field" } } : x) })`,
  );
  const envelope = inspector(page).locator('section[data-fold="envelope"]');
  await expect(envelope.getByText("Lasts at most")).toBeVisible();
  await expect(envelope.getByText("Longest it runs")).toHaveCount(0);
  await expect(envelope.getByText("Provenance", { exact: true })).toHaveCount(0);
  await expect(envelope.getByText("Corner", { exact: true })).toBeVisible();
  await expect(envelope.getByText("Size", { exact: true })).toBeVisible();
  // The provenance appears once, as the chip, and no text field holds it.
  await expect(envelope.locator('[data-tour="provenance"]')).toHaveCount(1);
  await expect(envelope.getByTestId("inspector-envelope-provenance")).toHaveText("From editor");
  await expect(envelope.locator('input[value*="SET FROM EDITOR"]')).toHaveCount(0);
  await expect(envelope.getByTestId("inspector-envelope-seconds")).toHaveValue("2.6");
  await expect(envelope.getByTestId("inspector-envelope-w")).toHaveValue("24.00");
  await expect(envelope.getByTestId("inspector-envelope-h")).toHaveValue("24.00");
  // The bin is in the header.
  // The header row is the section's own first child; the body is its second, and it holds no bin.
  await expect(envelope.locator(":scope > div").first().getByTestId("inspector-envelope-remove")).toHaveCount(1);
  await expect(envelope.locator(":scope > div").nth(1).getByTestId("inspector-envelope-remove")).toHaveCount(0);
  await envelope.getByTestId("inspector-envelope-remove").click();
  await expect(envelope).toHaveCount(0);
});

test("a Sequence has no paragraph, and its text is the hint on Steps", async ({ page }) => {
  await page.getByTestId("insert-step").click();
  await page.getByTestId("insert-kind-sequence").click();
  // Its one member is listed (issue #409).
  await expect(page.getByTestId("inspector-members").locator('button[data-testid^="inspector-member-"]')).toHaveCount(1);
  expect(await noteCount(page)).toBe(0);
  // Its own Steps section counts it, and what the list is for is a member row's long-hover hint.
  await expect(inspector(page).locator('section[data-fold="group.steps"] button[aria-expanded]').first()).toHaveText(/^Steps\s*1$/);
  await page.getByTestId("inspector-members").locator('button[data-testid^="inspector-member-"]').first().hover();
  await expect(page.getByRole("tooltip")).toContainText("Drag steps onto the group");
});

test("a Branch has no paragraph, and its reason is the hint on the guess chip", async ({ page }) => {
  await openAutoNamed(page, "all-step-kinds.auto.json");
  await page.getByTestId("step-main-checkPollen").click();
  await expect(page.getByTestId("inspector-branch-side")).toBeVisible();
  expect(await noteCount(page)).toBe(0);
  // robot.json does not say how the ledger reads holdingPiece, so the side is a guess, and the
  // reason is the chip's tooltip, not a paragraph.
  await expect(page.getByTestId("inspector-branch-side")).toHaveText("If true");
  await page.getByTestId("inspector-branch-guess").hover();
  await expect(page.getByRole("tooltip")).toContainText('does not say how the ledger reads "holdingPiece"');
});
