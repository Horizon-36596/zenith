/**
 * QA 2, tooltips and help (site/docs/editor.md, UI_GUIDE sections 9.3 and 9.4):
 * every icon-only control has an accessible name and a tooltip naming it, what it does and its
 * shortcut; disabled controls say why; every panel and inspector section has a `?` with plain text.
 */
import { expect, test, type Page } from "@playwright/test";
import { SHORTCUTS } from "../../src/app/shortcuts";
import { clearStatus, loadExample, selectStep, shot, skipTour } from "./helpers";

test.beforeEach(async ({ page }) => {
  await skipTour(page);
});

interface IconButton {
  index: number;
  label: string;
  testId: string | null;
  disabled: boolean;
}

/** Every visible button whose only content is an icon. */
async function iconButtons(page: Page): Promise<IconButton[]> {
  return page.evaluate(() => {
    const out: Array<{ index: number; label: string; testId: string | null; disabled: boolean }> = [];
    const buttons = [...document.querySelectorAll<HTMLElement>('button, [role="button"]')];
    buttons.forEach((button, index) => {
      const r = button.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      if (getComputedStyle(button).visibility === "hidden") return;
      const text = (button.innerText ?? "").trim();
      if (text !== "" && text !== "?") return;
      if (text === "?") return; // the help affordances have their own test
      if (button.closest('[data-testid="tour"]') !== null) return;
      out.push({
        index,
        label: button.getAttribute("aria-label") ?? "",
        testId: button.getAttribute("data-testid"),
        disabled: button.getAttribute("aria-disabled") === "true" || (button as HTMLButtonElement).disabled,
      });
    });
    return out;
  });
}

async function tooltipFor(page: Page, index: number): Promise<string | null> {
  const button = page.locator('button, [role="button"]').nth(index);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(150);
  await button.hover();
  const tip = page.getByRole("tooltip");
  try {
    await expect(tip.first()).toBeVisible({ timeout: 1_500 });
  } catch {
    return null;
  }
  return (await tip.first().innerText()).trim();
}

test("every icon-only control has an accessible name and a tooltip", async ({ page }) => {
  await loadExample(page);
  await selectStep(page, "driveOut");
  const buttons = await iconButtons(page);
  expect(buttons.length).toBeGreaterThan(15);
  const missingName: string[] = [];
  const missingTip: string[] = [];
  for (const button of buttons) {
    const who = button.testId ?? button.label ?? `#${String(button.index)}`;
    if (button.label.trim() === "") missingName.push(who);
    const tip = await tooltipFor(page, button.index);
    if (tip === null || tip.length < 3) missingTip.push(who);
  }
  expect(missingName, "icon-only buttons with no aria-label").toEqual([]);
  expect(missingTip, "icon-only buttons with no tooltip").toEqual([]);
});

test("the canvas Play button uses the shared tooltip, not a native title", async ({ page }) => {
  await loadExample(page);
  const play = page.getByTestId("canvas-play");
  await expect(play).toBeVisible();
  await play.hover();
  await expect(page.getByRole("tooltip")).toContainText("Play", { timeout: 1_500 });
});

const TOOLBAR: Array<[string, string, keyof typeof SHORTCUTS | null]> = [
  ["toolbar-tool.select", "Select", "select"],
  ["toolbar-tool.addPath", "Add path", "addPath"],
  ["toolbar-tool.marker", "Marker", "marker"],
  ["toolbar-tool.heading", "Heading", "heading"],
  ["toolbar-tool.measure", "Measure", "measure"],
  ["toolbar-view.snap", "Snap", "snap"],
  ["toolbar-run.validate", "Validate", "validate"],
  ["toolbar-view.play", "Play", "playPause"],
  ["toolbar-run.simulate", "Simulate", "simulate"],
  ["toolbar-run.save", "Save", "save"],
  ["toolbar-run.propose", "Propose", "propose"],
  ["toolbar-view.alliance", "Mirror", "alliance"],
];

test("each toolbar tooltip names the action, says what it does, and shows its shortcut", async ({ page }) => {
  await loadExample(page);
  for (const [id, name, shortcut] of TOOLBAR) {
    await page.mouse.move(0, 0);
    await page.waitForTimeout(150);
    await page.getByTestId(id).hover();
    const tip = page.getByRole("tooltip");
    await expect(tip, id).toContainText(name);
    if (shortcut !== null) await expect(tip, `${id} shows ${SHORTCUTS[shortcut]}`).toContainText(SHORTCUTS[shortcut]);
    const text = await tip.innerText();
    // A second line: what it does, in a sentence.
    expect(text.replace(name, "").replace(shortcut === null ? "" : SHORTCUTS[shortcut], "").trim().length, id).toBeGreaterThan(15);
  }
  await page.getByTestId("toolbar-view.snap").hover();
  await shot(page, "02-tooltip-snap");
});

test("disabled controls keep a tooltip that says why", async ({ page }) => {
  await loadExample(page);
  // Propose needs GitHub mode; undo has nothing to take back on a fresh load.
  const propose = page.getByTestId("toolbar-run.propose");
  await expect(propose).toBeDisabled();
  await propose.hover();
  await expect(page.getByRole("tooltip")).toContainText(/Unavailable|GitHub|open.*from GitHub/i);
  await shot(page, "02-tooltip-disabled-propose");

  // Every disabled icon button on screen explains itself.
  const buttons = (await iconButtons(page)).filter((button) => button.disabled);
  const silent: string[] = [];
  for (const button of buttons) {
    const tip = await tooltipFor(page, button.index);
    if (tip === null || !/unavailable|first|nothing|no |not |only|needs|read only/i.test(tip)) {
      silent.push(`${button.testId ?? button.label}: ${tip ?? "(no tooltip)"}`);
    }
  }
  expect(silent, "disabled controls whose tooltip does not say why").toEqual([]);
});

test("the welcome screen's disabled toolbar says to open an auto first", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("canvas-empty")).toBeVisible();
  for (const id of ["toolbar-run.validate", "toolbar-run.save", "toolbar-view.play"]) {
    await page.mouse.move(0, 0);
    await page.waitForTimeout(150);
    await page.getByTestId(id).hover();
    await expect(page.getByRole("tooltip"), id).toContainText(/open an auto first/i);
  }
});

test("every panel and every inspector section has a ? with plain text", async ({ page }) => {
  await loadExample(page);
  await selectStep(page, "driveOut");
  // Harmless, and no longer needed: the status bar overlays the panels instead of shifting them.
  await clearStatus(page);
  const helps = page.locator('[data-testid^="help-"]:not([data-testid="help-bubble"])');
  const count = await helps.count();
  expect(count).toBeGreaterThanOrEqual(8);
  const ids: string[] = [];
  const empty: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const help = helps.nth(i);
    if (!(await help.isVisible())) continue;
    const id = (await help.getAttribute("data-testid")) ?? "";
    ids.push(id);
    await expect(help, id).toHaveAttribute("aria-label", /^What is .+\?$/);
    await page.mouse.move(0, 0);
    await help.scrollIntoViewIfNeeded();
    await help.hover();
    const bubble = page.getByTestId("help-bubble");
    try {
      await expect(bubble).toBeVisible({ timeout: 1_500 });
      const text = (await bubble.innerText()).trim();
      if (text.split(/\s+/).length < 6) empty.push(`${id}: "${text}"`);
    } catch {
      empty.push(`${id}: no bubble`);
    }
  }
  expect(empty, "help affordances with no plain text").toEqual([]);
  // Every region named by UI_GUIDE 9.3, and the inspector's sections for a path.
  for (const want of ["help-steps", "help-inspector", "help-findings", "help-timeline", "help-ledger"]) {
    expect(ids, want).toContain(want);
  }
  const sections = ids.filter((id) => !["help-steps", "help-inspector", "help-findings", "help-timeline", "help-ledger"].includes(id));
  expect(sections.length, `inspector sections with a ?: ${sections.join(", ")}`).toBeGreaterThanOrEqual(4);
});

test("a ? pins open on click and closes on Escape", async ({ page }) => {
  await loadExample(page);
  const help = page.getByTestId("help-steps");
  await help.click();
  await expect(page.getByTestId("help-bubble")).toBeVisible();
  await page.mouse.move(700, 450);
  await page.waitForTimeout(300);
  await expect(page.getByTestId("help-bubble")).toBeVisible();
  await shot(page, "02-help-pinned");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("help-bubble")).toHaveCount(0);
});

test("a ? opens on keyboard focus", async ({ page }) => {
  await loadExample(page);
  // Tab onto it: a focus moved in code does not open it, only one from the keyboard.
  await page.getByTestId("help-findings").focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("help-findings")).toBeFocused();
  await expect(page.getByTestId("help-bubble")).toBeVisible({ timeout: 1_000 });
});

test("a ? does not open when focus is moved to it in code, and a hover tip closes when another opens", async ({
  page,
}) => {
  await loadExample(page);
  await page.getByTestId("help-findings").focus();
  await page.waitForTimeout(400);
  await expect(page.getByTestId("help-bubble")).toHaveCount(0);
  await page.getByTestId("help-inspector").hover();
  await expect(page.getByTestId("help-bubble")).toHaveCount(1);
  await page.getByTestId("toolbar-tool.marker").focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("tooltip")).toHaveCount(1);
  await expect(page.getByTestId("help-bubble")).toHaveCount(0);
});
