/**
 * Issue #316: the playhead never runs past the routine's end, and the folded Ledger summarises what
 * was collected and launched (site/docs/editor.md "Timeline and playback" and "Ledger").
 *
 *  - `.` stops at the routine's total, as the scrubber's maximum and the Step forward button do.
 *  - An edit that makes the routine shorter brings a playhead past the new end back to it.
 *  - The folded Ledger reads like "4 pollen in, 3 launched", not a count of changes.
 */
import { expect, test, type Page } from "@playwright/test";
import { editor, loadExample, skipTour } from "./qa/helpers";

const pageErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await skipTour(page);
  await loadExample(page);
});

const total = async (page: Page): Promise<number> =>
  Number(await page.getByTestId("playback").getAttribute("max"));

const playhead = (page: Page): Promise<number> => editor<number>(page, "s.playbackS ?? 0");

const readoutSeconds = async (page: Page): Promise<number> =>
  Number.parseFloat((await page.getByTestId("playhead-readout").innerText()).trim());

async function scrubTo(page: Page, atS: number): Promise<void> {
  await page.evaluate(`import("/src/state/store.ts").then((m) => m.setPlayback(${String(atS)}))`);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test("`.` stops the playhead at the routine's end and `,` stops it at 0", async ({ page }) => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const end = await total(page);
  expect(end).toBeGreaterThan(5);

  await page.keyboard.press(",");
  expect(await playhead(page)).toBe(0);

  await scrubTo(page, end - 0.25);
  for (let i = 0; i < 10; i += 1) await page.keyboard.press(".");
  expect(await playhead(page)).toBeCloseTo(end, 6);
  expect(await readoutSeconds(page)).toBeLessThanOrEqual(end + 0.005);
  expect(pageErrors).toEqual([]);
});

test("an edit that shortens the routine brings the playhead back to the new end", async ({ page }) => {
  const oldEnd = await total(page);
  await scrubTo(page, oldEnd - 0.5);

  await page.evaluate(
    `import("/src/state/store.ts").then((m) => { const s = m.getState(); m.commit({ ...s.auto, steps: s.auto.steps.slice(0, -1) }); })`,
  );
  await expect.poll(() => total(page)).toBeLessThan(oldEnd - 0.5);
  const newEnd = await total(page);

  await expect.poll(() => playhead(page)).toBeCloseTo(newEnd, 6);
  expect(await readoutSeconds(page)).toBeLessThanOrEqual(newEnd + 0.005);
  expect(pageErrors).toEqual([]);
});

test("the folded Ledger says how much pollen was collected and how many were launched", async ({ page }) => {
  // The example shoots its 4 preloads, collects 4 from flower1 and scores them, then sweeps 4 from
  // the RED garden line and scores those: 8 collected, 12 launched.
  const header = page.getByTestId("ledger-panel").locator("header");
  await expect(header).toContainText("8 pollen in, 12 launched");
  await expect(header).not.toContainText(/\bchanges?\b/);

  // The same totals as the open ledger's step rows.
  await page.getByTestId("ledger-panel-fold").click();
  const lines = page.getByTestId("ledger").locator("[data-collected]");
  const sum = (name: string) =>
    lines.evaluateAll((all, key) => all.reduce((total, line) => total + Number(line.getAttribute(key)), 0), name);
  expect(await sum("data-collected")).toBe(8);
  expect(await sum("data-launched")).toBe(12);
  expect(pageErrors).toEqual([]);
});
