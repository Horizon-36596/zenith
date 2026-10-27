/**
 * Proposals (spec 13 section 14, M-C6), end to end, with one browser
 * playing both teams. As the proposer: load the example propose-level share from
 * `examples/starter/partners/`, choose Suggest changes, drag one of the partner's points on the
 * field, comment on the change and save the proposal. As the owner: open that file against the
 * starter's own collect-and-score, accept every valid change, apply it, see the auto changed, and
 * undo it back.
 */
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";

const SHARE = fileURLToPath(
  new URL("../../../examples/starter/partners/starter-collect-and-score.propose.projection.json", import.meta.url),
);
const SHOTS = process.env["ZENITH_SHOTS"] ?? fileURLToPath(new URL("../test-results/proposals/", import.meta.url));

test.beforeEach(async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
    }
  });
  await turnOnFeatures(page);
});

async function worldToScreen(page: Page, xIn: number, yIn: number): Promise<{ x: number; y: number }> {
  const canvas = page.getByTestId("field-canvas");
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("the canvas has no box");
  const pxPerIn = Number(await canvas.getAttribute("data-px-per-in"));
  const originXPx = Number(await canvas.getAttribute("data-origin-x-px"));
  const originYPx = Number(await canvas.getAttribute("data-origin-y-px"));
  return { x: box.x + originXPx + pxPerIn * xIn, y: box.y + originYPx - pxPerIn * yIn };
}

async function drag(page: Page, from: { xIn: number; yIn: number }, to: { xIn: number; yIn: number }): Promise<void> {
  const start = await worldToScreen(page, from.xIn, from.yIn);
  const end = await worldToScreen(page, to.xIn, to.yIn);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 6 });
  await page.mouse.move(end.x, end.y, { steps: 6 });
  await page.mouse.up();
}

test("a partner proposes moving a pose, and the owner accepts it and undoes it", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-toGarden")).toBeVisible();

  // ---- The proposer: load the propose-level share and suggest changes. ----
  await page.getByTestId("partners-panel-fold").click();
  await page.getByTestId("partners-file-input").setInputFiles(SHARE);
  await expect(page.getByTestId("partners-list")).toContainText("Starter collect and score");
  await page.getByTestId("partner-suggest-partner1").click();
  await expect(page.getByTestId("proposal-banner")).toContainText("Suggesting changes to Starter collect and score");

  // Commands show only as tokens with their time.
  await expect(page.getByTestId("proposal-step-s2")).toContainText("cmd1 · 2.5 s · stationary");
  await expect(page.getByTestId("proposal-no-changes")).toBeVisible();

  // Drag the end of s9 (the share's toGarden) from (-46, -62) a few inches east along the wall.
  await page.getByTestId("proposal-step-s9").click();
  await drag(page, { xIn: -46, yIn: -62 }, { xIn: -40, yIn: -62 });
  const change = page.getByTestId("proposal-change-1");
  await expect(change).toContainText("Move the end of path 1 of s9");
  // The end of a curve carries its handle with it, so the handle's move is the second change.
  await expect(page.getByTestId("proposal-change-2")).toContainText("control point 3 of path 1 of s9");
  await expect(page.getByTestId("proposal-change-3")).toHaveCount(0);
  await expect(page.getByTestId("proposal-findings-empty")).toBeVisible();

  // Undo in the proposal takes the whole drag back and never touches the user's own auto.
  await page.keyboard.press("Control+z");
  await expect(page.getByTestId("proposal-no-changes")).toBeVisible();
  await page.keyboard.press("Control+y");
  await expect(page.getByTestId("proposal-change-2")).toContainText("s9");

  await page.getByTestId("proposal-comment-1").fill("Stop further east so we can pass behind you.");
  await page.getByTestId("proposal-comment-1").press("Enter");
  await page.screenshot({ path: `${SHOTS}proposer-editing.png` });


  const downloading = page.waitForEvent("download");
  await page.getByTestId("proposal-save").click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/\.proposal\.json$/);
  const saved = `${SHOTS}${download.suggestedFilename()}`;
  await download.saveAs(saved);
  await page.getByTestId("proposal-leave").click();
  await expect(page.getByTestId("step-row-toGarden")).toBeVisible();
  // The changes were saved, so leaving does not say they were dropped: the Saved line stays.
  await expect(page.getByTestId("status")).toContainText("Saved");
  await expect(page.getByTestId("status")).not.toContainText("dropped");

  // ---- The owner: open the proposal against collect-and-score. ----
  await page.keyboard.press("Control+k");
  await page.keyboard.type("Open proposal");
  const choosing = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  await (await choosing).setFiles(saved);
  await expect(page.getByTestId("owner-review-banner")).toBeVisible();
  const row = page.getByTestId("owner-change-1");
  await expect(row).toContainText('"toGarden"');
  await expect(row.getByTestId("owner-change-comment")).toContainText("Stop further east");
  await expect(row.getByTestId("owner-change-status")).toHaveText("not accepted");
  // Undecided: neither Accept nor Reject is pressed until the owner picks one.
  await expect(page.getByTestId("owner-accept-1")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("owner-reject-1")).toHaveAttribute("aria-pressed", "false");
  await page.getByTestId("owner-reject-1").click();
  await expect(page.getByTestId("owner-reject-1")).toHaveAttribute("aria-pressed", "true");
  await expect(row.getByTestId("owner-change-status")).toHaveText("rejected");
  await page.getByTestId("owner-accept-1").click();
  await expect(page.getByTestId("owner-accept-1")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("owner-reject-1")).toHaveAttribute("aria-pressed", "false");

  await page.getByTestId("owner-review-accept-all").click();
  await expect(row.getByTestId("owner-change-status")).toHaveText("accepted");
  await page.screenshot({ path: `${SHOTS}owner-review.png` });
  await expect(page.getByTestId("owner-review-apply")).toHaveText("Apply 2");
  await page.getByTestId("owner-review-apply").click();
  await expect(row.getByTestId("owner-change-status")).toHaveText("applied");
  await expect(page.getByTestId("owner-change-2").getByTestId("owner-change-status")).toHaveText("applied");
  await page.screenshot({ path: `${SHOTS}owner-applied.png` });
  await page.getByTestId("owner-review-leave").click();

  // The auto changed: toGarden now ends at a literal pose further east along the wall.
  await page.getByTestId("step-row-toGarden").getByRole("button").first().click();
  await expect(page.getByTestId("inspector-to-source-0")).toHaveValue("pose");
  await expect.poll(async () => Number(await page.getByTestId("inspector-to-x-0").inputValue())).toBeGreaterThan(-44);

  // One undo takes the whole Apply out.
  await page.keyboard.press("Control+z");
  await expect(page.getByTestId("inspector-to-source-0")).toHaveValue(/^ref:/);
});

test("Leave with changes not saved or sent asks Cancel, Discard changes or Save proposal first", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-toGarden")).toBeVisible();
  await page.getByTestId("partners-panel-fold").click();
  await page.getByTestId("partners-file-input").setInputFiles(SHARE);
  await page.getByTestId("partner-suggest-partner1").click();
  await expect(page.getByTestId("proposal-banner")).toBeVisible();
  await page.getByTestId("proposal-wait-start").click();
  await expect(page.getByTestId("proposal-change-1")).toBeVisible();

  await page.getByTestId("proposal-leave").click();
  const ask = page.getByTestId("unsaved-dialog");
  await expect(ask).toContainText("The proposal to Starter collect and score has 1 change that is not saved or sent. Leaving drops them.");
  await expect(ask.getByRole("button")).toHaveText(["Cancel", "Discard changes", "Save proposal…"]);
  await ask.getByTestId("unsaved-cancel").click();
  await expect(page.getByTestId("proposal-banner")).toBeVisible();
  await expect(page.getByTestId("proposal-change-1")).toBeVisible();

  await page.getByTestId("proposal-leave").click();
  await page.getByTestId("unsaved-discard").click();
  await expect(page.getByTestId("proposal-banner")).toHaveCount(0);
  await expect(page.getByTestId("status")).toContainText("Left the proposal to Starter collect and score");
});
