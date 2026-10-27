/**
 * Optimize path is easy to find (issue #366). On the example's collect-and-score: the toolbar's
 * Optimize button opens the card on the selected path step and says to select one otherwise; the
 * field's right-click menu on a path and a step row's menu have Optimize path; the toolbar button's
 * right-click menu and the palette have Optimize every path, which lists each path's result and
 * applies the ticked ones as one undo step. The Basic preset hides all of them.
 */
import { expect, test, type Page } from "@playwright/test";
import { useWideRoute } from "./qa/helpers";

const TOUR_SEEN = { tour: { seen: true, coreDone: true, fullDone: false } };

/** Stores `prefs` before the page loads, once. */
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

/** A value from the editor's store, through the dev server's module graph. */
async function editor<T>(page: Page, expr: string): Promise<T> {
  return (await page.evaluate(
    `import("/src/state/store.ts").then((m) => { const s = m.getState(); const d = m.currentDerived(); return (${expr}); })`,
  )) as T;
}

/** The open auto's canonical text, from the Code tab's own hash. */
const autoText = (page: Page): Promise<string> =>
  page.evaluate(async () => {
    const store = (await import(/* @vite-ignore */ "/src/state/store.ts")) as { getState(): { auto: unknown } };
    const code = (await import(/* @vite-ignore */ "/src/panels/codeView.ts")) as { shaOf(auto: unknown): string };
    return code.shaOf(store.getState().auto);
  });

async function worldToScreen(page: Page, xIn: number, yIn: number): Promise<{ x: number; y: number }> {
  const canvas = page.getByTestId("field-canvas");
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("the canvas has no box");
  const pxPerIn = Number(await canvas.getAttribute("data-px-per-in"));
  const originXPx = Number(await canvas.getAttribute("data-origin-x-px"));
  const originYPx = Number(await canvas.getAttribute("data-origin-y-px"));
  return { x: box.x + originXPx + pxPerIn * xIn, y: box.y + originYPx - pxPerIn * yIn };
}

async function discard(page: Page): Promise<void> {
  await page.getByTestId("optimize-discard").click();
  await expect(page.getByTestId("optimize-card")).toHaveCount(0);
}

test.describe("with Optimize path on", () => {
  test.beforeEach(async ({ page }) => {
    await storePrefs(page, TOUR_SEEN);
    await loadExample(page);
  });

  test("the toolbar button opens the card on the selected path step, and says to select one otherwise", async ({ page }) => {
    const button = page.getByTestId("toolbar-path.optimize");
    await page.getByTestId("step-row-shootPreloads").click();
    await expect(button).toHaveAttribute("aria-disabled", "true");
    await button.hover();
    await expect(page.getByRole("tooltip")).toContainText("Select a path step first.");

    await page.getByTestId("step-row-toOtherSide").click();
    await expect(button).not.toHaveAttribute("aria-disabled", "true");
    await button.click();
    await expect(page.getByTestId("optimize-card")).toBeVisible();
    await expect(page.getByTestId("optimize-step")).toHaveText("toOtherSide");
    await discard(page);
  });

  test("a step row's menu has Optimize path, and the field's menu on a path leaves it to the toolbar", async ({ page }) => {
    await page.getByTestId("step-row-toOtherSide").click({ button: "right" });
    await page.getByTestId("step-menu").getByTestId("menu-path.optimize").click();
    await expect(page.getByTestId("optimize-step")).toHaveText("toOtherSide");
    await discard(page);

    // A command step's menu has no Optimize path.
    await page.getByTestId("step-row-shootPreloads").click({ button: "right" });
    await expect(page.getByTestId("step-menu")).toBeVisible();
    await expect(page.getByTestId("step-menu").getByTestId("menu-path.optimize")).toHaveCount(0);
    await page.keyboard.press("Escape");

    // The middle of driveOut, a straight line from (-13, -63) to (-13, -36). Its menu is the path's,
    // with no Optimize path: the toolbar's wand is the one visible entry (issue #412).
    const menu = page.getByTestId("canvas-context-menu");
    const at = await worldToScreen(page, -13, -49.5);
    await page.mouse.click(at.x, at.y, { button: "right" });
    await expect(menu).toBeVisible();
    await expect(menu.locator('[data-action="edit.makeCurve"]')).toHaveCount(1);
    await expect(menu.locator('[data-action="path.optimize"]')).toHaveCount(0);
    await page.keyboard.press("Escape");
  });

  test("the toolbar button's menu runs Optimize every path, and Apply writes the ticked routes as one undo step", async ({ page }) => {
    test.setTimeout(120_000);
    // The shipped starter is already as fast as the optimizer gets it (issue #367), so the run is on the wide route, where collectFlower has a faster one.
    await useWideRoute(page);
    const before = await autoText(page);
    const undoDepth = await editor<number>(page, "s.undo.length");
    await page.getByTestId("step-row-toOtherSide").click();
    await page.getByTestId("toolbar-path.optimize").click({ button: "right" });
    const menu = page.getByTestId("optimize-menu");
    await expect(menu.getByTestId("menu-path.optimize")).toBeVisible();
    await expect(menu.getByTestId("menu-path.optimizeWithOptions")).toBeVisible();
    await menu.getByTestId("menu-path.optimizeAll").click();

    const card = page.getByTestId("optimize-card");
    await expect(card).toHaveAttribute("data-all", "true");
    await expect(page.getByTestId("optimize-all-progress")).toContainText("of 7");
    // collectFlower, the third path, has a faster route; Stop then ends the run with what it has.
    await expect(page.getByTestId("optimize-all-accept-collectFlower")).toBeAttached({ timeout: 60_000 });
    // On a fast machine the run may already have finished, and then there is no Stop to press.
    const stop = page.getByTestId("optimize-stop");
    if (await stop.isVisible()) await stop.click({ timeout: 2_000 }).catch(() => undefined);
    await expect(card).toHaveAttribute("data-phase", "result", { timeout: 30_000 });
    await expect(page.getByTestId("optimize-all-accept-collectFlower")).toBeChecked();
    await expect(page.getByTestId("optimize-all-total")).toContainText("of 7 paths searched");
    expect(await autoText(page)).toBe(before);

    await page.getByTestId("optimize-apply").click();
    await expect(card).toHaveCount(0);
    await expect(page.getByTestId("status")).toContainText("faster in all");
    expect(await editor<number>(page, "s.undo.length")).toBe(undoDepth + 1);
    expect(await autoText(page)).not.toBe(before);
    await page.getByTestId("toolbar-edit.undo").click();
    await expect.poll(() => autoText(page)).toBe(before);
  });

  test("the palette has Optimize every path", async ({ page }) => {
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("Optimize every path");
    await page.getByTestId("palette-item-path.optimizeAll").click();
    await expect(page.getByTestId("optimize-card")).toHaveAttribute("data-all", "true");
    await discard(page);
  });
});

test("the Basic preset hides the toolbar button, both menus' items and Optimize every path", async ({ page }) => {
  await storePrefs(page, { ...TOUR_SEEN, preset: { id: "basic", chosen: true } });
  await loadExample(page);
  await page.getByTestId("step-row-toOtherSide").click();
  await expect(page.getByTestId("toolbar-edit.undo")).toBeVisible();
  await expect(page.getByTestId("toolbar-path.optimize")).toHaveCount(0);

  await page.getByTestId("step-row-toOtherSide").click({ button: "right" });
  await expect(page.getByTestId("step-menu")).toBeVisible();
  await expect(page.getByTestId("step-menu").getByTestId("menu-path.optimize")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Optimize every path");
  await expect(page.getByTestId("palette-item-path.optimizeAll")).toHaveCount(0);
});
