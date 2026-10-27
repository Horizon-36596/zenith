/**
 * The alliance view (spec 13 section 9), end to end: load the example,
 * load the example partner's projection from `examples/starter/partners/` through the Partners
 * panel's file picker, and see the predicted collision in the problems panel's Alliance group and
 * the partner's robot on the field. Then the two one-click fixes: "Delay my start" clears it with a
 * view setting, and "Add a wait step" clears it with a real, undoable edit.
 */
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";

const PARTNER = fileURLToPath(
  new URL("../../../examples/starter/partners/starter-partner.projection.json", import.meta.url),
);
const SHOTS = fileURLToPath(new URL("../test-results/alliance/", import.meta.url));

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem(
        "zenith.ui",
        JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }),
      );
    }
  });
  await turnOnFeatures(page);
});

async function loadExampleWithPartner(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await page.getByTestId("partners-panel-fold").click();
  await page.getByTestId("partners-file-input").setInputFiles(PARTNER);
  await expect(page.getByTestId("partners-list")).toContainText("Starter partner");
}

const collisionRows = (page: Page) =>
  page.locator('[data-testid="alliance-finding-row"][data-code="ALLIANCE_COLLISION"]');

/** Selects a finding row, which is when it shows its fixes (UI_GUIDE section 9.7). */
async function openRow(row: Locator): Promise<void> {
  await row.getByTestId("alliance-finding-select").click();
  await expect(row).toHaveAttribute("data-selected", "true");
}

test("a partner projection shows a predicted collision and the partner's robot on the field", async ({ page }) => {
  await loadExampleWithPartner(page);

  // The finding, in its own group, labelled as a prediction, and not in the auto's own counts.
  const group = page.getByTestId("alliance-findings");
  await expect(group).toContainText("predicted");
  await expect(collisionRows(page)).toHaveCount(1);
  await expect(collisionRows(page).first()).toContainText("Predicted collision with Starter partner");
  await expect(page.getByTestId("findings-count-error")).toHaveText("0 errors");

  // The partner is on the canvas, and its lane is in the timeline.
  const canvas = page.locator("canvas").first();
  await expect(canvas).toHaveAttribute("data-partners", /^partner\d+@-37\.00,-63\.00$/);
  await expect(page.locator('[data-testid^="alliance-lane-"]')).toHaveCount(1);

  // An unselected row is one line, as a Problems row is, with no fixes and no how-to (K3).
  const row = collisionRows(page).first();
  await expect(row.getByTestId("alliance-finding-fixes")).toHaveCount(0);
  await expect(row).not.toContainText("How to fix");
  const lineHeight = (await row.boundingBox())?.height ?? 0;
  expect(lineHeight).toBeLessThanOrEqual(32);

  // Clicking the finding scrubs playback to its time, which moves the partner, and shows its fixes.
  await openRow(row);
  await expect(row.getByTestId("alliance-fix-delay")).toBeVisible();
  await expect(row.getByTestId("alliance-fix-wait")).toBeVisible();
  await expect(row).not.toContainText("How to fix");
  // The code chip's tooltip names the code, then says what it means and how to fix it (K22).
  await row.getByTestId("alliance-finding-code").hover();
  const tip = page.getByRole("tooltip");
  await expect(tip).toContainText("(ALLIANCE_COLLISION)");
  await expect(tip.locator("span").last()).toHaveText(/^To fix: /);
  await page.mouse.move(0, 0);
  const at = Number(await page.getByTestId("playback").inputValue());
  expect(at).toBeGreaterThan(0);
  await expect(canvas).not.toHaveAttribute("data-partners", /@-33\.00,-63\.00$/);
  await page.screenshot({ path: `${SHOTS}alliance-collision.png` });
  await collisionRows(page).first().hover();
  await group.screenshot({ path: `${SHOTS}alliance-findings.png` });
});

test("Delay my start clears the collision without editing the auto", async ({ page }) => {
  await loadExampleWithPartner(page);
  const row = collisionRows(page).first();
  await openRow(row);
  const delay = row.getByTestId("alliance-fix-delay");
  await expect(delay).toHaveText(/Delay my start \d+\.\d s/);
  await delay.click();
  await expect(collisionRows(page)).toHaveCount(0);
  const offset = await page.getByTestId("partners-own-offset").inputValue();
  expect(Number(offset)).toBeGreaterThan(0);
  await expect(page.getByTestId("alliance-own-offset-block")).toBeVisible();
  // The status line says what the delay left and how to take it back: it is a view setting, so
  // Undo cannot.
  const status = page.getByTestId("status");
  await expect(status).toContainText(`Your start is delayed by ${offset} s in the alliance view.`);
  await expect(status).toContainText(/(One|\d+) .+ (is|are) left\.|No predicted conflicts are left\./);
  await expect(status).toContainText("To undo it, set Your start offset back to 0.0 s.");
  await page.screenshot({ path: `${SHOTS}alliance-delayed.png` });
});

test("with no partner the Partners panel is an empty state, with no start offset to set", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await page.getByTestId("partners-panel-fold").click();
  const empty = page.getByTestId("partners-empty");
  await expect(empty).toContainText("No partners loaded");
  await expect(empty.getByTestId("partners-load")).toHaveText("Load share file…");
  await expect(page.getByTestId("partners-own-offset")).toHaveCount(0);
  await expect(page.getByTestId("partners-offset-to-wait")).toHaveCount(0);

  // A partner brings the offset row in, and the empty state goes.
  await page.getByTestId("partners-load-example").click();
  await expect(page.getByTestId("partners-list")).toContainText("Starter partner");
  await expect(empty).toHaveCount(0);
  await expect(page.getByTestId("partners-own-offset")).toBeVisible();
  await expect(page.getByTestId("partners-offset-to-wait")).toBeVisible();
});

test("the same file loaded again replaces the partner, and Remove says how to bring it back", async ({ page }) => {
  await loadExampleWithPartner(page);
  const rows = page.getByTestId("partners-list").locator('li[data-testid^="partner-"]');
  await expect(rows).toHaveCount(1);
  await page.getByTestId("partners-file-input").setInputFiles(PARTNER);
  const status = page.getByTestId("status");
  await expect(status).toContainText("Replaced Starter partner with the file loaded again, so it is not loaded twice.");
  await expect(rows).toHaveCount(1);
  await expect(page.locator('[data-testid^="alliance-lane-"]')).toHaveCount(1);

  await page.getByTestId("partners-list").locator('[data-testid^="partner-remove-"]').click();
  await expect(status).toContainText("Removed Starter partner. Load its file again to bring it back.");
  await expect(page.getByTestId("partners-empty")).toBeVisible();
});

test("Add a wait step inserts a real wait that clears it, and undo takes it out", async ({ page }) => {
  await loadExampleWithPartner(page);
  const row = collisionRows(page).first();
  await openRow(row);
  await row.getByTestId("alliance-fix-wait").click();
  await expect(page.getByTestId("step-row-wait")).toBeVisible();
  await expect(collisionRows(page)).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect(page.getByTestId("step-row-wait")).toHaveCount(0);
  await expect(collisionRows(page)).toHaveCount(1);
});

test("Make it a wait step turns the start offset into a real first wait, and undo puts the offset back", async ({ page }) => {
  await loadExampleWithPartner(page);
  const toWait = page.getByTestId("partners-offset-to-wait");
  // With no offset there is nothing to make, and the button says so rather than editing.
  await expect(toWait).toHaveAttribute("aria-disabled", "true");

  const row = collisionRows(page).first();
  await openRow(row);
  await row.getByTestId("alliance-fix-delay").click();
  await expect(collisionRows(page)).toHaveCount(0);
  const offset = await page.getByTestId("partners-own-offset").inputValue();
  expect(Number(offset)).toBeGreaterThan(0);

  await expect(toWait).not.toHaveAttribute("aria-disabled", "true");
  await toWait.click();
  // The offset is now a wait of the same length, first in the auto, and the offset is back to 0 s.
  await expect(page.locator('[data-testid^="step-row-"]').first()).toHaveAttribute("data-testid", "step-row-wait");
  await expect(page.getByTestId("partners-own-offset")).toHaveValue("0.0");
  await expect(page.getByTestId("alliance-own-offset-block")).toHaveCount(0);
  await expect(page.getByTestId("status")).toContainText(`Your ${offset} s start offset is now a wait`);
  // The robot waits exactly as long as it did, so the collision stays cleared.
  await expect(collisionRows(page)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}alliance-offset-to-wait.png` });

  // Undo takes the wait out and puts the offset back, so the delay is not lost; redo does both again.
  await page.keyboard.press("Control+z");
  await expect(page.getByTestId("step-row-wait")).toHaveCount(0);
  await expect(page.getByTestId("partners-own-offset")).toHaveValue(offset);
  await expect(collisionRows(page)).toHaveCount(0);
  await page.keyboard.press("Control+y");
  await expect(page.locator('[data-testid^="step-row-"]').first()).toHaveAttribute("data-testid", "step-row-wait");
  await expect(page.getByTestId("partners-own-offset")).toHaveValue("0.0");
  await expect(collisionRows(page)).toHaveCount(0);
});

/** Switches to another auto in the open project through the picker every auto opens through. */
async function openAutoNamed(page: Page, fileName: string): Promise<void> {
  await page.getByTestId("toolbar-auto-name").click();
  await page.getByTestId(`open-auto-${fileName}`).click();
}

test("the start offset belongs to one auto: first-auto shows its own collision, and the delay is there on the way back", async ({
  page,
}) => {
  await loadExampleWithPartner(page);
  const row = collisionRows(page).first();
  await openRow(row);
  await row.getByTestId("alliance-fix-delay").click();
  await expect(collisionRows(page)).toHaveCount(0);
  const offset = await page.getByTestId("partners-own-offset").inputValue();
  expect(Number(offset)).toBeGreaterThan(0);

  // Another auto opens with no offset, so its own predicted collision is not hidden by this one's.
  await openAutoNamed(page, "first-auto.auto.json");
  await expect(page.getByTestId("partners-own-offset")).toHaveValue("0.0");
  await expect(collisionRows(page)).toHaveCount(1);
  await expect(page.getByTestId("status")).toContainText(
    `Your start offset is 0 s for first-auto. The ${offset} s delay stays with collect-and-score.`,
  );
  await page.screenshot({ path: `${SHOTS}alliance-offset-other-auto.png` });

  // Going back finds the delay again, and the collision it cleared stays cleared.
  await openAutoNamed(page, "collect-and-score.auto.json");
  await expect(page.getByTestId("partners-own-offset")).toHaveValue(offset);
  await expect(collisionRows(page)).toHaveCount(0);
});

test("Load example forgets the start offsets and keeps the partner", async ({ page }) => {
  await loadExampleWithPartner(page);
  const row = collisionRows(page).first();
  await openRow(row);
  await row.getByTestId("alliance-fix-delay").click();
  await expect(page.getByTestId("partners-own-offset")).not.toHaveValue("0.0");

  await page.evaluate(`import("/src/state/store.ts").then((m) => m.setDialog("open"))`);
  await page.getByTestId("open-project-other").click();
  await page.getByTestId("load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await expect(page.getByTestId("partners-own-offset")).toHaveValue("0.0");
  await expect(page.getByTestId("partners-list")).toContainText("Starter partner");
  await expect(collisionRows(page)).toHaveCount(1);
});
