/**
 * Issue #243: the Inspector shows a point selected on the field in place.
 *
 * - Clicking a path end opens its path, folds the chain's other paths, gives the end's block the
 *   selected style (`--bg-selected` and a 2 px accent bar on its left, drawn as an inset shadow so
 *   nothing moves, issue #431) and scrolls it into view with `block: nearest`.
 * - With several points selected only the primary one is highlighted, and a quiet line counts them.
 * - Nothing here is written to the remembered folds.
 *
 * The bundled example opens collect-and-score: driveOut runs from waypoint start at (-13, -63) to scoreSouth at
 * (-13, -36), and toOtherSide is a curve with three control points at (-40, -46), (-50, 4.79) and
 * (-40, 34), west of the hive frame.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { LARGE_VIEWPORT, VIEWPORT } from "./viewports";
import { editor, loadExample, selectStep, skipTour, waitForFonts, worldToScreen } from "./qa/helpers";

const inspector = (page: Page): Locator => page.getByTestId("inspector");
const header = (page: Page, title: RegExp): Locator =>
  inspector(page).locator("section > div > button[aria-expanded]", { hasText: title });
/** The Path section's header: a lone path's rows sit straight under it (issue #431). */
const pathHeader = (page: Page): Locator => inspector(page).locator('section[data-fold="path.paths"] > div > button[aria-expanded]');
const block = (page: Page, which: string): Locator => page.getByTestId(`inspector-point-${which}`);
const folds = (page: Page) => editor<Record<string, boolean>>(page, "s.prefs.inspectorFolds");

/** The box of the Inspector's scroll area, the nearest ancestor that scrolls. */
const scrollBox = (page: Page) =>
  inspector(page).evaluate((node) => {
    let at: HTMLElement | null = node as HTMLElement;
    while (at !== null && at !== document.body) {
      const overflow = getComputedStyle(at).overflowY;
      if ((overflow === "auto" || overflow === "scroll") && at.clientHeight > 0) {
        const box = at.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom };
      }
      at = at.parentElement;
    }
    return null;
  });

/** Scrolls the Inspector's scroll area to its very bottom, so a block near the top is out of view. */
const scrollToBottom = (page: Page) =>
  inspector(page).evaluate((node) => {
    let at: HTMLElement | null = node as HTMLElement;
    while (at !== null && at !== document.body) {
      const overflow = getComputedStyle(at).overflowY;
      if ((overflow === "auto" || overflow === "scroll") && at.clientHeight > 0) {
        at.scrollTop = at.scrollHeight;
        return at.scrollTop;
      }
      at = at.parentElement;
    }
    return 0;
  });

/** Clicks a field point, with Shift when `add` is set. */
async function clickField(page: Page, xIn: number, yIn: number, add = false): Promise<void> {
  const at = await worldToScreen(page, xIn, yIn);
  // mouse.click takes no modifiers, so Shift is held on the keyboard.
  if (add) await page.keyboard.down("Shift");
  await page.mouse.click(at.x, at.y);
  if (add) await page.keyboard.up("Shift");
}

async function expectInsideScrollArea(page: Page, target: Locator): Promise<void> {
  const area = await scrollBox(page);
  expect(area).not.toBeNull();
  await expect(target).toBeVisible();
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.y ?? -1).toBeGreaterThanOrEqual((area?.top ?? Infinity) - 0.5);
  expect((box?.y ?? Infinity) + (box?.height ?? 0)).toBeLessThanOrEqual((area?.bottom ?? -Infinity) + 0.5);
}

async function expectSelectedStyle(target: Locator): Promise<void> {
  await expect(target).toHaveAttribute("data-selected", "true");
  const style = await target.evaluate((node) => {
    const computed = getComputedStyle(node);
    const root = getComputedStyle(document.documentElement);
    const probe = document.createElement("span");
    probe.style.color = "var(--accent)";
    document.body.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return {
      background: computed.backgroundColor,
      bar: computed.boxShadow,
      selected: root.getPropertyValue("--bg-selected").trim(),
      accent,
    };
  });
  // The accent bar is a 2 px inset shadow on the left, so selecting moves no value.
  expect(style.bar).toContain(`${style.accent} 2px 0px 0px 0px inset`);
  expect(style.background).not.toBe("rgba(0, 0, 0, 0)");
}

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
  await waitForFonts(page);
});

for (const size of [LARGE_VIEWPORT, VIEWPORT]) {
  test.describe(`at ${String(size.width)}x${String(size.height)}`, () => {
    test.use({ viewport: size });

    test("clicking driveOut's To dot gives the To block the selected style, inside the Inspector's scroll viewport", async ({
      page,
    }) => {
      await selectStep(page, "driveOut");
      // Scrolled away first, so the block has to be brought into view.
      await scrollToBottom(page);
      await clickField(page, -13, -36);
      await expect.poll(() => editor<unknown>(page, "s.selection.point")).toMatchObject({ segmentIndex: 0, pointKind: "to" });

      const to = block(page, "to-0");
      await expectSelectedStyle(to);
      await expect(block(page, "from-0")).not.toHaveAttribute("data-selected", "true");
      await expectInsideScrollArea(page, to);
    });
  });
}

test("selecting a point does not write the remembered folds, and deselecting leaves them as they were", async ({
  page,
}) => {
  await selectStep(page, "driveOut");
  // A fold the person chose: the Path section, which holds a lone path's rows (issue #431).
  await pathHeader(page).click();
  await expect(pathHeader(page)).toHaveAttribute("aria-expanded", "false");
  const before = await folds(page);
  expect(before).toEqual({ "path.paths": false });

  // A selected point holds its path open, though the memory says folded.
  await clickField(page, -13, -36);
  await expect(pathHeader(page)).toHaveAttribute("aria-expanded", "true");
  await expectSelectedStyle(block(page, "to-0"));
  expect(await folds(page)).toEqual(before);

  // Deselecting lets it fold again.
  await editor(page, `m.setSelection({ stepId: "driveOut" })`);
  await expect(pathHeader(page)).toHaveAttribute("aria-expanded", "false");
  await expect(inspector(page).locator('[data-selected="true"]')).toHaveCount(0);
  expect(await folds(page)).toEqual(before);
});

test("folding a path over its selected point lets go of that point only: the next point selected in it opens it again", async ({
  page,
}) => {
  await selectStep(page, "driveOut");
  await clickField(page, -13, -36);
  await expect(pathHeader(page)).toHaveAttribute("aria-expanded", "true");

  // The person folds the path the selected To holds open.
  await pathHeader(page).click();
  await expect(pathHeader(page)).toHaveAttribute("aria-expanded", "false");

  // Selecting From in the same path holds it open again and shows the From block.
  await editor(page, `m.setSelection({ stepId: "driveOut", point: { segmentIndex: 0, pointKind: "from" } })`);
  await expect(pathHeader(page)).toHaveAttribute("aria-expanded", "true");
  await expectSelectedStyle(block(page, "from-0"));
});

test("on a three-path chain, selecting a point on Path 3 opens Path 3, folds Paths 1 and 2 and marks its end", async ({
  page,
}) => {
  await selectStep(page, "driveOut");
  await page.getByTestId("inspector-chain-add").click();
  await page.getByTestId("inspector-chain-add").click();
  await expect.poll(() => editor<number>(page, 's.auto.steps.find((x) => x.id === "driveOut").segments.length')).toBe(3);
  const before = await folds(page);

  await editor(page, `m.setSelection({ stepId: "driveOut", point: { segmentIndex: 2, pointKind: "to" } })`);
  await expect(header(page, /^Path 3/)).toHaveAttribute("aria-expanded", "true");
  await expect(header(page, /^Path 1/)).toHaveAttribute("aria-expanded", "false");
  await expect(header(page, /^Path 2/)).toHaveAttribute("aria-expanded", "false");
  await expectSelectedStyle(block(page, "to-2"));
  await expect(inspector(page).locator('[data-selected="true"]')).toHaveCount(1);
  expect(await folds(page)).toEqual(before);
});

test("shift-selecting three points highlights the primary point only and says 3 points in 1 step", async ({ page }) => {
  await selectStep(page, "toOtherSide");
  await expect(page.getByTestId("inspector-points-selected")).toHaveCount(0);

  await clickField(page, -40, -46);
  await expect(page.getByTestId("inspector-points-selected")).toHaveCount(0);
  await clickField(page, -50, 4.79, true);
  await clickField(page, -40, 34, true);
  await expect.poll(() => editor<number>(page, "(s.selection.points ?? []).length")).toBe(3);

  await expect(page.getByTestId("inspector-points-selected")).toHaveText("3 points in 1 step");
  // The last one clicked is primary: Control 3. The other two are not marked.
  await expectSelectedStyle(block(page, "control-0-2"));
  await expect(block(page, "control-0-0")).not.toHaveAttribute("data-selected", "true");
  await expect(block(page, "control-0-1")).not.toHaveAttribute("data-selected", "true");
  await expect(inspector(page).locator('[data-selected="true"]')).toHaveCount(1);
  await expectInsideScrollArea(page, block(page, "control-0-2"));
});
