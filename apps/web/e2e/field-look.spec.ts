/**
 * The Grid setting (owner ruling D11): one dropdown in Settings, Editor, Field, and one palette action
 * that steps it. Tiles is the default, so the 12 in lines are off until chosen. The choice reaches the
 * canvas, repaints the static layer, and survives a reload. That the 12 in choice draws exactly what
 * `main` drew is held by the vitest golden in `src/canvas/staticLayer.test.ts`; here the painted canvas
 * has to differ between the four choices and come back the same when a choice is chosen again.
 */
import { expect, test, type Page } from "@playwright/test";

type Grid = "off" | "tiles" | "12" | "6";
const CHOICES: Grid[] = ["off", "tiles", "12", "6"];
const LABEL: Record<Grid, string> = { off: "Off", tiles: "Tiles (24 in)", "12": "12 in", "6": "6 in" };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
    }
    window.localStorage.removeItem("zenith.cloudFake");
  });
});

async function loadExample(page: Page): Promise<void> {
  await page.goto("/?cloud=fake");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
}

/** The painted field, as the browser would save it. */
async function paintedField(page: Page): Promise<string> {
  return page.getByTestId("field-canvas").evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());
}

async function expectGrid(page: Page, grid: Grid): Promise<void> {
  await expect(page.getByTestId("field-canvas")).toHaveAttribute("data-field-grid", grid);
}

async function chooseInSettings(page: Page, grid: Grid): Promise<void> {
  await page.getByTestId("toolbar-settings").click();
  await page.getByTestId("settings-nav-editor").click();
  await page.getByTestId("settings-field-grid-choice").selectOption(grid);
  await expect(page.getByTestId("settings-field-grid-choice")).toHaveValue(grid);
  await page.getByTestId("settings-close").click();
  await expect(page.getByTestId("settings")).toHaveCount(0);
}

async function stepWithPalette(page: Page): Promise<void> {
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Field grid");
  await page.getByTestId("palette-item-view.fieldGrid").click();
  await expect(page.getByTestId("palette-input")).toHaveCount(0);
}

test("the grid is Tiles until chosen, and Settings shows the choice", async ({ page }) => {
  await loadExample(page);
  await expectGrid(page, "tiles");
  await page.getByTestId("toolbar-settings").click();
  await page.getByTestId("settings-nav-editor").click();
  const dropdown = page.getByTestId("settings-field-grid-choice");
  await expect(dropdown).toHaveValue("tiles");
  await expect(dropdown.locator("option")).toHaveText(CHOICES.map((choice) => LABEL[choice]));
});

test("each Grid choice in Settings repaints the field, and each one is stable", async ({ page }) => {
  await loadExample(page);
  const painted = new Map<Grid, string>();
  for (const choice of CHOICES) {
    await chooseInSettings(page, choice);
    await expectGrid(page, choice);
    painted.set(choice, await paintedField(page));
  }
  // Four different drawings.
  expect(new Set(painted.values()).size).toBe(CHOICES.length);
  // Choosing one again draws it again, byte for byte.
  for (const choice of ["12", "off"] as const) {
    await chooseInSettings(page, choice);
    expect(await paintedField(page)).toBe(painted.get(choice));
  }
});

test("the palette action steps Off, Tiles, 12 in and 6 in, and the Settings row follows", async ({ page }) => {
  await loadExample(page);
  const painted = new Set<string>([await paintedField(page)]);
  for (const grid of ["12", "6", "off", "tiles"] as const) {
    await stepWithPalette(page);
    await expectGrid(page, grid);
    painted.add(await paintedField(page));
  }
  expect(painted.size).toBe(CHOICES.length);

  await stepWithPalette(page);
  await expectGrid(page, "12");
  await page.getByTestId("toolbar-settings").click();
  await page.getByTestId("settings-nav-editor").click();
  await expect(page.getByTestId("settings-field-grid-choice")).toHaveValue("12");
});

test("the choice survives a reload, and is written under fieldGrid in zenith.ui", async ({ page }) => {
  await loadExample(page);
  await chooseInSettings(page, "6");
  expect(await page.evaluate(() => (JSON.parse(window.localStorage.getItem("zenith.ui") ?? "{}") as { fieldGrid?: string }).fieldGrid)).toBe("6");
  await page.reload();
  await page.getByTestId("canvas-load-example").click();
  await expectGrid(page, "6");

  await stepWithPalette(page);
  await expectGrid(page, "off");
  await page.reload();
  await page.getByTestId("canvas-load-example").click();
  await expectGrid(page, "off");
});
