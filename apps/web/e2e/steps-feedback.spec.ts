/**
 * Issue #411, the steps list, the timeline and honest feedback. The example opens on
 * collect-and-score: `toGarden` is a path in the middle of the list, `waitForFull` a wait that ends on
 * a condition (so its time is unknown and the total is rough), and `returnToScore` a deadline
 * parallel group of the path `driveBack` and the sequence `clearThenSpinUp` (a wait and a command),
 * so it holds 3 steps that run.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { editor, findingRows, loadExample, openAutoNamed, skipTour } from "./qa/helpers";

const tooltips = (page: Page): Locator => page.locator('[role="tooltip"]');

/** The step ids the list shows, top to bottom. */
const ids = (page: Page): Promise<string[]> => editor<string[]>(page, `s.auto.steps.map((x) => x.id)`);

/** The first step row's top on main before this issue, at 1280x720: 265 px. */
const FIRST_ROW_TOP_BEFORE_PX = 265;

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await skipTour(page);
  await loadExample(page);
});

test("F2 on a focused step row starts the rename and leaves the status line as it was", async ({ page }) => {
  await page.getByTestId("step-main-toGarden").click();
  const before = await editor<string | null>(page, `s.status?.message ?? null`);
  await page.keyboard.press("F2");
  await expect(page.getByTestId("step-id-input-toGarden")).toBeFocused();
  expect(await editor<string | null>(page, `s.status?.message ?? null`)).toBe(before);
  await expect(page.getByTestId("status")).not.toContainText("Rename waypoint");
  await page.keyboard.press("Escape");
});

test("Ctrl D on the starter's driveOut chains the copy on and says so", async ({ page }) => {
  await openAutoNamed(page, "first-auto.auto.json");
  await page.getByTestId("step-main-driveOut").click();
  await page.keyboard.press("Control+d");
  await expect(page.getByTestId("step-row-driveOutCopy")).toBeVisible();
  expect(await ids(page)).toEqual(["driveOut", "driveOutCopy", "scorePreload", "park"]);
  expect(await editor<unknown>(page, `s.auto.steps[1].segments[0].from`)).toBe("current");
  await expect(page.getByTestId("status")).toContainText("Duplicated driveOut as driveOutCopy.");
  expect(await editor<number>(page, `m.currentDerived().findings.filter((f) => f.code === "CONTINUITY").length`)).toBe(0);
});

test("the list has no inline connect fix: a gap keeps its severity dot and its fix in Problems", async ({ page }) => {
  // toGarden starts away from where scoreFlowerPollen leaves the robot.
  await editor(
    page,
    `m.commit({ ...s.auto, steps: s.auto.steps.map((x) => x.id === "toGarden" ? { ...x, segments: [{ ...x.segments[0], from: { xIn: 0, yIn: -40, headingRad: 0 } }, ...x.segments.slice(1)] } : x) })`,
  );
  await expect(page.getByTestId("step-dot-toGarden")).toBeAttached();
  await expect(page.locator('[data-testid^="connect-"]')).toHaveCount(0);
  await expect(findingRows(page, "CONTINUITY").first()).toBeVisible();
});

test("the timeline head shows one total of the period, a quiet ~ and the level switch in the same row", async ({ page }) => {
  const head = page.getByTestId("timeline-total");
  await expect(page.getByTestId("timeline-level-total")).toHaveText(/^\d+\.\d\d\s*s$/);
  await expect(page.getByTestId("timeline-budget")).toHaveText(/^of 30\s*s$/);
  const bound = page.getByTestId("timeline-bound");
  await expect(bound).toHaveText("~");
  await bound.hover();
  await expect(tooltips(page)).toContainText("Rough");
  await expect(tooltips(page)).not.toContainText("at least");
  await page.mouse.move(640, 10);

  // No Playback label, and the level's word only on the switch.
  const timeline = page.locator('[aria-label="Timeline"]');
  await expect(timeline.getByText("Playback", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("timeline-level-total")).not.toContainText("ideal");
  await expect(page.getByTestId("playhead-readout")).not.toContainText("ideal");
  const totalBox = await head.boundingBox();
  const switchBox = await page.getByTestId("playback-level").boundingBox();
  expect(Math.abs((totalBox?.y ?? 0) + (totalBox?.height ?? 0) / 2 - ((switchBox?.y ?? 0) + (switchBox?.height ?? 0) / 2))).toBeLessThan(6);

  // The block above the first step row is at least 40 px shorter than it was.
  const first = await page.getByTestId("step-row-driveOut").boundingBox();
  expect(first?.y ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(FIRST_ROW_TOP_BEFORE_PX - 40);
});

test("the scrubber row starts with Play, which plays and pauses, and Space still does", async ({ page }) => {
  const play = page.getByTestId("timeline-play");
  const first = page.getByTestId("timeline-scrub").locator(":scope > *").first();
  await expect(first).toHaveAttribute("data-testid", "timeline-play");
  await play.click();
  await expect.poll(() => editor<boolean>(page, `s.playing`)).toBe(true);
  await expect(play).toHaveAttribute("aria-label", "Pause");
  await play.click();
  await expect.poll(() => editor<boolean>(page, `s.playing`)).toBe(false);
  await page.keyboard.press("Space");
  await expect.poll(() => editor<boolean>(page, `s.playing`)).toBe(true);
  await page.keyboard.press("Space");
  await expect.poll(() => editor<boolean>(page, `s.playing`)).toBe(false);
});

test("while playing, the deepest running row comes into view, and a scroll by the person is left alone", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  const list = page.getByTestId("steps-list");
  await expect(page.getByTestId("step-row-clearGarden")).not.toBeInViewport();
  // Late in the run, inside returnToScore.
  await editor(page, `m.setPlayback(21)`);
  await page.getByTestId("timeline-play").click();
  await expect(page.getByTestId("step-row-driveBack")).toBeInViewport({ timeout: 5000 });
  await page.getByTestId("timeline-play").click();

  // Scrolled back to the top by the person, a running step that changes within 3 s leaves it there.
  await editor(page, `m.setPlayback(0)`);
  await list.hover();
  await page.mouse.wheel(0, -2000);
  await page.getByTestId("timeline-play").click();
  await page.waitForTimeout(1500);
  await expect(page.getByTestId("step-row-driveOut")).toBeInViewport();
  await page.getByTestId("timeline-play").click();
});

test("a step row has one long-hover tooltip, a time, no pencil or box round the name, and a full-width focus ring", async ({ page }) => {
  await page.getByTestId("step-handle-toGarden").hover({ force: true });
  await page.waitForTimeout(1200);
  await expect(tooltips(page)).toHaveCount(0);

  await page.mouse.move(640, 10);
  await page.getByTestId("step-name-toGarden").hover();
  await expect(tooltips(page)).toContainText(/toGarden, a path, about 3\.\d\d s/, { timeout: 3000 });
  await expect(page.getByTestId("step-name-toGarden").locator("svg")).toHaveCount(0);
  expect(await page.getByTestId("step-name-toGarden").evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("0px");

  await expect(page.getByTestId("step-time-toGarden")).toHaveText(/^3\.\d\d s$/);
  await expect(page.getByTestId("step-time-waitForFull")).toHaveText("—");
  // The bars are the timeline's alone.
  await expect(page.getByTestId("timeline-track").locator("button").first()).toBeVisible();

  await page.getByTestId("step-main-toGarden").click();
  await page.keyboard.press("ArrowDown");
  const row = page.getByTestId("step-row-sweepGarden");
  await expect(page.getByTestId("step-main-sweepGarden")).toBeFocused();
  expect(await row.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe("none");
  const rowBox = await row.boundingBox();
  const listBox = await page.getByTestId("steps-list").boundingBox();
  expect(rowBox?.x ?? 99).toBeLessThanOrEqual((listBox?.x ?? 0) + 1);
});

test("the Steps header's + opens the insert menu, and the foot button stays", async ({ page }) => {
  const plus = page.getByTestId("steps-insert");
  await plus.hover();
  await expect(tooltips(page)).toContainText("Insert step");
  await expect(tooltips(page)).toContainText("Enter");
  await plus.click();
  await expect(page.getByTestId("insert-menu")).toBeVisible();
  await plus.click();
  await expect(page.getByTestId("insert-menu")).toHaveCount(0);
  await expect(page.getByTestId("insert-step")).toBeAttached();
});

test("the header's + opens the menu under itself, and a long list stays scrolled where it was", async ({ page }) => {
  // Enough steps that the list scrolls and its foot button is out of view.
  await page.evaluate(`import("/src/state/store.ts").then((m) => { const s = m.getState(); const extra = Array.from({ length: 16 }, (_, i) => ({ id: "pause" + i, kind: "wait", seconds: 0.5 })); m.commit({ ...s.auto, steps: [...s.auto.steps, ...extra] }); })`);
  await expect(page.getByTestId("step-row-pause15")).toBeAttached();
  const list = page.getByTestId("steps-list");
  // The scrolling box the list sits in: the nearest one whose content overflows it.
  const scrolled = (top?: number) =>
    list.evaluate((el, set) => {
      let box: HTMLElement | null = el as HTMLElement;
      while (box !== null && box.scrollHeight <= box.clientHeight) box = box.parentElement;
      if (box !== null && set !== undefined) box.scrollTop = set;
      return box?.scrollTop ?? -1;
    }, top);
  await page.getByTestId("step-main-toGarden").click();
  expect(await scrolled(0)).toBe(0);
  await expect(page.getByTestId("insert-step")).not.toBeInViewport();
  const before = await scrolled();
  const plus = page.getByTestId("steps-insert");
  await plus.click();
  const menu = page.getByTestId("insert-menu");
  await expect(menu).toBeVisible();
  const plusBox = await plus.boundingBox();
  const menuBox = await menu.boundingBox();
  if (plusBox === null || menuBox === null) throw new Error("missing a box");
  // Just under the +, not down at the foot of the list.
  expect(menuBox.y).toBeGreaterThanOrEqual(plusBox.y + plusBox.height - 1);
  expect(menuBox.y).toBeLessThanOrEqual(plusBox.y + plusBox.height + 12);
  expect(await scrolled()).toBe(before);
  await expect(page.getByTestId("insert-step")).not.toBeInViewport();
});

test("at 1024x640 the insert menu stays inside the window and every kind can be reached", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  await openAutoNamed(page, "first-auto.auto.json");
  await page.getByTestId("insert-step").click();
  const menu = page.getByTestId("insert-menu");
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(640);
  expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
  for (const kind of ["path", "turn", "command", "wait", "transfer", "sequence", "parallel", "branch"]) {
    const item = page.getByTestId(`insert-kind-${kind}`);
    await item.scrollIntoViewIfNeeded();
    await expect(item).toBeInViewport();
  }
});

test("one vocabulary: the insert menu, the step menu and the Wait pane", async ({ page }) => {
  await page.getByTestId("insert-step").click();
  const words = { path: "Path", turn: "Turn", command: "Command", wait: "Wait", transfer: "Transfer", sequence: "Sequence", parallel: "Parallel", branch: "Branch" };
  for (const [kind, word] of Object.entries(words)) {
    await expect(page.getByTestId(`insert-kind-${kind}`).locator('[class*="itemLabel"]')).toHaveText(word);
  }
  await page.getByTestId("insert-kind-wait").click();
  await expect(page.getByTestId("insert-wait-summary-hopperFull")).toHaveText(/^The robot holds as much pollen/);
  await page.keyboard.press("Escape");

  await page.getByTestId("step-main-toGarden").click({ button: "right" });
  const menu = page.getByTestId("step-menu");
  await expect(menu.getByTestId("menu-insert.path")).toHaveText(/Insert a path after/);
  await expect(menu.getByTestId("menu-step.insertMenu")).toHaveText(/Insert another step after…/);
});

test("the step menu offers only what applies, and counts what Duplicate and Delete touch", async ({ page }) => {
  const menu = page.getByTestId("step-menu");
  await page.getByTestId("step-main-waitForFull").click({ button: "right" });
  await expect(menu.getByTestId("menu-edit.joinNext")).toHaveCount(0);
  await expect(menu.getByTestId("menu-edit.unwrap")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.getByTestId("step-main-toGarden").click({ button: "right" });
  await expect(menu.getByTestId("menu-edit.joinNext")).toBeVisible();
  await expect(menu.getByTestId("menu-edit.unwrap")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.getByTestId("step-main-returnToScore").click({ button: "right" });
  await expect(menu.getByTestId("menu-edit.joinNext")).toHaveCount(0);
  await expect(menu.getByTestId("menu-edit.unwrap")).toBeVisible();
  await expect(menu.getByTestId("menu-edit.delete")).toHaveText(/Delete group and its 3 steps/);
  await page.keyboard.press("Escape");

  await page.getByTestId("step-main-toGarden").click();
  await page.getByTestId("step-main-sweepGarden").click({ modifiers: ["Control"] });
  await page.getByTestId("step-main-sweepGarden").click({ button: "right" });
  await expect(menu.getByTestId("menu-edit.duplicate")).toHaveText(/Duplicate 2 steps/);
  await expect(menu.getByTestId("menu-edit.delete")).toHaveText(/Delete 2 steps/);
});

test("two selected steps say so in the header, and Wrap says why steps in different lists cannot go together", async ({ page }) => {
  await page.getByTestId("step-main-toGarden").click();
  await page.getByTestId("step-main-driveBack").click({ modifiers: ["Control"] });
  await expect(page.getByTestId("steps-selected-count")).toHaveText("2 steps selected");
  await page.getByTestId("step-main-driveBack").click({ button: "right" });
  const wrap = page.getByTestId("step-menu").getByTestId("menu-edit.wrapSequence");
  await expect(wrap).toHaveAttribute("aria-disabled", "true");
  await wrap.hover();
  await expect(tooltips(page)).toContainText("Pick steps in the same list to wrap them.");
  await expect(tooltips(page)).not.toContainText("sibling");
  await page.keyboard.press("Escape");

  // The palette's Wrap is refused with the same words.
  await editor(page, `import("/src/app/edits.ts").then((e) => e.wrapSelection("sequence"))`);
  await expect(page.getByTestId("status")).toContainText("Pick steps in the same list to wrap them.");
  await expect(page.getByTestId("status")).not.toContainText("sibling");
});

test("after Delete and Ctrl Z the status line says the delete was undone, not that it happened", async ({ page }) => {
  await page.getByTestId("step-main-toGarden").click();
  await page.getByTestId("delete-step").click();
  await expect(page.getByTestId("status")).toContainText("Deleted toGarden.");
  await page.keyboard.press("Control+z");
  await expect(page.getByTestId("step-row-toGarden")).toBeVisible();
  // Undo names what it undid (#514), so the old line never stands on its own.
  expect(await editor<string>(page, `s.status?.message ?? ""`)).toMatch(/^Undid: Deleted toGarden/);
});

test("Delete selects and focuses the next row, so a second Delete deletes again, and a group says what it took", async ({ page }) => {
  await page.getByTestId("step-main-toGarden").click();
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("step-row-toGarden")).toHaveCount(0);
  await expect(page.getByTestId("step-main-sweepGarden")).toBeFocused();
  expect(await editor<string | undefined>(page, `s.selection.stepId`)).toBe("sweepGarden");
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("step-row-sweepGarden")).toHaveCount(0);
  await expect(page.getByTestId("step-main-stopGardenIntake")).toBeFocused();

  await page.getByTestId("step-main-returnToScore").click();
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("status")).toContainText("Deleted returnToScore and its 3 steps.");
  // It was not the last row, so the one after it takes the selection.
  expect(await editor<string | undefined>(page, `s.selection.stepId`)).toBe("scoreGardenPollen");
});

test("an insert says where it went, and a default path brings no error", async ({ page }) => {
  await page.getByTestId("step-main-toGarden").click({ button: "right" });
  await page.getByTestId("step-menu").getByTestId("menu-insert.path").click();
  await expect(page.getByTestId("status")).toContainText(/Added path\d* after toGarden\./);
  const added = await editor<string>(page, "s.selection.stepId");
  const errors = await editor<string[]>(page, `m.currentDerived().findings.filter((f) => f.severity === "error" && f.stepId === "${added}").map((f) => f.code)`);
  expect(errors).toEqual([]);
});

test("Shift-click selects a run of rows, the Inspector says which one it edits, and Wrap names them", async ({ page }) => {
  await page.getByTestId("step-main-driveOut").click();
  await page.getByTestId("step-main-toOtherSide").click({ modifiers: ["Shift"] });
  await expect(page.getByTestId("steps-selected-count")).toHaveText("3 steps selected");
  await expect(page.getByTestId("inspector-multi-steps-line")).toHaveText("3 steps selected. The fields below change toOtherSide only.");

  await page.getByTestId("step-main-toOtherSide").click({ button: "right" });
  await page.getByTestId("step-menu").getByTestId("menu-edit.wrapSequence").click();
  await expect(page.getByTestId("status")).toContainText(/Wrapped driveOut, shootPreloads and toOtherSide in sequence\d*\./);

  await page.getByTestId("step-main-toGarden").click();
  await page.getByTestId("step-main-sweepGarden").click({ modifiers: ["ControlOrMeta"] });
  await page.getByTestId("inspector-multi-steps-only").click();
  await expect(page.getByTestId("inspector-multi-steps")).toHaveCount(0);
  expect(await editor<string[]>(page, "s.multiSteps")).toEqual([]);
});

test("a turn on the spot reads as a turn in the list and the Inspector", async ({ page }) => {
  await page.getByTestId("step-main-toGarden").click();
  await page.getByTestId("insert-step").click();
  await page.getByTestId("insert-kind-turn").click();
  await expect(page.getByTestId("status")).toContainText(/Added turn\d* after toGarden\./);
  const added = await editor<string>(page, "s.selection.stepId");
  await expect(page.getByTestId(`step-kind-${added}`)).toHaveAttribute("data-kind", "turn");
  await expect(page.getByTestId("inspector-kind-icon")).toHaveAttribute("aria-label", "Turn");
  await expect(page.getByTestId("inspector-turn-as-path")).toBeVisible();
});
