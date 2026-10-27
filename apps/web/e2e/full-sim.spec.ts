/**
 * Full sim is on (hidden from the beta in issue #207, back on by the owner's ruling of 2026-10-14):
 * with the preferences a new person starts with, the editor offers the robot repository's sim.
 * Simulate is on the toolbar, in the palette and on F5, the shortcut sheet lists it, the playback
 * control has a Full sim level, the timeline's help names it, and the Simulate dialog loads a trace.
 * Settings still has no switch for it, because nobody chooses it in this version.
 */
import { expect, test, type Page } from "@playwright/test";
import { editor } from "./qa/helpers";

/** The tour done and nothing else stored, so every switch is at its default. */
async function start(page: Page, extra: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript((prefs) => {
    if (window.localStorage.getItem("zenith.ui") !== null) return;
    window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false }, ...prefs }));
  }, extra);
  await page.goto("/");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
}

test("the toolbar, the palette, F5 and the shortcut sheet offer Simulate", async ({ page }) => {
  await start(page);
  expect(await editor<boolean>(page, "s.prefs.features.fullSim")).toBe(true);
  await expect(page.getByTestId("toolbar-run.simulate")).toBeVisible();

  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("simulate");
  await expect(page.getByTestId("palette-item-run.simulate")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.keyboard.press("F1");
  const sheet = page.getByTestId("shortcuts-overlay");
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("Simulate");
  await expect(sheet).toContainText("F5");
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  await page.keyboard.press("F5");
  await expect(page.getByTestId("simulate")).toBeVisible();
  await expect(page.getByTestId("load-trace")).toHaveCount(1);
  // The example has no repository of its own: the command runs in the team's (0.1.2 UX sweep, W1-4).
  await expect(page.getByTestId("simulate-where")).toHaveText(
    "Run the command below in your robot repository, then load the trace it writes.",
  );
});

test("the playback control offers all three levels, and the timeline's help names Full sim", async ({ page }) => {
  await start(page);
  await expect(page.getByTestId("playback-level-ideal")).toBeVisible();
  await expect(page.getByTestId("playback-level-instant")).toBeVisible();
  await expect(page.getByTestId("playback-level-full")).toBeVisible();

  await page.getByTestId("help-timeline").click();
  await expect(page.getByTestId("help-bubble")).toContainText("Full sim");
});

test("a remembered Full sim level plays Ideal until a trace is loaded, with no error", async ({ page }) => {
  await start(page, { playbackLevel: "full" });
  await expect(page.getByTestId("playback-level")).toHaveAttribute("data-level", "ideal");
  await expect(page.getByTestId("field-canvas")).toHaveAttribute("data-playback-level", "ideal");
  await expect(page.getByRole("alert")).toHaveCount(0);
  // The choice itself is kept, so loading a trace plays it at once.
  expect(await editor<string>(page, "s.prefs.playbackLevel")).toBe("full");
});

test("a stored false from the beta does not hide it", async ({ page }) => {
  await start(page, { features: { fullSim: false } });
  await expect(page.getByTestId("toolbar-run.simulate")).toBeVisible();
  await expect(page.getByTestId("playback-level-full")).toBeVisible();
});

test("Settings lists no switch for Full sim", async ({ page }) => {
  await start(page);
  await page.getByTestId("toolbar-settings").click();
  await page.getByTestId("settings-nav-general").click();
  await expect(page.getByTestId("settings-features")).toBeVisible();
  await expect(page.getByTestId("settings-feature-commands")).toBeVisible();
  await expect(page.getByTestId("settings-feature-fullSim")).toHaveCount(0);
  await expect(page.getByTestId("settings-features")).not.toContainText("Full sim");
});
