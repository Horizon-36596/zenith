/**
 * The pre-release UX review's first-run lane (issue #507): the toolbar, the palette, What's this and
 * Settings each tell the person what happened and why, and the tour leaves the example as it was.
 * Each test names its finding.
 *
 * Screenshots go to test-results/first-run-review/, which git ignores, or to ZENITH_E2E_SHOTS.
 */
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { editor, loadExample, skipTour } from "./qa/helpers";

const SHOTS = process.env["ZENITH_E2E_SHOTS"] ?? fileURLToPath(new URL("../test-results/first-run-review/", import.meta.url));
const shot = (name: string): string => `${SHOTS.replace(/[\\/]?$/, "/")}${name}.png`;

async function openPalette(page: Page, query: string): Promise<void> {
  await page.getByTestId("field-canvas").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("palette-input")).toBeVisible();
  await page.getByTestId("palette-input").fill(query);
}

test.describe("with nothing open", () => {
  test.beforeEach(async ({ page }) => {
    await skipTour(page);
    await page.goto("/");
    await expect(page.getByTestId("canvas-empty")).toBeVisible();
  });

  test("S11: the arrow beside Optimize path is unavailable for the wand's reason", async ({ page }) => {
    const more = page.getByTestId("toolbar-optimize-more");
    await expect(more).toHaveAttribute("aria-disabled", "true");
    await more.hover();
    await expect(page.getByRole("tooltip")).toContainText("Unavailable: Open an auto first.");
    await more.click({ force: true });
    await expect(page.getByTestId("optimize-menu")).toHaveCount(0);
  });

  test("S12: with the cloud off, the palette's Settings row says nothing of an account", async ({ page }) => {
    const settings = await page.evaluate(`import("/src/app/actions.ts").then((m) => m.actionById("view.settings").does)`);
    expect(settings).toBe("The features you use, this project's robot, and how the editor looks.");
  });
});

test.describe("with the example open", () => {
  test.beforeEach(async ({ page }) => {
    await skipTour(page);
    await loadExample(page);
  });

  test("S10: the alliance pill's tooltip says Mirror and its key change it", async ({ page }) => {
    await page.getByTestId("alliance-pill").hover();
    await expect(page.getByRole("tooltip")).toContainText("Mirror (A) shows the other alliance.");
  });

  test("S11: with the example open, the arrow opens the Optimize menu", async ({ page }) => {
    const more = page.getByTestId("toolbar-optimize-more");
    await expect(more).not.toHaveAttribute("aria-disabled", "true");
    await more.click();
    await expect(page.getByTestId("optimize-menu")).toBeVisible();
  });

  test("S18: Enter on a first row that cannot run says why and keeps the palette open", async ({ page }) => {
    await openPalette(page, "Optimize path");
    const first = page.getByTestId("palette-results").getByRole("option").first();
    await expect(first).toHaveAttribute("data-testid", "palette-item-path.optimize");
    await expect(first).toBeDisabled();
    await expect(first).toHaveAttribute("aria-selected", "true");
    await page.screenshot({ path: shot("palette-first-row-disabled-night") });
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("palette-input")).toBeVisible();
    await expect(page.getByTestId("status")).toContainText("Optimize path: Select a path step first.");
    await expect(page.getByTestId("optimize-card")).toHaveCount(0);
  });

  test("S19: Snap names its state in the palette and is found by wall", async ({ page }) => {
    await openPalette(page, "wall");
    const snap = page.getByTestId("palette-item-view.snap");
    await expect(snap).toBeVisible();
    await expect(snap).toContainText("Snap: On");
  });

  test("S14: What's this from the Help menu explains the next control clicked", async ({ page }) => {
    await page.getByTestId("toolbar-help").click();
    await page.getByTestId("help-menu").getByTestId("menu-help.whatsThis").click();
    await expect(page.getByTestId("status")).toContainText("What's this: click a control or a row to see what it does.");
    await expect(page.locator("html")).toHaveAttribute("data-whats-this", "");
    expect(await page.evaluate(() => getComputedStyle(document.body).cursor)).toBe("help");
    // The click explains Snap instead of turning it off.
    const snapBefore = await editor<boolean>(page, "s.prefs.snap");
    await page.getByTestId("toolbar-view.snap").click();
    await expect(page.getByRole("tooltip")).toContainText("Snap");
    expect(await editor<boolean>(page, "s.prefs.snap")).toBe(snapBefore);
    await expect(page.locator("html")).not.toHaveAttribute("data-whats-this", "");
    await page.screenshot({ path: shot("whats-this-explained-night") });

    // Esc leaves the mode without explaining anything.
    await page.keyboard.press("Escape");
    await page.getByTestId("toolbar-help").click();
    await page.getByTestId("help-menu").getByTestId("menu-help.whatsThis").click();
    await expect(page.locator("html")).toHaveAttribute("data-whats-this", "");
    await page.keyboard.press("Escape");
    await expect(page.locator("html")).not.toHaveAttribute("data-whats-this", "");
    await expect(page.getByTestId("status")).toContainText("What's this cancelled.");
  });

  test("G1: each Settings section opens at its top", async ({ page }) => {
    await page.getByTestId("toolbar-settings").click();
    await page.getByTestId("settings-nav-general").click();
    const body = page.getByTestId("settings-pane-body");
    await body.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    expect(await body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await page.getByTestId("settings-nav-robot").click();
    await expect(page.getByTestId("settings-section-robot")).toBeVisible();
    expect(await page.getByTestId("settings-pane-body").evaluate((element) => element.scrollTop)).toBe(0);
    await page.getByTestId("settings-nav-keyboard").click();
    await expect(page.getByTestId("settings-section-keyboard")).toBeVisible();
    expect(await page.getByTestId("settings-pane-body").evaluate((element) => element.scrollTop)).toBe(0);
  });

  test("G3: searching key lists the Keyboard section first", async ({ page }) => {
    await page.getByTestId("toolbar-settings").click();
    await page.getByTestId("settings-search").fill("key");
    const first = page.getByTestId("settings-results").locator("section").first();
    await expect(first).toHaveAttribute("data-testid", "settings-results-keyboard");
    await page.screenshot({ path: shot("settings-search-key-night") });
  });

  test("G4: a Needs measurement chip is hollow, a Placeholder chip is filled", async ({ page }) => {
    await page.getByTestId("toolbar-settings").click();
    await page.getByTestId("settings-nav-robot").click();
    await expect(page.getByTestId("settings-section-robot")).toBeVisible();
    const looks = await page.getByTestId("settings-section-robot").evaluate((root) =>
      [...root.querySelectorAll<HTMLElement>("[data-tier]")].map((chip) => ({
        text: chip.textContent ?? "",
        needs: chip.hasAttribute("data-needs"),
        background: getComputedStyle(chip).backgroundColor,
        outline: getComputedStyle(chip).outlineStyle,
      })),
    );
    for (const chip of looks.filter((one) => one.text.startsWith("Needs"))) {
      expect(chip.needs, chip.text).toBe(true);
      expect(chip.outline).toBe("dashed");
    }
    for (const chip of looks.filter((one) => one.text.startsWith("Placeholder"))) {
      expect(chip.needs, chip.text).toBe(false);
      expect(chip.outline).not.toBe("dashed");
    }
    await page.screenshot({ path: shot("settings-robot-chips-night") });
  });
});
