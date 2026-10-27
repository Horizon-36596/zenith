/**
 * Issue #412: the toolbar is one stable row with one visible Optimize entry, the tools say what they
 * do and leave on Esc, the field has zoom controls and a board-sized fit, and the right-click menus
 * open where the person clicked. The menus' rows are counted in `src/app/canvasMenu.test.ts`; this
 * spec checks what only the page shows.
 */
import { expect, test, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
    }
  });
  await turnOnFeatures(page);
});

async function openExample(page: Page): Promise<void> {
  await page.goto("/?cloud=fake");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
}

/** Where a field inch sits in the window, from the view the canvas publishes on its element. */
async function worldToScreen(page: Page, xIn: number, yIn: number): Promise<{ x: number; y: number }> {
  const canvas = page.getByTestId("field-canvas");
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("the canvas has no box");
  const pxPerIn = Number(await canvas.getAttribute("data-px-per-in"));
  const originXPx = Number(await canvas.getAttribute("data-origin-x-px"));
  const originYPx = Number(await canvas.getAttribute("data-origin-y-px"));
  return { x: box.x + originXPx + pxPerIn * xIn, y: box.y + originYPx - pxPerIn * yIn };
}

const editor = <T>(page: Page, expr: string): Promise<T> =>
  page.evaluate(`import("/src/state/store.ts").then((m) => { const s = m.getState(); return ${expr}; })`) as Promise<T>;

test.describe("the toolbar", () => {
  test("puts Optimize in a group of its own after the tools, with a chevron that opens its menu", async ({ page }) => {
    await openExample(page);
    const wand = page.getByTestId("toolbar-path.optimize");
    const group = (testId: string) => page.getByTestId(testId).locator("xpath=ancestor::div[@data-group][1]").getAttribute("data-group");
    expect(await group("toolbar-path.optimize")).toBe("2");
    expect(await group("toolbar-edit.undo")).toBe("3");

    const more = page.getByTestId("toolbar-optimize-more");
    await more.hover();
    await expect(page.getByRole("tooltip")).toContainText("Optimize path with options, or Optimize every path.");
    await more.click();
    const menu = page.getByTestId("optimize-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem")).toHaveText(["Optimize path", "Optimize path with options…", "Optimize every path"]);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    // The wand's own tooltip names the chevron, and a right-click on it still opens the same menu.
    await page.getByTestId("step-row-toOtherSide").click();
    await wand.hover();
    await expect(page.getByRole("tooltip")).toContainText("The arrow beside it, or a right-click");
    await wand.click({ button: "right" });
    await expect(menu).toBeVisible();
  });

  test("choosing Add path moves no button, and Extend this chain says what it does", async ({ page }) => {
    await openExample(page);
    const validate = page.getByTestId("toolbar-run.validate");
    const before = (await validate.boundingBox())?.x;
    await page.getByTestId("toolbar-tool.addPath").click();
    await expect(page.getByTestId("toolbar-tool.extendChain")).toBeVisible();
    expect((await validate.boundingBox())?.x).toBe(before);
    await page.getByTestId("toolbar-tool.extendChain").hover();
    await expect(page.getByRole("tooltip")).toContainText("Add to this chain instead of a new step");
  });

  test("stays one row at 1024 x 640 signed in with sharing on, with Search as its icon and no Docs book", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 640 });
    await openExample(page);
    await page.getByTestId("toolbar-sign-in").click();
    const sheet = page.getByTestId("signin-sheet");
    await sheet.getByTestId("signin-github").click();
    await sheet.getByTestId("signin-display-name").fill("Ada");
    await sheet.getByTestId("signin-display-name-save").click();
    await expect(page.getByTestId("toolbar-account")).toBeVisible();
    await page.keyboard.press("Escape");

    const bar = page.getByTestId("toolbar");
    const height = await bar.evaluate((element) => element.getBoundingClientRect().height);
    const token = await bar.evaluate((element) => parseFloat(getComputedStyle(element).getPropertyValue("--toolbar-h")));
    expect(height).toBe(token);
    // Every button sits on the one row.
    const tops = await bar.locator("button:visible").evaluateAll((buttons) => [...new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top / 10)))]);
    expect(tops).toHaveLength(1);

    await expect(page.getByTestId("toolbar-search")).toBeVisible();
    await expect(page.getByTestId("toolbar-search").getByText("Search")).toBeHidden();
    await expect(page.getByTestId("toolbar-docs")).toBeHidden();
    await page.getByTestId("toolbar-help").click();
    await expect(page.getByTestId("help-menu").getByRole("menuitem").first()).toContainText("Documentation");
  });

  test("disables the editing tools with a reason while no auto is open", async ({ page }) => {
    await page.goto("/?cloud=fake");
    for (const id of ["tool.select", "tool.addPath", "tool.marker", "tool.heading", "tool.measure"]) {
      await expect(page.getByTestId(`toolbar-${id}`)).toHaveAttribute("aria-disabled", "true");
    }
    await page.getByTestId("toolbar-tool.addPath").hover();
    await expect(page.getByRole("tooltip")).toContainText("Open an auto first.");
  });

  test("draws Propose only for a project from GitHub, and its key says why elsewhere", async ({ page }) => {
    await openExample(page);
    await expect(page.getByTestId("toolbar-run.propose")).toHaveCount(0);
    await page.getByTestId("field-canvas").focus();
    await page.keyboard.press("Control+Shift+Enter");
    await expect(page.getByTestId("status")).toContainText("Propose needs a project opened from GitHub.");
    await expect(page.getByTestId("status")).not.toContainText("Propose: Propose");
  });

  test("keeps Search actions off the Help menu, and calls the long tour Take the full tour", async ({ page }) => {
    await openExample(page);
    await page.getByTestId("toolbar-help").click();
    const items = page.getByTestId("help-menu").getByRole("menuitem");
    await expect(items.filter({ hasText: "Search actions" })).toHaveCount(0);
    await expect(items.filter({ hasText: "Take the full tour" })).toHaveCount(1);
    await expect(items.filter({ hasText: "Show me everything" })).toHaveCount(0);
  });
});

test.describe("the tools on the field", () => {
  test("has no Play of its own on the field; the toolbar's plays", async ({ page }) => {
    await openExample(page);
    await expect(page.getByTestId("canvas-play")).toHaveCount(0);
    await expect(page.getByTestId("toolbar-view.play")).toBeVisible();
  });

  test("shows one hint line while a tool is on, naming the step Add path goes after", async ({ page }) => {
    await openExample(page);
    await expect(page.getByTestId("canvas-tool-hint")).toHaveCount(0);
    await page.getByTestId("toolbar-tool.marker").click();
    await expect(page.getByTestId("canvas-tool-hint")).toHaveText("Marker: click a path to drop a marker. Esc to finish");
    await page.getByTestId("step-row-toOtherSide").click();
    await page.getByTestId("toolbar-tool.addPath").click();
    await expect(page.getByTestId("canvas-tool-hint")).toContainText("after toOtherSide");
    await expect(page.getByTestId("canvas-tool-hint")).toHaveCount(1);
  });

  test("keeps Add path on between clicks, says where the path went, and Esc returns to Select", async ({ page }) => {
    await openExample(page);
    await page.getByTestId("step-row-toOtherSide").click();
    await page.getByTestId("toolbar-tool.addPath").click();
    await page.getByTestId("field-canvas").focus();
    const spot = await worldToScreen(page, 30, -20);
    await page.mouse.move(spot.x, spot.y);
    await page.mouse.click(spot.x, spot.y);
    await expect(page.getByTestId("status")).toContainText("Added path1 after toOtherSide.");
    await expect(page.getByTestId("toolbar-tool.addPath")).toHaveAttribute("aria-pressed", "true");
    const second = await worldToScreen(page, 30, 20);
    await page.mouse.move(second.x, second.y);
    await page.mouse.click(second.x, second.y);
    await expect(page.getByTestId("status")).toContainText("after path1.");
    await expect(page.getByTestId("toolbar-tool.addPath")).toHaveAttribute("aria-pressed", "true");

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("toolbar-tool.select")).toHaveAttribute("aria-pressed", "true");
    // The selection stays: Esc left the tool and nothing else.
    expect(await editor<string | undefined>(page, "s.selection.stepId")).toBe("path2");

    // The Measure tool leaves on Esc too.
    await page.getByTestId("toolbar-tool.measure").click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("toolbar-tool.select")).toHaveAttribute("aria-pressed", "true");
  });

  test("drops a marker on a click on the selected path's heading arrow, and opens it with Command focused", async ({ page }) => {
    await openExample(page);
    await page.getByTestId("step-row-driveOut").click();
    // driveOut is a straight line from (-13, -63) to (-13, -36); its end's heading arrow points north from its end.
    await page.getByTestId("toolbar-tool.marker").click();
    const arrow = await worldToScreen(page, -13, -36);
    await page.mouse.click(arrow.x, arrow.y - 18);
    await expect.poll(() => editor<number>(page, `(s.auto.steps.find((x) => x.id === "driveOut").markers ?? []).length`)).toBe(1);
    expect(await editor<number | undefined>(page, "s.selection.markerIndex")).toBe(0);
    await expect(page.getByTestId("inspector-marker-command")).toBeFocused();
  });
});

test.describe("the field's menus and controls", () => {
  test("opens a right-click menu at the pointer in the window, flipping above it near the bottom", async ({ page }) => {
    await openExample(page);
    const canvas = page.getByTestId("field-canvas");
    const box = await canvas.boundingBox();
    if (box === null) throw new Error("the canvas has no box");
    const y = Math.round(box.y + box.height / 2);
    await page.mouse.click(Math.round(box.x + 40), y, { button: "right" });
    const menu = page.getByTestId("canvas-context-menu");
    await expect(menu).toBeVisible();
    expect(await menu.evaluate((element) => getComputedStyle(element).position)).toBe("fixed");
    const top = (await menu.boundingBox())?.y ?? 0;
    const height = (await menu.boundingBox())?.height ?? 0;
    const viewport = page.viewportSize()?.height ?? 720;
    if (y + height <= viewport - 4) expect(Math.round(top)).toBe(y);
    else expect(Math.round(top + height)).toBeLessThanOrEqual(y + 1);
    await page.keyboard.press("Escape");

    // Near the window's bottom the menu ends at the pointer instead, and is never held to the canvas's top.
    const low = Math.round(box.y + box.height - 10);
    await page.mouse.click(Math.round(box.x + 40), low, { button: "right" });
    const placed = await menu.boundingBox();
    expect(Math.round((placed?.y ?? 0) + (placed?.height ?? 0))).toBeLessThanOrEqual(low + 1);
    expect(Math.round(placed?.y ?? 0)).not.toBe(Math.round(box.y + 4));
  });

  test("has Fit, + and − at the corner, which zoom about the well's centre, and a zoom percent", async ({ page }) => {
    await openExample(page);
    const canvas = page.getByTestId("field-canvas");
    const box = await canvas.boundingBox();
    if (box === null) throw new Error("the canvas has no box");
    const fitted = Number(await canvas.getAttribute("data-px-per-in"));
    await expect(page.getByTestId("canvas-zoom-pct")).toHaveText("100%");
    const centreWorld = async () => {
      const pxPerIn = Number(await canvas.getAttribute("data-px-per-in"));
      const ox = Number(await canvas.getAttribute("data-origin-x-px"));
      const oy = Number(await canvas.getAttribute("data-origin-y-px"));
      return { x: (box.width / 2 - ox) / pxPerIn, y: (oy - box.height / 2) / pxPerIn };
    };
    const before = await centreWorld();
    await page.getByTestId("canvas-zoom-in").click();
    await expect.poll(async () => Number(await canvas.getAttribute("data-px-per-in"))).toBeCloseTo(fitted * 1.25, 3);
    await expect(page.getByTestId("canvas-zoom-pct")).toHaveText("125%");
    const after = await centreWorld();
    expect(after.x).toBeCloseTo(before.x, 1);
    expect(after.y).toBeCloseTo(before.y, 1);
    await page.getByTestId("canvas-zoom-out").click();
    await page.getByTestId("canvas-zoom-out").click();
    await expect(page.getByTestId("canvas-zoom-pct")).toHaveText("80%");
    await page.getByTestId("canvas-zoom-fit").click();
    await expect.poll(async () => Number(await canvas.getAttribute("data-px-per-in"))).toBeCloseTo(fitted, 5);
    await expect(page.getByTestId("canvas-zoom-pct")).toHaveText("100%");
  });

  test("fits the field board, at least 90% of the well's shorter side at 1280 x 720", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await openExample(page);
    const canvas = page.getByTestId("field-canvas");
    const box = await canvas.boundingBox();
    if (box === null) throw new Error("the canvas has no box");
    const board = 144 * Number(await canvas.getAttribute("data-px-per-in"));
    expect(board).toBeGreaterThanOrEqual(0.9 * Math.min(box.width, box.height));
  });

  test("says which auto a mirrored preview edits, and takes no drawing edit while it shows", async ({ page }) => {
    await openExample(page);
    await page.getByTestId("toolbar-tool.addPath").click();
    await page.getByTestId("toolbar-view.alliance").click();
    await expect(page.getByTestId("canvas-mirror-banner")).toHaveText("Mirrored preview. Edits apply to the RED auto.");
    // Mirroring leaves the drawing tool, and the drawing tools say why they are off.
    await expect(page.getByTestId("toolbar-tool.select")).toHaveAttribute("aria-pressed", "true");
    for (const id of ["tool.addPath", "tool.marker", "tool.heading"]) {
      await expect(page.getByTestId(`toolbar-${id}`)).toHaveAttribute("aria-disabled", "true");
    }
    await page.getByTestId("toolbar-tool.addPath").hover();
    await expect(page.getByRole("tooltip")).toContainText("Mirrored preview. Edits apply to the RED auto.");
    // Its key does nothing either, and a field click makes no edit.
    const steps = await editor<number>(page, "s.auto.steps.length");
    await page.getByTestId("field-canvas").focus();
    await page.keyboard.press("p");
    await expect(page.getByTestId("toolbar-tool.select")).toHaveAttribute("aria-pressed", "true");
    const spot = await worldToScreen(page, 30, -20);
    await page.mouse.click(spot.x, spot.y);
    expect(await editor<number>(page, "s.auto.steps.length")).toBe(steps);
  });

  test("draws only the selected finding's clip ghosts", async ({ page }) => {
    await openExample(page);
    // Two legs that each run out to a wall and back, so each has a ghost of its own.
    await page.evaluate(
      `import("/src/state/store.ts").then((m) => {
        const s = m.getState();
        const steps = m.currentDerived().plan.steps;
        const end = steps[steps.length - 1].endPose;
        const leg = (id, x) => ({ id, kind: "path", heading: { mode: "constant", headingRad: 0 },
          segments: [
            { kind: "line", from: "current", to: { xIn: x, yIn: end.yIn } },
            { kind: "line", from: { xIn: x, yIn: end.yIn }, to: { xIn: end.xIn, yIn: end.yIn } },
          ] });
        m.commit({ ...s.auto, steps: [...s.auto.steps, leg("clipEast", 70), leg("clipWest", -70)] });
      })`,
    );
    const canvas = page.getByTestId("field-canvas");
    await expect.poll(async () => Number(await canvas.getAttribute("data-ghosts"))).toBeGreaterThanOrEqual(2);
    const all = Number(await canvas.getAttribute("data-ghosts"));
    const own = await editor<number>(
      page,
      `m.currentDerived().findings.filter((f) => ["PERIMETER", "STRUCTURE", "KEEPOUT", "OPPONENT_SIDE"].includes(f.code) && f.stepId === "clipEast" && f.geometry?.poseIn !== undefined).length`,
    );
    expect(own).toBeGreaterThan(0);
    expect(own).toBeLessThan(all);
    await page.getByTestId("step-row-clipEast").click();
    await expect.poll(async () => Number(await canvas.getAttribute("data-ghosts"))).toBe(own);
  });
});
