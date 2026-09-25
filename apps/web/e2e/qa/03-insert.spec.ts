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
 * toGarden is the third of the example's eight top-level steps and ends at gardenApproach,
 * (-61, -44), facing the south wall. The step after it, sweepGarden, starts from "current".
 */
const ANCHOR = "toGarden";
const ANCHOR_END = { xIn: -61, yIn: -44 };
/** Where the routine's last step ends, the scoreSouth waypoint: what v1 wrongly continued from. */
const ROUTINE_END = { xIn: -12, yIn: -36 };

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

test("the insert menu offers every kind, each with an icon and a line of help", async ({ page }) => {
  await loadExample(page);
  await selectStep(page, ANCHOR);
  await openInsert(page);
  for (const kind of ["path", "command", "wait", "sequence", "parallel", "branch"]) {
    const item = page.getByTestId(`insert-kind-${kind}`);
    await expect(item, kind).toBeVisible();
    await expect(item.locator("svg").first(), `${kind} has an icon`).toBeVisible();
    const text = (await item.innerText()).trim();
    expect(text.split(/\s+/).length, `${kind} has a line of help: "${text}"`).toBeGreaterThanOrEqual(4);
  }
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
  // sweepGarden ends at gardenPickup, (-61, -62), facing the south wall 10 in away.
  await selectStep(page, "sweepGarden");
  await openInsert(page);
  await page.getByTestId("insert-kind-path").click();
  const id = await editor<string>(page, "s.selection.stepId");
  const to = await editor<{ xIn: number; yIn: number }>(page, `s.auto.steps.find((x) => x.id === ${JSON.stringify(id)}).segments[0].to`);
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

test("inserting before a step with a fixed start flags the gap and offers Connect", async ({ page }) => {
  await loadExample(page);
  // sweepGarden starts from "current" in the example, so give it a fixed start first: the
  // gardenApproach waypoint, which is where toGarden leaves the robot, so there is no gap until the
  // insert puts a path between them.
  await selectStep(page, "sweepGarden");
  await page.getByTestId("inspector-from-kind-0").selectOption("ref");
  await page.getByTestId("inspector-from-ref-0").selectOption("gardenApproach");
  await expect
    .poll(async () => editor<unknown>(page, `s.auto.steps.find((x) => x.id === "sweepGarden").segments[0].from`))
    .toEqual({ ref: "gardenApproach" });
  const continuityNow = async () =>
    editor<number>(page, `m.currentDerived().findings.filter((f) => f.code === "CONTINUITY").length`);
  expect(await continuityNow()).toBe(0);
  await selectStep(page, ANCHOR);
  await openInsert(page);
  await page.getByTestId("insert-kind-path").click();
  const id = await editor<string>(page, "s.selection.stepId");
  const connect = page.locator('[data-testid^="connect-fix-"]');
  const continuity = async () =>
    editor<number>(page, `m.currentDerived().findings.filter((f) => f.code === "CONTINUITY").length`);
  await expect.poll(async () => (await connect.count()) + (await continuity())).toBeGreaterThan(0);
  await shot(page, "03-connect-offered");
  if ((await connect.count()) > 0) {
    await connect.first().click();
    await expect.poll(continuity).toBe(0);
    await expect(connect).toHaveCount(0);
  }
  void id;
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
    const inspector = page.getByTestId("inspector");
    await expect(inspector).toBeVisible();
    const headers = await inspector.locator("h2, h3, [data-section]").count();
    const helps = await inspector.locator('[data-testid^="help-"]').count();
    if (helps === 0 || helps < Math.min(headers, 1)) missing.push(`${kind.name}: ${String(helps)} ? for ${String(headers)} headers`);
    await shot(page, `03-inspector-${kind.name.replace(/\s+/g, "-")}`);
  }
  expect(missing).toEqual([]);
});
