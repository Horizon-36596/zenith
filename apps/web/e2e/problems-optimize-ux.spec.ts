/**
 * The Problems panel, the Code tab and the Optimize card after the UX pass of issue #413.
 *
 * Problems: an unselected row is one `--row-h` line with the message cut and its full text in the
 * row's tooltip, pointing at a row moves no row, only the selected row has fixes, the fixes say a
 * verb and a noun, there is no "How to fix" line, Route around is not offered where the step's own
 * end is inside the obstacle, the time budget's info note is neither listed nor counted, an auto that
 * opens with a problem gets four rows, and a collapsed panel keeps its tabs and counts. The ghost
 * toggle is an icon and the header never wraps at 1024 px. The Code tab opens to most of the column,
 * starts at buildRoutine() and wraps long comments.
 *
 * Optimize: the card's results come from a stand-in optimizer (`setOptimizeStarter`), so each state
 * is exact and fast: the action row stays in view, the result says each time once with one headline
 * and no codes, What changes starts closed, the problems a route adds are on the Apply line, the
 * safety stop is said once with Search longer, Optimize every path counts its paths, and a clear path
 * names the structure by its label and says why Apply is disabled.
 */
import { expect, test, type Page } from "@playwright/test";
import { editor, findingRows, loadExample, skipTour } from "./qa/helpers";

const STEP = "toOtherSide";
/** No raw finding code or provenance word in the card's text. */
const RAW_CODE = /\b[A-Z]{3,}(_[A-Z]+)+\b|PROVENANCE/;

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
});

/** Commits a change to the open auto through the editor's own store, so the checks run on it. */
const commit = (page: Page, rewrite: string): Promise<unknown> =>
  page.evaluate(`import("/src/state/store.ts").then((m) => { const s = m.getState(); const rewrite = ${rewrite}; m.commit(rewrite(s.auto)); })`);

/** toOtherSide's first two curve controls under the hive (STRUCTURE rows) and sweepGarden too fast (SWEEP_SPEED). */
async function makeProblems(page: Page): Promise<void> {
  await breakSteps(page);
  await expect(findingRows(page, "STRUCTURE").first()).toBeVisible();
  await expect(findingRows(page, "SWEEP_SPEED")).toHaveCount(1);
}

/** The edit of `makeProblems` alone, for a panel that does not show the rows. */
async function breakSteps(page: Page): Promise<void> {
  await commit(
    page,
    `(auto) => ({ ...auto, steps: auto.steps.map((step) => step.id === "${STEP}"
      ? { ...step, segments: [{ ...step.segments[0], control: step.segments[0].control.map((c, i) => (i < 2 ? { ...c, xIn: -9 } : c)) }] }
      : step.id === "sweepGarden" ? { ...step, speedFraction: 0.8 } : step) })`,
  );
}

/** One path along the hive frame's west base bar, from south of it to `endYIn`: through it at 40, ending in it at 0. */
const alongTheBar = (endYIn: number) => ({
  $schema: "https://libraries.horizon36596.org/zenith/schema/v1/auto.json",
  formatVersion: 4,
  name: "along-the-bar",
  alliance: "RED",
  start: { pose: { xIn: -23.65, yIn: -40, headingRad: 1.5708 } },
  steps: [
    {
      id: "pastTheHive",
      kind: "path",
      segments: [{ kind: "line", from: "current", to: { xIn: -23.65, yIn: endYIn, provenance: "SET FROM EDITOR" } }],
      heading: { mode: "constant", headingRad: 1.5708 },
    },
  ],
});

const panelHeight = async (page: Page): Promise<number> => (await page.locator("[data-findings-panel]").boundingBox())?.height ?? 0;

test.describe("the Problems panel", () => {
  test("an unselected row is one line, its tooltip has the whole message, and pointing at rows moves none of them", async ({ page }) => {
    await makeProblems(page);
    // Room for every row, so no hover scrolls the list.
    await editor(page, "m.setPrefs({ findingsH: 420 })");
    await editor(page, "m.setSelection({})");
    const rows = page.getByTestId("finding-row");
    const count = await rows.count();
    expect(count).toBeGreaterThan(1);
    const rowH = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--row-h")));
    const boxes = async () => rows.evaluateAll((all) => all.map((row) => { const r = row.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }));
    const before = await boxes();
    for (const box of before) expect(box[3]).toBe(rowH);
    for (let at = 0; at < count; at += 1) {
      await rows.nth(at).hover();
      expect(await boxes(), `pointing at row ${String(at)}`).toEqual(before);
    }
    // No fixes and no how-to anywhere while nothing is selected.
    await expect(page.getByTestId("finding-fixes")).toHaveCount(0);
    await expect(page.getByTestId("findings-list")).not.toContainText("How to fix");

    // A long message is cut to the line, and the row's tooltip carries all of it.
    const structure = findingRows(page, "STRUCTURE").first();
    const message = structure.getByTestId("finding-message");
    expect(await message.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    const full = (await message.textContent()) ?? "";
    await structure.getByTestId("finding-select").hover();
    await expect(page.getByRole("tooltip")).toContainText(full, { timeout: 5_000 });
  });

  test("only the selected row has fixes, which say a verb and a noun, and the obstacle is named only in the message", async ({ page }) => {
    await makeProblems(page);
    await editor(page, "m.setSelection({})");
    const structure = findingRows(page, "STRUCTURE").first();
    await structure.getByTestId("finding-select").click();
    await expect(structure).toHaveAttribute("data-selected", "true");
    // Every fix line is on a selected row.
    const fixLines = page.getByTestId("finding-fixes");
    expect(await fixLines.count()).toBeGreaterThan(0);
    for (const selected of await fixLines.evaluateAll((all) => all.map((el) => el.closest('[data-testid="finding-row"]')?.getAttribute("data-selected")))) {
      expect(selected).toBe("true");
    }
    await expect(findingRows(page, "SWEEP_SPEED").getByTestId("finding-fixes")).toHaveCount(0);
    await expect(structure.getByTestId("fix-optimizeRoute")).toHaveText("Route around");
    for (const label of await structure.getByTestId("finding-fixes").locator("button").allTextContents()) {
      expect(label.trim().split(/\s+/).length, label).toBeLessThanOrEqual(3);
      expect(label).not.toMatch(/hive|frame|leg|wall|\(/);
    }
    await expect(structure.getByTestId("finding-message")).toContainText("hive frame");
    await expect(structure).not.toContainText("How to fix");
  });

  test("Route around is offered through an obstacle, and not where the step's own end is inside it, which the row says", async ({ page }) => {
    const open = (endYIn: number) =>
      page.evaluate(`import("/src/state/store.ts").then((m) => { m.commit(${JSON.stringify(alongTheBar(endYIn))}); m.selectStep("pastTheHive"); })`);
    await open(40);
    const through = findingRows(page, "STRUCTURE").first();
    await expect(through).toHaveAttribute("data-selected", "true");
    await expect(through.getByTestId("fix-optimizeRoute")).toHaveText("Route around");

    await open(0);
    const inside = findingRows(page, "STRUCTURE");
    await expect(inside.first()).toBeVisible();
    // Core still lists Route around on the finding; the rows leave it off, on every collision of the step.
    expect(
      await editor<boolean>(page, `m.currentDerived().findings.some((f) => f.code === "STRUCTURE" && f.geometry.tRange[1] === 1 && f.fixes.some((x) => x.kind === "optimizeRoute"))`),
    ).toBe(true);
    await expect(page.getByTestId("fix-optimizeRoute")).toHaveCount(0);
    // The row that offers nothing says why, and what to do first (0.1.2 UX sweep W2-7).
    const bar = inside.filter({ hasText: "west base bar" });
    await bar.getByTestId("finding-select").click();
    await expect(bar.getByTestId("finding-nofix")).toHaveText(
      "This path ends inside the west base bar of the hive frame: move its end out first, then Route around can help.",
    );
  });

  test("the time budget's info note is not listed or counted, so the clean starter reads No problems found", async ({ page }) => {
    expect(await editor<number>(page, `m.currentDerived().findings.filter((f) => f.code === "TIME_BUDGET" && f.severity === "info").length`)).toBe(1);
    await expect(findingRows(page, "TIME_BUDGET")).toHaveCount(0);
    await expect(page.getByTestId("findings-count-info")).toHaveText("0 info");
    await expect(page.getByTestId("findings-empty")).toContainText("No problems found.");
  });

  test("an auto that opens with a problem gets room for four rows, unless the person set the height", async ({ page }) => {
    expect(await panelHeight(page)).toBe(180);
    const rowH = 32;
    await page.evaluate(`import("/src/state/store.ts").then((m) => { const a = ${JSON.stringify(alongTheBar(40))}; m.openAuto("along.auto.json", a, JSON.stringify(a)); })`);
    await expect(findingRows(page, "STRUCTURE").first()).toBeVisible();
    await expect.poll(() => panelHeight(page)).toBeGreaterThanOrEqual(rowH * 5);

    // A height the person dragged to stays.
    await editor(page, "m.setPrefs({ findingsH: 150 })");
    await page.evaluate(`import("/src/state/store.ts").then((m) => { const a = ${JSON.stringify(alongTheBar(0))}; m.openAuto("inside.auto.json", a, JSON.stringify(a)); })`);
    await expect(findingRows(page, "STRUCTURE").first()).toBeVisible();
    expect(await panelHeight(page)).toBe(150);
  });

  test("collapsed, the panel keeps its tabs and counts, and a count or a tab opens it again", async ({ page }) => {
    await makeProblems(page);
    await page.getByTestId("findings-collapse").click();
    await expect(page.getByTestId("findings-list")).toHaveCount(0);
    await expect(page.getByTestId("bottom-tab-problems")).toBeVisible();
    await expect(page.getByTestId("bottom-tab-code")).toBeVisible();
    await expect(page.getByTestId("findings-count-error")).toBeVisible();
    await expect(page.getByTestId("findings-count-error")).toHaveText(/^[1-9]\d* errors?$/);
    await page.getByTestId("findings-count-error").click();
    await expect(page.getByTestId("findings-list")).toBeVisible();
    await expect(page.getByTestId("findings-count-error")).toHaveAttribute("aria-pressed", "false");

    await page.getByTestId("findings-collapse").click();
    await expect(page.getByTestId("findings-list")).toHaveCount(0);
    await page.getByTestId("bottom-tab-problems").click();
    await expect(page.getByTestId("findings-list")).toBeVisible();
  });

  test("collapsed on the Code tab, the header still counts the problems, and a count opens Problems", async ({ page }) => {
    await page.getByTestId("bottom-tab-code").click();
    await expect(page.getByTestId("code-view")).toBeVisible();
    await page.getByTestId("findings-collapse").click();
    await expect(page.getByTestId("code-view")).toHaveCount(0);
    await expect(page.getByTestId("code-count-error")).toHaveText("0 errors");
    // A new error shows in the collapsed header without opening anything.
    await breakSteps(page);
    await expect(page.getByTestId("code-count-error")).toHaveText(/^[1-9]\d* errors?$/);
    await expect(page.getByTestId("code-count-warning")).toHaveText(/^[1-9]\d* warnings?$/);
    await expect(page.getByTestId("bottom-tab-code")).toHaveAttribute("aria-selected", "true");
    await page.getByTestId("code-count-error").click();
    await expect(page.getByTestId("bottom-tab-problems")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("findings-list")).toBeVisible();
  });

  test("the ghost toggle is an icon with its tooltip, and nothing in the header wraps at 1024 px", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 640 });
    await makeProblems(page);
    const ghosts = page.getByTestId("findings-clip-ghosts");
    expect(((await ghosts.textContent()) ?? "").trim()).toBe("");
    await expect(ghosts).toHaveAttribute("aria-label", "Show where the robot hits the wall");
    await ghosts.hover();
    await expect(page.getByRole("tooltip")).toContainText("Show where the robot hits the wall");

    const head = page.getByTestId("findings-head");
    await expect(head).toHaveCSS("height", "32px");
    const heights = await head.locator("button").evaluateAll((all) => all.map((el) => el.getBoundingClientRect().height));
    for (const height of heights) expect(height).toBeLessThanOrEqual(32);
    const panel = await page.locator("[data-findings-panel]").boundingBox();
    const toggle = await ghosts.boundingBox();
    if (panel === null || toggle === null) throw new Error("missing a box");
    expect(toggle.x + toggle.width).toBeLessThanOrEqual(panel.x + panel.width);
  });
});

/**
 * The one-click fixes after the 0.1.2 UX sweep: each says what it changed and how to undo it (W2-22),
 * a strafing leg is tinted along its sideways stretch, not filled as a polygon (W2-1), Move to
 * approach lands somewhere clean and labelled (W2-2), and Push end clear keeps the clearance (W2-5).
 */
test.describe("one-click fixes", () => {
  const UNDO = / Press (Ctrl|⌘) Z to undo\.$/;
  const status = (page: Page) => page.getByTestId("status");
  const findingsOn = (page: Page, stepId: string) =>
    editor<string[]>(page, `m.currentDerived().findings.filter((f) => f.stepId === "${stepId}").map((f) => f.code)`);
  /** Replaces the open auto's steps with `steps`, as JSON. */
  const useSteps = (page: Page, steps: unknown[]) => commit(page, `(auto) => ({ ...auto, steps: ${JSON.stringify(steps)} })`);

  test("Point nose along path tints the sideways stretch, then says what it changed and how to undo it", async ({ page }) => {
    await commit(page, `(auto) => ({ ...auto, steps: auto.steps.map((step) => step.id === "driveOut" ? { ...step, heading: { mode: "constant", headingRad: 0 } } : step) })`);
    const strafe = findingRows(page, "STRAFE_FRACTION").filter({ hasText: "driveOut" });
    await expect(strafe).toHaveCount(1);
    // The highlight is a stretch of the path, not the samples filled closed.
    const geometry = await editor<{ polygonIn?: unknown; tRange?: [number, number] }>(
      page,
      `m.currentDerived().findings.find((f) => f.code === "STRAFE_FRACTION" && f.stepId === "driveOut").geometry`,
    );
    expect(geometry.polygonIn).toBeUndefined();
    expect(geometry.tRange?.[1]).toBeGreaterThan(geometry.tRange?.[0] ?? 1);
    await strafe.getByTestId("finding-select").click();
    await strafe.getByTestId("fix-makeTangent").click();
    await expect(status(page)).toContainText("driveOut points its nose along the path now.");
    await expect(status(page).locator("span").first()).toHaveText(UNDO);
    await expect(findingRows(page, "STRAFE_FRACTION")).toHaveCount(0);
  });

  test("Move to approach moves a shot inside the hive frame to a clean legal spot, SET FROM EDITOR, and says so", async ({ page }) => {
    await useSteps(page, [
      { id: "path2", kind: "path", segments: [{ kind: "line", from: "current", to: { xIn: -24, yIn: -10, provenance: "SET BY HAND: e2e fixture" } }], heading: { mode: "tangent" } },
      { id: "shoot", kind: "command", name: "score", args: { count: 4 } },
    ]);
    const legal = findingRows(page, "LEGAL_APPROACH");
    await expect(legal).toHaveCount(1);
    await legal.getByTestId("finding-select").click();
    await legal.getByTestId("fix-moveToLegalApproach").click();
    await expect(status(page)).toContainText("Moved the end of path2 to a legal spot to launch from, turned so the same side faces the target.");
    await expect(findingRows(page, "LEGAL_APPROACH")).toHaveCount(0);
    expect(await findingsOn(page, "path2")).not.toContain("STRUCTURE");
    expect(await editor<string>(page, `s.auto.steps[0].segments[0].to.provenance`)).toBe("SET FROM EDITOR");
  });

  test("Push end clear keeps the robot's clearance and says what it moved", async ({ page }) => {
    // Facing west, the nose stops inside the foot of flower0 on the west wall.
    await useSteps(page, [
      { id: "toFoot", kind: "path", segments: [{ kind: "line", from: "current", to: { xIn: -62, yIn: -24, provenance: "SET BY HAND: e2e fixture" } }], heading: { mode: "constant", headingRad: 3.1416 } },
    ]);
    const structure = findingRows(page, "STRUCTURE");
    await expect(structure).toHaveCount(1);
    await structure.getByTestId("finding-select").click();
    await structure.getByTestId("fix-pushBack").click();
    await expect(status(page)).toContainText("Moved the end of toFoot clear of the foot of flower0 on the west wall (flower0Foot).");
    const left = await findingsOn(page, "toFoot");
    expect(left).not.toContain("STRUCTURE");
    expect(left).not.toContain("CLEARANCE");
  });
});

test.describe("the Code tab", () => {
  test("opens to about 60 % of the column, starts at buildRoutine() and wraps a long comment; Problems puts the height back", async ({ page }) => {
    expect(await panelHeight(page)).toBe(180);
    await page.getByTestId("bottom-tab-code").click();
    const column = (await page.locator("[data-findings-panel]").evaluate((el) => el.parentElement?.clientHeight)) ?? 0;
    await expect.poll(() => panelHeight(page)).toBeGreaterThan(180);
    const height = await panelHeight(page);
    expect(Math.abs(height - Math.min(420, column * 0.6))).toBeLessThanOrEqual(2);

    const view = page.getByTestId("code-view");
    const routine = view.getByTestId("code-line").filter({ hasText: /buildRoutine\(\) \{/ });
    await expect(routine).toBeInViewport();
    expect(await view.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    // The first line is a long comment: it wraps inside the well rather than running off it.
    const first = view.locator('[data-line="1"]');
    await expect(first).toHaveAttribute("data-comment", "true");
    const fits = await first.evaluate((line) => {
      const well = line.closest('[data-testid="code-view"]') as HTMLElement;
      const text = line.lastElementChild as HTMLElement;
      return { lineH: line.getBoundingClientRect().height, right: text.getBoundingClientRect().right, wellRight: well.getBoundingClientRect().right };
    });
    expect(fits.lineH).toBeGreaterThan(18);
    expect(fits.right).toBeLessThanOrEqual(fits.wellRight + 1);

    await page.getByTestId("bottom-tab-problems").click();
    await expect.poll(() => panelHeight(page)).toBe(180);
  });

  test("leaves a height the person set", async ({ page }) => {
    await editor(page, "m.setPrefs({ findingsH: 200 })");
    await page.getByTestId("bottom-tab-code").click();
    await expect(page.getByTestId("code-view")).toBeVisible();
    expect(await panelHeight(page)).toBe(200);
  });
});

/**
 * Puts a stand-in optimizer in the page. `kind` decides what each run reports: a faster route that
 * adds a warning and a note, the same stopped at the safety stop, no faster route, an end inside the
 * hive frame's east bar, a run that never ends, or a first run that fails and no faster route after.
 */
async function fakeOptimizer(page: Page, kind: "adds" | "stopped" | "none" | "inside" | "running" | "failFirst"): Promise<void> {
  await page.evaluate(`(async () => {
    const o = await import("/src/optimize/state.ts");
    const find = (steps, id) => {
      for (const step of steps) {
        if (step.id === id) return step;
        for (const value of Object.values(step)) if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object" && value[0] !== null && "kind" in value[0] && "id" in value[0]) { const hit = find(value, id); if (hit) return hit; }
      }
      return null;
    };
    const times = (b, a) => ({ before: { windowEndS: b, ownS: b }, after: { windowEndS: a, ownS: a } });
    let runs = 0;
    o.setOptimizeStarter((request, options, events) => {
      runs += 1;
      const id = request.stepId;
      const step = find(request.auto.steps, id);
      const base = { stepId: id, mode: options.mode, alternatives: [], scorer: "sim", scorerReason: null, marginIn: options.marginIn, movedMarkers: [], findingsRemoved: [], evaluations: 10, budget: 100, inputKey: "fake", originalBlocked: null };
      const added = [
        { code: "STRAFE_FRACTION", severity: "warning", stepId: id, message: "This path is driven sideways." },
        { code: "PROVENANCE", severity: "info", stepId: id, message: "One pose carries no provenance." },
      ];
      const changes = [
        "It is 0.70 s faster in the instant sim.",
        "The step takes 3.42 s instead of 4.11 s in the instant sim.",
        "The estimate has the step at 3.75 s instead of 3.98 s.",
        "The heading is now Linear, where it was Tangent.",
        'It adds a STRAFE_FRACTION warning on step "' + id + '".',
        'It adds a PROVENANCE info on step "' + id + '".',
      ];
      const route = { step, label: null, t0: times(3.98, 3.75), t1: times(4.11, 3.42), gainS: 0.7, closest: { kind: "structure", id: "frameBarWest", clearanceIn: 2.48 }, movedMarkers: [], findingsAdded: added, findingsRemoved: [], changes, note: null };
      const notes = ["This path ends on a condition. It is scored as if the condition never fires, so it may end early."];
      const picked = { ...base, status: "improved", step, pick: route, findingsAdded: added, changes, notes, closest: null };
      const result =
        ${JSON.stringify(kind)} === "none" || ${JSON.stringify(kind)} === "failFirst"
          ? { ...base, status: "noBetter", step: null, pick: null, findingsAdded: [], changes: ["No faster route was found."], notes, closest: null }
          : ${JSON.stringify(kind)} === "inside"
            ? { ...base, status: "infeasible", step: null, pick: null, findingsAdded: [], changes: ['The step\\'s own end overlaps the structure "frameBarEast".'], notes, closest: { step: null, pose: { xIn: 20, yIn: 0, headingRad: 0 }, kind: "structure", id: "frameBarEast", shortfallIn: 2 } }
            : ${JSON.stringify(kind)} === "stopped"
              ? { ...picked, status: "stoppedEarly", notes: [...notes, "The search stopped before it finished; this is the fastest route found so far."] }
              : picked;
      if (${JSON.stringify(kind)} === "running") setTimeout(() => events.progress({ evaluations: 5, budget: 100, bestJ: 3.4, phase: "search" }), 0);
      else if (${JSON.stringify(kind)} === "failFirst" && runs === 1) setTimeout(() => events.failed("The optimizer stopped answering, so it was ended. Run it again."), 0);
      else setTimeout(() => (${JSON.stringify(kind)} === "stopped" ? events.stopped(result, "safety") : events.done(result)), 0);
      return { engine: "slices", state: "running", stop: () => undefined, continue: () => undefined, cancel: () => undefined };
    });
  })()`);
}

const openOptimize = (page: Page, stepId = STEP): Promise<unknown> =>
  page.evaluate(`import("/src/optimize/state.ts").then((o) => o.openOptimize({ stepId: ${JSON.stringify(stepId)} }))`);

/** True when `inner` lies inside `outer`, give or take a pixel. */
const inside = (inner: { x: number; y: number; width: number; height: number }, outer: { x: number; y: number; width: number; height: number }): boolean =>
  inner.x >= outer.x - 1 && inner.y >= outer.y - 1 && inner.x + inner.width <= outer.x + outer.width + 1 && inner.y + inner.height <= outer.y + outer.height + 1;

test.describe("the Optimize card", () => {
  for (const size of [{ width: 1280, height: 720 }, { width: 1024, height: 640 }]) {
    test(`keeps the action row inside the card and the window at ${String(size.width)}x${String(size.height)}, and takes at most 70 % of the column`, async ({ page }) => {
      await page.setViewportSize(size);
      await fakeOptimizer(page, "adds");
      await openOptimize(page);
      const card = page.getByTestId("optimize-card");
      await expect(card).toHaveAttribute("data-phase", "result");
      const actions = await page.getByTestId("optimize-actions").boundingBox();
      const cardBox = await card.boundingBox();
      if (actions === null || cardBox === null) throw new Error("missing a box");
      expect(inside(actions, cardBox)).toBe(true);
      expect(inside(actions, { x: 0, y: 0, ...size })).toBe(true);
      await expect(page.getByTestId("optimize-apply")).toBeInViewport();
      const column = (await card.evaluate((el) => el.parentElement?.clientHeight)) ?? 0;
      expect(cardBox.height).toBeLessThanOrEqual(column * 0.7 + 1);
      expect(await card.evaluate((el) => getComputedStyle(el).maxHeight)).toBe("70%");
    });
  }

  test("says each thing once: one headline, each time once, no codes, What changes closed, and what it adds on the Apply line", async ({ page }) => {
    await fakeOptimizer(page, "adds");
    await openOptimize(page);
    const card = page.getByTestId("optimize-card");
    await expect(card).toHaveAttribute("data-phase", "result");
    await expect(page.getByTestId("optimize-status")).toHaveText("0.70 s faster in the instant sim");
    const text = (await card.textContent()) ?? "";
    for (const time of ["4.11 s", "3.42 s", "3.98 s", "3.75 s"]) expect(text.split(time).length - 1, time).toBe(1);
    expect(text).not.toMatch(RAW_CODE);
    expect(text).not.toContain("frameBarWest");
    await expect(page.getByTestId("optimize-details")).not.toHaveAttribute("open", /.*/);
    await expect(page.getByTestId("optimize-changes")).toBeHidden();

    // What it adds: on the Apply line in the warning colour, and listed in plain sentences, open.
    const adds = page.getByTestId("optimize-adds");
    await expect(adds).toHaveText("Adds 1 warning and 1 note");
    const colour = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--sev-warn)";
      document.body.append(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    });
    expect(await adds.evaluate((el) => getComputedStyle(el).color)).toBe(colour);
    await expect(page.getByTestId("optimize-added")).toHaveAttribute("open", "");
    await expect(page.getByTestId("optimize-added-item").first()).toHaveText("A warning: driving sideways.");
    await expect(page.getByTestId("optimize-added-item").first()).toBeVisible();
  });

  test("Enter on the What changes summary opens it and applies nothing", async ({ page }) => {
    await fakeOptimizer(page, "adds");
    await openOptimize(page);
    const card = page.getByTestId("optimize-card");
    await expect(card).toHaveAttribute("data-phase", "result");
    const before = await editor<string>(page, "JSON.stringify(m.getState().auto)");
    const summary = card.locator("summary", { hasText: "What changes" });
    const details = summary.locator("xpath=..");
    await expect(details).not.toHaveAttribute("open", /.*/);
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(details).toHaveAttribute("open", "");
    await expect(page.getByTestId("optimize-changes")).toBeVisible();
    // The card is still showing its result, and the auto is as it was.
    await expect(card).toHaveAttribute("data-phase", "result");
    expect(await editor<string>(page, "JSON.stringify(m.getState().auto)")).toBe(before);
    await page.keyboard.press("Enter");
    await expect(details).not.toHaveAttribute("open", /.*/);
    await expect(card).toHaveAttribute("data-phase", "result");
  });

  test("a run the safety stop ended says it searched for 5 s, once, with Search longer, never that it stopped early", async ({ page }) => {
    await fakeOptimizer(page, "stopped");
    await openOptimize(page);
    await expect(page.getByTestId("optimize-card")).toHaveAttribute("data-phase", "result");
    await expect(page.getByTestId("optimize-stopped")).toHaveText("Searched for 5 s: the best route so far.");
    await expect(page.getByTestId("optimize-status")).toHaveAttribute("data-tone", "ok");
    await expect(page.getByTestId("optimize-continue")).toHaveText("Search longer");
    const text = (await page.getByTestId("optimize-card").textContent()) ?? "";
    expect(text.match(/searched for 5 s/gi)?.length).toBe(1);
    expect(text).not.toMatch(/stopped early/i);
  });

  test("folds the options away once a run starts, so the result has the room, and they open again on a click (0.1.2 UX review)", async ({ page }) => {
    await fakeOptimizer(page, "adds");
    await page.evaluate(`import("/src/optimize/state.ts").then((o) => o.openOptimize({ stepId: ${JSON.stringify(STEP)}, withOptions: true }))`);
    const options = page.getByTestId("optimize-options");
    await expect(options).toHaveAttribute("open", "");
    await expect(page.getByTestId("optimize-margin")).toBeVisible();
    await page.getByTestId("optimize-run").click();
    await expect(page.getByTestId("optimize-card")).toHaveAttribute("data-phase", "result");
    await expect(options).not.toHaveAttribute("open", /.*/);
    await expect(page.getByTestId("optimize-margin")).toBeHidden();
    await expect(options.locator("summary")).toHaveText(/^Options: \d+\.\d\d in margin, instant sim$/);
    await expect(page.getByTestId("optimize-status")).toBeInViewport();
    await expect(page.getByTestId("optimize-added-item").first()).toBeInViewport();
    await options.locator("summary").click();
    await expect(page.getByTestId("optimize-margin")).toBeVisible();
  });

  test("draws success, nothing found and blocked in three tones (0.1.2 UX review)", async ({ page }) => {
    await fakeOptimizer(page, "adds");
    await openOptimize(page);
    await expect(page.getByTestId("optimize-status")).toHaveAttribute("data-tone", "ok");
    await page.getByTestId("optimize-discard").click();
    await fakeOptimizer(page, "none");
    await openOptimize(page);
    await expect(page.getByTestId("optimize-status")).toHaveAttribute("data-tone", "neutral");
    await expect(page.getByTestId("optimize-status")).toHaveText("No faster route was found.");
    await page.getByTestId("optimize-discard").click();
    await fakeOptimizer(page, "inside");
    await openOptimize(page);
    await expect(page.getByTestId("optimize-status")).toHaveAttribute("data-tone", "blocked");
    await expect(page.getByTestId("optimize-status")).toContainText("An end of this path is inside");
  });

  test("while it runs it says how long it may take, with a bar", async ({ page }) => {
    await fakeOptimizer(page, "running");
    await openOptimize(page);
    await expect(page.getByTestId("optimize-progress")).toContainText("Searching, up to 5 s");
    await expect(page.getByTestId("optimize-progress-bar")).toHaveAttribute("role", "progressbar");
    await expect(page.getByTestId("optimize-actions")).toBeInViewport();
  });

  test("Optimize every path counts its paths, and a path with no faster route says so", async ({ page }) => {
    await fakeOptimizer(page, "none");
    await page.evaluate(`import("/src/optimize/state.ts").then((o) => o.openOptimizeAll())`);
    const card = page.getByTestId("optimize-card");
    await expect(card).toHaveAttribute("data-phase", "result");
    const paths = await editor<number>(page, `(function count(steps) { return steps.reduce((n, s) => n + (s.kind === "path" ? 1 : 0) + count(s.steps ?? s.children ?? []), 0); })(s.auto.steps)`);
    await expect(page.getByTestId("optimize-step")).toHaveText(`${String(paths)} paths`);
    await expect(page.getByTestId("optimize-all-results")).toContainText(`${STEP}: No faster route found`);
  });

  test("Optimize every path counts a failed path apart, and its Try again searches it alone (0.1.2 UX review)", async ({ page }) => {
    await fakeOptimizer(page, "failFirst");
    await page.evaluate(`import("/src/optimize/state.ts").then((o) => o.openOptimizeAll())`);
    const card = page.getByTestId("optimize-card");
    await expect(card).toHaveAttribute("data-phase", "result");
    const first = await editor<string>(page, `(function first(steps) { for (const s of steps) { if (s.kind === "path") return s.id; const inner = first(s.steps ?? s.children ?? []); if (inner) return inner; } return ""; })(s.auto.steps)`);
    const total = page.getByTestId("optimize-all-total");
    await expect(total).toContainText(/^\d+ of \d+ paths searched, 1 failed\./);
    const retry = page.getByTestId(`optimize-all-retry-${first}`);
    await expect(retry).toBeVisible();
    await retry.click();
    await expect(card).toHaveAttribute("data-phase", "result");
    await expect(page.getByTestId("optimize-all-results")).toContainText(`${first}: No faster route found`);
    await expect(total).not.toContainText("failed");
    await expect(retry).toHaveCount(0);
  });

  test("a clear path into the hive frame is refused at once, before any search, naming the bar by its label (0.1.2 UX review)", async ({ page }) => {
    await fakeOptimizer(page, "running");
    const opened = await page.evaluate(`import("/src/optimize/state.ts").then((o) => o.openClearPath({ xIn: -23.65, yIn: 0 }))`);
    expect(opened).toBe(false);
    await expect(page.getByTestId("optimize-card")).toHaveCount(0);
    const message = await editor<string>(page, "s.status?.message ?? ''");
    expect(message).toMatch(/^That spot is inside the .*hive frame.*\. Right-click somewhere clear of it\.$/);
    expect(message).not.toContain("frameBarWest");
  });
});
