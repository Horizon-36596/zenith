/**
 * The keys on a focused step row (issue #161): the arrows, Home and End walk the list, Left and
 * Right fold a group, and R does nothing, instead of nudging or turning the step's end. Enter and
 * Space on the only selected row (or timeline block) are the app's: the insert menu and play. And a
 * held arrow or R is one undo step.
 */
import { expect, test, type Page } from "@playwright/test";
import { skipTour } from "./qa/helpers";

interface Snapshot {
  stepId: string | undefined;
  multiSteps: string[];
  undo: number;
  playing: boolean;
  status: string | null;
  driveOutTo: unknown;
  auto: string;
}

/** What the tests read of the editor: the selection, the history depth, playback and driveOut's end. */
async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(async () => {
    const store = (await import("/src/state/store.ts" as string)) as {
      getState: () => {
        selection: { stepId?: string };
        multiSteps: string[];
        undo: unknown[];
        playing: boolean;
        status: { message: string } | null;
        auto: { steps: Array<{ id: string; segments?: Array<{ to: unknown }> }> } | null;
      };
    };
    const state = store.getState();
    return {
      stepId: state.selection.stepId,
      multiSteps: state.multiSteps,
      undo: state.undo.length,
      playing: state.playing,
      status: state.status?.message ?? null,
      driveOutTo: state.auto?.steps.find((step) => step.id === "driveOut")?.segments?.[0]?.to,
      auto: JSON.stringify(state.auto),
    };
  });
}

const insertOpen = (page: Page): Promise<boolean> =>
  page.evaluate(`import("/src/state/ui.ts").then((u) => u.getUi().insertOpen)`) as Promise<boolean>;

const pause = (page: Page): Promise<unknown> =>
  page.evaluate(`import("/src/state/store.ts").then((m) => m.setPlaying(false))`);

/** The focused element's test id, or its tag name. */
const focused = (page: Page): Promise<string> =>
  page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName ?? "none");

/** Clears the focus, so the keys go to the page the way they do after a click on the canvas. */
const blur = (page: Page): Promise<void> =>
  page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await page.goto("/?cloud=fake");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
});

test("ArrowDown on a focused row selects and focuses the next row and leaves the step's end alone", async ({ page }) => {
  await page.getByTestId("step-main-driveOut").click();
  expect((await snapshot(page)).stepId).toBe("driveOut");
  const before = await snapshot(page);

  await page.keyboard.press("ArrowDown");
  await expect.poll(async () => (await snapshot(page)).stepId).toBe("shootPreloads");
  expect(await focused(page)).toBe("step-main-shootPreloads");
  const after = await snapshot(page);
  expect(after.driveOutTo).toEqual({ ref: "scoreSouth" });
  expect(after.undo).toBe(before.undo);
  expect(after.auto).toBe(before.auto);

  await page.keyboard.press("ArrowUp");
  await expect.poll(async () => (await snapshot(page)).stepId).toBe("driveOut");
  expect(await focused(page)).toBe("step-main-driveOut");
});

test("Home and End go to the first and last row, and the ends of the list stay put", async ({ page }) => {
  await page.getByTestId("step-main-toGarden").click();
  await page.keyboard.press("End");
  await expect.poll(async () => (await snapshot(page)).stepId).toBe("scoreGardenPollen");
  await page.keyboard.press("ArrowDown");
  expect((await snapshot(page)).stepId).toBe("scoreGardenPollen");
  await page.keyboard.press("Home");
  await expect.poll(async () => (await snapshot(page)).stepId).toBe("driveOut");
  await page.keyboard.press("ArrowUp");
  expect((await snapshot(page)).stepId).toBe("driveOut");
  expect((await snapshot(page)).undo).toBe(0);
});

test("Left folds a group and Right unfolds it; rows inside a folded group are skipped", async ({ page }) => {
  await page.getByTestId("step-main-returnToScore").click();
  await expect(page.getByTestId("step-row-driveBack")).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("step-row-returnToScore")).toHaveAttribute("data-folded", "true");
  await expect(page.getByTestId("step-row-driveBack")).toHaveCount(0);
  // The next row down is the one after the group, not one of its hidden steps.
  await page.keyboard.press("ArrowDown");
  await expect.poll(async () => (await snapshot(page)).stepId).toBe("scoreGardenPollen");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("step-row-driveBack")).toBeVisible();
  expect((await snapshot(page)).undo).toBe(0);
});

test("Shift+Down and Shift+Up extend and shrink the multi-selection", async ({ page }) => {
  await page.getByTestId("step-main-driveOut").click();
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await expect.poll(async () => (await snapshot(page)).multiSteps).toEqual(["driveOut", "shootPreloads", "toOtherSide"]);
  expect(await focused(page)).toBe("step-main-toOtherSide");
  await page.keyboard.press("Shift+ArrowUp");
  await expect.poll(async () => (await snapshot(page)).multiSteps).toEqual(["driveOut", "shootPreloads"]);
  await page.keyboard.press("Shift+ArrowUp");
  await expect.poll(async () => (await snapshot(page)).multiSteps).toEqual([]);
  expect((await snapshot(page)).stepId).toBe("driveOut");
});

test("Shift+Down from a focused row that is not selected selects that row and the next", async ({ page }) => {
  await page.evaluate(`import("/src/state/store.ts").then((m) => m.selectStep(undefined))`);
  await page.getByTestId("step-main-driveOut").focus();
  expect((await snapshot(page)).stepId).toBeUndefined();
  await page.keyboard.press("Shift+ArrowDown");
  await expect.poll(async () => (await snapshot(page)).multiSteps).toEqual(["driveOut", "shootPreloads"]);
  expect((await snapshot(page)).stepId).toBe("shootPreloads");
  expect(await focused(page)).toBe("step-main-shootPreloads");
});

test("R and Shift+R on a row change nothing", async ({ page }) => {
  await page.getByTestId("step-main-toOtherSide").click();
  const before = await snapshot(page);
  await page.keyboard.press("r");
  await page.keyboard.press("Shift+R");
  const after = await snapshot(page);
  expect(after.auto).toBe(before.auto);
  expect(after.undo).toBe(0);
  expect(after.stepId).toBe("toOtherSide");
});

test("focus roves: one row is in the Tab order, so Tab leaves the rows", async ({ page }) => {
  await page.getByTestId("step-main-toOtherSide").click();
  const tabbable = await page.locator('[data-testid^="step-main-"]:not([tabindex="-1"])').evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid")));
  expect(tabbable).toEqual(["step-main-toOtherSide"]);
  await page.keyboard.press("Tab");
  expect(await focused(page)).not.toMatch(/^step-main-/);
  await page.keyboard.press("Shift+Tab");
  expect(await focused(page)).toBe("step-main-toOtherSide");
});

test("Enter on the only selected row opens the insert menu; on an unselected row it selects it", async ({ page }) => {
  await page.getByTestId("step-main-driveOut").click();
  await page.keyboard.press("Enter");
  await expect.poll(() => insertOpen(page)).toBe(true);
  await expect(page.getByTestId("insert-menu")).toContainText("After driveOut");
  await page.keyboard.press("Escape");
  await expect.poll(() => insertOpen(page)).toBe(false);

  // A focused row that is not the selected one keeps the button's own Enter, which selects it.
  await page.getByTestId("step-main-shootPreloads").focus();
  expect((await snapshot(page)).stepId).toBe("driveOut");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await snapshot(page)).stepId).toBe("shootPreloads");
  expect(await insertOpen(page)).toBe(false);
});

/** Turns on the switches that show every insert kind: the ledger's transfer, the groups and commands. */
const showEveryKind = (page: Page): Promise<unknown> =>
  page.evaluate(`import("/src/state/features.ts").then((f) => f.setFeatures({ ledger: true, groups: true, commands: true }))`);

/** Opens the insert menu with Enter on the selected driveOut row, and walks to `kind` with the arrows. */
async function openKindByKeys(page: Page, kind: string): Promise<void> {
  await page.getByTestId("step-main-driveOut").click();
  await page.keyboard.press("Enter");
  await expect.poll(() => insertOpen(page)).toBe(true);
  for (let press = 0; press < 12 && (await focused(page)) !== `insert-kind-${kind}`; press += 1) {
    await page.keyboard.press("ArrowDown");
  }
  expect(await focused(page)).toBe(`insert-kind-${kind}`);
}

test("a step inserted from the keyboard takes the focus, for every kind that inserts straight away", async ({ page }) => {
  await showEveryKind(page);
  for (const kind of ["path", "turn", "transfer", "sequence"]) {
    const before = JSON.parse((await snapshot(page)).auto) as { steps: Array<{ id: string }> };
    await openKindByKeys(page, kind);
    await page.keyboard.press("Enter");
    await expect.poll(() => insertOpen(page)).toBe(false);
    const after = await snapshot(page);
    const added = (JSON.parse(after.auto) as { steps: Array<{ id: string }> }).steps.find(
      (step) => !before.steps.some((old) => old.id === step.id),
    );
    expect(added, kind).toBeDefined();
    expect(after.stepId).toBe(added?.id);
    await expect.poll(() => focused(page)).toBe(`step-main-${added?.id ?? ""}`);
  }
});

test("a pane opened with Enter puts the focus on its first field, so a wait can be typed in", async ({ page }) => {
  await showEveryKind(page);
  // Wait: the seconds take the focus with the default selected, and Enter adds the typed time.
  await openKindByKeys(page, "wait");
  await page.keyboard.press("Enter");
  await expect.poll(() => focused(page)).toBe("insert-wait-seconds");
  const before = await snapshot(page);
  await page.keyboard.type("1.5");
  // The keys went to the field, not to the editor's shortcuts.
  expect((await snapshot(page)).auto).toBe(before.auto);
  await page.keyboard.press("Enter");
  await expect.poll(() => insertOpen(page)).toBe(false);
  const after = await snapshot(page);
  const wait = (JSON.parse(after.auto) as { steps: Array<{ id: string; kind: string; seconds?: number }> }).steps.find(
    (step) => step.id === after.stepId,
  );
  expect(wait).toMatchObject({ kind: "wait", seconds: 1.5 });
  await expect.poll(() => focused(page)).toBe(`step-main-${after.stepId ?? ""}`);

  // Command: the search; Parallel: the chosen way to end; Branch: the condition. Escape from each
  // closes the menu and gives the focus back to the row it was opened from.
  const panes: Array<[string, string]> = [
    ["command", "insert-command-search"],
    ["parallel", "radio"],
    ["branch", "insert-branch-condition"],
  ];
  for (const [kind, field] of panes) {
    await openKindByKeys(page, kind);
    await page.keyboard.press("Enter");
    if (field === "radio") {
      await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.type)).toBe("radio");
    } else {
      await expect.poll(() => focused(page)).toBe(field);
    }
    await page.keyboard.press("Escape");
    await expect.poll(() => insertOpen(page)).toBe(false);
    await expect.poll(() => focused(page)).toBe("step-main-driveOut");
  }
});

test("Space plays after a click on a row, the scrubber or Step forward", async ({ page }) => {
  await page.getByTestId("step-main-driveOut").click();
  await page.keyboard.press(" ");
  await expect.poll(async () => (await snapshot(page)).playing).toBe(true);
  await page.keyboard.press(" ");
  await expect.poll(async () => (await snapshot(page)).playing).toBe(false);

  await page.getByTestId("playback").click();
  await pause(page);
  await page.keyboard.press(" ");
  await expect.poll(async () => (await snapshot(page)).playing).toBe(true);
  await pause(page);

  await page.getByRole("button", { name: "Step forward 0.1 s" }).click();
  await page.keyboard.press(" ");
  await expect.poll(async () => (await snapshot(page)).playing).toBe(true);
  await pause(page);
});

test("Space on a slider that is not the scrubber is the slider's, and does not play", async ({ page }) => {
  // The Inspector's and a proposal's sliders are plain range inputs; this one stands in for them.
  await page.evaluate(() => {
    const slider = document.createElement("input");
    slider.type = "range";
    slider.dataset["testid"] = "other-slider";
    document.body.append(slider);
  });
  await page.getByTestId("other-slider").focus();
  await page.keyboard.press(" ");
  await page.waitForTimeout(200);
  expect((await snapshot(page)).playing).toBe(false);

  await page.getByTestId("playback").focus();
  await page.keyboard.press(" ");
  await expect.poll(async () => (await snapshot(page)).playing).toBe(true);
  await pause(page);
});

test("a press on a transport or level button does not take focus", async ({ page }) => {
  await page.getByTestId("step-main-driveOut").click();
  await page.getByRole("button", { name: "Step forward 0.1 s" }).click();
  expect(await focused(page)).toBe("step-main-driveOut");
  await page.getByTestId("playback-level-ideal").click();
  expect(await focused(page)).toBe("step-main-driveOut");
});

test("Enter and Space on a timeline block follow the same rule as a row", async ({ page }) => {
  const block = page.getByTestId("timeline-track").getByRole("button", { name: "driveOut" });
  await block.focus();
  // Not selected yet: Enter is the block's own press, which selects the step and opens nothing.
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await snapshot(page)).stepId).toBe("driveOut");
  expect(await insertOpen(page)).toBe(false);
  // Now it is the only selected step: Enter opens the menu and Space plays.
  await page.keyboard.press("Enter");
  await expect.poll(() => insertOpen(page)).toBe(true);
  await page.keyboard.press("Escape");
  await block.focus();
  await page.keyboard.press(" ");
  await expect.poll(async () => (await snapshot(page)).playing).toBe(true);
  await pause(page);
});

test("a step's end that follows a waypoint is not moved by an arrow from the canvas", async ({ page }) => {
  await page.getByTestId("step-main-driveOut").click();
  await blur(page);
  const before = await snapshot(page);
  await page.keyboard.press("ArrowRight");
  const after = await snapshot(page);
  expect(after.driveOutTo).toEqual({ ref: "scoreSouth" });
  expect(after.undo).toBe(before.undo);
  expect(after.status).toBe("Select the waypoint to move it, or click the end on the field to give it its own pose.");
});

test("a held arrow on a picked end is one undo step, and one Ctrl+Z links it to the waypoint again", async ({ page }) => {
  await page.evaluate(
    `import("/src/state/store.ts").then((m) => m.setSelection({ stepId: "driveOut", point: { segmentIndex: 0, pointKind: "to" } }))`,
  );
  await blur(page);
  const before = await snapshot(page);
  // Playwright sends the second and later down events of a held key as repeats.
  for (let held = 0; held < 12; held += 1) await page.keyboard.down("ArrowRight");
  await page.keyboard.up("ArrowRight");
  const after = await snapshot(page);
  expect(after.driveOutTo).toMatchObject({ xIn: -13 + 12 * 0.5, yIn: -36 });
  expect(after.undo).toBe(before.undo + 1);

  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await snapshot(page)).driveOutTo).toEqual({ ref: "scoreSouth" });
});
