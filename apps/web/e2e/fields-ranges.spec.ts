/**
 * Issue #502: fields that clamped, reverted or took anything in silence.
 *
 * - A number out of range is refused, and the field's tooltip and the status line say its range.
 * - A robot's top speed has a ceiling, so 99999999 in/s is refused rather than saved.
 * - A step's new name is checked: empty, a space, or another step's name each say why.
 * - Auto details' Title and Authors are full-width boxes with an edge, and Holds at start writes the
 *   piece the field places for an auto that preloaded nothing.
 *
 * Screenshots, in Night and Day, go to test-results/fields-ranges/.
 */
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";
import { openServedFolder, serveFolder, starterFiles } from "./opfsProject";

const SHOTS = fileURLToPath(new URL("../test-results/fields-ranges/", import.meta.url));

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
    }
  });
});

async function shoot(page: Page, name: string): Promise<void> {
  // With no colour transitions, a shot taken right after the theme changes shows the theme it names.
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((given) => {
      document.documentElement.dataset["theme"] = given;
    }, theme);
    await page.screenshot({ path: `${SHOTS}${name}-${theme === "dark" ? "night" : "day"}.png` });
  }
  await page.evaluate(() => {
    document.documentElement.dataset["theme"] = "dark";
  });
}

/** A value from the editor's store, through the dev server's module graph. */
async function editor<T>(page: Page, expr: string): Promise<T> {
  return (await page.evaluate(`import("/src/state/store.ts").then((m) => { const s = m.getState(); return (${expr}); })`)) as T;
}

async function loadExample(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
}

test("a top speed of 99999999 in/s is refused with the range, and robot.json is not changed", async ({ page }) => {
  await serveFolder(page, starterFiles());
  await page.goto("/");
  await openServedFolder(page);
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await page.getByTestId("toolbar-settings").click();
  await page.getByTestId("settings-nav-robot").click();
  const speed = page.getByTestId("settings-robot-maxForward");
  await expect(speed).toHaveValue("60.0");
  await speed.fill("99999999");
  await speed.press("Enter");
  await expect(speed).toHaveValue("60.0");
  await expect(page.getByTestId("status")).toContainText("Top speed forward runs 0.1 to 300 in/s.");
  await expect(page.getByTestId("settings-robot-save")).toHaveCount(0);
  await shoot(page, "robot-top-speed-refused");
});

test("a step's new id is checked: empty, with a space, or another step's", async ({ page }) => {
  await loadExample(page);
  await page.getByTestId("step-main-driveOut").click();
  await page.getByTestId("step-main-driveOut").press("F2");
  // A refused id keeps the field open on what was typed (issue #494), so each try types again.
  const rename = async (to: string): Promise<void> => {
    await page.getByTestId("step-id-input-driveOut").fill(to);
    await page.getByTestId("step-id-input-driveOut").press("Enter");
  };
  await rename("");
  await expect(page.getByTestId("status")).toContainText("A step needs an id. driveOut keeps its id.");
  await rename("drive out");
  await expect(page.getByTestId("status")).toContainText(
    "A step's id starts with a letter and holds only letters, digits, _ and -. driveOut keeps its id.",
  );
  await rename("collectFlower");
  await expect(page.getByTestId("status")).toContainText("There is already a step named collectFlower. driveOut keeps its id.");
  await page.getByTestId("step-id-input-driveOut").press("Escape");
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  expect(await editor<string[]>(page, "s.auto.steps.map((x) => x.id)")).toContain("driveOut");
});

test("Auto details: Title and Authors are full-width boxes, and Holds at start preloads the field's piece", async ({ page }) => {
  await turnOnFeatures(page);
  await loadExample(page);
  // An auto that preloads nothing, as a new one does.
  await page.evaluate(
    `import("/src/state/store.ts").then((m) => { const s = m.getState(); const { holds, ...start } = s.auto.start; m.commit({ ...s.auto, start }); })`,
  );
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Auto details");
  await page.getByTestId("palette-item-project.meta").click();
  const dialog = page.getByTestId("auto-meta");
  const width = (await dialog.boundingBox())?.width ?? 0;
  for (const id of ["meta-title", "meta-authors"]) {
    expect((await page.getByTestId(id).boundingBox())?.width ?? 0, id).toBeGreaterThan(width * 0.8);
  }
  await expect(page.getByTestId("meta-authors")).toHaveAttribute("placeholder", "Names, with commas between them");
  await shoot(page, "auto-details");

  const holds = page.getByTestId("meta-holds");
  await holds.fill("2");
  await holds.press("Enter");
  await expect.poll(() => editor<Record<string, number> | undefined>(page, "s.auto.start.holds")).toEqual({ pollen: 2 });
  await holds.fill("-1");
  await holds.press("Enter");
  await expect(holds).toHaveValue("2");
});
