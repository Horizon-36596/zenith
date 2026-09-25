/**
 * The public web build under its subpath, the way GitHub Pages serves it: the app served
 * at /zenith/app/ loads its scripts, styles, fonts and favicons from under that path, the first visit
 * loads the bundled example, and the field picture (an `app:` image source) loads and is drawn.
 * Every request outside /zenith/app/ is a 404 from the server, and the test fails on any of them.
 */
import { expect, test } from "@playwright/test";

const BASE = "/zenith/app/";

test("the app loads the example and draws the field picture under /zenith/app/", async ({ page }) => {
  const failed: string[] = [];
  const outside: string[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.protocol !== "http:") return;
    if (!url.pathname.startsWith(BASE)) outside.push(url.pathname);
    if (response.status() >= 400) failed.push(`${String(response.status())} ${url.pathname}`);
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(BASE);

  // The first visit loads the example and starts the tour; the tour's own tests cover it.
  const canvas = page.getByTestId("field-canvas");
  await expect(canvas).toBeVisible();
  await expect(page.getByTestId("titlebar-wordmark")).toBeVisible();

  // The canvas says `image+outlines` only once the picture has loaded; a missing picture reads `vector`.
  await expect(canvas).toHaveAttribute("data-field-view", "image+outlines");
  const picture = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map((entry) => new URL(entry.name).pathname)
      .find((path) => path.endsWith(".webp")),
  );
  expect(picture).toMatch(/^\/zenith\/app\/fields\//);

  // The picture is painted: the canvas is not one flat colour over the field.
  const distinct = await page.evaluate(() => {
    const element = document.querySelector<HTMLCanvasElement>('[data-testid="field-canvas"]');
    const ctx = element?.getContext("2d");
    if (element === null || element === undefined || ctx === null || ctx === undefined) return 0;
    const { width, height } = element;
    const data = ctx.getImageData(Math.floor(width / 4), Math.floor(height / 4), Math.floor(width / 2), Math.floor(height / 2)).data;
    const colours = new Set<number>();
    for (let i = 0; i < data.length; i += 4 * 97) colours.add(((data[i] ?? 0) << 16) | ((data[i + 1] ?? 0) << 8) | (data[i + 2] ?? 0));
    return colours.size;
  });
  expect(distinct).toBeGreaterThan(20);

  // The fonts and the title-bar images came from under the base too.
  const fonts = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map((entry) => new URL(entry.name).pathname)
      .filter((path) => path.endsWith(".woff2") || path.endsWith(".svg")),
  );
  expect(fonts.length).toBeGreaterThan(0);
  for (const path of fonts) expect(path.startsWith(BASE)).toBe(true);

  expect(outside).toEqual([]);
  expect(failed).toEqual([]);
  expect(errors).toEqual([]);
});
