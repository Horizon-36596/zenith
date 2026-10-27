/**
 * Issue #230: each hive frame leg's blocking band, the part below the robot's top, is drawn over
 * the hives, wide enough to see at both layout sizes. At 1440x900 with a device scale factor of
 * 1.95, and at 1280x720 at the fitted zoom (about 2.4 px per inch), every band is at least 3 px
 * across, and the pixel at its middle is the obstacle fill even where a hive's up cell, tinted in its
 * alliance's colour, lies under it. The unit tests (src/canvas/structureLayer.test.ts) check the
 * band's shape and the paint order; this one keeps a screenshot of each size.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";
import { LARGE_VIEWPORT, VIEWPORT } from "./viewports";

interface Point {
  xIn: number;
  yIn: number;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** `--field-obstacle-fill` in the dark theme (src/styles/tokens.css). */
const OBSTACLE_FILL: Rgb = { r: 0x2e, g: 0x20, b: 0x34 };

const SIZES = [
  { name: "1440x900 at 1.95", viewport: LARGE_VIEWPORT, deviceScaleFactor: 1.95, shot: "bands-1440.png" },
  { name: "1280x720 at the fitted zoom", viewport: VIEWPORT, deviceScaleFactor: 1, shot: "bands-1280.png" },
] as const;

async function bandsOf(page: Page): Promise<Array<{ id: string; corners: Point[] }>> {
  const summary = (await page.getByTestId("field-canvas").getAttribute("data-strut-bands")) ?? "";
  return summary
    .split(";")
    .filter((entry) => entry !== "")
    .map((entry) => {
      const [id, points] = entry.split(":") as [string, string];
      const corners = points.split(" ").map((pair) => {
        const [xIn, yIn] = pair.split(",").map(Number) as [number, number];
        return { xIn, yIn };
      });
      return { id, corners };
    });
}

/** The canvas's colour at a field point, read from its backing store. */
async function colourAt(page: Page, at: Point): Promise<Rgb | null> {
  return page.evaluate((at) => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="field-canvas"]');
    const ctx = canvas?.getContext("2d");
    if (canvas === null || canvas === undefined || ctx === null || ctx === undefined) return null;
    const dpr = canvas.width / canvas.getBoundingClientRect().width;
    const pxPerIn = Number(canvas.dataset["pxPerIn"]);
    const x = (Number(canvas.dataset["originXPx"]) + pxPerIn * at.xIn) * dpr;
    const y = (Number(canvas.dataset["originYPx"]) - pxPerIn * at.yIn) * dpr;
    const data = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
    return { r: data[0] ?? 0, g: data[1] ?? 0, b: data[2] ?? 0 };
  }, at);
}

const distance = (a: Rgb, b: Rgb): number => Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
    }
  });
  await turnOnFeatures(page);
});

for (const size of SIZES) {
  test.describe(size.name, () => {
    test.use({ viewport: size.viewport, deviceScaleFactor: size.deviceScaleFactor });

    test(`draws each hive frame leg's band at least 3 px wide and over the hives, ${size.viewport.width}x${size.viewport.height}`, async ({ page }) => {
      await page.goto("/");
      await page.getByTestId("canvas-load-example").click();
      await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
      await expect.poll(async () => (await bandsOf(page)).length).toBe(4);

      const pxPerIn = Number(await page.getByTestId("field-canvas").getAttribute("data-px-per-in"));
      if (size.viewport.width === 1280) expect(pxPerIn).toBeGreaterThan(2.2);
      const offBand: Rgb[] = [];
      for (const band of await bandsOf(page)) {
        const [a, b, c] = band.corners as [Point, Point, Point];
        // The band's two side lengths; the shorter is how wide it is across the leg.
        const widthIn = Math.min(Math.hypot(b.xIn - a.xIn, b.yIn - a.yIn), Math.hypot(c.xIn - b.xIn, c.yIn - b.yIn));
        expect(widthIn * pxPerIn, band.id).toBeGreaterThanOrEqual(3);

        // The middle of the band reads as the obstacle fill.
        const middle = {
          xIn: band.corners.reduce((sum, corner) => sum + corner.xIn, 0) / 4,
          yIn: band.corners.reduce((sum, corner) => sum + corner.yIn, 0) / 4,
        };
        const colour = await colourAt(page, middle);
        expect(colour, band.id).not.toBeNull();
        expect(distance(colour as Rgb, OBSTACLE_FILL), `${band.id} ${JSON.stringify(colour)}`).toBeLessThanOrEqual(6);
        // A little toward the hive's pivot from the band, still inside the hive's body.
        const beside = await colourAt(page, { xIn: middle.xIn - Math.sign(middle.xIn) * 3, yIn: middle.yIn });
        if (beside !== null) offBand.push(beside);
      }
      // Under at least one band per hive lies an up cell, tinted in its alliance's colour, so the
      // band is seen over something that is not the obstacle fill.
      expect(offBand.filter((colour) => distance(colour, OBSTACLE_FILL) > 12).length).toBeGreaterThanOrEqual(2);

      const dir = process.env["ZENITH_QA_SHOTS"] ?? join(process.cwd(), "test-results", "strut-bands");
      mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: join(dir, size.shot) });
    });
  });
}
