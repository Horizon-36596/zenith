/**
 * Every action answers once on the status line, and an old answer goes away (UI_GUIDE rule 7 and
 * 9.15): undo and redo in one voice from the keys and the toolbar, Validate, Snap, opening another
 * auto, and the tour's Skip.
 */
import { expect, test } from "@playwright/test";
import { editor, loadExample, openAutoNamed, selectStep, shot, skipTour } from "./qa/helpers";

const status = (page: import("@playwright/test").Page) => page.getByTestId("status");

for (const theme of ["dark", "light"] as const) {
  const look = theme === "dark" ? "night" : "day";

  test(`undo and redo say Undid and Redid from the keys and the toolbar (${look})`, async ({ page }) => {
    await skipTour(page, { theme });
    await loadExample(page);
    await selectStep(page, "driveOut");
    await page.keyboard.press("Delete");
    await expect(status(page)).toContainText("Deleted driveOut");
    await page.keyboard.press("Control+z");
    await expect(status(page)).toContainText(/^Undid: Deleted driveOut/);
    await shot(page, `status-undo-${look}`);
    await page.getByTestId("toolbar-edit.redo").click();
    await expect(status(page)).toContainText(/^Redid: Deleted driveOut/);
    await page.getByTestId("toolbar-edit.undo").click();
    await expect(status(page)).toContainText(/^Undid: Deleted driveOut/);
  });

  test(`the example's line reads as two sentences (${look})`, async ({ page }) => {
    await skipTour(page, { theme });
    await loadExample(page);
    await expect(status(page)).toHaveText(/Example loaded, read only\. Save makes your own copy\./);
    await shot(page, `status-example-${look}`);
  });
}

test("Validate answers with what it found", async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
  await page.getByTestId("toolbar-run.validate").click();
  await expect(status(page)).toContainText(/^(No problems found\.|\d+ (errors?|warnings?)\b)/);
});

test("Snap from the palette says its new state", async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
  const snap = await editor<boolean>(page, "s.prefs.snap");
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Snap");
  await page.keyboard.press("Enter");
  await expect(status(page)).toContainText(snap ? "Snap off." : "Snap on.");
});

test("opening another auto says which one, in place of the example's line", async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
  await expect(status(page)).toContainText("Example loaded");
  await openAutoNamed(page, "first-auto.auto.json");
  await expect(status(page)).toHaveText(/^Opened first-auto\.auto\.json\./);
});

test("Skip tour says how to replay it", async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
  await page.evaluate(`import("/src/tour/store.ts").then((m) => m.startCoreTour())`);
  await page.getByTestId("tour-skip").click();
  await expect(status(page)).toContainText("Tour skipped.");
  await expect(page.getByTestId("status-hint")).toHaveText("Replay it from Help, Take the tour.");
});
