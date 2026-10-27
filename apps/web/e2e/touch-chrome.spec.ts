/**
 * Issue #189: the toolbar on a tablet without a keyboard.
 *
 * - N77: Undo and Redo are toolbar buttons (UI_GUIDE 9.2). They are not toggles, so they carry no
 *   `aria-pressed`, and in a proposal they move the proposal's own history, never the auto under it.
 * - N89: tooltips open on touch (UI_GUIDE 9.4). A 450 ms hold shows one without pressing the
 *   button, and a tap on a disabled button shows why it is disabled.
 */
import { fileURLToPath } from "node:url";
import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { dragWorld, editor, loadExample, rowIds, selectStep, skipTour } from "./qa/helpers";

const SHARE = fileURLToPath(
  new URL("../../../examples/starter/partners/starter-collect-and-score.propose.projection.json", import.meta.url),
);

const undoDepth = (page: Page) => editor<number>(page, "s.undo.length");

async function centreOf(page: Page, testId: string): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId(testId).boundingBox();
  if (box === null) throw new Error(`${testId} has no box`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const touch = async (client: CDPSession, type: "touchStart" | "touchMove" | "touchEnd", at: { x: number; y: number } | null): Promise<void> => {
  await client.send("Input.dispatchTouchEvent", { type, touchPoints: at === null ? [] : [{ x: at.x, y: at.y, id: 1 }] });
};

/** A tap by hand: Playwright's own tap refuses a button that is aria-disabled, which is the case under test. */
async function tapByHand(page: Page, testId: string): Promise<void> {
  const client = await page.context().newCDPSession(page);
  const at = await centreOf(page, testId);
  await touch(client, "touchStart", at);
  await touch(client, "touchEnd", null);
}

test.beforeEach(async ({ page }) => {
  await skipTour(page);
});

test.describe("undo and redo in the toolbar", () => {
  test.use({ hasTouch: true });

  test("a tap on Undo brings back a deleted step, and a tap on Redo deletes it again", async ({ page }) => {
    await loadExample(page);
    const undo = page.getByTestId("toolbar-edit.undo");
    const redo = page.getByTestId("toolbar-edit.redo");
    await expect(undo).toHaveAttribute("aria-disabled", "true");
    // Not toggles: neither carries a pressed state.
    await expect(undo).not.toHaveAttribute("aria-pressed", /.*/);
    await expect(redo).not.toHaveAttribute("aria-pressed", /.*/);

    await page.getByTestId("step-row-collectFlower").getByRole("button").first().tap();
    await page.getByTestId("delete-step").tap();
    await expect.poll(() => rowIds(page)).not.toContain("collectFlower");
    expect(await undoDepth(page)).toBe(1);
    await expect(undo).toHaveAttribute("aria-disabled", "false");

    await undo.tap();
    await expect.poll(() => rowIds(page)).toContain("collectFlower");
    expect(await undoDepth(page)).toBe(0);
    await expect(redo).toHaveAttribute("aria-disabled", "false");

    await redo.tap();
    await expect.poll(() => rowIds(page)).not.toContain("collectFlower");
  });
});

test("in a proposal the toolbar Undo reverts the last proposal edit, not the auto underneath", async ({ page }) => {
  await loadExample(page);
  // One edit to the user's own auto, so there is something underneath to wrongly undo.
  await selectStep(page, "collectFlower");
  await page.getByTestId("delete-step").click();
  await expect.poll(() => rowIds(page)).not.toContain("collectFlower");
  expect(await undoDepth(page)).toBe(1);

  await page.getByTestId("partners-panel-fold").click();
  await page.getByTestId("partners-file-input").setInputFiles(SHARE);
  await page.getByTestId("partner-suggest-partner1").click();
  await expect(page.getByTestId("proposal-banner")).toBeVisible();
  await expect(page.getByTestId("toolbar-edit.undo")).toHaveAttribute("aria-disabled", "true");

  // Drag the end of s9 a few inches east, as proposals.spec does; that is one proposal change group.
  await page.getByTestId("proposal-step-s9").click();
  await dragWorld(page, { xIn: -46, yIn: -62 }, { xIn: -40, yIn: -62 });
  await expect(page.getByTestId("proposal-change-1")).toBeVisible();
  const changes = (): Promise<number> =>
    page.evaluate(`import("/src/proposals/proposerStore.ts").then((p) => p.getProposerSession().changes.length)`);
  expect(await changes()).toBeGreaterThan(0);
  const undo = page.getByTestId("toolbar-edit.undo");
  await expect(undo).toHaveAttribute("aria-disabled", "false");
  await undo.click();
  expect(await changes()).toBe(0);
  // The auto underneath is as it was: still one undo step, collectFlower still deleted.
  expect(await undoDepth(page)).toBe(1);
  await expect(page.getByTestId("toolbar-edit.redo")).toHaveAttribute("aria-disabled", "false");
});

test.describe("tooltips on touch", () => {
  test.use({ hasTouch: true });

  test("a 600 ms hold on the Heading tool shows its tooltip and leaves the tool unchanged", async ({ page }) => {
    await loadExample(page);
    const client = await page.context().newCDPSession(page);
    const heading = await centreOf(page, "toolbar-tool.heading");
    expect(await editor<string>(page, "s.tool")).toBe("select");
    await touch(client, "touchStart", heading);
    await page.waitForTimeout(600);
    await expect(page.getByRole("tooltip")).toContainText("Heading");
    await touch(client, "touchEnd", null);
    // The lift does not close it, and the click it ends with did not press the tool.
    await page.waitForTimeout(150);
    await expect(page.getByRole("tooltip")).toContainText("Heading");
    expect(await editor<string>(page, "s.tool")).toBe("select");
  });

  test("a tap, or a hold that drifts more than 8 px, opens no tooltip and presses as usual", async ({ page }) => {
    await loadExample(page);
    const client = await page.context().newCDPSession(page);
    const heading = await centreOf(page, "toolbar-tool.heading");
    await touch(client, "touchStart", heading);
    await touch(client, "touchMove", { x: heading.x + 12, y: heading.y });
    await page.waitForTimeout(600);
    await touch(client, "touchEnd", null);
    await expect(page.getByRole("tooltip")).toHaveCount(0);

    await page.getByTestId("toolbar-tool.heading").tap();
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    expect(await editor<string>(page, "s.tool")).toBe("heading");
  });

  // Undo, with nothing to take back on a fresh load: Propose, which these used, is not drawn outside
  // GitHub mode since issue #412.
  test("a tap on the disabled Undo button shows why, and a press elsewhere closes it", async ({ page }) => {
    await loadExample(page);
    const undo = page.getByTestId("toolbar-edit.undo");
    await expect(undo).toHaveAttribute("aria-disabled", "true");
    await tapByHand(page, "toolbar-edit.undo");
    await expect(page.getByRole("tooltip")).toContainText("Unavailable:");
    await page.getByTestId("field-canvas").tap({ position: { x: 5, y: 5 } });
    await expect(page.getByRole("tooltip")).toHaveCount(0);
  });

  test("a tooltip a finger opened closes by itself after about 4 s", async ({ page }) => {
    await loadExample(page);
    await tapByHand(page, "toolbar-edit.undo");
    await expect(page.getByRole("tooltip")).toBeVisible();
    await page.waitForTimeout(3000);
    await expect(page.getByRole("tooltip")).toBeVisible();
    await expect(page.getByRole("tooltip")).toHaveCount(0, { timeout: 2500 });
  });
});
