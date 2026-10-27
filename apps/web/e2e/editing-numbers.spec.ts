/**
 * How far a key moves is a per-person setting (issue #282): Settings, Editor, "Editing" has the nudge,
 * the far nudge, the rotate step and the playhead step. With nothing set the keys move as they always
 * have; set to other numbers, the arrow keys, R and the comma and full stop keys move by them, and the
 * shortcut sheet and the timeline's buttons say them. The numbers are kept in zenith.ui, never in a
 * project.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { editor, fixture, openProjectWith, skipTour, worldToScreen } from "./qa/helpers";

interface Pose {
  xIn: number;
  yIn: number;
}

const looseTo = (page: Page) => editor<Pose>(page, `s.auto.steps.find((x) => x.id === "loose").segments[0].to`);
const looseHeadingRad = async (page: Page): Promise<number> =>
  (await editor<{ headingRad?: number }>(page, `s.auto.steps.find((x) => x.id === "loose").heading`)).headingRad ?? 0;

async function blur(page: Page): Promise<void> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
}

async function selectLooseEnd(page: Page): Promise<void> {
  await page.getByTestId("step-row-loose").getByRole("button").first().click();
  const at = await worldToScreen(page, 0, 40);
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => editor<string | undefined>(page, "s.selection.point?.pointKind")).toBe("to");
}

const input = async (field: Locator): Promise<Locator> =>
  (await field.evaluate((node) => node.tagName)) === "INPUT" ? field : field.locator("input").first();

/** Types `value` into the Settings number `name` and commits it. */
async function setNumber(page: Page, name: string, value: string): Promise<void> {
  const box = await input(page.getByTestId(`settings-editing-${name}`));
  await box.fill(value);
  await box.press("Enter");
}

async function openEditingSettings(page: Page): Promise<void> {
  await page.getByTestId("toolbar-settings").click();
  await page.getByTestId("settings-nav-editor").click();
  await expect(page.getByTestId("settings-editing")).toBeVisible();
}

async function closeSettings(page: Page): Promise<void> {
  await page.getByTestId("settings-close").click();
  await expect(page.getByTestId("settings")).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await openProjectWith(page, { "qa-curves.auto.json": fixture("qa-curves.auto.json") });
});

test("Settings, Editor lists the four numbers at the old values, and a number past its range is refused with the range", async ({ page }) => {
  await openEditingSettings(page);
  for (const [name, shown] of [["nudgeIn", "0.50"], ["nudgeFarIn", "2.00"], ["rotateDeg", "5.00"], ["scrubStepS", "0.10"]] as const) {
    await expect(await input(page.getByTestId(`settings-editing-${name}`))).toHaveValue(shown);
  }
  // A typed number out of range is refused, never clamped in silence, and the status line says the
  // range (issue #502).
  await setNumber(page, "nudgeIn", "100");
  await expect(page.getByTestId("status")).toContainText("Nudge runs 0.05 to 12 in.");
  expect(await editor<number>(page, "s.prefs.nudgeIn")).toBe(0.5);
  await expect(await input(page.getByTestId("settings-editing-nudgeIn"))).toHaveValue("0.50");
  await setNumber(page, "scrubStepS", "0");
  await expect(page.getByTestId("status")).toContainText("Playhead step runs 0.01 to 1 s.");
  expect(await editor<number>(page, "s.prefs.scrubStepS")).toBe(0.1);
  // A number is kept to the two decimals the field shows, so the key and the sheet say what it says.
  await setNumber(page, "nudgeIn", "0.123");
  await expect.poll(() => editor<number>(page, "s.prefs.nudgeIn")).toBe(0.12);
  await expect(await input(page.getByTestId("settings-editing-nudgeIn"))).toHaveValue("0.12");
});

test("with nothing set, an arrow moves a point 0.5 in and the sheet says so", async ({ page }) => {
  await selectLooseEnd(page);
  await blur(page);
  const p0 = await looseTo(page);
  await page.keyboard.press("ArrowRight");
  expect((await looseTo(page)).xIn).toBeCloseTo(p0.xIn + 0.5, 6);
  await page.keyboard.press("Shift+Slash");
  const sheet = (await page.getByTestId("shortcuts-overlay").innerText()).replace(/\s+/g, " ");
  expect(sheet).toContain("by 0.5 in, or 2 in with Shift");
  expect(sheet).toContain("forward 0.1 s");
});

test("set to 1 in, 3 in, 10 degrees and 0.25 s, the keys move by them and the words say them", async ({ page }) => {
  await openEditingSettings(page);
  await setNumber(page, "nudgeIn", "1");
  await setNumber(page, "nudgeFarIn", "3");
  await setNumber(page, "rotateDeg", "10");
  await setNumber(page, "scrubStepS", "0.25");
  await expect.poll(() => editor<number>(page, "s.prefs.scrubStepS")).toBe(0.25);
  await closeSettings(page);

  await selectLooseEnd(page);
  await blur(page);
  const p0 = await looseTo(page);
  await page.keyboard.press("ArrowRight");
  expect((await looseTo(page)).xIn).toBeCloseTo(p0.xIn + 1, 6);
  await page.keyboard.press("Shift+ArrowUp");
  expect((await looseTo(page)).yIn).toBeCloseTo(p0.yIn + 3, 6);
  const h0 = await looseHeadingRad(page);
  await page.keyboard.press("r");
  expect(await looseHeadingRad(page)).toBeCloseTo(h0 + (10 * Math.PI) / 180, 6);

  await page.evaluate(`import("/src/state/store.ts").then((m) => m.setPlayback(1))`);
  await page.keyboard.press(".");
  expect(await editor<number>(page, "s.playbackS")).toBeCloseTo(1.25, 6);
  await expect(page.getByRole("button", { name: "Step back 0.25 s" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Step forward 0.25 s" })).toBeVisible();

  await page.keyboard.press("Shift+Slash");
  const sheet = (await page.getByTestId("shortcuts-overlay").innerText()).replace(/\s+/g, " ");
  expect(sheet).toContain("by 1 in, or 3 in with Shift");
  expect(sheet).toContain("forward 0.25 s");
  expect(sheet).not.toContain("half an inch");
});

test("the numbers are kept in zenith.ui, not in the auto, and survive a reload", async ({ page }) => {
  await openEditingSettings(page);
  await setNumber(page, "nudgeIn", "1");
  await expect.poll(() => editor<number>(page, "s.prefs.nudgeIn")).toBe(1);
  const stored = await page.evaluate(() => JSON.parse(window.localStorage.getItem("zenith.ui") ?? "{}") as { nudgeIn?: number });
  expect(stored.nudgeIn).toBe(1);
  expect(await editor<string>(page, "JSON.stringify(s.auto)")).not.toContain("nudge");
  await page.reload();
  await expect.poll(() => editor<number>(page, "s.prefs.nudgeIn")).toBe(1);
});

test("a stored number out of range or of the wrong type reads as the default", async ({ page }) => {
  await page.evaluate(() => {
    window.localStorage.setItem("zenith.ui", JSON.stringify({ version: 1, nudgeIn: 999, nudgeFarIn: "2", rotateDeg: 15, scrubStepS: -1 }));
  });
  await page.reload();
  await expect.poll(() => editor<number>(page, "s.prefs.rotateDeg")).toBe(15);
  expect(await editor<number[]>(page, "[s.prefs.nudgeIn, s.prefs.nudgeFarIn, s.prefs.scrubStepS]")).toEqual([0.5, 2, 0.1]);
});
