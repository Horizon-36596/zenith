/**
 * The editor's shell (site/docs/editor.md): inserting in the middle of a routine
 * continues from the selected step, every step kind can be inserted, the steps list has a context
 * menu, Space plays, and help is one key away.
 */
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem(
        "zenith.ui",
        JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }),
      );
    }
  });
});

async function loadExample(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
}

const rowIds = async (page: Page): Promise<string[]> =>
  page
    .getByTestId("steps-list")
    .locator('[data-testid^="step-row-"]')
    .evaluateAll((rows) => rows.map((row) => (row.getAttribute("data-testid") ?? "").slice("step-row-".length)));

interface SavedStep {
  id?: string;
  kind: string;
  segments?: Array<{ from: unknown }>;
}

async function saveAndRead(page: Page): Promise<{ steps: SavedStep[] }> {
  const download = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  const path = await (await download).path();
  return JSON.parse(readFileSync(path, "utf8")) as { steps: SavedStep[] };
}

test("a path inserted after a step in the middle continues from that step", async ({ page }) => {
  await loadExample(page);
  const before = await rowIds(page);
  const at = before.indexOf("driveOut");
  expect(at).toBeGreaterThanOrEqual(0);
  expect(at).toBeLessThan(before.length - 1);

  await page.getByTestId("step-row-driveOut").getByRole("button").first().click();
  await page.getByTestId("insert-step").click();
  await expect(page.getByTestId("insert-menu")).toBeVisible();
  await page.getByTestId("insert-kind-path").click();

  // The new step sits straight after driveOut, not at the end, and is selected.
  const after = await rowIds(page);
  expect(after.length).toBe(before.length + 1);
  const inserted = after[at + 1] ?? "";
  expect(before).not.toContain(inserted);
  await expect(page.getByTestId("inspector")).toContainText(inserted);

  // In the file its first segment starts wherever driveOut left the robot.
  const saved = await saveAndRead(page);
  const index = saved.steps.findIndex((step) => step.id === inserted);
  expect(saved.steps[index - 1]?.id).toBe("driveOut");
  expect(saved.steps[index]?.segments?.[0]?.from).toBe("current");
});

test("every step kind can be inserted from the menu", async ({ page }) => {
  await loadExample(page);
  const count = async () => (await rowIds(page)).length;
  let expected = await count();

  const insert = async (open: () => Promise<void>, extraRows: number) => {
    await page.getByTestId("insert-step").click();
    await expect(page.getByTestId("insert-menu")).toBeVisible();
    await open();
    expected += extraRows;
    await expect.poll(count).toBe(expected);
    await expect(page.getByTestId("insert-menu")).toHaveCount(0);
  };

  await insert(async () => {
    await page.getByTestId("insert-kind-path").click();
  }, 1);
  await insert(async () => {
    await page.getByTestId("insert-kind-command").click();
    await page.getByTestId("insert-command-search").fill("score");
    await page.locator('[data-testid^="insert-command-"]:not([data-testid="insert-command-search"])').first().click();
  }, 1);
  await insert(async () => {
    await page.getByTestId("insert-kind-wait").click();
    await page.getByTestId("insert-wait-seconds").fill("1.5");
    await page.getByTestId("insert-wait-add").click();
  }, 1);
  // A sequence arrives holding one path; a parallel group a drive and a command; a branch a
  // placeholder on each side.
  await insert(async () => {
    await page.getByTestId("insert-kind-sequence").click();
  }, 2);
  await insert(async () => {
    await page.getByTestId("insert-kind-parallel").click();
    await page.getByTestId("insert-parallel-mode-deadline").click();
    await page.getByTestId("insert-parallel-add").click();
  }, 3);
  await insert(async () => {
    await page.getByTestId("insert-kind-branch").click();
    await page.getByTestId("insert-branch-add").click();
  }, 3);
});

test("Enter opens the insert menu for the selected step", async ({ page }) => {
  await loadExample(page);
  await page.getByTestId("step-row-driveOut").getByRole("button").first().click();
  await page.getByTestId("steps-list").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("insert-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("insert-menu")).toHaveCount(0);
});

test("right-clicking a step opens its menu, and wrap puts it in a sequence", async ({ page }) => {
  await loadExample(page);
  await page.getByTestId("step-row-driveOut").click({ button: "right" });
  const menu = page.getByTestId("step-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByTestId("menu-edit.wrapSequence")).toBeVisible();
  await expect(menu.getByTestId("menu-edit.delete")).toBeVisible();

  await menu.getByTestId("menu-edit.wrapSequence").click();
  await expect(page.getByTestId("step-menu")).toHaveCount(0);
  await expect(page.getByTestId("inspector")).toContainText("Sequence");
  await expect(page.getByTestId("inspector-sequence-count")).toHaveText("1");

  // Unwrap, from the group's own row, takes it back out. Core names a new sequence "sequence".
  await page.getByTestId("step-row-sequence").click({ button: "right" });
  await page.getByTestId("step-menu").getByTestId("menu-edit.unwrap").click();
  await expect(page.getByTestId("step-row-sequence")).toHaveCount(0);
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
});

test("Space plays and pauses the routine", async ({ page }) => {
  await loadExample(page);
  const play = page.getByTestId("toolbar-view.play");
  await expect(play).toHaveAttribute("aria-pressed", "false");
  await page.getByTestId("steps-list").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("Space");
  await expect(play).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Space");
  await expect(play).toHaveAttribute("aria-pressed", "false");
});

test("? opens every shortcut and canvas gesture, and each panel explains itself", async ({ page }) => {
  await loadExample(page);
  await page.getByTestId("steps-list").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("?");
  const overlay = page.getByTestId("shortcuts-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText("Ctrl K");
  await expect(overlay.getByTestId("shortcuts-canvas")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);

  for (const id of ["steps", "inspector", "findings", "timeline", "ledger"]) {
    await page.getByTestId(`help-${id}`).hover();
    await expect(page.getByTestId("help-bubble")).toBeVisible();
    await page.mouse.move(0, 0);
  }
});

test("the status bar overlays the window: nothing moves when it shows or clears", async ({ page }) => {
  await loadExample(page);
  const status = page.getByTestId("status");
  await expect(status).toBeVisible();
  const boxes = async () => ({
    canvas: await page.getByTestId("field-canvas").boundingBox(),
    findingsHelp: await page.getByTestId("help-findings").boundingBox(),
    pxPerIn: await page.getByTestId("field-canvas").getAttribute("data-px-per-in"),
  });
  const shown = await boxes();
  expect(shown.canvas).not.toBeNull();
  expect(shown.findingsHelp).not.toBeNull();

  // The pointer goes through the bar to the panel under it; only the dismiss button takes it.
  const bar = await status.boundingBox();
  if (bar === null) throw new Error("the status bar has no box");
  const under = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.closest('[data-testid="status"]') === null,
    [bar.x + 40, bar.y + bar.height / 2],
  );
  expect(under, "a click on the bar's text reaches the panel beneath").toBe(true);

  await status.getByRole("button", { name: "Dismiss" }).click();
  await expect(status).toHaveCount(0);
  await expect(page.getByTestId("status-leaving")).toHaveCount(0);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await boxes()).toEqual(shown);
});

test("the problems panel explains a finding's code", async ({ page }) => {
  await loadExample(page);
  // collect-and-score, the auto the example opens, raises one finding: TIME_BUDGET on its total.
  const code = page.getByTestId("finding-code").first();
  await code.hover();
  await expect(page.getByRole("tooltip")).toContainText("How to fix");
});

test("right-clicking the field opens the canvas menu, built from the action table", async ({ page }) => {
  await loadExample(page);
  const canvas = page.getByTestId("field-canvas");
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("the canvas has no box");
  // An empty stretch of field, well away from the example's paths: (40, 40) in.
  const pxPerIn = Number(await canvas.getAttribute("data-px-per-in"));
  const originXPx = Number(await canvas.getAttribute("data-origin-x-px"));
  const originYPx = Number(await canvas.getAttribute("data-origin-y-px"));
  await page.mouse.click(box.x + originXPx + pxPerIn * 40, box.y + originYPx - pxPerIn * 40, {
    button: "right",
  });
  const menu = page.getByTestId("canvas-context-menu");
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-action="tool.addPath"]')).toBeVisible();
  await expect(menu.locator('[data-action="view.snap"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});

test("a group row folds its steps away, and stays folded after a reload", async ({ page }) => {
  await loadExample(page);
  // returnToScore is a deadline group: the drive back, and a sequence that holds two more steps.
  await expect(page.getByTestId("step-row-driveBack")).toBeVisible();
  await page.getByTestId("step-fold-returnToScore").click();
  await expect(page.getByTestId("step-row-driveBack")).toHaveCount(0);
  await expect(page.getByTestId("step-row-clearThenSpinUp")).toHaveCount(0);
  await expect(page.getByTestId("step-row-readyLauncher")).toHaveCount(0);
  await expect(page.getByTestId("step-fold-count-returnToScore")).toHaveText("2");

  // Selecting a hidden step marks the group row that hides it.
  await page.getByTestId("step-fold-returnToScore").click();
  await page.getByTestId("step-row-driveBack").getByRole("button").first().click();
  await page.getByTestId("step-fold-returnToScore").click();
  await expect(page.getByTestId("step-row-returnToScore")).toHaveAttribute("data-selected", "true");

  await page.reload();
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await expect(page.getByTestId("step-row-driveBack")).toHaveCount(0);
  await page.getByTestId("step-fold-returnToScore").click();
  await expect(page.getByTestId("step-row-driveBack")).toBeVisible();
});

test("switching autos with unsaved edits asks Save, Discard or Cancel first", async ({ page }) => {
  await loadExample(page);
  const name = page.getByTestId("toolbar-auto-name");
  const unsaved = name.getByLabel("Unsaved changes");
  const dialog = page.getByTestId("unsaved-dialog");
  const switchTo = async (fileName: string): Promise<void> => {
    await name.click();
    await page.getByTestId(`open-auto-${fileName}`).click();
  };

  await page.getByTestId("step-row-driveOut").getByRole("button").first().click();
  await page.keyboard.press("Delete");
  await expect(unsaved).toHaveCount(1);

  // Cancel keeps the edit and the auto; Escape is Cancel too.
  await switchTo("first-auto.auto.json");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("collect-and-score.auto.json has edits that are not saved.");
  await page.getByTestId("unsaved-cancel").click();
  await expect(dialog).toHaveCount(0);
  await expect(name).toContainText("collect-and-score.auto.json");
  await expect(unsaved).toHaveCount(1);
  await switchTo("first-auto.auto.json");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(unsaved).toHaveCount(1);

  // Save writes the edit (a download, on the read-only example) and then switches.
  const download = page.waitForEvent("download");
  await switchTo("first-auto.auto.json");
  await page.getByTestId("unsaved-save").click();
  const saved = JSON.parse(readFileSync(await (await download).path(), "utf8")) as { steps: Array<{ id: string }> };
  expect(saved.steps.map((step) => step.id)).not.toContain("driveOut");
  await expect(name).toContainText("first-auto.auto.json");

  // Discard switches without saving.
  const first = (await rowIds(page))[0] ?? "";
  await page.getByTestId(`step-row-${first}`).getByRole("button").first().click();
  await page.keyboard.press("Delete");
  await expect(unsaved).toHaveCount(1);
  await switchTo("all-step-kinds.auto.json");
  await page.getByTestId("unsaved-discard").click();
  await expect(name).toContainText("all-step-kinds.auto.json");
  await expect(unsaved).toHaveCount(0);
});
