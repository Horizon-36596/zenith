/**
 * Issue #143: turning a straight line into a curve. The inspector's Kind select used to put the new
 * control point at the field centre, with no provenance, whenever either end of the segment was
 * "last step's end" or a waypoint: every path Add path makes, and almost every starter segment. The
 * curve swung through the hive and raised STRUCTURE errors, and its chip said Needs measurement.
 * Now the control lands at the middle of the segment's own ends, with the editor's provenance, so
 * the new curve lies on the line: no new finding, no Needs measurement chip, the same estimate. Make
 * curve and Make straight line are also in the command palette and in a path's right-click menu.
 */
import { expect, test, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";

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

/** The first segment of a top-level path step, as the file has it. */
const firstSegment = (page: Page, stepId: string) =>
  editor<Record<string, unknown>>(page, `s.auto.steps.find((step) => step.id === ${JSON.stringify(stepId)}).segments[0]`);

/** Where the planner draws a step's first segment's ends, after "current" and waypoints resolve. */
const drawnEnds = (page: Page, stepId: string) =>
  editor<{ from: { xIn: number; yIn: number }; to: { xIn: number; yIn: number } }>(
    page,
    `(() => { const flat = (steps) => steps.flatMap((x) => [x, ...flat(x.children ?? [])]); const seg = flat(d.resolved.steps).find((x) => x.id === ${JSON.stringify(stepId)}).segments[0]; return { from: seg.fromPose, to: seg.toPose }; })()`,
  );

/** Every finding, one line each, so a before and an after compare as lists. */
const findings = (page: Page) =>
  editor<string[]>(page, "d.findings.map((f) => `${f.severity} ${f.code} ${f.stepId}: ${f.message}`)");

/** Where a field inch sits on screen, from the view the canvas publishes on its element. */
async function worldToScreen(page: Page, xIn: number, yIn: number): Promise<{ x: number; y: number }> {
  const canvas = page.getByTestId("field-canvas");
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("the canvas has no box");
  const pxPerIn = Number(await canvas.getAttribute("data-px-per-in"));
  const originXPx = Number(await canvas.getAttribute("data-origin-x-px"));
  const originYPx = Number(await canvas.getAttribute("data-origin-y-px"));
  // The example field puts the audience at the bottom: +x right, +y up the screen.
  return { x: box.x + originXPx + pxPerIn * xIn, y: box.y + originYPx - pxPerIn * yIn };
}

/** What the switch must leave alone: the findings, the step's estimate and the routine's total. */
async function snapshot(page: Page) {
  const chips = page.getByTestId("inspector").locator('[data-tour="provenance"]');
  return {
    findings: await findings(page),
    estimate: await page.getByTestId("inspector-estimate").textContent(),
    total: await page.getByTestId("timeline-total").getAttribute("data-seconds"),
    needsMeasurement: await chips.filter({ hasText: "Needs meas." }).count(),
    setFromEditor: await chips.filter({ hasText: "From editor" }).count(),
  };
}

/**
 * Switches the selected path's first segment to Curve in the inspector and checks that the control
 * point lands in the middle of the drawn ends, labelled Set from editor, with nothing else changed.
 */
async function curveInInspector(page: Page, stepId: string): Promise<void> {
  const ends = await drawnEnds(page, stepId);
  const before = await snapshot(page);
  const structure = before.findings.filter((line) => line.includes(" STRUCTURE "));

  await page.getByTestId("inspector-segment-kind-0").selectOption("bezier");
  await expect.poll(async () => (await firstSegment(page, stepId))["kind"]).toBe("bezier");

  const segment = (await firstSegment(page, stepId)) as { control: Array<{ xIn: number; yIn: number; provenance: string }> };
  expect(segment.control).toHaveLength(1);
  const control = segment.control[0];
  expect(control?.xIn).toBeCloseTo((ends.from.xIn + ends.to.xIn) / 2, 6);
  expect(control?.yIn).toBeCloseTo((ends.from.yIn + ends.to.yIn) / 2, 6);
  expect(control?.provenance).toBe("SET FROM EDITOR");
  // Never the field centre.
  expect(Math.hypot(control?.xIn ?? 0, control?.yIn ?? 0)).toBeGreaterThan(1);

  const after = await snapshot(page);
  expect(after.findings.filter((line) => line.includes(" STRUCTURE "))).toEqual(structure);
  expect(after.findings).toEqual(before.findings);
  expect(after.needsMeasurement).toBe(before.needsMeasurement);
  // A control point shows its chip only while it is the selected point (issue #409), so the new
  // one adds none; its SET FROM EDITOR label is checked in the file above.
  expect(after.setFromEditor).toBe(before.setFromEditor);
  expect(after.estimate).toBe(before.estimate);
  expect(after.total).toBe(before.total);
  await expect(page.getByTestId("status")).toContainText("hollow square");
}

/** Adds a path with the Add path tool, ending at a clear spot west of scoreNorth, and returns its id. */
async function addPathTo(page: Page, xIn: number, yIn: number): Promise<string> {
  await page.getByTestId("toolbar-tool.addPath").click();
  const before = await editor<number>(page, "s.auto.steps.length");
  const at = await worldToScreen(page, xIn, yIn);
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => editor<number>(page, "s.auto.steps.length")).toBe(before + 1);
  const id = await editor<string>(page, "s.selection.stepId");
  expect(await firstSegment(page, id)).toMatchObject({ kind: "line", from: "current" });
  await page.getByTestId("toolbar-tool.select").click();
  return id;
}

test("Curve on collectFlower puts the control on its own line, with no new finding and the same estimate", async ({ page }) => {
  await loadExample(page);
  await page.getByTestId("step-row-collectFlower").getByRole("button").first().click();
  // collectFlower runs from the last step's end to the waypoint flowerNorthPickup.
  expect(await firstSegment(page, "collectFlower")).toEqual({ kind: "line", from: "current", to: { ref: "flowerNorthPickup" } });
  await curveInInspector(page, "collectFlower");

  // Straight line gives back the segment as it was written.
  await page.getByTestId("inspector-segment-kind-0").selectOption("line");
  await expect.poll(() => firstSegment(page, "collectFlower")).toEqual({
    kind: "line",
    from: "current",
    to: { ref: "flowerNorthPickup" },
  });
});

test("Curve on a fresh Add path path puts the control on its own line, with no new finding and the same estimate", async ({ page }) => {
  await loadExample(page);
  const id = await addPathTo(page, -48, 12);
  await expect(page.getByTestId(`step-row-${id}`)).toBeVisible();
  await curveInInspector(page, id);
});

test("the palette finds Make curve and Make straight line, and Make curve curves the selected path", async ({ page }) => {
  await loadExample(page);
  await page.getByTestId("step-row-collectFlower").getByRole("button").first().click();
  await page.keyboard.press("Control+k");
  const input = page.getByTestId("palette-input");
  await expect(input).toBeFocused();
  for (const word of ["curve", "bezier", "bend"]) {
    await input.fill(word);
    await expect(page.getByTestId("palette-item-edit.makeCurve"), word).toBeVisible();
  }
  await input.fill("straight");
  await expect(page.getByTestId("palette-item-edit.makeLine")).toBeVisible();

  await input.fill("curve");
  await page.getByTestId("palette-item-edit.makeCurve").click();
  await expect.poll(async () => (await firstSegment(page, "collectFlower"))["kind"]).toBe("bezier");
  expect(await firstSegment(page, "collectFlower")).toMatchObject({
    control: [{ xIn: -24, yIn: 51.5, provenance: "SET FROM EDITOR" }],
  });
});

test("a path's right-click menu lists Make curve for the segment under the pointer", async ({ page }) => {
  await loadExample(page);
  const id = await addPathTo(page, -48, 12);
  const ends = await drawnEnds(page, id);
  const middle = { xIn: (ends.from.xIn + ends.to.xIn) / 2, yIn: (ends.from.yIn + ends.to.yIn) / 2 };
  const at = await worldToScreen(page, middle.xIn, middle.yIn);
  await page.mouse.click(at.x, at.y, { button: "right" });

  const menu = page.getByTestId("canvas-context-menu");
  await expect(menu).toBeVisible();
  const curve = menu.locator('[data-action="edit.makeCurve"]');
  const line = menu.locator('[data-action="edit.makeLine"]');
  await expect(curve).toContainText("Make curve");
  await expect(curve).toBeEnabled();
  // A straight line offers only Make curve: Make straight line would change nothing (issue #412).
  await expect(line).toHaveCount(0);

  await curve.click();
  await expect(menu).toHaveCount(0);
  const segment = (await firstSegment(page, id)) as { kind: string; control: Array<{ xIn: number; yIn: number; provenance: string }> };
  expect(segment.kind).toBe("bezier");
  expect(segment.control[0]?.xIn).toBeCloseTo(middle.xIn, 6);
  expect(segment.control[0]?.yIn).toBeCloseTo(middle.yIn, 6);
  expect(segment.control[0]?.provenance).toBe("SET FROM EDITOR");
});
