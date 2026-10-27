/**
 * Issue #237: row hints and Shift F1, "What's this" (UI_GUIDE section 9.4).
 *
 * - A row with a hint opens it after a long hover on its label, 800 ms (`--hint-delay`), not at the
 *   400 ms every other tooltip uses. The exact 799 and 800 ms edges are in tooltipGate.test.ts.
 * - Opening a second hint closes the first, and a press on the row closes an open one.
 * - Shift F1 opens the focused control's hint, even in a text field, which never opens its tooltip
 *   on focus, and Esc closes it without leaving the field.
 * - A 450 ms touch hold on a row that does not drag opens its hint; a step row drags, so it is marked
 *   as one and takes no hold hint.
 */
import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { loadExample, openMore, selectStep, skipTour, waitForFonts } from "./qa/helpers";

const tooltips = (page: Page) => page.locator('[role="tooltip"]');
const rowLabel = (page: Page, text: string) => page.getByTestId("inspector").locator("label", { hasText: text });

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
  await waitForFonts(page);
  await selectStep(page, "driveOut");
  await expect(page.getByTestId("inspector-estimate")).toBeVisible();
});

test("a row's label opens its hint after a long hover, later than an ordinary tooltip", async ({ page }) => {
  // The step's MetaLine (issue #239) is a hint trigger as a row's label is.
  await page.getByTestId("inspector-estimate").hover();
  // An ordinary tooltip would be open by now.
  await page.waitForTimeout(600);
  await expect(tooltips(page)).toHaveCount(0);
  await expect(tooltips(page)).toHaveCount(1);
  await expect(tooltips(page)).toContainText("How long the plan expects this step to take.");
  // The pointer leaving closes it.
  await page.mouse.move(0, 0);
  await expect(tooltips(page)).toHaveCount(0);
});

test("opening a second hint closes the first, and a press on the row closes it", async ({ page }) => {
  await openMore(page);
  await page.getByTestId("inspector-estimate").hover();
  await expect(tooltips(page)).toContainText("How long the plan expects");
  await rowLabel(page, "Stay inside").hover();
  await expect(tooltips(page)).toHaveCount(1);
  await expect(tooltips(page)).toContainText("Optional: where you stay, for partners.");

  await page.mouse.down();
  await expect(tooltips(page)).toHaveCount(0);
  await page.mouse.up();
});

test("Shift F1 opens the focused number field's hint, and Esc closes it and stays in the field", async ({ page }) => {
  await openMore(page);
  const timeout = page.getByTestId("inspector-timeout");
  await timeout.focus();
  // A field a person types into opens no tooltip on focus.
  await page.waitForTimeout(500);
  await expect(tooltips(page)).toHaveCount(0);

  await page.keyboard.press("Shift+F1");
  await expect(tooltips(page)).toHaveCount(1);
  await expect(tooltips(page)).toContainText("Timeout");
  await expect(tooltips(page)).toContainText("Empty means no timeout.");

  await page.keyboard.press("Escape");
  await expect(tooltips(page)).toHaveCount(0);
  // That Esc closed the hint and did nothing else: the field still has focus and the step its selection.
  await expect(timeout).toBeFocused();
  await expect(page.getByTestId("inspector")).toBeVisible();
});

test("the step's MetaLine is described by its hint, strafe fraction included, and Shift F1 on it opens the hint", async ({ page }) => {
  // The MetaLine (issue #239) replaced the read-only Estimated and Strafe fraction rows, so its
  // hint carries both: the estimate's description, then the path's strafe fraction and its own.
  const strafe = /Strafe fraction \d+\.\d\d: how much of this path the robot drives sideways/;
  const readout = page.getByTestId("inspector-estimate");
  const ids = (await readout.getAttribute("aria-describedby"))?.split(/\s+/) ?? [];
  expect(ids.length).toBeGreaterThan(0);
  const described = (await Promise.all(ids.map((id) => page.locator(`[id="${id}"]`).textContent()))).join(" ");
  expect(described).toContain("How long the plan expects this step to take.");
  expect(described).toMatch(strafe);

  await readout.focus();
  await page.keyboard.press("Shift+F1");
  await expect(tooltips(page)).toHaveCount(1);
  await expect(tooltips(page)).toContainText("How long the plan expects this step to take.");
  await expect(tooltips(page)).toContainText(strafe);
  await page.keyboard.press("Escape");
  await expect(tooltips(page)).toHaveCount(0);
  await expect(readout).toBeFocused();
});

test("the Help menu lists What's this with its key", async ({ page }) => {
  await page.getByTestId("toolbar-help").click();
  const item = page.getByTestId("help-menu").getByTestId("menu-help.whatsThis");
  await expect(item).toBeVisible();
  await expect(item).toContainText("What's this");
  await expect(item).toContainText("Shift F1");
});

test.describe("on touch", () => {
  test.use({ hasTouch: true });

  const touch = async (client: CDPSession, type: "touchStart" | "touchEnd", at: { x: number; y: number } | null): Promise<void> => {
    await client.send("Input.dispatchTouchEvent", { type, touchPoints: at === null ? [] : [{ x: at.x, y: at.y, id: 1 }] });
  };

  test("a 450 ms hold on a row's label opens its hint", async ({ page }) => {
    const box = await page.getByTestId("inspector-estimate").boundingBox();
    if (box === null) throw new Error("the MetaLine has no box");
    const client = await page.context().newCDPSession(page);
    await touch(client, "touchStart", { x: box.x + 8, y: box.y + box.height / 2 });
    await page.waitForTimeout(600);
    await expect(tooltips(page)).toContainText("How long the plan expects this step to take.");
    await touch(client, "touchEnd", null);
    // The lift does not close it.
    await page.waitForTimeout(150);
    await expect(tooltips(page)).toHaveCount(1);
  });

  test("a step row is marked as a row that drags, so it takes no hold hint", async ({ page }) => {
    await expect(page.getByTestId("step-row-driveOut")).toHaveAttribute("data-drag-row", "");
  });
});
