/**
 * The divider between the step list and the Ledger (issue #86): it drags, the arrow keys move it,
 * it says its height to assistive technology, and the height survives a reload. The Ledger also
 * shows where our own nectar is (issues #84 and #95).
 */
import { expect, test, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem(
        "zenith.ui",
        JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false }, ledgerOpen: true }),
      );
    }
  });
  await turnOnFeatures(page);
});

async function loadExample(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
}

const ledgerHeight = async (page: Page): Promise<number> => {
  const box = await page.getByTestId("ledger-panel").boundingBox();
  if (box === null) throw new Error("the Ledger panel has no box");
  return box.height;
};

const valueNow = async (page: Page): Promise<number> =>
  Number(await page.getByTestId("ledger-resizer").getAttribute("aria-valuenow"));

test("the Ledger shows our own hive's nectar, where the tip dumped it, and not the other alliance's", async ({ page }) => {
  await loadExample(page);
  const ledger = page.getByTestId("ledger");
  // The staged nectar in our hive's up cell, drawn as red nectar.
  await expect(page.getByTestId("ledger-now-hive").locator('[aria-label="3 red nectar"]')).toHaveCount(1);
  const dumped = page.getByTestId("ledger-end-floorRedGardenSide");
  await expect(dumped).toHaveAttribute("title", "floorRedGardenSide: 4 pollen, 3 nectarRed");
  await expect(dumped.locator('[aria-label="4 pollen"]')).toHaveCount(1);
  await expect(dumped.locator('[aria-label="3 red nectar"]')).toHaveCount(1);
  await expect(page.getByTestId("ledger-end-hive")).toContainText("8 to tip");
  // Zenith edits one alliance's auto at a time, so the Ledger follows that alliance only (issue #95).
  await expect(ledger.locator('svg[data-piece="nectarBlue"]')).toHaveCount(0);
});

test("the divider between the steps and the Ledger drags, takes arrow keys and is remembered", async ({ page }) => {
  await loadExample(page);
  const divider = page.getByRole("separator", { name: "Resize the ledger" });
  await expect(divider).toBeVisible();
  await expect(divider).toHaveAttribute("aria-orientation", "horizontal");
  await expect(divider).toHaveAttribute("aria-valuemin", /^\d+$/);
  await expect(divider).toHaveAttribute("aria-valuemax", /^\d+$/);

  // Drag it up 80 px: the Ledger grows by as much.
  const before = await ledgerHeight(page);
  const box = await divider.boundingBox();
  if (box === null) throw new Error("the divider has no box");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 40, { steps: 4 });
  await page.mouse.move(x, y - 80, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => ledgerHeight(page)).toBeGreaterThan(before + 70);
  const dragged = await ledgerHeight(page);
  await expect.poll(() => valueNow(page)).toBe(Math.round(dragged));

  // Two presses of the down arrow make it 16 px shorter.
  await divider.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => ledgerHeight(page)).toBeLessThan(dragged - 12);
  const keyed = await ledgerHeight(page);

  const max = Number(await divider.getAttribute("aria-valuemax"));
  const min = Number(await divider.getAttribute("aria-valuemin"));
  expect(max).toBeGreaterThan(min);

  // A reload starts at the welcome screen; the example opens with the remembered split.
  await loadExample(page);
  await expect.poll(() => ledgerHeight(page)).toBeGreaterThan(keyed - 2);
  expect(await ledgerHeight(page)).toBeLessThan(keyed + 2);
  const saved = await page.evaluate(() => JSON.parse(window.localStorage.getItem("zenith.ui") ?? "{}") as { ledgerH?: number });
  expect(saved.ledgerH).toBe(Math.round(keyed));
});

test("the divider keeps each side at its minimum", async ({ page }) => {
  await loadExample(page);
  const divider = page.getByRole("separator", { name: "Resize the ledger" });
  await divider.focus();
  for (let press = 0; press < 40; press += 1) await page.keyboard.press("Shift+ArrowUp");
  await expect.poll(() => valueNow(page)).toBe(Number(await divider.getAttribute("aria-valuemax")));
  const steps = await page.getByTestId("steps-panel").boundingBox();
  expect(steps?.height ?? 0).toBeGreaterThanOrEqual(119);

  for (let press = 0; press < 60; press += 1) await page.keyboard.press("Shift+ArrowDown");
  await expect.poll(() => valueNow(page)).toBe(Number(await divider.getAttribute("aria-valuemin")));
  expect(await ledgerHeight(page)).toBeGreaterThanOrEqual(79);
});

test("the divider is not there while the Ledger is folded", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "zenith.ui",
      JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false }, ledgerOpen: false, features: { partners: true, ledger: true, commands: true } }),
    );
  });
  await loadExample(page);
  await expect(page.getByTestId("ledger-panel")).toBeVisible();
  await expect(page.getByTestId("ledger-resizer")).toHaveCount(0);
});
