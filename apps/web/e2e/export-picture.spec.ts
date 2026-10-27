/**
 * "Download picture" (issue #190): from the command palette, the open auto downloads as a PNG or an
 * SVG, the picture `zenith render` writes. The file is named `<auto>.<alliance viewed>.<format>`,
 * and the PNG is twice the SVG's width.
 */
import { readFileSync } from "node:fs";
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
  await page.goto("/");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
}

async function download(page: Page, query: string, id: string): Promise<{ name: string; bytes: Buffer }> {
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill(query);
  const waiting = page.waitForEvent("download");
  await page.getByTestId(`palette-item-${id}`).click();
  const file = await waiting;
  return { name: file.suggestedFilename(), bytes: readFileSync(await file.path()) };
}

test("a palette search for png finds the picture action, and picture finds both", async ({ page }) => {
  await openExample(page);
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("png");
  await expect(page.getByTestId("palette-item-project.downloadPicture")).toBeVisible();
  await page.getByTestId("palette-input").fill("picture");
  await expect(page.getByTestId("palette-item-project.downloadPicture")).toBeVisible();
  await expect(page.getByTestId("palette-item-project.downloadPictureSvg")).toBeVisible();
});

test("the SVG action downloads text that starts with <svg and carries the auto's title", async ({ page }) => {
  await openExample(page);
  const svg = await download(page, "Download picture (SVG)", "project.downloadPictureSvg");
  expect(svg.name).toBe("collect-and-score.red.svg");
  const text = svg.bytes.toString("utf8");
  expect(text.startsWith("<svg")).toBe(true);
  expect(text).toContain("Collect and score");
  expect(text).not.toContain("<image");
});

test("the PNG action downloads a PNG twice as wide as the SVG", async ({ page }) => {
  await openExample(page);
  const svg = await download(page, "Download picture (SVG)", "project.downloadPictureSvg");
  const svgWidth = Number(/<svg[^>]*\swidth="([\d.]+)"/.exec(svg.bytes.toString("utf8"))?.[1]);
  expect(svgWidth).toBeGreaterThan(0);

  const png = await download(page, "Download picture (PNG)", "project.downloadPicture");
  expect(png.name).toBe("collect-and-score.red.png");
  expect([...png.bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(png.bytes.readUInt32BE(16)).toBe(Math.round(svgWidth * 2));
});

test("the file name follows the alliance being viewed", async ({ page }) => {
  await openExample(page);
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("alliance");
  await page.getByTestId("palette-item-view.alliance").click();
  const svg = await download(page, "Download picture (SVG)", "project.downloadPictureSvg");
  expect(svg.name).toBe("collect-and-score.blue.svg");
});
