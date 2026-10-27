/**
 * Rectangle envelopes on the field (issue #120): draw one corner to corner, resize it by a corner
 * and by a side, each drag one undo step, and save it as the four-corner polygon the file format
 * already carries. Runs against the fake cloud, as the beta does.
 */
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { saveExampleAuto } from "./saveExample";
import { turnOnFeatures } from "./features";
import { openMore } from "./qa/helpers";

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

/** A field position in inches to a page position, read from the canvas's published view. */
async function worldToScreen(page: Page, xIn: number, yIn: number): Promise<{ x: number; y: number }> {
  const canvas = page.getByTestId("field-canvas");
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("the canvas has no box");
  const pxPerIn = Number(await canvas.getAttribute("data-px-per-in"));
  const originXPx = Number(await canvas.getAttribute("data-origin-x-px"));
  const originYPx = Number(await canvas.getAttribute("data-origin-y-px"));
  // The example field puts the audience at the bottom: +x right, +y up the screen.
  return { x: box.x + originXPx + pxPerIn * xIn, y: box.y + originYPx - pxPerIn * yIn };
}

/** A left-button drag between two field positions, in small steps as a hand would. */
async function drag(page: Page, from: { xIn: number; yIn: number }, to: { xIn: number; yIn: number }): Promise<void> {
  const a = await worldToScreen(page, from.xIn, from.yIn);
  const b = await worldToScreen(page, to.xIn, to.yIn);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 6 });
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
}

test("an envelope is drawn as a rectangle, resized by a corner and a side, and saved as one", async ({ page }) => {
  await page.goto("/?cloud=fake");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await page.getByTestId("step-row-shootPreloads").getByRole("button").first().click();

  // Draw it: the next drag on the field, from one corner to the opposite, whatever it starts on.
  await openMore(page);
  await page.getByTestId("inspector-envelope-draw").click();
  await expect(page.getByTestId("inspector-envelope-drawing")).toBeVisible();
  await drag(page, { xIn: -30, yIn: -50 }, { xIn: -10, yIn: -30 });

  const x = page.getByTestId("inspector-envelope-x");
  const y = page.getByTestId("inspector-envelope-y");
  const width = page.getByTestId("inspector-envelope-w");
  const height = page.getByTestId("inspector-envelope-h");
  await expect(x).toHaveValue("-30.00");
  await expect(y).toHaveValue("-50.00");
  await expect(width).toHaveValue("20.00");
  await expect(height).toHaveValue("20.00");
  // Drawing is one drag: the field is back to normal afterwards.
  await expect(page.getByTestId("inspector-envelope-drawing")).toHaveCount(0);

  // The north-east corner resizes both its sides; the south-west corner stays put.
  await drag(page, { xIn: -10, yIn: -30 }, { xIn: -4, yIn: -24 });
  await expect(x).toHaveValue("-30.00");
  await expect(y).toHaveValue("-50.00");
  await expect(width).toHaveValue("26.00");
  await expect(height).toHaveValue("26.00");

  // The east side's handle moves that side alone.
  await drag(page, { xIn: -4, yIn: -37 }, { xIn: 0, yIn: -40 });
  await expect(width).toHaveValue("30.00");
  await expect(height).toHaveValue("26.00");

  // Each drag is one undo step.
  await page.keyboard.press("Control+z");
  await expect(width).toHaveValue("26.00");
  await page.keyboard.press("Control+y");
  await expect(width).toHaveValue("30.00");

  const download = saveExampleAuto(page);
  const saved = JSON.parse(readFileSync(await (await download).path(), "utf8")) as {
    steps: Array<{ id?: string; envelope?: { polygon: unknown; provenance: string } }>;
  };
  const envelope = saved.steps.find((step) => step.id === "shootPreloads")?.envelope;
  // Counter-clockwise from the south-west corner, the order the file format's example uses.
  expect(envelope?.polygon).toEqual([
    { xIn: -30, yIn: -50 },
    { xIn: 0, yIn: -50 },
    { xIn: 0, yIn: -24 },
    { xIn: -30, yIn: -24 },
  ]);
  expect(envelope?.provenance).toMatch(/^SET FROM EDITOR: drawn on the field/);
});

test("an envelope that is not a rectangle is drawn as it is and can be made the rectangle round it", async ({ page }) => {
  await page.goto("/?cloud=fake");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  // A triangle, as an agent or a hand-written file might carry.
  await page.evaluate(
    `import("/src/state/store.ts").then((m) => { const s = m.getState(); m.commit({ ...s.auto, steps: s.auto.steps.map((x) => x.id !== "shootPreloads" ? x : { ...x, envelope: { polygon: [{ xIn: -30, yIn: -50 }, { xIn: -10, yIn: -50 }, { xIn: -20, yIn: -30 }], maxDurationS: 3, provenance: "SET BY HAND: e2e triangle" } }) }); })`,
  );
  await page.getByTestId("step-row-shootPreloads").getByRole("button").first().click();
  await expect(page.getByTestId("inspector-envelope-polygon-note")).toContainText("3-corner shape");
  await expect(page.getByTestId("inspector-envelope-x")).toHaveCount(0);
  // With no Corner row, the envelope's one provenance chip still sits on the seconds row and opens its picker.
  const chip = page.getByTestId("inspector-envelope-provenance");
  await expect(chip).toHaveCount(1);
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("Set by hand");
  await chip.click();
  await expect(page.getByTestId("inspector-envelope-provenance-menu")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByTestId("inspector-envelope-to-rect").click();
  await expect(page.getByTestId("inspector-envelope-x")).toHaveValue("-30.00");
  // As a rectangle the one chip stays on the seconds row.
  await expect(chip).toHaveCount(1);
  await expect(page.getByTestId("inspector").locator("[data-pose-row]", { has: chip })).toHaveCount(0);
  await expect(page.getByTestId("inspector-envelope-w")).toHaveValue("20.00");
  await expect(page.getByTestId("inspector-envelope-h")).toHaveValue("20.00");
});
