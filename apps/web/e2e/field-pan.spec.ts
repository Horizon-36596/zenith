/**
 * Issue #115: the field pans the way Onshape does. A middle-button drag and a Ctrl + right-button
 * drag both move the view by exactly the distance the pointer moved, open no context menu and
 * change no selection; a plain right-click still opens the field's menu.
 */
import { expect, test, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";
import { LAYOUT_SIZES } from "./viewports";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem(
        "zenith.ui",
        JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }),
      );
    }
  });
  await turnOnFeatures(page);
});

interface Origin {
  x: number;
  y: number;
}

/** Where the world origin sits on the canvas, from the view the canvas publishes on its element. */
async function origin(page: Page): Promise<Origin> {
  const canvas = page.getByTestId("field-canvas");
  return {
    x: Number(await canvas.getAttribute("data-origin-x-px")),
    y: Number(await canvas.getAttribute("data-origin-y-px")),
  };
}

/** A point on the canvas, `fx` and `fy` of the way across it, in page pixels. */
async function at(page: Page, fx: number, fy: number): Promise<Origin> {
  const box = await page.getByTestId("field-canvas").boundingBox();
  if (box === null) throw new Error("the canvas has no box");
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
}

/**
 * Drags with `button` from `from` by (dx, dy) in several moves, as a hand would, and checks the
 * canvas shows the grabbing hand while the button is down.
 */
async function drag(page: Page, button: "middle" | "right", from: Origin, dx: number, dy: number): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down({ button });
  for (let i = 1; i <= 8; i += 1) await page.mouse.move(from.x + (dx * i) / 8, from.y + (dy * i) / 8);
  expect(await page.getByTestId("field-canvas").evaluate((canvas) => canvas.style.cursor)).toBe("grabbing");
  await page.mouse.up({ button });
}

const selection = (page: Page): Promise<unknown> =>
  page.evaluate(`import("/src/state/store.ts").then((m) => m.getState().selection)`);

test("a middle drag and a Ctrl + right drag pan the field, with no context menu", async ({ page }) => {
  await page.goto("/?cloud=fake");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  const menu = page.getByTestId("canvas-context-menu");
  const before = await selection(page);

  // Middle drag, starting on the field near a corner, away from the routine.
  const first = await origin(page);
  await drag(page, "middle", await at(page, 0.1, 0.1), 60, -40);
  const second = await origin(page);
  expect(second.x - first.x).toBeCloseTo(60, 0);
  expect(second.y - first.y).toBeCloseTo(-40, 0);
  await expect(menu).toHaveCount(0);

  // Ctrl + right drag, the other way. The drag ends off the canvas, which pointer capture covers.
  await page.keyboard.down("Control");
  await drag(page, "right", await at(page, 0.15, 0.15), -45, 30);
  await page.keyboard.up("Control");
  const third = await origin(page);
  expect(third.x - second.x).toBeCloseTo(-45, 0);
  expect(third.y - second.y).toBeCloseTo(30, 0);
  await expect(menu).toHaveCount(0);
  expect(await selection(page)).toEqual(before);

  // A pan that ends outside the canvas still ends: moving the mouse afterwards moves nothing.
  const canvasBox = await page.getByTestId("field-canvas").boundingBox();
  if (canvasBox === null) throw new Error("the canvas has no box");
  await drag(page, "middle", await at(page, 0.1, 0.5), -canvasBox.x - canvasBox.width * 0.1 + 5, 0);
  const fourth = await origin(page);
  await page.mouse.move(canvasBox.x + canvasBox.width * 0.5, canvasBox.y + canvasBox.height * 0.5);
  await page.mouse.move(canvasBox.x + canvasBox.width * 0.6, canvasBox.y + canvasBox.height * 0.6);
  expect(await origin(page)).toEqual(fourth);

  // A plain right-click still opens the field's menu.
  const spot = await at(page, 0.1, 0.1);
  await page.mouse.click(spot.x, spot.y, { button: "right" });
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");

  // The shortcut sheet names both pans.
  await page.keyboard.press("F1");
  await page.getByTestId("shortcuts-tab-mouse").click();
  await expect(page.getByTestId("shortcuts-overlay")).toContainText("Middle-drag, Ctrl + right-drag, or Space + drag");
});

/*
 * Issue #151: the field stays whole while the view moves. The canvas used to blit the field it had
 * painted before a pan or a zoom under the new transform and repaint it only once the gesture had
 * stopped for 110 ms, so whatever had been off screen when the gesture began showed as the empty
 * well until then, and the first frame of a Zoom to fit showed only the small rectangle that had
 * been in view. A round trip from the test to the page can take longer than those 110 ms, so the
 * page itself records the canvas on the frame after each input (`watchPoint`), before anything
 * could settle, and the test reads those records afterwards.
 */

type Rgb = [number, number, number];

interface CanvasView {
  pxPerIn: number;
  originXPx: number;
  originYPx: number;
  widthPx: number;
  heightPx: number;
}

/** The view the canvas publishes on its element, with its size in CSS pixels. */
async function canvasView(page: Page): Promise<CanvasView> {
  return page.getByTestId("field-canvas").evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const box = canvas.getBoundingClientRect();
    return {
      pxPerIn: Number(canvas.dataset["pxPerIn"]),
      originXPx: Number(canvas.dataset["originXPx"]),
      originYPx: Number(canvas.dataset["originYPx"]),
      widthPx: box.width,
      heightPx: box.height,
    };
  });
}

/** A field point on the canvas, in CSS pixels from its top-left corner. BIOBUZZ puts the audience at the bottom. */
const onCanvas = (view: CanvasView, xIn: number, yIn: number): { xPx: number; yPx: number } => ({
  xPx: view.originXPx + view.pxPerIn * xIn,
  yPx: view.originYPx - view.pxPerIn * yIn,
});

/** A colour token of the page's theme, as red, green and blue. */
async function token(page: Page, name: string): Promise<Rgb> {
  const hex = await page.evaluate((property) => getComputedStyle(document.documentElement).getPropertyValue(property).trim(), name);
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (match === null) throw new Error(`${name} is ${hex}, not a #rrggbb colour`);
  return [parseInt(match[1] ?? "", 16), parseInt(match[2] ?? "", 16), parseInt(match[3] ?? "", 16)];
}

/** What the canvas showed at the watched point on the frame after one input. */
interface PointRead {
  rgb: Rgb;
  xPx: number;
  yPx: number;
  view: CanvasView;
}

/**
 * From now on, on the frame after every pointer move, wheel turn and click, the page records the
 * colour the canvas shows at a field point and where that point is on it. The listeners sit on the
 * window and hear an event after the canvas has, so the frame callback each one queues runs after
 * the canvas's own draw for that input and reads what that frame painted.
 */
async function watchPoint(page: Page, xIn: number, yIn: number): Promise<void> {
  await page.getByTestId("field-canvas").evaluate((element, point) => {
    const canvas = element as HTMLCanvasElement;
    const reads: unknown[] = [];
    (window as unknown as { fieldPointReads: unknown[] }).fieldPointReads = reads;
    const read = (): void => {
      requestAnimationFrame(() => {
        const box = canvas.getBoundingClientRect();
        const view = {
          pxPerIn: Number(canvas.dataset["pxPerIn"]),
          originXPx: Number(canvas.dataset["originXPx"]),
          originYPx: Number(canvas.dataset["originYPx"]),
          widthPx: box.width,
          heightPx: box.height,
        };
        const xPx = view.originXPx + view.pxPerIn * point.xIn;
        const yPx = view.originYPx - view.pxPerIn * point.yIn;
        const scale = canvas.width / box.width;
        const data = canvas.getContext("2d")?.getImageData(Math.round(xPx * scale), Math.round(yPx * scale), 1, 1).data;
        reads.push({ rgb: [data?.[0] ?? -1, data?.[1] ?? -1, data?.[2] ?? -1], xPx, yPx, view });
      });
    };
    for (const type of ["pointermove", "wheel", "click"]) window.addEventListener(type, read);
  }, { xIn, yIn });
}

/** The first record `watchPoint` made under a view that passes `test`, once there is one. */
async function firstReadWhere(page: Page, test: (view: CanvasView) => boolean): Promise<PointRead> {
  let found: PointRead | undefined;
  await expect
    .poll(async () => {
      const reads = (await page.evaluate(() => (window as unknown as { fieldPointReads?: unknown[] }).fieldPointReads ?? [])) as PointRead[];
      found = reads.find((entry) => test(entry.view));
      return found !== undefined;
    })
    .toBe(true);
  if (found === undefined) throw new Error("no frame under that view");
  return found;
}

const distance = (a: Rgb, b: Rgb): number => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

/**
 * The first floor point east of the canvas's right edge, on the field's row y = 6 in: the middle of
 * a 12 in grid square (x is 6 more than a multiple of 12), clear of the hives, the hive frame's bars
 * and legs, the flowers and the routine, which all stay west of it or away from that row.
 */
function floorPointPastRightEdge(view: CanvasView): { xIn: number; yIn: number } {
  const edgeIn = (view.widthPx - view.originXPx) / view.pxPerIn;
  let xIn = Math.ceil((edgeIn - 6) / 12) * 12 + 6;
  while (onCanvas(view, xIn, 6).xPx <= view.widthPx + 2) xIn += 12;
  if (xIn >= 72) throw new Error(`no floor east of the canvas at x = ${String(xIn)} in: zoom in further`);
  return { xIn, yIn: 6 };
}

/** Opens the example and zooms in about the middle of the canvas, so the field's east side is off screen. */
async function zoomedIn(page: Page): Promise<void> {
  await page.goto("/?cloud=fake");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  const middle = await at(page, 0.5, 0.5);
  await page.mouse.move(middle.x, middle.y);
  const before = (await canvasView(page)).pxPerIn;
  for (let i = 0; i < 3; i += 1) await page.mouse.wheel(0, -300);
  await expect.poll(async () => (await canvasView(page)).pxPerIn).toBeGreaterThan(before * 3);
  // The view then rests, as a hand's does between gestures. Before issue #151 this rest is when the
  // field was repainted for the zoomed view, 110 ms after the last wheel turn, and only where it was
  // on screen; the next gesture then moved that painting about instead of the whole field.
  await page.waitForTimeout(300);
}

test.describe("the field stays whole while the view moves (issue #151)", () => {
  test("a middle-button pan of 200 px shows the floor that was off screen, before the button is released", async ({ page }) => {
    await zoomedIn(page);
    const floor = await token(page, "--field-floor");
    const well = await token(page, "--bg-canvas");
    const start = await canvasView(page);
    const point = floorPointPastRightEdge(start);
    expect(onCanvas(start, point.xIn, point.yIn).xPx).toBeGreaterThan(start.widthPx);

    const from = await at(page, 0.75, 0.5);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down({ button: "middle" });
    await watchPoint(page, point.xIn, point.yIn);
    for (let i = 1; i <= 8; i += 1) await page.mouse.move(from.x - (200 * i) / 8, from.y);
    // The frame after the last move, with the button still down.
    const during = await firstReadWhere(page, (view) => Math.abs(view.originXPx - (start.originXPx - 200)) < 0.5);
    await page.mouse.up({ button: "middle" });

    expect(during.xPx).toBeGreaterThan(0);
    expect(during.xPx).toBeLessThan(during.view.widthPx);
    expect(distance(during.rgb, well)).toBeGreaterThan(0);
    expect(distance(during.rgb, floor)).toBeLessThanOrEqual(2);
  });

  test("a wheel zoom out shows the floor that was off screen on its first frame", async ({ page }) => {
    await zoomedIn(page);
    const floor = await token(page, "--field-floor");
    const start = await canvasView(page);
    const point = floorPointPastRightEdge(start);

    const middle = await at(page, 0.5, 0.5);
    await page.mouse.move(middle.x, middle.y);
    await watchPoint(page, point.xIn, point.yIn);
    await page.mouse.wheel(0, 600);
    const after = await firstReadWhere(page, (view) => view.pxPerIn < start.pxPerIn);

    expect(after.xPx).toBeLessThan(after.view.widthPx);
    expect(distance(after.rgb, floor)).toBeLessThanOrEqual(2);
  });

  test("Zoom to fit from a zoomed-in view shows the whole floor on its first frame", async ({ page }) => {
    await zoomedIn(page);
    const floor = await token(page, "--field-floor");
    const start = await canvasView(page);
    const point = floorPointPastRightEdge(start);

    await watchPoint(page, point.xIn, point.yIn);
    // The field's corner Fit (issue #412), where the menus' Zoom to fit used to be.
    await page.getByTestId("canvas-zoom-fit").click();
    const after = await firstReadWhere(page, (view) => view.pxPerIn < start.pxPerIn);

    expect(distance(after.rgb, floor)).toBeLessThanOrEqual(2);
  });
});

test("Zoom to fit takes in a curve control past the north wall, and a resize keeps the box the last fit framed (issue #151)", async ({ page }) => {
  await page.goto("/?cloud=fake");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  const reachIn = Math.hypot(18, 18) / 2;
  const topOfControl = async (): Promise<number> => onCanvas(await canvasView(page), -5, 130 + reachIn).yPx;

  // toOtherSide's three curve controls, pulled north to y = 130 in, 58 in past the north wall.
  await page.evaluate(`import("/src/state/store.ts").then((m) => {
    const auto = structuredClone(m.getState().auto);
    const step = auto.steps.find((x) => x.id === "toOtherSide");
    for (const control of step.segments[0].control) control.yIn = 130;
    m.commit(auto);
  })`);
  // The open auto's fit framed the field, and an edit is not a fit: the controls stay off screen,
  // and a resize refits to the same box rather than jumping to take them in.
  expect(await topOfControl()).toBeLessThan(0);
  const before = await canvasView(page);
  await page.setViewportSize({ width: 1280, height: 640 });
  await expect.poll(async () => (await canvasView(page)).heightPx).toBeLessThan(before.heightPx);
  await expect.poll(async () => (await canvasView(page)).pxPerIn).toBeLessThan(before.pxPerIn);
  expect(await topOfControl()).toBeLessThan(0);

  // Zoom to fit frames them, with room for the robot's outline around them.
  await page.getByTestId("canvas-zoom-fit").click();
  await expect.poll(topOfControl).toBeGreaterThanOrEqual(0);

  // That box is held: back at the first size, the refit still takes the controls in.
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect.poll(async () => (await canvasView(page)).heightPx).toBeCloseTo(before.heightPx, 0);
  expect(await topOfControl()).toBeGreaterThanOrEqual(0);
});

test.describe("Zoom to fit at 700 x 500 (issue #151)", () => {
  test.use({ viewport: { width: 700, height: 500 } });

  test("leaves the field's north-west corner uncovered, so a press there reaches the field", async ({ page }) => {
    await page.goto("/?cloud=fake");
    await page.getByTestId("canvas-load-example").click();
    await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
    // The field has no Play over its corner since issue #412; Fit is the corner control.
    await page.getByTestId("canvas-zoom-fit").click();

    const view = await canvasView(page);
    const corner = onCanvas(view, -72, 72);
    const box = await page.getByTestId("field-canvas").boundingBox();
    if (box === null) throw new Error("the canvas has no box");
    const hit = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.getAttribute("data-testid") ?? null,
      { x: box.x + corner.xPx, y: box.y + corner.yPx },
    );
    expect(hit).toBe("field-canvas");
  });
});

/*
 * Issue #151, review of PR #179: the shortcut sheet's Zoom to fit sentence stays on one line. A
 * longer one wrapped to a second line, which made the row 18 px taller (38 px, the gesture on its
 * own line and the sentence under it, became 56 px) and pushed the sheet past the bottom of a
 * 1280 x 720 window (the visual pass's "fits the window without scrolling"). The sentence has to be
 * as tall as the one-line "Zoom about the pointer." beside Scroll, at both layout sizes.
 */
for (const size of LAYOUT_SIZES) {
  test.describe(`the shortcut sheet at ${String(size.width)}x${String(size.height)} (issue #151)`, () => {
    test.use({ viewport: size });

    test("keeps the Zoom to fit sentence on one line", async ({ page }) => {
      await page.goto("/?cloud=fake");
      await page.getByTestId("canvas-load-example").click();
      await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
      await page.keyboard.press("F1");
      await page.getByTestId("shortcuts-tab-mouse").click();
      const field = page.getByTestId("shortcuts-overlay").getByTestId("shortcuts-canvas");
      await expect(field).toBeVisible();
      await page.evaluate(() => document.fonts.ready);

      const does = (gesture: string) =>
        field.locator("div").filter({ has: page.getByText(gesture, { exact: true }) }).locator("dd");
      const fit = does("Double-click empty field");
      const oneLine = does("Scroll");
      await expect(fit).toHaveCount(1);
      await expect(oneLine).toHaveCount(1);
      const fitBox = await fit.boundingBox();
      const oneLineBox = await oneLine.boundingBox();
      if (fitBox === null || oneLineBox === null) throw new Error("a shortcut row has no box");
      expect(fitBox.height).toBeCloseTo(oneLineBox.height, 0);
    });
  });
}
