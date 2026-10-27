/**
 * The hive on the field follows the playback clock (`canvas/hiveLayer.ts`): before the tip it shows
 * the kickoff cell up with its staged nectar, a tip swings it over on that clock with the load
 * leaving the cell at level, and afterwards the other cell is up and empty. The dumped pieces are not
 * drawn on the floor; the floor quarter's count chip shows them. The canvas publishes what it drew
 * as `data-hive`, and the pixels of the hive change with it.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { fixture, openProjectWith, SHOTS_DIR, skipTour } from "./qa/helpers";

async function scrubTo(page: Page, atS: number): Promise<void> {
  await page.evaluate(`import("/src/state/store.ts").then((m) => m.setPlayback(${String(atS)}))`);
  // Two frames: one for React to hand the canvas the new time, one for the canvas to draw it.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

const hive = async (page: Page): Promise<string> =>
  (await page.getByTestId("field-canvas").getAttribute("data-hive")) ?? "";

/** The canvas pixels around the red hive, as a data URL, so two frames can be compared. */
async function hivePixels(page: Page): Promise<string> {
  return page.getByTestId("field-canvas").evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const pxPerIn = Number(canvas.dataset["pxPerIn"]);
    const originX = Number(canvas.dataset["originXPx"]);
    const originY = Number(canvas.dataset["originYPx"]);
    const scale = canvas.width / canvas.getBoundingClientRect().width;
    // The red hive's box with room south of it, in field inches; the view has the
    // audience at the bottom, so +y is up the screen.
    const left = (originX - 40 * pxPerIn) * scale;
    const top = (originY - 22 * pxPerIn) * scale;
    const crop = document.createElement("canvas");
    crop.width = Math.round(56 * pxPerIn * scale);
    crop.height = Math.round(70 * pxPerIn * scale);
    crop.getContext("2d")?.drawImage(canvas, left, top, crop.width, crop.height, 0, 0, crop.width, crop.height);
    return crop.toDataURL();
  });
}

async function save(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.getByTestId("field-canvas").screenshot({ path: join(SHOTS_DIR, `${name}.png`) });
}

/**
 * When the tip starts, to a twentieth of a second, found by halving the time between kickoff, when
 * the south cell is up, and the end, when it is not.
 */
async function findTip(page: Page): Promise<{ tipS: number; totalS: number }> {
  const totalS = Number(await page.getByTestId("playback").getAttribute("max"));
  await scrubTo(page, totalS);
  expect(await hive(page), "the hive never tipped").toMatch(/^hiveRed:up=NORTH/);
  let lo = 0;
  let hi = totalS;
  while (hi - lo > 0.05) {
    const atS = (lo + hi) / 2;
    await scrubTo(page, atS);
    if ((await hive(page)).startsWith("hiveRed:up=SOUTH")) lo = atS;
    else hi = atS;
  }
  expect(totalS - hi, "the routine runs on past the whole swing").toBeGreaterThan(4);
  return { tipS: hi, totalS };
}

test.use({ viewport: { width: 1600, height: 1000 } });

test("the hive still tips with the Ledger switch off, and no counts are drawn, at 1600x1000", async ({ page }) => {
  test.setTimeout(180_000);
  await skipTour(page, { features: { partners: true, ledger: false, commands: true } });
  await openProjectWith(page, { "qa-hive-tip.auto.json": fixture("qa-hive-tip.auto.json") });
  const canvas = page.getByTestId("field-canvas");
  await expect(canvas).toHaveAttribute("data-hive", /hiveRed:up=SOUTH,cell=3/);
  await expect(page.getByTestId("ledger-panel")).toHaveCount(0);
  const { tipS } = await findTip(page);
  await scrubTo(page, tipS + 1.6);
  expect(await hive(page)).toMatch(/hiveRed:up=NORTH,cell=0,swing=SOUTH>NORTH@0\.[5-6]\d;/);
  await save(page, "hive-0-mid-swing-ledger-off");
  // The switch still hides the counts.
  expect(await canvas.getAttribute("data-ledger")).toBe("");
});

test("the hive tips on the playback clock, swinging, and scrubs back, at 1600x1000", async ({ page }) => {
  // Opening a project on a cold dev server can take most of a minute on a loaded machine.
  test.setTimeout(180_000);
  await skipTour(page);
  await openProjectWith(page, { "qa-hive-tip.auto.json": fixture("qa-hive-tip.auto.json") });
  const canvas = page.getByTestId("field-canvas");
  await expect(canvas).toHaveAttribute("data-hive", /hiveRed:up=SOUTH,cell=3/);

  const { tipS, totalS } = await findTip(page);

  await scrubTo(page, Math.max(0, tipS - 0.5));
  expect(await hive(page)).toMatch(/^hiveRed:up=SOUTH,cell=3;/);
  const before = await hivePixels(page);
  await save(page, "hive-1-before-tip");

  // Just past level: the playback clock says how far through the swing it is, the bar is drawn
  // between its two states and the load has left the cell that is going down.
  await scrubTo(page, tipS + 1.6);
  const mid = await hive(page);
  expect(mid).toMatch(/hiveRed:up=NORTH,cell=0,swing=SOUTH>NORTH@0\.[5-6]\d;/);
  const midPixels = await hivePixels(page);
  expect(midPixels).not.toBe(before);
  await save(page, "hive-2-mid-swing");

  // After: north up and empty, with no pieces drawn on the floor.
  await scrubTo(page, Math.min(totalS, tipS + 4.5));
  expect(await hive(page)).toMatch(/^hiveRed:up=NORTH,cell=0;hiveBlue:up=NORTH,cell=3$/);
  const after = await hivePixels(page);
  expect(after).not.toBe(before);
  expect(after).not.toBe(midPixels);
  await save(page, "hive-3-after-tip");

  // Scrubbing back draws exactly what it drew the first time.
  await scrubTo(page, tipS + 1.6);
  expect(await hive(page)).toBe(mid);
  expect(await hivePixels(page)).toBe(midPixels);
  await scrubTo(page, Math.max(0, tipS - 0.5));
  expect(await hivePixels(page)).toBe(before);

  // The Day theme draws the same hive in its own tokens.
  await page.evaluate(() => {
    document.documentElement.dataset["theme"] = "light";
  });
  await scrubTo(page, tipS + 1.6);
  expect(await hive(page)).toBe(mid);
  await save(page, "hive-4-mid-swing-day");
});
