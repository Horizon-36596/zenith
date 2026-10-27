/**
 * Issue #410, unit "inspector-rows": the rows and lists the Inspector draws, and the command palette.
 *
 * - An angle shows wrapped into (-180, 180] with one decimal and its degree sign tight against it,
 *   and typing 270 writes 270 degrees as typed. An empty nullable number shows its placeholder alone.
 * - A section's `?` is quiet until the header is hovered or focused; the selection header's stays.
 * - A piecewise heading speaks in percent of the path, and a block too narrow for its label shows none.
 * - A command argument is called by its sentence-cased key, with the raw key in the row's hint.
 * - The stay-inside box's words, the Waypoints header, its Pins choice on the column headings' line
 *   and rows, and the save-as-waypoint button that only a pose of its own offers.
 * - Every row sits on one grid (issue #431): labels at 24 px, values at 120 px, in every section.
 * - The palette keeps the first row active under a resting pointer, ranks label matches first, finds
 *   steps, says why a row cannot run and leads with the recent actions.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { editor, loadExample, openMore, selectStep, skipTour, waitForFonts } from "./qa/helpers";
import { VIEWPORT } from "./viewports";

test.use({ viewport: VIEWPORT });

test.beforeEach(async ({ page }) => {
  await skipTour(page, { waypointPins: "all" });
  await loadExample(page);
  await waitForFonts(page);
});

const stepOf = (page: Page, id: string) =>
  editor<Record<string, unknown>>(page, `s.auto.steps.find((x) => x.id === ${JSON.stringify(id)})`);

/** Types into a number field the way a student does: click, select all, type, Enter. */
async function typeInto(page: Page, testId: string, text: string): Promise<void> {
  const input = page.getByTestId(testId);
  await input.click();
  await input.selectText();
  await input.pressSequentially(text);
  await input.press("Enter");
}

/** The ids of the palette's rows, top to bottom, and which one is active. */
const paletteRows = (page: Page) =>
  page.getByTestId("palette-results").locator('[role="option"]').evaluateAll((rows) =>
    rows.map((row) => ({ id: row.getAttribute("data-testid") ?? "", active: row.getAttribute("aria-selected") === "true", disabled: (row as HTMLButtonElement).disabled })),
  );

const activeRow = async (page: Page): Promise<string | undefined> => (await paletteRows(page)).find((row) => row.active)?.id;

async function openPalette(page: Page): Promise<void> {
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("palette-input")).toBeFocused();
}

/* ---- Number rows --------------------------------------------------------------------------- */

test("a heading stored as pi shows 180.0 with the degree sign tight, and typing 270 stores 270 degrees", async ({ page }) => {
  await editor(
    page,
    `m.commit({ ...s.auto, steps: s.auto.steps.map((x) => x.id === "sweepGarden" ? { ...x, heading: { mode: "constant", headingRad: -Math.PI } } : x) })`,
  );
  await selectStep(page, "sweepGarden");
  const field = page.getByTestId("inspector-heading-constant");
  await expect(field).toHaveValue("180.0");
  // The degree sign sits right after the number's last digit, not a field's width away.
  const gap = await field.evaluate((input) => {
    const unit = input.parentElement?.querySelector(".unit");
    if (unit === null || unit === undefined) return Number.NaN;
    const style = getComputedStyle(input);
    const textEnd = input.getBoundingClientRect().right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth);
    return unit.getBoundingClientRect().left - textEnd;
  });
  expect(gap).toBeGreaterThanOrEqual(-1);
  expect(gap).toBeLessThanOrEqual(3);

  await typeInto(page, "inspector-heading-constant", "270");
  await expect.poll(async () => ((await stepOf(page, "sweepGarden")) as { heading: { headingRad: number } }).heading.headingRad).toBeCloseTo((270 * Math.PI) / 180, 9);
  // What is shown is wrapped; what is stored is as typed.
  await expect(field).toHaveValue("-90.0");
});

test("an empty timeout shows its placeholder alone, with no unit after it", async ({ page }) => {
  await selectStep(page, "driveOut");
  // A path's time limit is Give up after, in Speed (issue #431).
  const row = page.getByTestId("inspector-timeout-row");
  await expect(row).toContainText("Give up after");
  const input = page.getByTestId("inspector-timeout");
  await expect(input).toHaveAttribute("placeholder", "Never");
  await expect(input).toHaveValue("");
  await expect(row).not.toContainText("none s");
  await expect(row.locator(".unit")).toHaveCount(0);
  // A typed value brings the unit back.
  await typeInto(page, "inspector-timeout", "3");
  await expect(row.locator(".unit")).toHaveText("s");
  // Clearing the stored value to retype it keeps the unit right after the box: the field is not
  // empty yet. The box takes the width of its placeholder, Never, so the gap is what stays put.
  const unitGap = async () => {
    const unit = await row.locator(".unit").boundingBox();
    const box = await input.boundingBox();
    return unit === null || box === null ? Number.NaN : unit.x - (box.x + box.width);
  };
  const before = await unitGap();
  await input.click();
  await input.press("ControlOrMeta+a");
  await input.press("Backspace");
  await expect(input).toHaveValue("");
  await expect(row.locator(".unit")).toHaveText("s");
  expect(await unitGap()).toBeCloseTo(before, 0);
});

/* ---- The grid (issue #431) ---------------------------------------------------------------- */

/** Where a row's label text and its value start, from the Inspector's left edge. */
async function columns(page: Page, row: Locator): Promise<{ label: number; value: number }> {
  const panel = await page.getByTestId("inspector").boundingBox();
  return row.evaluate((node, left) => {
    const label = node.querySelector("label, [data-pose-label]") as HTMLElement;
    const control = node.querySelector(":scope > div:nth-of-type(1) > *:not([hidden])") as HTMLElement | null;
    const value = control ?? (node.children[1] as HTMLElement);
    const style = getComputedStyle(value);
    const inset = value instanceof HTMLInputElement || value instanceof HTMLSelectElement || value.tagName === "BUTTON"
      ? parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth)
      : 0;
    return { label: Math.round(label.getBoundingClientRect().left - left), value: Math.round(value.getBoundingClientRect().left + inset - left) };
  }, panel?.x ?? 0);
}

test("every row's label starts at 24 px and its value at 120 px, in every section, and in a sub-group too", async ({ page }) => {
  await selectStep(page, "toOtherSide");
  const rowOf = (testId: string) => page.getByTestId(testId).locator("xpath=ancestor::div[contains(@class, 'row')][1]");
  for (const testId of ["inspector-heading-mode", "inspector-speed", "inspector-end-condition", "inspector-timeout"]) {
    const at = await columns(page, rowOf(testId));
    expect(at, testId).toEqual({ label: 24, value: 120 });
  }
  // A chain's paths are sub-groups: their labels move to 40 px, their values stay at 120 px.
  await page.getByTestId("inspector-chain-add").click();
  await selectStep(page, "toOtherSide");
  const kind = await columns(page, rowOf("inspector-segment-kind-0"));
  expect(kind).toEqual({ label: 40, value: 120 });
  // Labels are 12 px in --text-lo; values left-aligned.
  const style = await rowOf("inspector-heading-mode").evaluate((row) => {
    const label = getComputedStyle(row.querySelector("label") as HTMLElement);
    return { size: label.fontSize, align: getComputedStyle(row.querySelector(":scope > div") as HTMLElement).textAlign };
  });
  expect(style).toEqual({ size: "12px", align: "left" });
});

test("sections are separated by full-bleed hairlines under 28 px uppercase headers", async ({ page }) => {
  await selectStep(page, "driveOut");
  const heading = page.locator('section[data-fold="path.heading"]');
  const look = await heading.evaluate((node) => {
    const head = node.querySelector("button[aria-expanded]") as HTMLElement;
    const style = getComputedStyle(head);
    const box = node.getBoundingClientRect();
    const panel = (node.closest('[data-testid="inspector"]') as HTMLElement).getBoundingClientRect();
    return {
      height: head.getBoundingClientRect().height,
      transform: style.textTransform,
      size: style.fontSize,
      weight: style.fontWeight,
      rule: getComputedStyle(node).borderBottomWidth,
      fullBleed: Math.round(box.left - panel.left) === 0 && Math.round(panel.right - box.right) === 0,
    };
  });
  expect(look).toEqual({ height: 28, transform: "uppercase", size: "11px", weight: "600", rule: "1px", fullBleed: true });
  // The DOM keeps the title in sentence case, so a screen reader says it as a word.
  await expect(heading.locator("button[aria-expanded]").first()).toHaveText("Heading");
});

/* ---- Section help -------------------------------------------------------------------------- */

test("a section's ? is quiet at rest, shown on a header hover or keyboard focus, and the selection header's stays", async ({ page }) => {
  await selectStep(page, "driveOut");
  const head = page.locator('section[data-fold="path.heading"]');
  const help = head.locator('button:text-is("?")');
  const opacity = () => help.evaluate((button) => getComputedStyle(button.parentElement as HTMLElement).opacity);
  await page.mouse.move(5, 5);
  await expect.poll(opacity).toBe("0");
  await head.locator("button[aria-expanded]").first().hover();
  await expect.poll(opacity).toBe("1");
  await page.mouse.move(5, 5);
  await expect.poll(opacity).toBe("0");
  // Still in the tab order: Tab from the header's button reaches it, and it shows.
  await head.locator("button[aria-expanded]").first().focus();
  await page.keyboard.press("Tab");
  await expect(help).toBeFocused();
  await expect.poll(opacity).toBe("1");
  // The region title's ? is not inside any section and never fades.
  const titles = await page.locator('button:text-is("?")').evaluateAll((buttons) =>
    buttons.filter((button) => button.closest("section") === null).map((button) => getComputedStyle(button.parentElement as HTMLElement).opacity),
  );
  expect(titles.length).toBeGreaterThan(0);
  expect(titles.every((value) => value === "1")).toBe(true);
  // Nor does the selection header's, which is the Inspector's title now (issue #431).
  await page.mouse.move(5, 5);
  const selection = page.getByTestId("inspector-head").locator('button:text-is("?")');
  await expect(selection).toHaveCount(1);
  expect(await selection.evaluate((button) => getComputedStyle(button.parentElement as HTMLElement).opacity)).toBe("1");
});

/* ---- Piecewise ranges ---------------------------------------------------------------------- */

test("piecewise ranges are in percent: a 0–20% row, Ends at 20%, an axis of 0% to 100%, and 35 writes t 0.35", async ({ page }) => {
  await selectStep(page, "toOtherSide");
  await expect(page.getByTestId("heading-range-0-head")).toContainText("0–20%");
  await expect(page.getByTestId("heading-range-1-head")).toContainText("20–");
  await expect(page.getByTestId("heading-range-0-toggle")).toHaveAccessibleName(/^Range 1, 0–20%, Linear$/);
  await page.getByTestId("heading-range-0-toggle").click();
  const row = page.getByTestId("heading-range-0").locator("[data-testid=heading-range-0-end]").locator("xpath=ancestor::div[contains(@class, 'row')][1]");
  await expect(row).toContainText("Ends at");
  await expect(page.getByTestId("heading-range-0-end")).toHaveValue("20");
  await expect(row.locator(".unit")).toHaveText("%");
  await expect(page.getByTestId("heading-ranges")).not.toContainText(/\bt\b/);
  await expect(page.getByTestId("heading-ranges")).toContainText("0%");
  await expect(page.getByTestId("heading-ranges")).toContainText("100%");

  await typeInto(page, "heading-range-0-end", "35");
  await expect.poll(async () => ((await stepOf(page, "toOtherSide")) as { heading: { ranges: Array<{ endT: number }> } }).heading.ranges[0]?.endT).toBeCloseTo(0.35, 9);
});

test("a track block too narrow for its label shows no text, and its tooltip names the mode", async ({ page }) => {
  await selectStep(page, "toOtherSide");
  // The example's last range is about 13% of a track that is ~280 px wide: too narrow for "Linear".
  const narrow = page.getByTestId("heading-track-block-2");
  const wide = page.getByTestId("heading-track-block-1");
  await expect(wide.locator("span")).toBeVisible();
  await expect(narrow.locator("span")).toBeHidden();
  await narrow.hover();
  await expect(page.locator('[role="tooltip"]')).toContainText("Range 3: Linear");
});

/* ---- Argument labels and the stay-inside box ------------------------------------------------ */

test("a command's argument is called Count, with the raw key in the row's hint", async ({ page }) => {
  await selectStep(page, "shootPreloads");
  const input = page.getByTestId("inspector-arg-count");
  await expect(input).toBeVisible();
  const label = page.locator("label", { hasText: /^Count$/ });
  await expect(label).toHaveCount(1);
  await expect(page.locator("label", { hasText: /^count$/ })).toHaveCount(0);
  const describedBy = await input.getAttribute("aria-describedby");
  const hint = await page.evaluate((ids) => (ids ?? "").split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" "), describedBy);
  expect(hint).toContain("count");
});

test("Advanced names the box 'Stay inside' and its text buttons Draw box and Add 24 in, in the value column", async ({ page }) => {
  await selectStep(page, "driveOut");
  await openMore(page);
  await expect(page.getByText("Stay inside", { exact: true })).toBeVisible();
  await expect(page.getByTestId("inspector-envelope-draw")).toHaveText("Draw box");
  await expect(page.getByTestId("inspector-envelope-add")).toHaveText("Add 24 in");
  const draw = await page.getByTestId("inspector-envelope-draw").boundingBox();
  const panel = await page.getByTestId("inspector").boundingBox();
  // Its text starts on the value column, 120 px in, past its 4 px of padding.
  expect(Math.round((draw?.x ?? 0) + 4 - (panel?.x ?? 0))).toBe(120);
});

/* ---- Waypoints list ------------------------------------------------------------------------ */

const waypointSection = (page: Page) => page.locator('section[data-fold="waypoint.list"]');

test("the Waypoints header is 'Waypoints 7', the rest under 'Other waypoints 2', and Pins sits on the column headings' line", async ({ page }) => {
  const head = waypointSection(page).locator("button").first();
  await expect(head).toHaveText(/^Waypoints\s*7$/);
  await expect(head.locator("svg")).toHaveCount(1); // the fold triangle alone
  await expect(page.getByTestId("inspector-waypoints-others")).toHaveText(/^Other waypoints\s*2$/);
  const pins = page.getByTestId("inspector-waypoints-pins");
  await expect(pins.locator("xpath=ancestor::*[@data-testid='inspector-waypoints-columns'][1]")).toHaveCount(1);
  await expect(pins.locator("svg")).toHaveCount(1);
  await expect(page.getByTestId("inspector-waypoints-show")).toHaveText("All");
  await expect(page.getByTestId("inspector-waypoints-show")).toHaveAccessibleName("Pins: All");
  // The tooltip says how many pins are hidden.
  await page.getByTestId("inspector-waypoint-eye-park").click();
  await page.getByTestId("inspector-waypoints-show").hover();
  await expect(page.locator('[role="tooltip"]')).toContainText("1 of 9 pins are hidden now.");
});

test("a waypoint row's eye and ⋯ show on hover or focus, and a hidden pin keeps its eye", async ({ page }) => {
  const shown = (testId: string) =>
    page.getByTestId(testId).evaluate((button) => getComputedStyle(button.parentElement as HTMLElement).opacity);
  await page.mouse.move(5, 5);
  await expect.poll(() => shown("inspector-waypoint-eye-scoreSouth")).toBe("0");
  await expect.poll(() => shown("inspector-waypoint-more-scoreSouth")).toBe("0");
  await page.getByTestId("inspector-waypoint-row-scoreSouth").hover();
  await expect.poll(() => shown("inspector-waypoint-eye-scoreSouth")).toBe("1");
  await expect.poll(() => shown("inspector-waypoint-more-scoreSouth")).toBe("1");
  await page.mouse.move(5, 5);
  await page.getByTestId("inspector-waypoint-row-scoreSouth").focus();
  await expect.poll(() => shown("inspector-waypoint-more-scoreSouth")).toBe("1");
  // A hidden pin's eye-off stays, so it is easy to show again.
  await page.getByTestId("inspector-waypoint-eye-park").click();
  await page.mouse.move(5, 5);
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
  await expect.poll(() => shown("inspector-waypoint-eye-park")).toBe("1");
  await expect.poll(() => shown("inspector-waypoint-more-park")).toBe("0");
});

test("the list has one 'x y heading' heading row, headings read 90.0°, and a long name keeps its last word", async ({ page }) => {
  const columns = page.getByTestId("inspector-waypoints-columns");
  await expect(columns).toHaveText(/x\s*y\s*heading/);
  await expect(page.getByTestId("inspector-waypoint-start-h")).toHaveValue("90.0");
  const name = page.getByTestId("inspector-waypoint-row-flowerNorthApproach");
  await expect(name).toHaveAttribute("title", "flowerNorthApproach");
  await expect(name).toHaveText("flowerNorthApproach");
  const cut = await name.evaluate((button) => {
    const head = button.children[0] as HTMLElement;
    const tail = button.children[1] as HTMLElement;
    return { cut: head.scrollWidth > head.clientWidth, tail: tail.textContent, tailShown: tail.getBoundingClientRect().right <= button.getBoundingClientRect().right + 1 };
  });
  expect(cut.tail).toBe("Approach");
  expect(cut.tailShown).toBe(true);
});

test.describe("on a touch screen", () => {
  // A touch screen reports no hover (`(hover: none)`), so what a pointer reveals is drawn at rest
  // (issue #431).
  test.use({ hasTouch: true, isMobile: true });

  test("a list's eyes, menus, bins and scissors are always shown", async ({ page }) => {
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
    const shown = (testId: string, holder: string) =>
      page.getByTestId(testId).evaluate((button, cls) => getComputedStyle(button.closest(`[class*="${cls}"]`) as HTMLElement).opacity, holder);
    await expect.poll(() => shown("inspector-waypoint-eye-scoreSouth", "eye")).toBe("1");
    await expect.poll(() => shown("inspector-waypoint-more-scoreSouth", "more")).toBe("1");
    await editor(page, `m.selectStep("toOtherSide")`);
    await expect.poll(() => shown("heading-range-0-split", "rangeActions")).toBe("1");
    await editor(page, `import("/src/app/edits.ts").then((e) => e.appendPathToChain("toOtherSide"))`);
    await expect.poll(() => shown("inspector-segment-remove-1", "sectionActions")).toBe("1");
    await editor(page, `m.selectStep("collectFlower")`);
    await expect.poll(() => shown("inspector-marker-remove-0", "hoverAction")).toBe("1");
  });
});

test("a selected waypoint row has no pencil or bin: its ⋯ menu holds Rename, Delete and Select the points that follow it", async ({ page }) => {
  await page.getByTestId("inspector-waypoint-row-scoreSouth").click();
  await expect(page.getByTestId("inspector-waypoint-detail")).toBeVisible();
  // The pin's own section comes first, above the list (issue #431), and its header has the same ⋯.
  const folds = await page.getByTestId("inspector").locator(":scope > section[data-fold]").evaluateAll((all) => all.map((node) => node.getAttribute("data-fold")));
  expect(folds.slice(0, 2)).toEqual(["waypoint.pin", "waypoint.list"]);
  await expect(page.getByTestId("inspector-title")).toHaveText("scoreSouth");
  await page.getByTestId("inspector-waypoint-head-more").click();
  for (const id of ["waypoint.rename", "waypoint.delete", "waypoint.selectFollowers"]) {
    await expect(page.getByTestId("inspector-waypoint-head-menu").locator(`[data-action="${id}"]`)).toHaveCount(1);
  }
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("inspector-waypoint-rename")).toHaveCount(0);
  await expect(page.getByTestId("inspector-waypoint-delete")).toHaveCount(0);
  await page.getByTestId("inspector-waypoint-more-scoreSouth").click();
  const menu = page.getByTestId("inspector-waypoint-menu");
  for (const id of ["waypoint.rename", "waypoint.delete", "waypoint.selectFollowers"]) await expect(menu.locator(`[data-action="${id}"]`)).toHaveCount(1);
});

test("save-as-waypoint shows only on a pose of its own, never on 'Last step's end'", async ({ page }) => {
  // toOtherSide starts from the last step's end and ends on a waypoint it follows.
  await selectStep(page, "toOtherSide");
  await expect(page.getByTestId("inspector-from-source-0")).toContainText("Last step's end");
  await expect(page.getByTestId("inspector-from-0-save-waypoint")).toHaveCount(0);
  await expect(page.getByTestId("inspector-from-0-select-waypoint")).toHaveCount(0);
  await expect(page.getByTestId("inspector-to-0-select-waypoint")).toBeVisible();
  // A To given a pose of its own offers the bookmark.
  await editor(
    page,
    `m.commit({ ...s.auto, steps: s.auto.steps.map((x) => x.id === "toOtherSide" ? { ...x, segments: x.segments.map((seg) => ({ ...seg, to: { xIn: -20, yIn: 10, headingRad: 0, provenance: "SET BY HAND: test" } })) } : x) })`,
  );
  await expect(page.getByTestId("inspector-to-0-save-waypoint")).toBeVisible();
  await expect(page.getByTestId("inspector-from-0-save-waypoint")).toHaveCount(0);
});

/* ---- Command palette ----------------------------------------------------------------------- */

test("opening the palette under a resting pointer keeps the first row active, and only a real move changes it", async ({ page }) => {
  await page.mouse.move(640, 330);
  await openPalette(page);
  const first = (await paletteRows(page))[0];
  expect(first?.active).toBe(true);
  expect(await activeRow(page)).toBe(first?.id);
  // The list scrolling under a still pointer is not a move.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const arrowed = await activeRow(page);
  expect(arrowed).not.toBe(first?.id);
  await page.getByTestId("palette-results").evaluate((list) => {
    list.scrollTop += 1;
  });
  await page.waitForTimeout(150);
  expect(await activeRow(page)).toBe(arrowed);
  // A real move over another row takes it.
  const rows = await paletteRows(page);
  const other = rows.find((row) => !row.active && !row.disabled && row.id !== first?.id);
  expect(other).toBeDefined();
  const box = await page.getByTestId(other?.id ?? "").boundingBox();
  if (box === null) throw new Error("the row has no box");
  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  await page.mouse.move(box.x + 60, box.y + box.height / 2);
  await expect.poll(() => activeRow(page)).toBe(other?.id);
});

test("typing start puts a label match first and never makes Insert spinUp active; Enter selects the waypoint and says so", async ({ page }) => {
  await openPalette(page);
  await page.getByTestId("palette-input").fill("start");
  const rows = await paletteRows(page);
  const active = rows.find((row) => row.active);
  expect(active?.id).toBeDefined();
  expect(active?.id).not.toMatch(/^palette-item-command:/);
  const commandAt = rows.findIndex((row) => row.id.startsWith("palette-item-command:"));
  const waypointAt = rows.findIndex((row) => row.id === "palette-item-waypoint:start");
  expect(waypointAt).toBeGreaterThanOrEqual(0);
  if (commandAt >= 0) expect(commandAt).toBeGreaterThan(waypointAt);
  await page.getByTestId("palette-item-waypoint:start").click();
  await expect(page.getByTestId("status")).toContainText("Selected waypoint start (-13.0, -63.0 in)");
  expect(await editor(page, "s.selection")).toEqual({ waypoint: "start" });
});

test("a step id shows a Steps group with Go to <id>, and Enter selects that step", async ({ page }) => {
  await openPalette(page);
  await page.getByTestId("palette-input").fill("toGarden");
  await expect(page.getByTestId("palette-results")).toContainText("Steps");
  const row = page.getByTestId("palette-item-step:toGarden");
  await expect(row).toContainText("Go to toGarden");
  await expect(row).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("palette-input")).toHaveCount(0);
  expect(await editor<string | undefined>(page, "s.selection.stepId")).toBe("toGarden");
});

test("a search with no match says what to try", async ({ page }) => {
  await openPalette(page);
  await page.getByTestId("palette-input").fill("zzzqqq");
  await expect(page.getByTestId("palette-none")).toHaveText("Try a step name, a waypoint, or an action.");
});

test("a row that cannot run says why on a second line, and the arrow keys skip it", async ({ page }) => {
  // No step is selected, so Play from the selected step cannot run.
  await expect.poll(() => editor<boolean>(page, "s.selection.stepId === undefined")).toBe(true);
  await openPalette(page);
  const input = page.getByTestId("palette-input");
  await input.fill("play");
  const rows = await paletteRows(page);
  const disabled = rows.filter((row) => row.disabled);
  expect(disabled.length).toBeGreaterThan(0);
  const reasonId = (disabled[0]?.id ?? "").replace("palette-item-", "palette-detail-");
  await expect(page.getByTestId(reasonId)).not.toBeEmpty();
  // Walking down never lands on it.
  for (let press = 0; press < rows.length + 1; press += 1) {
    await page.keyboard.press("ArrowDown");
    const now = await paletteRows(page);
    const active = now.find((row) => row.active);
    expect(active?.disabled ?? false).toBe(false);
  }
});

test("an empty box leads with the Recent group, newest first", async ({ page }) => {
  await page.getByTestId("toolbar-view.snap").click();
  await openPalette(page);
  const rows = await paletteRows(page);
  expect(rows[0]?.id).toBe("palette-item-recent:view.snap");
  await expect(page.getByTestId("palette-results").locator("p").first()).toHaveText("Recent");
});
