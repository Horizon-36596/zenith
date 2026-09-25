/**
 * QA 4 and 6, canvas modifiers and the heading arrows (site/docs/editor.md, and the
 * conventions other path planners and drawing tools share), through real pointer drags on
 * the canvas:
 *
 * - the snap toggle, and Ctrl inverting it for one drag;
 * - Alt turning off only the grid and the 15 degree heading, with the wall snap still acting;
 * - Shift constraining a point to one axis, turning a heading in 45 degree steps, and breaking
 *   Bezier handle mirroring;
 * - the drag bubble naming the snap that is acting;
 * - the heading arrows turning only the heading mode, never the point (spec 11 section 3);
 * - smooth and corner nodes, from S and C and from the context menu.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  canvasView,
  dragWorld,
  editor,
  fixture,
  installCanvasProbe,
  nextFrame,
  openProjectWith,
  shot,
  skipTour,
  worldToScreen,
} from "./helpers";

interface Pose {
  xIn: number;
  yIn: number;
  headingRad?: number;
}

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await installCanvasProbe(page);
  await openProjectWith(page, { "qa-curves.auto.json": fixture("qa-curves.auto.json") });
});

const seg = (page: Page, step: string, index: number) =>
  editor<{ to: Pose; control?: Pose[] }>(page, `s.auto.steps.find((x) => x.id === ${JSON.stringify(step)}).segments[${String(index)}]`);

async function select(page: Page, step: string): Promise<void> {
  await page.getByTestId(`step-row-${step}`).getByRole("button").first().click();
  await expect.poll(() => editor<string>(page, "s.selection.stepId")).toBe(step);
}

const isHalf = (value: number): boolean => Math.abs(value * 2 - Math.round(value * 2)) < 1e-9;

/** The drag bubble's text while a drag is held: every string drawn on the canvas that frame. */
async function bubbleText(page: Page): Promise<string> {
  return (await nextFrame(page)).texts.join(" | ");
}

test.describe("snap", () => {
  test("the toolbar toggle and S flip snapping, and say so", async ({ page }) => {
    const snap = page.getByTestId("toolbar-view.snap");
    const initial = await editor<boolean>(page, "s.prefs.snap");
    await expect(snap).toHaveAttribute("aria-pressed", String(initial));
    await snap.click();
    await expect(snap).toHaveAttribute("aria-pressed", String(!initial));
    await page.getByTestId("steps-list").click({ position: { x: 4, y: 4 } });
    await page.keyboard.press("s");
    await expect(snap).toHaveAttribute("aria-pressed", String(initial));
  });

  test("with snap on, a dragged point lands on the half-inch grid and the bubble says grid", async ({ page }) => {
    expect(await editor<boolean>(page, "s.prefs.snap")).toBe(true);
    await select(page, "curve");
    await dragWorld(page, { xIn: 36, yIn: 12 }, { xIn: 30.37, yIn: 20.21 }, { release: false });
    const bubble = await bubbleText(page);
    await shot(page, "04-drag-bubble-grid");
    await page.mouse.up();
    const to = (await seg(page, "curve", 1)).to;
    expect(isHalf(to.xIn) && isHalf(to.yIn), `(${String(to.xIn)}, ${String(to.yIn)}) is on the grid`).toBe(true);
    expect(to.xIn).toBeCloseTo(30.5, 0);
    expect(bubble).toMatch(/grid 0\.5 in/);
  });

  test("Ctrl inverts snap for one drag: off while snap is on", async ({ page }) => {
    await select(page, "curve");
    await dragWorld(page, { xIn: 36, yIn: 12 }, { xIn: 30.37, yIn: 20.21 }, { keys: ["Control"], release: false });
    const bubble = await bubbleText(page);
    await page.mouse.up();
    await page.keyboard.up("Control");
    const to = (await seg(page, "curve", 1)).to;
    expect(isHalf(to.xIn) && isHalf(to.yIn), `(${String(to.xIn)}, ${String(to.yIn)}) is off the grid`).toBe(false);
    expect(bubble).toMatch(/snap off \(Ctrl\)/);
    // Snap itself is still on afterwards: Ctrl only lasts the drag.
    expect(await editor<boolean>(page, "s.prefs.snap")).toBe(true);
  });

  test("Ctrl inverts snap for one drag: on while snap is off", async ({ page }) => {
    await page.getByTestId("toolbar-view.snap").click();
    expect(await editor<boolean>(page, "s.prefs.snap")).toBe(false);
    await select(page, "curve");
    await dragWorld(page, { xIn: 36, yIn: 12 }, { xIn: 30.37, yIn: 20.21 });
    let to = (await seg(page, "curve", 1)).to;
    expect(isHalf(to.xIn) && isHalf(to.yIn), "snap off leaves the pointer's value").toBe(false);
    await dragWorld(page, to, { xIn: 26.13, yIn: 24.77 }, { keys: ["Control"] });
    to = (await seg(page, "curve", 1)).to;
    expect(isHalf(to.xIn) && isHalf(to.yIn), "Ctrl with snap off snaps").toBe(true);
  });

  test("Alt turns off the grid but the wall still snaps flush", async ({ page }) => {
    await select(page, "hop");
    // hop ends at (36, 40) facing +x; the body is 18 in wide, so y = 62.6 puts its top 0.4 in
    // from the 72 in wall, inside the 1 in wall-snap reach.
    await dragWorld(page, { xIn: 36, yIn: 40 }, { xIn: 33.37, yIn: 62.6 }, { keys: ["Alt"], release: false });
    const bubble = await bubbleText(page);
    await shot(page, "04-drag-bubble-wall");
    await page.mouse.up();
    await page.keyboard.up("Alt");
    const to = (await seg(page, "hop", 0)).to;
    expect(to.yIn).toBeCloseTo(63, 6);
    expect(isHalf(to.xIn), `x ${String(to.xIn)} is not quantised under Alt`).toBe(false);
    expect(bubble).toMatch(/wall/);
    const perimeter = await editor<number>(page, `m.currentDerived().findings.filter((f) => f.code === "PERIMETER" && f.stepId === "hop").length`);
    expect(perimeter).toBe(0);
  });

  test("Shift constrains a point drag to the axis it moved furthest on", async ({ page }) => {
    await select(page, "hop");
    await dragWorld(page, { xIn: 36, yIn: 40 }, { xIn: 46.3, yIn: 43.1 }, { keys: ["Shift"], release: false });
    const bubble = await bubbleText(page);
    await page.mouse.up();
    await page.keyboard.up("Shift");
    const to = (await seg(page, "hop", 0)).to;
    expect(to.yIn).toBe(40);
    expect(to.xIn).toBeCloseTo(46.5, 0);
    expect(bubble).toMatch(/axis x \(Shift\)/);
  });
});

test.describe("the heading arrows", () => {
  /** hop is a straight line from (36, 12) to (36, 40) with a Constant 0 heading. */
  const HOP_END = { xIn: 36, yIn: 40 };

  const hopHeading = (page: Page) =>
    editor<{ mode: string; headingRad?: number }>(page, `s.auto.steps.find((x) => x.id === "hop").heading`);

  /**
   * Drags the arrow drawn at `base` (26 px long, along the heading it shows now) round to point
   * towards `towardsDeg`, and returns the drag bubble's text just before release.
   */
  async function dragArrow(page: Page, base: { xIn: number; yIn: number }, nowRad: number, towardsDeg: number, keys: string[] = []): Promise<string> {
    const view = await canvasView(page);
    const reachIn = 26 / view.pxPerIn;
    const grab = await worldToScreen(page, base.xIn + reachIn * Math.cos(nowRad), base.yIn + reachIn * Math.sin(nowRad));
    const rad = (towardsDeg * Math.PI) / 180;
    const b = await worldToScreen(page, base.xIn + 12 * Math.cos(rad), base.yIn + 12 * Math.sin(rad));
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    for (const key of keys) await page.keyboard.down(key);
    for (let i = 1; i <= 8; i += 1) await page.mouse.move(grab.x + ((b.x - grab.x) * i) / 8, grab.y + ((b.y - grab.y) * i) / 8);
    const bubble = await bubbleText(page);
    await page.mouse.up();
    for (const key of keys) await page.keyboard.up(key);
    return bubble;
  }

  test("dragging an arrow changes only the heading mode; the point stays put to a micro-inch", async ({ page }) => {
    await select(page, "hop");
    const before = (await seg(page, "hop", 0)).to;
    await dragArrow(page, HOP_END, 0, 60);
    const after = (await seg(page, "hop", 0)).to;
    expect(Math.abs(after.xIn - before.xIn)).toBeLessThan(1e-6);
    expect(Math.abs(after.yIn - before.yIn)).toBeLessThan(1e-6);
    // The pose heading no mode reads is left alone; the mode's own angle is what turned.
    expect(after.headingRad ?? 0).toBe(before.headingRad ?? 0);
    const heading = await hopHeading(page);
    expect(heading.mode).toBe("constant");
    expect(heading.headingRad ?? 0).toBeCloseTo(Math.PI / 3, 3);
    await shot(page, "04-heading-drag");
  });

  test("with snap on it turns in 15 degree steps, Shift in 45, and Alt frees it", async ({ page }) => {
    await select(page, "hop");
    await dragArrow(page, HOP_END, 0, 38);
    const deg = async (): Promise<number> => (((await hopHeading(page)).headingRad ?? 0) * 180) / Math.PI;
    expect(await deg()).toBeCloseTo(45, 3);

    const coarse = await dragArrow(page, HOP_END, Math.PI / 4, 118, ["Shift"]);
    expect(await deg()).toBeCloseTo(135, 3);
    expect(coarse).toMatch(/45° \(Shift\)/);

    const free = await dragArrow(page, HOP_END, (3 * Math.PI) / 4, 128, ["Alt"]);
    const d = await deg();
    expect(Math.abs(d / 15 - Math.round(d / 15)), `${String(d)}° is not on a 15° step`).toBeGreaterThan(0.01);
    expect(free).toMatch(/free \(Alt\)/);
  });
});
test.describe("Bezier nodes", () => {
  /** The node between the two cubics is at (0, -12): incoming control (-12, -24), outgoing (12, -12). */
  const NODE = { xIn: 0, yIn: -12 };

  const collinear = (a: Pose, node: Pose, b: Pose): number => {
    const ux = a.xIn - node.xIn;
    const uy = a.yIn - node.yIn;
    const vx = b.xIn - node.xIn;
    const vy = b.yIn - node.yIn;
    return Math.abs(ux * vy - uy * vx) / (Math.hypot(ux, uy) * Math.hypot(vx, vy));
  };

  async function selectNode(page: Page): Promise<void> {
    await select(page, "curve");
    const at = await worldToScreen(page, NODE.xIn, NODE.yIn);
    await page.mouse.click(at.x, at.y);
    await expect.poll(() => editor<string | undefined>(page, "s.selection.point?.pointKind")).toBe("to");
  }

  test("S makes a corner node smooth, C makes it a corner again", async ({ page }) => {
    await selectNode(page);
    const before = await seg(page, "curve", 1);
    const incoming = (await seg(page, "curve", 0)).control?.[1] as Pose;
    expect(collinear(incoming, NODE, before.control?.[0] as Pose)).toBeGreaterThan(0.1);
    await page.getByTestId("field-canvas").focus();
    await page.keyboard.press("s");
    const smoothed = (await seg(page, "curve", 1)).control?.[0] as Pose;
    expect(collinear(incoming, NODE, smoothed)).toBeLessThan(1e-6);
    // S on a curve point is the canvas's key: it must not also have toggled snap.
    expect(await editor<boolean>(page, "s.prefs.snap")).toBe(true);
    // C makes it a corner: dragging the incoming handle no longer swings the outgoing one.
    await page.keyboard.press("c");
    expect(await editor<string>(page, "s.tool"), "C on a curve point is not the command tool").toBe("select");
    await dragWorld(page, incoming, { xIn: -16, yIn: -14 });
    const kept = (await seg(page, "curve", 1)).control?.[0] as Pose;
    expect(kept.xIn).toBeCloseTo(smoothed.xIn, 6);
    expect(kept.yIn).toBeCloseTo(smoothed.yIn, 6);
    await page.keyboard.press("Control+z");
    // One more undo step puts the handle back where S found it.
    await page.getByTestId("field-canvas").focus();
    await page.keyboard.press("Control+z");
    const undone = (await seg(page, "curve", 1)).control?.[0] as Pose;
    expect(undone.xIn).toBeCloseTo(12, 6);
    expect(undone.yIn).toBeCloseTo(-12, 6);
  });

  test("a smooth node mirrors its handles, and Shift breaks the mirror for one drag", async ({ page }) => {
    await selectNode(page);
    await page.getByTestId("field-canvas").focus();
    await page.keyboard.press("s");
    const outgoing = (await seg(page, "curve", 1)).control?.[0] as Pose;

    // Drag the incoming handle round: the outgoing one swings to stay opposite.
    await dragWorld(page, { xIn: -12, yIn: -24 }, { xIn: -16, yIn: -14 });
    const incoming = (await seg(page, "curve", 0)).control?.[1] as Pose;
    const swung = (await seg(page, "curve", 1)).control?.[0] as Pose;
    expect(collinear(incoming, NODE, swung)).toBeLessThan(1e-3);
    expect(Math.hypot(swung.xIn - outgoing.xIn, swung.yIn - outgoing.yIn)).toBeGreaterThan(1);

    // With Shift, only the grabbed handle moves.
    await dragWorld(page, incoming, { xIn: -8, yIn: -26 }, { keys: ["Shift"] });
    const still = (await seg(page, "curve", 1)).control?.[0] as Pose;
    expect(still.xIn).toBeCloseTo(swung.xIn, 6);
    expect(still.yIn).toBeCloseTo(swung.yIn, 6);
  });

  test("the point's context menu offers smooth and corner, each with its shortcut", async ({ page }) => {
    await selectNode(page);
    const at = await worldToScreen(page, NODE.xIn, NODE.yIn);
    await page.mouse.click(at.x, at.y, { button: "right" });
    const menu = page.getByTestId("canvas-context-menu");
    await expect(menu).toBeVisible();
    await shot(page, "04-context-menu-point");
    const smooth = menu.locator('[data-action="canvas.node.smooth"]');
    const corner = menu.locator('[data-action="canvas.node.corner"]');
    await expect(smooth).toContainText("S");
    await expect(corner).toContainText("C");
    // The node is a corner, so Corner is the one that is unavailable.
    await expect(corner).toBeDisabled();
    await smooth.click();
    await expect(menu).toHaveCount(0);
    const incoming = (await seg(page, "curve", 0)).control?.[1] as Pose;
    const outgoing = (await seg(page, "curve", 1)).control?.[0] as Pose;
    expect(collinear(incoming, NODE, outgoing)).toBeLessThan(1e-6);
  });
});
