/**
 * Issue #144: three inspector fields that could make an auto invalid or lose a setting.
 *
 * - A parallel group switched to deadline named no deadline, so the auto went invalid, and the
 *   Deadline choice offered a "—" that failed with a raw schema message. Now the switch picks the
 *   group's first step that drives, a switch away removes the deadline, and the Deadline choice has
 *   no empty option; it shows a disabled "Pick a step" only when the file names no step of the group.
 *   Dragging the deadline step out of the group clears that choice, and the group picks again the
 *   same way, so it never stays a deadline group with no deadline.
 * - A wait showed Seconds and Until at once, and typing seconds silently dropped the condition. Now
 *   one Wait for choice shows only the field it waits for, and every switch says how to undo it.
 *   Ctrl Z does what it says straight after the pick, with the choice still focused.
 * - An empty Speed hid the robot's default, a set fraction could not go back to it, and the
 *   arrow keys did nothing on an empty Speed or Timeout.
 */
import { expect, test, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";
import { openMore } from "./qa/helpers";

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

/** "Load example" opens the starter's `collect-and-score.auto.json`. */
async function loadExample(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
}

/** A value from the editor's store, through the dev server's module graph. */
async function editor<T>(page: Page, expr: string): Promise<T> {
  return (await page.evaluate(
    `import("/src/state/store.ts").then((m) => { const s = m.getState(); const d = m.currentDerived(); return (${expr}); })`,
  )) as T;
}

/** A step as the file has it, found by id anywhere in the tree. */
const stepOf = (page: Page, id: string) =>
  editor<Record<string, unknown>>(
    page,
    `(() => { const find = (steps) => { for (const x of steps) { if (x.id === ${JSON.stringify(id)}) return x; const inner = find([...(x.steps ?? []), ...(x.then ?? []), ...(x.else ?? [])]); if (inner !== undefined) return inner; } return undefined; }; return find(s.auto.steps); })()`,
  );

/** Every SCHEMA finding, one line each. */
const schemaFindings = (page: Page) =>
  editor<string[]>(page, "d.findings.filter((f) => f.code === 'SCHEMA').map((f) => `${f.stepId}: ${f.message}`)");

test("a parallel group switched to deadline names the step that drives and stays valid", async ({ page }) => {
  await loadExample(page);
  expect(await schemaFindings(page)).toEqual([]);

  await page.getByTestId("step-main-stopIntake").click();
  await page.getByTestId("step-main-toScoreNorth").click({ modifiers: ["Shift"] });
  await page.getByTestId("step-row-toScoreNorth").click({ button: "right" });
  await page.getByTestId("step-menu").getByTestId("menu-edit.wrapParallel").click();
  await expect(page.getByTestId("inspector-kind-icon")).toHaveAttribute("aria-label", "Parallel group");
  const groupId = await editor<string>(page, "s.selection.stepId");

  await page.getByTestId("inspector-parallel-mode").selectOption("deadline");
  await expect.poll(async () => (await stepOf(page, groupId))["mode"]).toBe("deadline");
  // stopIntake is a command; toScoreNorth is the member that drives, as Wrap in a deadline group picks.
  expect((await stepOf(page, groupId))["deadline"]).toBe("toScoreNorth");
  expect(await schemaFindings(page)).toEqual([]);

  const deadline = page.getByTestId("inspector-parallel-deadline");
  await expect(deadline).toHaveValue("toScoreNorth");
  await expect(deadline.locator("option")).toHaveText(["stopIntake", "toScoreNorth"]);

  // Back to all: the deadline goes with the mode, rather than staying in the file.
  await page.getByTestId("inspector-parallel-mode").selectOption("all");
  await expect.poll(async () => (await stepOf(page, groupId))["mode"]).toBe("all");
  expect("deadline" in (await stepOf(page, groupId))).toBe(false);
  await expect(page.getByTestId("inspector-parallel-deadline")).toHaveCount(0);
  expect(await schemaFindings(page)).toEqual([]);
});

test("a group switched to deadline stays valid when its deadline step is dragged out of it", async ({ page }) => {
  await loadExample(page);
  await page.getByTestId("step-main-stopIntake").click();
  await page.getByTestId("step-main-toScoreNorth").click({ modifiers: ["Shift"] });
  await page.getByTestId("step-row-toScoreNorth").click({ button: "right" });
  await page.getByTestId("step-menu").getByTestId("menu-edit.wrapParallel").click();
  await expect(page.getByTestId("inspector-kind-icon")).toHaveAttribute("aria-label", "Parallel group");
  const groupId = await editor<string>(page, "s.selection.stepId");
  await page.getByTestId("inspector-parallel-mode").selectOption("deadline");
  await expect.poll(async () => (await stepOf(page, groupId))["deadline"]).toBe("toScoreNorth");

  // The lower part of a step row drops after it, at the top level, outside the new group.
  const target = page.getByTestId("step-row-scoreFlowerPollen");
  const box = await target.boundingBox();
  if (box === null) throw new Error("the scoreFlowerPollen row has no box");
  await page.getByTestId("step-handle-toScoreNorth").dragTo(target, {
    targetPosition: { x: box.width / 2, y: box.height * 0.8 },
  });

  await expect.poll(async () => editor<number>(page, `s.auto.steps.findIndex((x) => x.id === "toScoreNorth")`)).toBeGreaterThan(0);
  // The choice is cleared, and the group picks again the same way: stopIntake is the only step left.
  const group = await stepOf(page, groupId);
  expect(group["mode"]).toBe("deadline");
  expect(group["deadline"]).toBe("stopIntake");
  expect(await schemaFindings(page)).toEqual([]);
  await expect(page.getByTestId("status")).toContainText(
    `toScoreNorth was the deadline of ${groupId}, so stopIntake is its deadline now. Pick another in the Inspector, or press Ctrl Z to undo.`,
  );

  await page.getByTestId("step-main-" + groupId).click();
  const deadline = page.getByTestId("inspector-parallel-deadline");
  await expect(deadline).toHaveValue("stopIntake");
  await expect(deadline.locator("option", { hasText: "Pick a step" })).toHaveCount(0);
});

test("a deadline that names no step of its group shows a disabled Pick a step until one is picked", async ({ page }) => {
  await loadExample(page);
  // A file whose deadline names a step outside the group, as a hand edit can leave it.
  await page.evaluate(
    `import("/src/state/store.ts").then((m) => { const s = m.getState(); m.commit({ ...s.auto, steps: s.auto.steps.map((x) => x.id === "returnToScore" ? { ...x, deadline: "nowhere" } : x) }); })`,
  );
  await page.getByTestId("step-main-returnToScore").click();
  const deadline = page.getByTestId("inspector-parallel-deadline");
  await expect(deadline).toHaveValue("");
  const placeholder = deadline.locator("option", { hasText: "Pick a step" });
  await expect(placeholder).toHaveCount(1);
  await expect(placeholder).toBeDisabled();
  expect(await schemaFindings(page)).toHaveLength(1);

  await deadline.selectOption("driveBack");
  await expect.poll(async () => (await stepOf(page, "returnToScore"))["deadline"]).toBe("driveBack");
  await expect(deadline.locator("option", { hasText: "Pick a step" })).toHaveCount(0);
  expect(await schemaFindings(page)).toEqual([]);
});

test("a wait shows only what it waits for, and a switch says how to undo it", async ({ page }) => {
  await loadExample(page);
  await page.getByTestId("step-main-waitForFull").click();

  const waitFor = page.getByTestId("inspector-wait-for");
  await expect(waitFor).toHaveValue("condition");
  await expect(page.getByTestId("inspector-wait-seconds")).toHaveCount(0);
  await expect(page.getByTestId("inspector-wait-until")).toHaveValue("hopperFull");
  // The condition form says what caps the wait in its own Give up after row, the step's one second
  // timeout (issue #409). Without a Timeout Until has a warning chip instead (issue #242).
  await expect(page.getByTestId("inspector-wait-cap")).toHaveCount(0);
  await expect(page.getByTestId("inspector-timeout")).toHaveValue("1.00");
  await expect(page.getByTestId("inspector-wait-no-timeout")).toHaveCount(0);

  // A time starts from the timeout, so the wait lasts as long as it could have before. The switch
  // is made as a keyboard user makes it: ArrowUp on the focused choice picks A time, and the focus
  // stays on the choice.
  await waitFor.press("ArrowUp");
  await expect.poll(async () => (await stepOf(page, "waitForFull"))["seconds"]).toBe(1);
  expect("until" in (await stepOf(page, "waitForFull"))).toBe(false);
  await expect(page.getByTestId("inspector-wait-seconds")).toHaveValue("1.00");
  await expect(page.getByTestId("inspector-wait-until")).toHaveCount(0);
  await expect(page.getByTestId("status")).toContainText("hopperFull");
  await expect(page.getByTestId("status")).toContainText("Ctrl Z");

  // Ctrl Z straight away, as the status line says, with the choice still focused. A select has no
  // undo of its own, so the routine's undo runs and the condition comes back.
  await expect(waitFor).toBeFocused();
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await stepOf(page, "waitForFull"))["until"]).toBe("hopperFull");
  expect("seconds" in (await stepOf(page, "waitForFull"))).toBe(false);
  await expect(waitFor).toHaveValue("condition");

  // Ctrl Y from the same focused choice makes the switch again.
  await expect(waitFor).toBeFocused();
  await page.keyboard.press("Control+y");
  await expect.poll(async () => (await stepOf(page, "waitForFull"))["seconds"]).toBe(1);
  expect("until" in (await stepOf(page, "waitForFull"))).toBe(false);
  await expect(waitFor).toHaveValue("time");

  // From a time, A condition starts with the first condition robot.json declares, and Ctrl Z from
  // the focused choice puts the time back.
  await waitFor.press("ArrowDown");
  await expect.poll(async () => (await stepOf(page, "waitForFull"))["until"]).toBe("holdingPiece");
  expect("seconds" in (await stepOf(page, "waitForFull"))).toBe(false);
  await expect(page.getByTestId("status")).toContainText("Ctrl Z");
  await expect(waitFor).toBeFocused();
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await stepOf(page, "waitForFull"))["seconds"]).toBe(1);
  expect("until" in (await stepOf(page, "waitForFull"))).toBe(false);
  await expect(waitFor).toHaveValue("time");
});

test("the speed fraction shows the robot's default, goes back to it, and the arrows start an empty field", async ({ page }) => {
  await loadExample(page);
  await page.getByTestId("step-main-driveOut").click();

  // driveOut sets no speed of its own, so it drives at robot.json's 0.80, and the field says so.
  const speed = page.getByTestId("inspector-speed");
  await expect(speed).toHaveValue("");
  await expect(speed).toHaveAttribute("placeholder", "80");
  await expect(page.getByTestId("inspector-speed-default")).toHaveCount(0);

  // An empty Timeout steps up from nothing to 0.1 s. It sits in More, closed by default (issue #239).
  await openMore(page);
  const timeout = page.getByTestId("inspector-timeout");
  await expect(timeout).toHaveValue("");
  await timeout.click();
  await timeout.press("ArrowUp");
  await expect.poll(async () => (await stepOf(page, "driveOut"))["timeoutS"]).toBeCloseTo(0.1, 9);
  await expect(timeout).toHaveValue("0.10");

  // collectFlower sets 30%; the reset button takes the key out, so it follows the robot again.
  await page.getByTestId("step-main-collectFlower").click();
  await expect(speed).toHaveValue("30");
  await page.getByTestId("inspector-speed-default").click();
  await expect.poll(async () => "speedFraction" in (await stepOf(page, "collectFlower"))).toBe(false);
  await expect(speed).toHaveValue("");
  await expect(speed).toHaveAttribute("placeholder", "80");
  await expect(page.getByTestId("inspector-speed-default")).toHaveCount(0);

  // And the arrows on the empty field step from the default it shows.
  await speed.click();
  await speed.press("ArrowUp");
  await expect.poll(async () => (await stepOf(page, "collectFlower"))["speedFraction"]).toBeCloseTo(0.85, 6);
});

/** Issue #192: a path speed only reaches the robot through atSpeed, and the field says so. */
test("the speed fraction's tooltip says the robot applies it only if its ZenithRobot implements atSpeed", async ({ page }) => {
  await loadExample(page);
  await page.getByTestId("step-main-driveOut").click();
  await page.getByTestId("inspector-speed").hover();
  await expect(page.getByRole("tooltip")).toContainText("atSpeed");
});

/** Presses the left button on the middle of a field, and returns how to move the pointer across it. */
async function pressOn(page: Page, testId: string): Promise<(dx: number) => Promise<void>> {
  // The Timeout sits in More, at the end of the Inspector (issue #239), so it may need scrolling to.
  await page.getByTestId(testId).scrollIntoViewIfNeeded();
  const box = await page.getByTestId(testId).boundingBox();
  if (box === null) throw new Error(`${testId} is not on screen`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  return (dx) => page.mouse.move(x + dx, y, { steps: 4 });
}

test("ArrowDown or a drag to the left leaves an empty Timeout empty, and an empty Speed still steps down", async ({ page }) => {
  await loadExample(page);
  const timeout = page.getByTestId("inspector-timeout");

  // A path, a command and a wait with no timeout. The Timeout's floor is 0.01 s, and ArrowDown used
  // to write it, which cut driveOut's 1.59 s drive short after 10 ms.
  for (const id of ["driveOut", "shootPreloads", "clearGarden"]) {
    await page.getByTestId(`step-main-${id}`).click();
    await openMore(page);
    await expect(timeout).toHaveValue("");
    await timeout.click();
    await timeout.press("ArrowDown");
    await timeout.press("Shift+ArrowDown");
    // Only a field without focus scrubs; one with focus selects its text (issue #145).
    await timeout.blur();
    const move = await pressOn(page, "inspector-timeout");
    await move(-20);
    await page.mouse.up();
    await expect(timeout).toHaveValue("");
    await expect(timeout).toHaveAttribute("placeholder", "Never");
    expect("timeoutS" in (await stepOf(page, id))).toBe(false);
  }

  // A drag that goes right and then back past where it began leaves the field empty again.
  await page.getByTestId("step-main-driveOut").click();
  const move = await pressOn(page, "inspector-timeout");
  // 8 px past the 3 px dead zone is two steps of 0.1 s, at 4 px a step (issue #145).
  await move(11);
  await expect.poll(async () => (await stepOf(page, "driveOut"))["timeoutS"]).toBeCloseTo(0.2, 9);
  await move(-8);
  // Emptied in memory as typing it empty does: the key is undefined, and canonical form drops it.
  await expect.poll(async () => (await stepOf(page, "driveOut"))["timeoutS"]).toBeUndefined();
  await page.mouse.up();
  await expect(timeout).toHaveValue("");

  // An empty Speed starts from robot.json's 0.80, a value it can hold, so ArrowDown gives 0.75.
  const speed = page.getByTestId("inspector-speed");
  await expect(speed).toHaveValue("");
  await speed.click();
  await speed.press("ArrowDown");
  await expect.poll(async () => (await stepOf(page, "driveOut"))["speedFraction"]).toBeCloseTo(0.75, 6);
  await expect(speed).toHaveValue("75");
});
