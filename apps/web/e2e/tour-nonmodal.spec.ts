/**
 * The tour never blocks the app (UI_GUIDE section 10.1). For every stop of the
 * core tour and the full tour:
 *
 * - the stop's target is on top where it is drawn (nothing of the tour's is hit there), and the
 *   coach mark's box does not intersect it;
 * - the target, and any menu, submenu, tooltip or dialog the stop is about, can be clicked or
 *   hovered and responds, with the card's box clear of each popover once it is open;
 * - a stop with a "Try it" task moves on when the person does that thing through the real UI.
 *
 * The two cases the owner hit are here by name: on "Add a step" the Insert menu's submenus open and
 * a Path is added, and on "The inspector" every `?` opens its tooltip.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CORE_STOPS, FULL_STOPS } from "../src/tour/stops";
import { canvasView, editor, waitForFonts, worldToScreen } from "./qa/helpers";

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const card = (page: Page): Locator => page.getByTestId("tour-card");

async function boxOf(locator: Locator): Promise<Box | null> {
  const box = await locator.boundingBox();
  return box === null ? null : { left: box.x, top: box.y, width: box.width, height: box.height };
}

const intersects = (a: Box, b: Box): boolean =>
  a.left < b.left + b.width - 0.5 &&
  b.left < a.left + a.width - 0.5 &&
  a.top < b.top + b.height - 0.5 &&
  b.top < a.top + a.height - 0.5;

/**
 * The card's box clears every element `what` matches once the card has settled (it moves the
 * frame after a popover opens).
 */
async function dumpState(page: Page, why: string): Promise<void> {
  const state = await page.evaluate(() => {
    const r = (e: Element) => {
      const b = e.getBoundingClientRect();
      return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)];
    };
    const c = document.querySelector('[data-testid="tour-card"]');
    const p = (window as unknown as { __ptr?: [number, number] }).__ptr ?? [0, 0];
    const hit = document.elementFromPoint(p[0], p[1]);
    return {
      card: c === null ? null : r(c),
      stop: c?.getAttribute("data-stop"),
      pops: [...document.querySelectorAll('[role="tooltip"],[role="menu"],[role="dialog"],[role="listbox"]')].map(
        (e) => `${e.getAttribute("role")} ${e.getAttribute("data-testid") ?? e.id} ${JSON.stringify(r(e))} vis=${getComputedStyle(e).visibility}`,
      ),
      ptr: p,
      hit: hit === null ? null : `${hit.tagName} ${hit.getAttribute("data-testid") ?? ""} inCard=${String(hit.closest("[data-tour-card]") !== null)}`,
      ring: (() => { const g = document.querySelector('[data-testid="tour-ring"]'); return g === null ? null : r(g); })(),
    };
  });
  console.log(`DIAG ${why}: ${JSON.stringify(state)}`);
}

async function expectCardClear(page: Page, what: Locator, label: string): Promise<void> {
  try {
    await expectCardClearInner(page, what, label);
  } catch (error) {
    await dumpState(page, label);
    throw error;
  }
}

/**
 * Waits for the app to say it is settled, then checks once. A tooltip says `data-state="open"`
 * once it has positioned itself; the card says `data-settled="true"` once it has placed itself
 * against everything on screen, which it does before the next paint after any change. A frame
 * then lets any change still queued land, and the card and `what` are measured in one go, so
 * the two boxes come from the same moment.
 */
async function expectCardClearInner(page: Page, what: Locator, label: string): Promise<void> {
  await expect(what.first(), `${label} is open`).toBeVisible();
  const state = await what.first().getAttribute("data-state");
  if (state !== null) await expect(what.first(), `${label} has positioned itself`).toHaveAttribute("data-state", "open");
  await expect(card(page), "the card has placed itself").toHaveAttribute("data-settled", "true");
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const snapshot = await what.evaluateAll((elements) => {
    const box = (element: Element) => {
      const r = element.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    };
    const tourCard = document.querySelector('[data-testid="tour-card"]');
    return {
      settled: tourCard?.getAttribute("data-settled") ?? null,
      card: tourCard === null ? null : box(tourCard),
      boxes: elements.map(box),
    };
  });
  expect(snapshot.settled, "the card is still settled").toBe("true");
  const at = snapshot.card;
  expect(at, "the card is on screen").not.toBeNull();
  if (at === null) return;
  const covered = snapshot.boxes.filter((b) => b.width > 0 && intersects(at, b));
  expect(covered, `the card ${JSON.stringify(at)} keeps off ${label}`).toEqual([]);
}

/**
 * Nothing of the tour's is hit anywhere over the target: its centre and four points round it all
 * land on the target itself (or on something inside it), never on the card or a tour layer.
 */
async function expectHittable(page: Page, target: Locator, label: string): Promise<void> {
  const problems = await target.first().evaluate((element) => {
    const box = element.getBoundingClientRect();
    const out: string[] = [];
    const points: Array<[number, number]> = [
      [0.5, 0.5],
      [0.2, 0.2],
      [0.8, 0.2],
      [0.2, 0.8],
      [0.8, 0.8],
    ];
    for (const [fx, fy] of points) {
      const x = box.left + box.width * fx;
      const y = box.top + box.height * fy;
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue;
      const hit = document.elementFromPoint(x, y);
      if (hit === null) continue;
      if (hit.closest("[data-tour-layer]") !== null) out.push(`(${String(fx)}, ${String(fy)}) hits the tour`);
      else if (fx === 0.5 && fy === 0.5 && !element.contains(hit)) {
        out.push(`the centre hits ${hit.tagName}.${String(hit.className)} outside the target`);
      }
    }
    return out;
  });
  expect(problems, `${label} can be clicked`).toEqual([]);
}

/**
 * Move the pointer somewhere with no tooltip, and wait for the help bubble to close. A control's
 * tooltip can stay open on keyboard focus (a menu focuses its first item), so only the bubble a
 * hover opened is waited for.
 */
async function hoverAway(page: Page): Promise<void> {
  await page.mouse.move(2, 2);
  await expect(page.getByTestId("help-bubble")).toHaveCount(0, { timeout: 3_000 });
}

/** Hover a control and check the tooltip it names opens, with the card clear of it. */
async function hoverForTooltip(page: Page, control: Locator, label: string): Promise<void> {
  await control.hover();
  // One tooltip opens (never two), and it is the one the control, or the button inside it, is
  // described by.
  const open = page.locator('[role="tooltip"][data-state="open"]');
  try {
    await expect(open, `${label} opens its tooltip on hover`).toHaveCount(1);
  } catch (error) {
    await dumpState(page, `${label} no tooltip`);
    throw error;
  }
  const id = (await open.getAttribute("id")) ?? "";
  const describes = await control.first().evaluate(
    (element, tip) =>
      element.getAttribute("aria-describedby") === tip || element.querySelector(`[aria-describedby="${tip}"]`) !== null,
    id,
  );
  expect(describes, `the open tooltip is ${label}'s`).toBe(true);
  await expectCardClear(page, page.locator(`[id="${id}"]`), `${label}'s tooltip`);
  await hoverAway(page);
}

/** Hover every visible `?` inside `scope` and check each help tooltip opens clear of the card. */
async function hoverEveryHelp(page: Page, scope: Locator, label: string): Promise<number> {
  const tips = scope.locator("[data-help]");
  const count = await tips.count();
  let seen = 0;
  for (let at = 0; at < count; at += 1) {
    const tip = tips.nth(at);
    if (!(await tip.isVisible())) continue;
    await tip.scrollIntoViewIfNeeded();
    await expectHittable(page, tip, `${label} ? ${String(at)}`);
    await tip.hover();
    await expectCardClear(page, page.getByTestId("help-bubble"), `${label} ? ${String(at)}`);
    await hoverAway(page);
    seen += 1;
  }
  return seen;
}

const stopNow = async (page: Page): Promise<string> => (await card(page).getAttribute("data-stop")) ?? "";

/** The next stop's id, or the card that follows the last one. */
async function expectMovedOn(page: Page, from: string, list: readonly { id: string }[]): Promise<void> {
  const at = list.findIndex((stop) => stop.id === from);
  const next = list[at + 1];
  if (next !== undefined) await expect(card(page)).toHaveAttribute("data-stop", next.id);
  else await expect(page.locator("[data-testid=tour-choice], [data-testid=tour-finished]")).toBeVisible();
}

/** Where the example's scoreSouth waypoint is on the page: a point on the first path to drag. */
async function waypointOnScreen(page: Page, name: string): Promise<{ x: number; y: number }> {
  const pose = await editor<{ xIn: number; yIn: number }>(
    page,
    `(() => {
      const find = (value) => {
        if (value === null || typeof value !== "object") return null;
        if (typeof value.xIn === "number" && typeof value.yIn === "number") return value;
        for (const inner of Object.values(value)) { const hit = find(inner); if (hit !== null) return hit; }
        return null;
      };
      return find(s.project.waypoints.waypoints[${JSON.stringify(name)}]);
    })()`,
  );
  return worldToScreen(page, pose.xIn, pose.yIn);
}

type Probe = (page: Page, anchor: Locator) => Promise<void>;

/**
 * What each stop asks the person to look at or do, done for real. A probe for a stop with a task
 * does the task; the loop then checks the tour moved on by itself.
 */
const PROBES: Record<string, Probe> = {
  // Core tour.
  async field(page) {
    // Drag the end of driveOut straight away: a dot drags without its path being selected first.
    expect(await editor<string | undefined>(page, "s.selection.stepId")).toBeUndefined();
    const from = await waypointOnScreen(page, "scoreSouth");
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 12, from.y - 20, { steps: 6 });
    await page.mouse.move(from.x + 24, from.y - 40, { steps: 6 });
    await page.mouse.up();
  },
  async steps(page) {
    // The field stop's drag selected driveOut; a different step is a new selection.
    await page.getByTestId("step-row-toGarden").getByRole("button").first().click();
    await expect.poll(() => editor<string | undefined>(page, "s.selection.stepId")).toBe("toGarden");
  },
  async insert(page) {
    const before = await editor<number>(page, "s.auto.steps.length");
    await page.getByTestId("insert-step").click();
    await expectCardClear(page, page.getByTestId("insert-menu"), "the Insert menu");
    // Each kind's tooltip opens beside the menu, clear of the card.
    await hoverForTooltip(page, page.getByTestId("insert-kind-parallel"), "Parallel");
    // A kind with options opens its submenu, and Back returns to the kinds.
    await page.getByTestId("insert-kind-command").click();
    await expect(page.getByTestId("insert-command-search")).toBeVisible();
    await expectCardClear(page, page.getByTestId("insert-menu"), "the Command submenu");
    await page.getByTestId("insert-back").click();
    await page.getByTestId("insert-kind-wait").click();
    await expect(page.getByTestId("insert-wait-seconds")).toBeVisible();
    await expectCardClear(page, page.getByTestId("insert-menu"), "the Wait submenu");
    await page.getByTestId("insert-back").click();
    await page.getByTestId("insert-kind-path").click();
    await expect(page.getByTestId("insert-menu")).toHaveCount(0);
    expect(await editor<number>(page, "s.auto.steps.length")).toBeGreaterThan(before);
  },
  async inspector(page, anchor) {
    const seen = await hoverEveryHelp(page, anchor, "the inspector");
    expect(seen, "the inspector has ? tips to hover").toBeGreaterThan(1);
  },
  async findings(page, anchor) {
    await hoverEveryHelp(page, anchor, "Problems");
    const toggle = anchor.locator('[data-testid^="findings-count-"]').first();
    if ((await toggle.count()) > 0) {
      const was = await toggle.getAttribute("aria-pressed");
      await toggle.click();
      await expect(toggle).not.toHaveAttribute("aria-pressed", was ?? "");
      await toggle.click();
    }
  },
  async run(page) {
    await hoverForTooltip(page, page.getByTestId("toolbar-view.play"), "Play");
    await card(page).focus();
    await page.keyboard.press("Space");
    await expect.poll(() => editor<boolean>(page, "s.playing")).toBe(true);
  },

  // Full tour.
  async "tool.select"(page) {
    await hoverForTooltip(page, page.getByTestId("toolbar-tool.select"), "Select");
    await page.getByTestId("toolbar-tool.select").click();
    await expect(page.getByTestId("toolbar-tool.select")).toHaveAttribute("aria-pressed", "true");
  },
  async "tool.addPath"(page) {
    await card(page).focus();
    await page.keyboard.press("p");
    await expect(page.getByTestId("toolbar-tool.addPath")).toHaveAttribute("aria-pressed", "true");
  },
  async "tool.marker"(page) {
    await hoverForTooltip(page, page.getByTestId("toolbar-tool.marker"), "Marker");
    await page.getByTestId("toolbar-tool.marker").click();
    await expect(page.getByTestId("toolbar-tool.marker")).toHaveAttribute("aria-pressed", "true");
  },
  async "tool.heading"(page) {
    await hoverForTooltip(page, page.getByTestId("toolbar-tool.heading"), "Heading");
    // The stop selected a path whose arrows turn: the example's sweepGarden, a Constant heading.
    await expect.poll(() => editor<string | undefined>(page, "s.selection.stepId")).toBe("sweepGarden");
    const { end, headingRad } = await editor<{ end: { xIn: number; yIn: number }; headingRad: number }>(
      page,
      `(() => ({
        end: m.currentDerived().plan.steps.find((x) => x.id === "sweepGarden").endPose,
        headingRad: s.auto.steps.find((x) => x.id === "sweepGarden").heading.headingRad,
      }))()`,
    );
    // The end arrow is drawn 26 px along the heading from the pose; drag it round a quarter turn.
    const view = await canvasView(page);
    const reachIn = 26 / view.pxPerIn;
    const grab = await worldToScreen(page, end.xIn + reachIn * Math.cos(headingRad), end.yIn + reachIn * Math.sin(headingRad));
    const turned = headingRad + Math.PI / 2;
    const to = await worldToScreen(page, end.xIn + 12 * Math.cos(turned), end.yIn + 12 * Math.sin(turned));
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i += 1) await page.mouse.move(grab.x + ((to.x - grab.x) * i) / 8, grab.y + ((to.y - grab.y) * i) / 8);
    await page.mouse.up();
    const after = await editor<number>(page, `s.auto.steps.find((x) => x.id === "sweepGarden").heading.headingRad`);
    expect(after, "the arrow turned the heading").not.toBeCloseTo(headingRad, 2);
  },
  async "tool.measure"(page) {
    await hoverForTooltip(page, page.getByTestId("toolbar-tool.measure"), "Measure");
    await page.getByTestId("toolbar-tool.measure").click();
    await expect(page.getByTestId("toolbar-tool.measure")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("toolbar-tool.select").click();
  },
  async "view.snap"(page) {
    const was = await page.getByTestId("toolbar-view.snap").getAttribute("aria-pressed");
    await card(page).focus();
    await page.keyboard.press("s");
    await expect(page.getByTestId("toolbar-view.snap")).not.toHaveAttribute("aria-pressed", was ?? "");
  },
  async "section.heading"(page, anchor) {
    expect(await hoverEveryHelp(page, anchor, "Heading")).toBeGreaterThan(0);
  },
  async "section.markers"(page, anchor) {
    expect(await hoverEveryHelp(page, anchor, "Markers")).toBeGreaterThan(0);
  },
  async groups(page) {
    await page.getByTestId("insert-step").click();
    await expectCardClear(page, page.getByTestId("insert-menu"), "the Insert menu");
    await hoverForTooltip(page, page.getByTestId("insert-kind-sequence"), "Sequence");
    await page.getByTestId("insert-kind-parallel").click();
    await expect(page.getByTestId("insert-parallel-add")).toBeVisible();
    await expectCardClear(page, page.getByTestId("insert-menu"), "the Parallel submenu");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("insert-menu")).toHaveCount(0);
    await expect(card(page)).toHaveAttribute("data-stop", "groups");
  },
  async timeline(page, anchor) {
    await hoverEveryHelp(page, anchor, "Timeline");
    const bar = anchor.locator('[data-testid^="timeline-preview-"]').first();
    if ((await bar.count()) > 0 && (await bar.isVisible())) await hoverForTooltip(page, bar, "a timeline bar");
  },
  async ledger(page, anchor) {
    await hoverEveryHelp(page, anchor, "Ledger");
  },
  async provenance(page, anchor) {
    await hoverForTooltip(page, anchor, "the provenance chip");
  },
  async "findings.fixes"(page, anchor) {
    const code = anchor.getByTestId("finding-code").first();
    if ((await code.count()) > 0) await hoverForTooltip(page, code, "a problem's code");
    else await hoverEveryHelp(page, anchor, "Problems");
  },
  async "view.alliance"(page) {
    const was = await page.getByTestId("toolbar-view.alliance").getAttribute("aria-pressed");
    await card(page).focus();
    await page.keyboard.press("a");
    await expect(page.getByTestId("toolbar-view.alliance")).not.toHaveAttribute("aria-pressed", was ?? "");
  },
  async "run.simulate"(page, anchor) {
    await hoverForTooltip(page, anchor, "Simulate");
  },
  async "run.propose"(page, anchor) {
    await hoverForTooltip(page, anchor, "Propose");
  },
  async context(page) {
    const box = await boxOf(page.getByTestId("field-canvas"));
    if (box === null) throw new Error("no canvas");
    await page.mouse.click(box.left + box.width * 0.5, box.top + box.height * 0.3, { button: "right" });
    await expectCardClear(page, page.getByTestId("canvas-context-menu"), "the right-click menu");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("canvas-context-menu")).toHaveCount(0);
    await expect(card(page)).toHaveAttribute("data-stop", "context");
  },
  async palette(page) {
    await card(page).focus();
    await page.keyboard.press("Control+k");
    await expect(page.getByTestId("palette-input")).toBeVisible();
    await expectCardClear(page, page.getByRole("dialog", { name: "Command palette" }), "the command palette");
  },
  async help(page) {
    await page.getByTestId("toolbar-help").click();
    await expectCardClear(page, page.getByTestId("menu-help.tour").locator("xpath=.."), "the help menu");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("menu-help.tour")).toHaveCount(0);
    await expect(card(page)).toHaveAttribute("data-stop", "help");
  },
};

/** Every check for the stop on screen, then on to the next one. */
async function walkStop(page: Page, list: readonly (typeof CORE_STOPS)[number][], index: number): Promise<void> {
  const stop = list[index];
  if (stop === undefined) throw new Error(`no stop ${String(index)}`);
  await expect(card(page)).toHaveAttribute("data-stop", stop.id);
  await expect(card(page)).toBeVisible();
  // Focus arrives in the card on each stop, so its own keys work from there.
  await expect.poll(() => card(page).evaluate((element) => element.contains(document.activeElement))).toBe(true);
  const anchor = page.locator(`[data-tour="${stop.anchor ?? ""}"]`).first();
  await expect(anchor, `${stop.id}'s target`).toBeVisible();
  // The ring moves over --dur-tour; the card settles a frame after it.
  await page.waitForTimeout(300);

  await expectCardClear(page, anchor, `${stop.id}'s target`);
  await expectHittable(page, anchor, `${stop.id}'s target`);
  // Where the stop's task happens, when that is somewhere other than its anchor.
  for (const other of stop.keepClear ?? []) {
    await expectCardClear(page, page.locator(`[data-tour="${other}"]`).first(), `${stop.id}'s ${other}`);
  }

  const probe = PROBES[stop.id];
  expect(probe, `a probe for ${stop.id}`).toBeDefined();
  await probe?.(page, anchor);

  if (stop.task !== undefined) {
    // Doing the thing moved the tour on by itself.
    await expectMovedOn(page, stop.id, list);
  } else {
    expect(await stopNow(page)).toBe(stop.id);
    await page.getByTestId("tour-next").click();
  }
}

test.describe("the tour never blocks the app", () => {
  // A walk hovers every tooltip and does every task on up to 19 stops; that outlasts the 45 s default.
  test.describe.configure({ timeout: 180_000 });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.addEventListener("pointermove", (e) => { (window as unknown as { __ptr: [number, number] }).__ptr = [e.clientX, e.clientY]; }, true);
    });
    await page.goto("/");
    await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
    await expect(card(page)).toBeVisible();
    await waitForFonts(page);
  });

  test("every core stop: target and popovers usable, card clear, tasks done for real", async ({ page }) => {
    for (let index = 0; index < CORE_STOPS.length; index += 1) await walkStop(page, CORE_STOPS, index);
    await expect(page.getByTestId("tour-choice")).toBeVisible();
  });

  test("every full-tour stop: target and popovers usable, card clear, tasks done for real", async ({ page }) => {
    for (let i = 0; i < CORE_STOPS.length; i += 1) await page.getByTestId("tour-next").click();
    await page.getByTestId("tour-full").click();
    for (let index = 0; index < FULL_STOPS.length; index += 1) await walkStop(page, FULL_STOPS, index);
    await expect(page.getByTestId("tour-finished")).toBeVisible();
  });

  test("the first stop's drag also works after clicking the dot first", async ({ page }) => {
    await expect(card(page)).toHaveAttribute("data-stop", "field");
    const from = await waypointOnScreen(page, "scoreSouth");
    await page.mouse.click(from.x, from.y);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 12, from.y - 20, { steps: 6 });
    await page.mouse.move(from.x + 24, from.y - 40, { steps: 6 });
    await page.mouse.up();
    await expect(card(page)).toHaveAttribute("data-stop", "steps");
  });

  test("clicks anywhere outside the card reach the app", async ({ page }) => {
    await expect(card(page)).toHaveAttribute("data-stop", "field");
    // The toolbar's Measure tool, outside the field's ring, takes the click.
    await page.getByTestId("toolbar-tool.measure").click();
    await expect(page.getByTestId("toolbar-tool.measure")).toHaveAttribute("aria-pressed", "true");
    await expect(card(page)).toHaveAttribute("data-stop", "field");
  });

  test("keys outside the card are the app's: Escape clears the selection and leaves the tour running", async ({
    page,
  }) => {
    await page.getByTestId("step-row-driveOut").getByRole("button").first().click();
    await expect.poll(() => editor<string | undefined>(page, "s.selection.stepId")).toBe("driveOut");
    await page.getByTestId("step-row-driveOut").getByRole("button").first().focus();
    await page.keyboard.press("Escape");
    await expect.poll(() => editor<string | undefined>(page, "s.selection.stepId")).toBeUndefined();
    await expect(card(page)).toBeVisible();
    // With focus in the card, Escape is the tour's and leaves it.
    await card(page).focus();
    await page.keyboard.press("Escape");
    await expect(card(page)).toHaveCount(0);
  });

  test("the card is a labelled, non-modal dialog", async ({ page }) => {
    await expect(card(page)).toHaveAttribute("role", "dialog");
    await expect(card(page)).toHaveAttribute("aria-modal", "false");
    await expect(page.locator("[data-tour-layer]")).toHaveCSS("pointer-events", "none");
    await expect(page.getByTestId("tour-ring")).toHaveCSS("pointer-events", "none");
  });
});
