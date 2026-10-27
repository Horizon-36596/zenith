/**
 * QA 9, the drawn field (site/docs/editor.md, "The drawn field"; issue #117): the BIOBUZZ field is
 * drawn from its geometry, with no picture requested and no picture credit on the field. The loading
 * zones' tape and the hives' up cells are drawn in their alliance's colour where the field file puts
 * them, and the field view and field style actions, which only choose between a field file's own
 * pictures, are disabled.
 */
import { expect, test, type Page } from "@playwright/test";
import { canvasView, installCanvasProbe, loadExample, nextFrame, shot, skipTour } from "./helpers";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    performance.setResourceTimingBufferSize(5000);
  });
  await skipTour(page);
  await installCanvasProbe(page);
  await loadExample(page);
});

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

const redness = (c: { r: number; g: number; b: number }) => c.r - (c.g + c.b) / 2;
const blueness = (c: { r: number; g: number; b: number }) => c.b - (c.r + c.g) / 2;

test("the field is drawn, not a picture: no image is requested and no picture credit is drawn", async ({ page }) => {
  const canvas = page.getByTestId("field-canvas");
  await expect(canvas).toHaveAttribute("data-field-view", "vector");
  const frame = await nextFrame(page);
  expect(frame.texts.join(" ")).not.toContain("Field image");
  const images = await page.evaluate(() =>
    performance.getEntriesByType("resource").filter((entry) => /\.(webp|png|jpe?g)(\?|$)/.test(entry.name) && entry.name.includes("/fields/")),
  );
  expect(images).toEqual([]);
  await shot(page, "09-drawn-field");
});

test("the loading zones' tape is in its alliance's colour, where field.json puts it", async ({ page }) => {
  await nextFrame(page);
  // loadingZoneRed is x -72..-61, y 24..48, taped on the three sides off the wall; read the inner tape.
  const red = await meanColour(page, { minXIn: -62, maxXIn: -61, minYIn: 30, maxYIn: 42 });
  const blue = await meanColour(page, { minXIn: 61, maxXIn: 62, minYIn: -42, maxYIn: -30 });
  const tile = await meanColour(page, { minXIn: -50, maxXIn: -43, minYIn: 4, maxYIn: 20 });
  if (red === null || blue === null || tile === null) throw new Error("no pixels");
  expect(redness(red), `red tape ${JSON.stringify(red)} vs tile ${JSON.stringify(tile)}`).toBeGreaterThan(redness(tile) + 60);
  expect(blueness(blue), `blue tape ${JSON.stringify(blue)} vs tile ${JSON.stringify(tile)}`).toBeGreaterThan(blueness(tile) + 60);
});

test("each hive's up cell is filled in its alliance's colour: red south, blue north", async ({ page }) => {
  await nextFrame(page);
  // hiveRed pivots at (-12.75, 0) with its SOUTH cell up; hiveBlue at (12.75, 0) with NORTH up.
  const redUp = await meanColour(page, { minXIn: -20, maxXIn: -6, minYIn: -16, maxYIn: -11 });
  const redDown = await meanColour(page, { minXIn: -20, maxXIn: -6, minYIn: 11, maxYIn: 16 });
  const blueUp = await meanColour(page, { minXIn: 6, maxXIn: 20, minYIn: 11, maxYIn: 16 });
  if (redUp === null || redDown === null || blueUp === null) throw new Error("no pixels");
  expect(redness(redUp)).toBeGreaterThan(redness(redDown) + 30);
  expect(blueness(blueUp)).toBeGreaterThan(30);
});

test("the field view and field style actions are disabled: there is no picture to choose", async ({ page }) => {
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Field view");
  const item = page.getByTestId("palette-item-view.fieldView");
  await expect(item).toBeVisible();
  await expect(item).toBeDisabled();
  await page.getByTestId("palette-input").fill("Field style");
  await expect(page.getByTestId("palette-item-view.fieldStyle")).toBeDisabled();
});
