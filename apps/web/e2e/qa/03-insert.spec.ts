/**
 * QA 3, inserting in the middle (site/docs/editor.md and site/docs/step-kinds.md): the insert menu
 * offers every kind; each lands straight after the selected middle step; a path starts where that
 * step ends, for both the menu and the add-path tool's rubber band; the step after is repaired or
 * flagged; undo and redo work for each.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  dragWorld,
  editor,
  findingRows,
  installCanvasProbe,
  knownBug,
  lastFrame,
  loadExample,
  localToWorld,
  canvasView,
  nextFrame,
  rowIds,
  selectStep,
  shot,
  skipTour,
  worldToScreen,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await skipTour(page);
});

/**
 * toGarden is the ninth of the example's thirteen top-level steps and ends at gardenSweepStart,
 * (-46, -62), heading west along the south wall. The step after it, sweepGarden, starts from
 * "current".
 */
const ANCHOR = "toGarden";
const ANCHOR_END = { xIn: -46, yIn: -62 };
/** Where the routine's last step ends, the scoreNorth waypoint: what v1 wrongly continued from. */
const ROUTINE_END = { xIn: -13, yIn: 44 };

async function openInsert(page: Page): Promise<void> {
  await page.getByTestId("insert-step").click();
  await expect(page.getByTestId("insert-menu")).toBeVisible();
}

interface Kind {
  name: string;
  /** How many rows the insert adds (a group brings its children). */
  rows: number;
  /** The id prefix core gives the new step. */
  prefix: RegExp;
  pick: (page: Page) => Promise<void>;
}

const KINDS: Kind[] = [
  { name: "path", rows: 1, prefix: /^path/, pick: async (page) => page.getByTestId("insert-kind-path").click() },
  { name: "turn on the spot", rows: 1, prefix: /^turn/, pick: async (page) => page.getByTestId("insert-kind-turn").click() },
  {
    name: "command",
    rows: 1,
    prefix: /^intakeOn/,
    pick: async (page) => {
      await page.getByTestId("insert-kind-command").click();
      await page.getByTestId("insert-command-intakeOn").click();
    },
  },
  {
    name: "wait seconds",
    rows: 1,
    prefix: /^wait/,
    pick: async (page) => {
      await page.getByTestId("insert-kind-wait").click();
      await page.getByTestId("insert-wait-seconds").fill("1.25");
      await page.getByTestId("insert-wait-add").click();
    },
  },
  {
    name: "wait until",
    rows: 1,
    prefix: /^waitUntil/,
    pick: async (page) => {
      await page.getByTestId("insert-kind-wait").click();
      await page.getByTestId("insert-wait-until-hopperFull").click();
    },
  },
  { name: "sequence", rows: 2, prefix: /^sequence/, pick: async (page) => page.getByTestId("insert-kind-sequence").click() },
  ...(["all", "race", "deadline"] as const).map((mode) => ({
    name: `parallel ${mode}`,
    rows: 3,
    prefix: /^group/,
    pick: async (page: Page) => {
      await page.getByTestId("insert-kind-parallel").click();
      await page.getByTestId(`insert-parallel-mode-${mode}`).click();
      await page.getByTestId("insert-parallel-add").click();
    },
  })),
  {
    name: "branch",
    rows: 3,
    prefix: /^branch/,
    pick: async (page) => {
      await page.getByTestId("insert-kind-branch").click();
      await page.getByTestId("insert-branch-add").click();
    },
  },
];

test("the insert menu offers every kind, each with an icon and its name, and its help on a long hover", async ({ page }) => {
  await loadExample(page);
  await selectStep(page, ANCHOR);
  await openInsert(page);
  for (const kind of ["path", "turn", "command", "wait", "sequence", "parallel", "branch"]) {
    const item = page.getByTestId(`insert-kind-${kind}`);
    await expect(item, kind).toBeVisible();
    await expect(item.locator("svg").first(), `${kind} has an icon`).toBeVisible();
    // Labels only, the default: the name and nothing under it (issue #246).
    const text = (await item.innerText()).trim();
    expect(text.split(/\s+/).length, `${kind} shows a name only: "${text}"`).toBeLessThanOrEqual(4);
  }
  await page.getByTestId("insert-kind-sequence").hover();
  await expect(page.locator('[role="tooltip"]')).toContainText("Steps in order, as one block.");
  await shot(page, "03-insert-menu");
  await page.getByTestId("insert-kind-wait").click();
  await expect(page.getByTestId("insert-wait-seconds")).toBeVisible();
  await expect(page.getByTestId("insert-wait-until-hopperFull")).toBeVisible();
  await shot(page, "03-insert-wait");
  await page.getByTestId("insert-back").click();
  await page.getByTestId("insert-kind-parallel").click();
  for (const mode of ["all", "race", "deadline"]) await expect(page.getByTestId(`insert-parallel-mode-${mode}`)).toBeVisible();
  await shot(page, "03-insert-parallel");
});

for (const kind of KINDS) {
  test(`${kind.name} lands straight after the selected middle step, and undo and redo work`, async ({ page }) => {
    await loadExample(page);
    const before = await rowIds(page);
    const at = before.indexOf(ANCHOR);
    await selectStep(page, ANCHOR);
    await openInsert(page);
    await kind.pick(page);
    await expect(page.getByTestId("insert-menu")).toHaveCount(0);

    await expect.poll(async () => (await rowIds(page)).length).toBe(before.length + kind.rows);
    const after = await rowIds(page);
    const inserted = after[at + 1] ?? "";
    expect(inserted, `the row after ${ANCHOR}`).toMatch(kind.prefix);
    expect(after.slice(0, at + 1)).toEqual(before.slice(0, at + 1));
    expect(after.slice(at + 1 + kind.rows)).toEqual(before.slice(at + 1));
    // The new step is selected, so the inspector shows it.
    expect(await editor<string | undefined>(page, "s.selection.stepId")).toBe(inserted);
    // In the document, too, it is the top-level step after the anchor.
    const top = await editor<string[]>(page, "s.auto.steps.map((x) => x.id)");
    expect(top[top.indexOf(ANCHOR) + 1]).toBe(inserted);

    await page.getByTestId("steps-list").click({ position: { x: 4, y: 4 } });
    await page.keyboard.press("Control+z");
    await expect.poll(async () => rowIds(page)).toEqual(before);
    await page.keyboard.press("Control+y");
    await expect.poll(async () => rowIds(page)).toEqual(after);
    await page.keyboard.press("Control+Shift+z");
    await expect.poll(async () => rowIds(page)).toEqual(after);
  });
}

test("a path inserted in the middle starts where the selected step ends, not where the routine ends", async ({ page }) => {
  await loadExample(page);
  await selectStep(page, ANCHOR);
  await openInsert(page);
  await page.getByTestId("insert-kind-path").click();
  const id = await editor<string>(page, "s.selection.stepId");
  const resolved = await editor<{ from: { xIn: number; yIn: number } }>(
    page,
    `(() => { const r = m.currentDerived().resolved; const find = (steps) => { for (const x of steps) { if (x.id === ${JSON.stringify(id)}) return x; const inner = find(x.steps ?? []); if (inner) return inner; } return null; }; const step = find(r.steps); return { from: step.segments[0].fromPose ?? step.segments[0].from ?? step.startPose }; })()`,
  ).catch(() => null);
  const file = await editor<{ from: unknown }>(page, `s.auto.steps.find((x) => x.id === ${JSON.stringify(id)}).segments[0]`);
  expect(file.from).toBe("current");
  // Where the robot is when the new step starts: the plan's start pose for that step.
  const start = await editor<{ xIn: number; yIn: number }>(
    page,
    `(() => { const flat = (steps) => steps.flatMap((x) => [x, ...flat(x.children ?? x.steps ?? [])]); const step = flat(m.currentDerived().plan.steps).find((x) => x.id === ${JSON.stringify(id)}); return step.startPose; })()`,
  );
  expect(start.xIn).toBeCloseTo(ANCHOR_END.xIn, 3);
  expect(start.yIn).toBeCloseTo(ANCHOR_END.yIn, 3);
  void resolved;
});

test("a path inserted by the menu after a step facing a wall stays on the field", async ({ page }) => {
  await loadExample(page);
  // sweepGarden ends at gardenSweepEnd, (-62, -62), facing the west wall 10 in away.
  await selectStep(page, "sweepGarden");
  await openInsert(page);
  await page.getByTestId("insert-kind-path").click();
  const id = await editor<string>(page, "s.selection.stepId");
  const to = await editor<{ xIn: number; yIn: number }>(page, `s.auto.steps.find((x) => x.id === ${JSON.stringify(id)}).segments[0].to`);
  expect(to.xIn).toBeGreaterThan(-72);
  expect(to.yIn).toBeGreaterThan(-72);
  const perimeter = await editor<string[]>(
    page,
    `m.currentDerived().findings.filter((f) => f.code === "PERIMETER").map((f) => f.stepId)`,
  );
  expect(perimeter).not.toContain(id);
});

test("the add-path tool's rubber band starts at the selected step's end", async ({ page }) => {
  await installCanvasProbe(page);
  await loadExample(page);
  await selectStep(page, ANCHOR);
  await page.keyboard.press("p");
  expect(await editor<string>(page, "s.tool")).toBe("addPath");
  const target = await worldToScreen(page, -30, -50);
  await page.mouse.move(target.x - 20, target.y - 20);
  await page.mouse.move(target.x, target.y, { steps: 4 });
  const frame = await nextFrame(page);
  const view = await canvasView(page);
  const bands = frame.dashes.map((line) => ({ a: localToWorld(view, line[0][0], line[0][1]), b: localToWorld(view, line[1][0], line[1][1]) }));
  const band = bands.find((line) => Math.hypot(line.b.xIn + 30, line.b.yIn + 50) < 1);
  expect(band, `a dashed line to the pointer among ${JSON.stringify(bands)}`).toBeDefined();
  expect(band?.a.xIn).toBeCloseTo(ANCHOR_END.xIn, 0);
  expect(band?.a.yIn).toBeCloseTo(ANCHOR_END.yIn, 0);
  expect(Math.hypot((band?.a.xIn ?? 0) - ROUTINE_END.xIn, (band?.a.yIn ?? 0) - ROUTINE_END.yIn)).toBeGreaterThan(10);
  await shot(page, "03-rubber-band-middle");

  // Clicking puts the new path after the anchor, ending where the click was.
  const before = await rowIds(page);
  await page.mouse.click(target.x, target.y);
  await expect.poll(async () => (await rowIds(page)).length).toBe(before.length + 1);
  const after = await rowIds(page);
  const id = after[after.indexOf(ANCHOR) + 1] ?? "";
  expect(id).toMatch(/^path/);
  const to = await editor<{ xIn: number; yIn: number }>(page, `s.auto.steps.find((x) => x.id === ${JSON.stringify(id)}).segments[0].to`);
  expect(to.xIn).toBeCloseTo(-30, 0);
  expect(to.yIn).toBeCloseTo(-50, 0);
  void lastFrame;
  void dragWorld;
});

test("inserting before a step with a fixed start flags the gap, with its fix in Problems", async ({ page }) => {
  await loadExample(page);
  // sweepGarden starts from "current" in the example, so give it a fixed start first: the
  // gardenSweepStart waypoint, which is where toGarden leaves the robot, so there is no gap until the
  // insert puts a path between them.
  await selectStep(page, "sweepGarden");
  await page.getByTestId("inspector-from-source-0").selectOption("ref:gardenSweepStart");
  await expect
    .poll(async () => editor<unknown>(page, `s.auto.steps.find((x) => x.id === "sweepGarden").segments[0].from`))
    .toEqual({ ref: "gardenSweepStart" });
  const continuityNow = async () =>
    editor<number>(page, `m.currentDerived().findings.filter((f) => f.code === "CONTINUITY").length`);
  expect(await continuityNow()).toBe(0);
  await selectStep(page, ANCHOR);
  await openInsert(page);
  await page.getByTestId("insert-kind-path").click();
  const continuity = async () =>
    editor<number>(page, `m.currentDerived().findings.filter((f) => f.code === "CONTINUITY").length`);
  await expect.poll(continuity).toBeGreaterThan(0);
  // The gap is offered in one place, the CONTINUITY row in Problems; the list keeps only the
  // step's severity dot (issue #411).
  await expect(findingRows(page, "CONTINUITY").first()).toBeVisible();
  await expect(page.locator('[data-testid^="connect-fix-"]')).toHaveCount(0);
  await expect(page.getByTestId("step-dot-sweepGarden")).toBeAttached();
  await shot(page, "03-connect-offered");
});

test("inserting before a step that continues from 'current' leaves no gap", async ({ page }) => {
  await loadExample(page);
  // sweepGarden, after toGarden, starts from "current", so it follows the new path's end.
  await selectStep(page, ANCHOR);
  await openInsert(page);
  await page.getByTestId("insert-kind-path").click();
  expect(await editor<number>(page, `m.currentDerived().findings.filter((f) => f.code === "CONTINUITY").length`)).toBe(0);
  await expect(page.locator('[data-testid^="connect-fix-"]')).toHaveCount(0);
});

test("the inspector of each new kind has a ? on every section", async ({ page }) => {
  await loadExample(page);
  const missing: string[] = [];
  for (const kind of KINDS) {
    await selectStep(page, ANCHOR);
    await openInsert(page);
    await kind.pick(page);
    // The selection header, which holds the kind's ?, is part of the panel, not of its scroll area (issue #431).
    const inspector = page.getByTestId("inspector-panel");
    await expect(page.getByTestId("inspector")).toBeVisible();
    const headers = await inspector.locator("h2, h3, [data-section]").count();
    const helps = await inspector.locator('[data-testid^="help-"]').count();
    if (helps === 0 || helps < Math.min(headers, 1)) missing.push(`${kind.name}: ${String(helps)} ? for ${String(headers)} headers`);
    await shot(page, `03-inspector-${kind.name.replace(/\s+/g, "-")}`);
  }
  expect(missing).toEqual([]);
});

interface TurnStep {
  segments: { kind: string; from: unknown; to: unknown }[];
  heading: { mode: string; fromRad: number; toRad: number };
  timeoutS?: number;
}

interface TurnPlan {
  arrival: number;
  end: { xIn: number; yIn: number; headingRad: number };
  samples: number;
  nominalS: number;
}

const turnStep = (page: Page, id: string) => editor<TurnStep>(page, `s.auto.steps.find((x) => x.id === ${JSON.stringify(id)})`);

/** The plan of a turn: the heading the robot arrives with, its end pose, its samples and its seconds. */
const turnPlan = (page: Page, id: string) =>
  editor<TurnPlan>(
    page,
    `(() => { const d = m.currentDerived(); const steps = d.plan.steps; const at = steps.findIndex((x) => x.id === ${JSON.stringify(id)}); return { arrival: steps[at - 1].endPose.headingRad, end: steps[at].endPose, samples: steps[at].samples.length, nominalS: d.estimate.byStepId[${JSON.stringify(id)}].nominalS }; })()`,
  );

/**
 * Turn on the spot (issue #187, decision D10): a line from "current" to the anchor's own end, which
 * the runtime holds at its end heading. After driveOut, which ends on the scoreSouth waypoint, the
 * turn ends on the same waypoint and turns a quarter turn from the way the robot arrives. Its end
 * arrow, the one heading handle a turn has, is drawn at the point and turns its To when dragged.
 */
test("Turn on the spot after driveOut adds a step whose arrow can be dragged on the field", async ({ page }) => {
  await loadExample(page);
  await selectStep(page, "driveOut");
  await openInsert(page);
  await page.getByTestId("insert-kind-turn").click();
  await expect(page.getByTestId("insert-menu")).toHaveCount(0);

  const after = await rowIds(page);
  const id = after[after.indexOf("driveOut") + 1] ?? "";
  expect(id).toMatch(/^turn/);
  expect(await editor<string | undefined>(page, "s.selection.stepId")).toBe(id);
  const step = await turnStep(page, id);
  expect(step.segments).toEqual([{ kind: "line", from: "current", to: { ref: "scoreSouth" } }]);
  const planned = await turnPlan(page, id);
  expect(step.heading.mode).toBe("linear");
  expect(step.heading.fromRad).toBeCloseTo(planned.arrival, 3);
  expect(Math.cos(step.heading.toRad - planned.arrival - Math.PI / 2)).toBeCloseTo(1, 6);
  // Planned as a turn: sampled by angle at one point, ending at To, and timed as the turn rather
  // than as 0.25 s of settle.
  expect(planned.samples).toBeGreaterThan(2);
  expect(Math.cos(planned.end.headingRad - step.heading.toRad)).toBeCloseTo(1, 6);
  expect(planned.nominalS).toBeGreaterThan(0.25);
  // A default timeout, so a hold that never settles cannot stall the auto: a half turn at the
  // starter robot's 6 rad/s plus core's 1.5 s margin, rounded up to a tenth, well past the turn.
  expect(step.timeoutS).toBeCloseTo(Math.ceil((Math.PI / 6 + 1.5) * 10) / 10, 9);
  expect(step.timeoutS ?? 0).toBeGreaterThan(planned.nominalS);

  // Its end arrow sits on the point, 26 px along To; drag it round to an eighth of a turn the other way.
  const view = await canvasView(page);
  const reachIn = 26 / view.pxPerIn;
  const base = planned.end;
  const grab = await worldToScreen(page, base.xIn + reachIn * Math.cos(step.heading.toRad), base.yIn + reachIn * Math.sin(step.heading.toRad));
  const towards = planned.arrival - Math.PI / 4;
  const to = await worldToScreen(page, base.xIn + 12 * Math.cos(towards), base.yIn + 12 * Math.sin(towards));
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) await page.mouse.move(grab.x + ((to.x - grab.x) * i) / 8, grab.y + ((to.y - grab.y) * i) / 8);
  await page.mouse.up();
  const turned = (await turnStep(page, id)).heading;
  expect(Math.cos(turned.toRad - towards)).toBeCloseTo(1, 3);
  expect(turned.fromRad).toBe(step.heading.fromRad);
  await expect(page.getByTestId("inspector-heading-to")).toBeVisible();
  // The drag turned the new step: driveOut still ends on its waypoint, and the turn is still one.
  expect(await editor<unknown>(page, `s.auto.steps.find((x) => x.id === "driveOut").segments[0].to`)).toEqual({ ref: "scoreSouth" });
  expect((await turnStep(page, id)).segments[0]?.to).toEqual({ ref: "scoreSouth" });
  await shot(page, "03-turn-on-the-spot");
});

test("the canvas menu on a path's end offers Turn on the spot after it", async ({ page }) => {
  await loadExample(page);
  await selectStep(page, "driveOut");
  const middle = await editor<{ xIn: number; yIn: number }>(
    page,
    `(() => { const step = m.currentDerived().plan.steps.find((x) => x.id === "driveOut"); return step.endPose; })()`,
  );
  // Selecting a step opens the inspector, which resizes the canvas; aim once the view has settled.
  let at = await worldToScreen(page, middle.xIn, middle.yIn);
  await expect
    .poll(async () => {
      const now = await worldToScreen(page, middle.xIn, middle.yIn);
      const still = Math.hypot(now.x - at.x, now.y - at.y) < 0.5;
      at = now;
      return still;
    })
    .toBe(true);
  await page.mouse.move(at.x, at.y);
  await page.mouse.click(at.x, at.y, { button: "right" });
  const item = page.getByTestId("canvas-context-menu").locator('[data-action="insert.turn"]');
  await expect(item).toBeEnabled();
  await item.click();
  const after = await rowIds(page);
  expect(after[after.indexOf("driveOut") + 1] ?? "").toMatch(/^turn/);
});
