/**
 * QA 9, the field image layer (site/docs/editor.md, site/docs/seasons.md): the three
 * views (image, image with outlines, outlines only), the three looks the field file names (dark,
 * black, light), the credit line, the picture's registration against the frame (the RED loading zone
 * is at x -72..-61, y 24..48 in the field file), and dark ink over the light picture.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  canvasView,
  editor,
  installCanvasProbe,
  loadExample,
  nextFrame,
  robotOutlines,
  shot,
  skipTour,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await installCanvasProbe(page);
  await loadExample(page);
});

const setPrefs = (page: Page, prefs: Record<string, unknown>) =>
  page.evaluate(`import("/src/state/store.ts").then((m) => m.setPrefs(${JSON.stringify(prefs)}))`);

/** The mean colour of the canvas over a box of field inches. */
async function meanColour(page: Page, box: { minXIn: number; maxXIn: number; minYIn: number; maxYIn: number }) {
  const view = await canvasView(page);
  return page.evaluate(
    ({ view, box }) => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="field-canvas"]');
      const ctx = canvas?.getContext("2d");
      if (canvas === null || canvas === undefined || ctx === null || ctx === undefined) return null;
      const dpr = canvas.width / canvas.getBoundingClientRect().width;
      const x0 = (view.originXPx + view.pxPerIn * box.minXIn) * dpr;
      const x1 = (view.originXPx + view.pxPerIn * box.maxXIn) * dpr;
      const y0 = (view.originYPx - view.pxPerIn * box.maxYIn) * dpr;
      const y1 = (view.originYPx - view.pxPerIn * box.minYIn) * dpr;
      const data = ctx.getImageData(Math.round(x0), Math.round(y0), Math.max(1, Math.round(x1 - x0)), Math.max(1, Math.round(y1 - y0))).data;
      let r = 0;
      let g = 0;
      let b = 0;
      const n = data.length / 4;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i] ?? 0;
        g += data[i + 1] ?? 0;
        b += data[i + 2] ?? 0;
      }
      return { r: r / n, g: g / n, b: b / n };
    },
    { view, box },
  );
}

/** Waits for the field picture to have loaded and been painted. */
async function imageRequested(page: Page, variant: string): Promise<void> {
  await expect
    .poll(() => page.evaluate((v) => performance.getEntriesByType("resource").some((e) => e.name.includes(`biobuzz-${v}.webp`)), variant))
    .toBe(true);
  await page.waitForTimeout(300);
}

test("the three views switch, default to the picture with outlines, and publish which is showing", async ({ page }) => {
  const canvas = page.getByTestId("field-canvas");
  await expect(canvas).toHaveAttribute("data-field-view", "image+outlines");
  await shot(page, "09-view-image+outlines");
  for (const view of ["image", "vector", "image+outlines"]) {
    await setPrefs(page, { fieldView: view });
    await expect(canvas).toHaveAttribute("data-field-view", view);
    await page.waitForTimeout(200);
    await shot(page, `09-view-${view}`);
  }
});

test("the field view action cycles the three views from the palette", async ({ page }) => {
  const canvas = page.getByTestId("field-canvas");
  // The attribute is published after the click re-renders the canvas, so each step awaits it rather
  // than reading it straight after the click. Starting from the default, the palette action steps
  // image+outlines -> image -> vector -> image+outlines (FIELD_VIEWS in src/app/actions.ts).
  await expect(canvas).toHaveAttribute("data-field-view", "image+outlines");
  for (const next of ["image", "vector", "image+outlines"]) {
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("Field view");
    await page.getByTestId("palette-item-view.fieldView").click();
    await expect(canvas).toHaveAttribute("data-field-view", next);
  }
});

test("the credit line reads 'Field image: Team Juice 16236' over the picture and is gone in vector", async ({ page }) => {
  await imageRequested(page, "dark");
  expect((await nextFrame(page)).texts).toContain("Field image: Team Juice 16236");
  await setPrefs(page, { fieldView: "image" });
  expect((await nextFrame(page)).texts).toContain("Field image: Team Juice 16236");
  await setPrefs(page, { fieldView: "vector" });
  expect((await nextFrame(page)).texts.join(" ")).not.toContain("Team Juice");
});

test("the dark, black and light looks each load their own picture", async ({ page }) => {
  for (const variant of ["dark", "black", "light"]) {
    await setPrefs(page, { fieldStyle: variant, fieldView: "image" });
    await imageRequested(page, variant);
    await shot(page, `09-style-${variant}`);
  }
  // The field style action is enabled because the file names three looks.
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Field style");
  await expect(page.getByTestId("palette-item-view.fieldStyle")).toBeVisible();
});

test("the picture is registered: the RED loading zone is red, where field.json puts it", async ({ page }) => {
  await setPrefs(page, { fieldView: "image", fieldStyle: "dark" });
  await imageRequested(page, "dark");
  await nextFrame(page);
  // loadingZoneRed is x -72..-61, y 24..48; the picture draws it as red tape, so read a strip
  // across its inner edge, between the corners.
  const zone = await meanColour(page, { minXIn: -62.5, maxXIn: -58.5, minYIn: 30, maxYIn: 42 });
  // Point-mirrored on the other side is the BLUE loading zone's tape.
  const blue = await meanColour(page, { minXIn: 58.5, maxXIn: 62.5, minYIn: -42, maxYIn: -30 });
  // And a plain tile for contrast.
  const tile = await meanColour(page, { minXIn: -50, maxXIn: -43, minYIn: 4, maxYIn: 20 });
  if (zone === null || blue === null || tile === null) throw new Error("no pixels");
  const redness = (c: { r: number; g: number; b: number }) => c.r - (c.g + c.b) / 2;
  const blueness = (c: { r: number; g: number; b: number }) => c.b - (c.r + c.g) / 2;
  expect(redness(zone), `zone ${JSON.stringify(zone)} vs tile ${JSON.stringify(tile)}`).toBeGreaterThan(redness(tile) + 15);
  expect(blueness(blue), `blue zone ${JSON.stringify(blue)} vs tile ${JSON.stringify(tile)}`).toBeGreaterThan(blueness(tile) + 15);
  await shot(page, "09-registration-dark");
});

test("over the light picture the robot and paths are drawn in dark ink", async ({ page }) => {
  await setPrefs(page, { fieldView: "image", fieldStyle: "light" });
  await imageRequested(page, "light");
  await page.getByTestId("step-row-driveOut").getByRole("button").first().click();
  const frame = await nextFrame(page);
  const view = await canvasView(page);
  const robot = robotOutlines(frame, view.pxPerIn);
  expect(robot.length).toBe(1);
  const strokes = frame.polygons.filter((p) => p.op === "stroke" && robotOutlines({ ...frame, polygons: [p] }, view.pxPerIn).length === 1);
  const style = strokes[0]?.style ?? "";
  // #17061d, the ground colour, as the canvas reports it.
  expect(style.toLowerCase()).toMatch(/#17061d|rgba?\(23, 6, 29/);
  await shot(page, "09-light-ink");
  // Back on the dark picture the outline is light again.
  await setPrefs(page, { fieldStyle: "dark" });
  const dark = await nextFrame(page);
  const darkStroke = dark.polygons.filter((p) => p.op === "stroke" && robotOutlines({ ...dark, polygons: [p] }, view.pxPerIn).length === 1)[0]?.style ?? "";
  expect(darkStroke.toLowerCase()).not.toMatch(/#17061d/);
  expect(await editor<string>(page, "s.prefs.fieldStyle")).toBe("dark");
});
