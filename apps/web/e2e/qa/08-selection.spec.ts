/**
 * QA 8, selection and the canvas's other gestures (site/docs/editor.md,
 * interaction-conventions.md sections 3.4 to 3.6): click, Shift-click, marquee, moving several
 * points together, double-click to add or split, the context menu on a point, a path, a step and
 * empty field, and the measure tool.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  canvasView,
  dragWorld,
  editor,
  fixture,
  installCanvasProbe,
  localToWorld,
  nextFrame,
  openProjectWith,
  rowIds,
  shot,
  skipTour,
  worldToScreen,
} from "./helpers";

interface Pose {
  xIn: number;
  yIn: number;
}

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await installCanvasProbe(page);
  await openProjectWith(page, { "qa-curves.auto.json": fixture("qa-curves.auto.json") });
});

const to = (page: Page, step: string, index = 0) =>
  editor<Pose>(page, `s.auto.steps.find((x) => x.id === ${JSON.stringify(step)}).segments[${String(index)}].to`);
const segments = (page: Page, step: string) =>
  editor<number>(page, `s.auto.steps.find((x) => x.id === ${JSON.stringify(step)}).segments.length`);

/** A click at a field point; `mouse.click` takes no modifiers, so they are held on the keyboard. */
async function clickWorld(page: Page, xIn: number, yIn: number, modifiers: Array<"Shift" | "Control"> = []) {
  const at = await worldToScreen(page, xIn, yIn);
  for (const key of modifiers) await page.keyboard.down(key);
  await page.mouse.click(at.x, at.y);
  for (const key of modifiers) await page.keyboard.up(key);
}

test("clicking a point selects it; Shift-click adds a second; a plain click replaces both", async ({ page }) => {
  await page.getByTestId("step-row-curve").getByRole("button").first().click();
  await clickWorld(page, 0, -12);
  await expect.poll(() => editor<string | undefined>(page, "s.selection.point?.pointKind")).toBe("to");
  await clickWorld(page, 36, 12, ["Shift"]);
  await expect.poll(() => editor<number>(page, "(s.selection.points ?? []).length")).toBe(2);
  await shot(page, "08-two-selected");
  await clickWorld(page, 0, -12);
  await expect.poll(() => editor<number>(page, "(s.selection.points ?? []).length")).toBeLessThanOrEqual(1);
});

test("a marquee on empty field selects every endpoint inside it", async ({ page }) => {
  // A box round (0, -12) and (36, 12), well clear of any path at its corners.
  await dragWorld(page, { xIn: -6, yIn: 30 }, { xIn: 44, yIn: -20 }, { release: false });
  await shot(page, "08-marquee");
  await page.mouse.up();
  const points = await editor<Array<{ stepId: string; point: { pointKind: string; segmentIndex: number } }>>(
    page,
    "s.selection.points ?? []",
  );
  const keys = points.map((p) => `${p.stepId}:${String(p.point.segmentIndex)}:${p.point.pointKind}`);
  expect(keys).toContain("curve:0:to");
  expect(keys).toContain("curve:1:to");
});

test("dragging one of several selected points moves them all by the same amount", async ({ page }) => {
  await page.getByTestId("step-row-curve").getByRole("button").first().click();
  await clickWorld(page, 0, -12);
  await clickWorld(page, 36, 12, ["Shift"]);
  const a0 = await to(page, "curve", 0);
  const b0 = await to(page, "curve", 1);
  await dragWorld(page, { xIn: 36, yIn: 12 }, { xIn: 30, yIn: 18 });
  const a1 = await to(page, "curve", 0);
  const b1 = await to(page, "curve", 1);
  expect(b1.xIn - b0.xIn).toBeCloseTo(-6, 0);
  expect(b1.yIn - b0.yIn).toBeCloseTo(6, 0);
  expect(a1.xIn - a0.xIn).toBeCloseTo(b1.xIn - b0.xIn, 6);
  expect(a1.yIn - a0.yIn).toBeCloseTo(b1.yIn - b0.yIn, 6);
  // One undo takes back the whole group move.
  await page.keyboard.press("Control+z");
  expect(await to(page, "curve", 0)).toMatchObject({ xIn: a0.xIn, yIn: a0.yIn });
  expect(await to(page, "curve", 1)).toMatchObject({ xIn: b0.xIn, yIn: b0.yIn });
});

test("with nothing selected, dragging a path's end moves it and selects that step; one undo puts it back", async ({ page }) => {
  // Empty field clears the selection; loose ends at (0, 40), well clear of every other step's dots.
  await clickWorld(page, -50, 60);
  await expect.poll(() => editor<string | undefined>(page, "s.selection.stepId")).toBeUndefined();
  const before = await to(page, "loose");
  const undoDepth = await editor<number>(page, "s.undo.length");
  await dragWorld(page, { xIn: 0, yIn: 40 }, { xIn: -6, yIn: 46 }, { release: false });
  await shot(page, "08-drag-unselected-dot");
  await page.mouse.up();
  const after = await to(page, "loose");
  expect(after.xIn).toBeCloseTo(-6, 0);
  expect(after.yIn).toBeCloseTo(46, 0);
  expect(await editor<string | undefined>(page, "s.selection.stepId")).toBe("loose");
  // The drag is one undo step, and selecting the step on the way added none.
  expect(await editor<number>(page, "s.undo.length")).toBe(undoDepth + 1);
  await page.keyboard.press("Control+z");
  await expect.poll(() => to(page, "loose")).toMatchObject({ xIn: before.xIn, yIn: before.yIn });
  expect(await editor<number>(page, "s.undo.length")).toBe(undoDepth);
});

test("with nothing selected, a plain click on a path's dot only selects the step", async ({ page }) => {
  await clickWorld(page, -50, 60);
  await expect.poll(() => editor<string | undefined>(page, "s.selection.stepId")).toBeUndefined();
  const before = await to(page, "loose");
  const undoDepth = await editor<number>(page, "s.undo.length");
  await clickWorld(page, 0, 40);
  await expect.poll(() => editor<string | undefined>(page, "s.selection.stepId")).toBe("loose");
  expect(await editor<unknown>(page, "s.selection.point ?? null")).toBeNull();
  expect(await to(page, "loose")).toMatchObject({ xIn: before.xIn, yIn: before.yIn });
  expect(await editor<number>(page, "s.undo.length")).toBe(undoDepth);
});

test("double-clicking a path splits the segment there", async ({ page }) => {
  // loose runs from (36, 40) to (0, 40) with both ends written out; its middle is (18, 40).
  await page.getByTestId("step-row-loose").getByRole("button").first().click();
  expect(await segments(page, "loose")).toBe(1);
  const at = await worldToScreen(page, 18, 40);
  await page.mouse.dblclick(at.x, at.y);
  await expect.poll(() => segments(page, "loose")).toBe(2);
  const split = await to(page, "loose", 0);
  expect(split.xIn).toBeCloseTo(18, 0);
  expect(split.yIn).toBeCloseTo(40, 0);
  await page.keyboard.press("Control+z");
  await expect.poll(() => segments(page, "loose")).toBe(1);
});

test("double-clicking a path that starts where the last step ended splits it too", async ({ page }) => {
  await page.getByTestId("step-row-hop").getByRole("button").first().click();
  const at = await worldToScreen(page, 36, 26);
  await page.mouse.dblclick(at.x, at.y);
  await expect.poll(() => segments(page, "hop"), { timeout: 2_000 }).toBe(2);
});

test("with the path tool, a double-click on empty field adds one path, not two", async ({ page }) => {
  await page.getByTestId("step-row-hop").getByRole("button").first().click();
  await page.keyboard.press("p");
  const before = (await rowIds(page)).length;
  const at = await worldToScreen(page, 50, -50);
  await page.mouse.dblclick(at.x, at.y);
  await page.waitForTimeout(300);
  expect((await rowIds(page)).length, "one new step").toBe(before + 1);
});

test("double-clicking empty field with the select tool fits the field back into view", async ({ page }) => {
  const canvas = page.getByTestId("field-canvas");
  const fitted = await canvasView(page);
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("no canvas");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -400);
  await expect.poll(async () => (await canvasView(page)).pxPerIn).toBeGreaterThan(fitted.pxPerIn * 1.1);
  // A spot inside the canvas's bottom-left corner, clear of every path at this zoom.
  await page.mouse.dblclick(box.x + 30, box.y + box.height - 60);
  await expect.poll(async () => (await canvasView(page)).pxPerIn).toBeCloseTo(fitted.pxPerIn, 1);
});

test.describe("context menus", () => {
  /** Every item shows its shortcut when it has one, and disabled items say why. */
  async function menuRows(page: Page): Promise<Array<{ action: string; label: string; shortcut: string; disabled: boolean }>> {
    return page.getByTestId("canvas-context-menu").locator("[data-action]").evaluateAll((items) =>
      items.map((item) => {
        const spans = item.querySelectorAll("span");
        return {
          action: item.getAttribute("data-action") ?? "",
          label: (spans[0]?.textContent ?? "").trim(),
          shortcut: (spans[1]?.textContent ?? "").trim(),
          disabled: (item as HTMLButtonElement).disabled,
        };
      }),
    );
  }

  test("on a path: split here, with Double-click as its shortcut", async ({ page }) => {
    const at = await worldToScreen(page, 36, 26);
    await page.mouse.click(at.x, at.y, { button: "right" });
    await expect(page.getByTestId("canvas-context-menu")).toBeVisible();
    const rows = await menuRows(page);
    await shot(page, "08-context-menu-path");
    expect(rows.map((row) => row.action)).toContain("canvas.split");
    expect(rows.find((row) => row.action === "canvas.split")?.shortcut).toMatch(/double-click/i);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("canvas-context-menu")).toHaveCount(0);
  });

  test("on empty field: add path and snap, each with its key", async ({ page }) => {
    const at = await worldToScreen(page, 55, -55);
    await page.mouse.click(at.x, at.y, { button: "right" });
    const rows = await menuRows(page);
    await shot(page, "08-context-menu-field");
    expect(rows.find((row) => row.action === "tool.addPath")?.shortcut).toBe("P");
    expect(rows.find((row) => row.action === "view.snap")?.shortcut).toBe("S");
    // A click elsewhere closes it.
    await page.mouse.click(5, 400);
    await expect(page.getByTestId("canvas-context-menu")).toHaveCount(0);
  });

  test("on a step row: the step's actions with their shortcuts", async ({ page }) => {
    await page.getByTestId("step-row-hop").click({ button: "right" });
    const menu = page.getByTestId("step-menu");
    await expect(menu).toBeVisible();
    await shot(page, "08-context-menu-step");
    await expect(menu.getByTestId("menu-edit.delete")).toContainText("Del");
    await expect(menu.getByTestId("menu-edit.duplicate")).toContainText("Ctrl D");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  });

  test("a disabled context-menu item can still be reached and says why", async ({ page }) => {
    await page.getByTestId("step-row-curve").getByRole("button").first().click();
    const at = await worldToScreen(page, 0, -12);
    await page.mouse.click(at.x, at.y, { button: "right" });
    const corner = page.getByTestId("canvas-context-menu").locator('[data-action="canvas.node.corner"]');
    await expect(corner).toBeVisible();
    await corner.hover();
    await expect(page.getByRole("tooltip")).toContainText(/already/i, { timeout: 1_500 });
  });

  test("the context menu is keyboard operable: arrows move, Enter runs", async ({ page }) => {
    const at = await worldToScreen(page, 55, -55);
    await page.mouse.click(at.x, at.y, { button: "right" });
    const menu = page.getByTestId("canvas-context-menu");
    await expect(menu).toBeVisible();
    await page.keyboard.press("ArrowDown");
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-action") ?? null);
    expect(focused, "a menu item has focus after ArrowDown").not.toBeNull();
    await page.keyboard.press("Enter");
    await expect(menu).toHaveCount(0);
  });
});

/** Every point the measure tool can snap to: the auto's own poses and controls, and the waypoints. */
const snapCandidates = (page: Page) =>
  editor<Pose[]>(
    page,
    `(() => {
      const out = [];
      const walk = (value) => {
        if (Array.isArray(value)) { value.forEach(walk); return; }
        if (value === null || typeof value !== "object") return;
        if (typeof value.xIn === "number" && typeof value.yIn === "number") out.push({ xIn: value.xIn, yIn: value.yIn });
        Object.values(value).forEach(walk);
      };
      walk(s.auto);
      walk(Object.values(s.project?.waypoints?.waypoints ?? {}));
      return out;
    })()`,
  );

/**
 * A start and end, `offset` apart, both on the field and at least three snap radii from every snap
 * candidate, so a drag between them measures exactly `offset`.
 */
async function clearMeasureEnds(page: Page, offset: Pose): Promise<{ from: Pose; to: Pose }> {
  const candidates = await snapCandidates(page);
  const { pxPerIn } = await canvasView(page);
  const clearIn = (3 * 8) / pxPerIn;
  const clear = (point: Pose) => candidates.every((c) => Math.hypot(c.xIn - point.xIn, c.yIn - point.yIn) > clearIn);
  for (let yIn = -60; yIn <= 60 - offset.yIn; yIn += 2) {
    for (let xIn = -60; xIn <= 60 - offset.xIn; xIn += 2) {
      const from = { xIn, yIn };
      const to = { xIn: xIn + offset.xIn, yIn: yIn + offset.yIn };
      if (clear(from) && clear(to)) return { from, to };
    }
  }
  throw new Error(`no measure ends clear of ${String(candidates.length)} snap candidates`);
}

test.describe("the measure tool", () => {
  test("U picks it, a drag reads distance and angle, and Escape clears it", async ({ page }) => {
    await page.getByTestId("field-canvas").focus();
    await page.keyboard.press("u");
    expect(await editor<string>(page, "s.tool")).toBe("measure");
    await expect(page.getByTestId("toolbar-tool.measure")).toHaveAttribute("aria-pressed", "true");
    const before = await editor<string>(page, "s.auto ? JSON.stringify(s.auto) : ''");
    // 30 in right and 40 in up: 50 in at 53.1 degrees. Both ends must sit clear of every point
    // the measure tool snaps to, or the reading is from the snapped point instead. Those points
    // come from the fixture and the example's waypoints, which can move (an earlier example put a
    // waypoint next to the old start here), so the ends are chosen from them rather than hard-coded.
    const { from, to: end } = await clearMeasureEnds(page, { xIn: 30, yIn: 40 });
    await dragWorld(page, from, end, { release: false });
    await page.mouse.up();
    const frame = await nextFrame(page);
    const text = frame.texts.join(" | ");
    await shot(page, "08-measure");
    expect(text).toMatch(/50(\.0+)? ?in/);
    expect(text).toMatch(/53(\.1)?°/);
    // Measuring never edits the routine.
    expect(await editor<string>(page, "s.auto ? JSON.stringify(s.auto) : ''")).toBe(before);
    await page.getByTestId("field-canvas").focus();
    await page.keyboard.press("Escape");
    const cleared = (await nextFrame(page)).texts.join(" | ");
    expect(cleared).not.toMatch(/53(\.1)?°/);
    void localToWorld;
  });
});
