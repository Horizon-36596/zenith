/**
 * Issue #150: the Add path tool shows where its point will land, and a snap onto a waypoint follows
 * the waypoint.
 *
 * Before the fix, the rubber band and the corner readout put a point near the south wall where the
 * pointer was, and only the click snapped it, up to 11 in away. "Add a path to here" on the field's
 * menu did not snap at all. And a path end snapped onto a waypoint, by a click or by a drag, copied
 * the waypoint's numbers with the editor's provenance instead of following it.
 *
 * The example opens collect-and-score, which ends at the scoreNorth waypoint, (-13, 44). Its first
 * path, driveOut, runs from the start waypoint to the scoreSouth waypoint, (-13, -36). The east half
 * of the field, x > 0, has none of its paths or pins on it.
 */
import { expect, test, type Page } from "@playwright/test";
import { canvasView, dragWorld, editor, loadExample, skipTour, worldToScreen } from "./qa/helpers";

test.beforeEach(async ({ page }) => {
  await skipTour(page);
});

interface Readout {
  pose: { xIn: number; yIn: number; headingRad: number } | null;
  snap: string;
}

/** The corner readout, as the canvas publishes it in full on its element. */
async function readout(page: Page): Promise<Readout> {
  const canvas = page.getByTestId("field-canvas");
  const pose = (await canvas.getAttribute("data-readout-pose")) ?? "";
  const snap = (await canvas.getAttribute("data-readout-snap")) ?? "";
  if (pose === "") return { pose: null, snap };
  const [xIn = NaN, yIn = NaN, headingRad = NaN] = pose.split(",").map(Number);
  return { pose: { xIn, yIn, headingRad }, snap };
}

/** Picks a tool from its key, with the field focused, and waits for the editor to take it. */
async function pickTool(page: Page, key: string, tool: string): Promise<void> {
  await page.getByTestId("field-canvas").focus();
  await page.keyboard.press(key);
  await expect.poll(() => editor<string>(page, "s.tool")).toBe(tool);
}

/** Moves the pointer onto a field spot, the last few pixels as a hand would. */
async function hover(page: Page, xIn: number, yIn: number): Promise<{ x: number; y: number }> {
  const at = await worldToScreen(page, xIn, yIn);
  await page.mouse.move(at.x - 12, at.y + 6);
  await page.mouse.move(at.x, at.y, { steps: 3 });
  return at;
}

interface Band {
  fromIn: { xIn: number; yIn: number };
  toIn: { xIn: number; yIn: number };
}

/** The dashed line's two ends, as the canvas publishes them on its element, or null with no line. */
async function rubberBand(page: Page): Promise<Band | null> {
  const band = (await page.getByTestId("field-canvas").getAttribute("data-rubber-band")) ?? "";
  if (band === "") return null;
  const [fromX = NaN, fromY = NaN, toX = NaN, toY = NaN] = band.split(",").map(Number);
  return { fromIn: { xIn: fromX, yIn: fromY }, toIn: { xIn: toX, yIn: toY } };
}

/**
 * Waits for the preview to name `snap`, then checks that the dashed line ends exactly at the point
 * the readout shows, and returns that point.
 */
async function snappedPreview(page: Page, snap: string): Promise<{ readout: { xIn: number; yIn: number; headingRad: number }; band: Band }> {
  await expect.poll(async () => (await readout(page)).snap).toBe(snap);
  const shown = (await readout(page)).pose;
  const band = await rubberBand(page);
  if (shown === null || band === null) throw new Error("the preview shows no point or no dashed line");
  expect(band.toIn).toEqual({ xIn: shown.xIn, yIn: shown.yIn });
  return { readout: shown, band };
}

/** A press and a release where the pointer is, with no move in between. */
async function clickInPlace(page: Page): Promise<void> {
  await page.mouse.down();
  await page.mouse.up();
}

const endOf = (id: string): string => `s.auto.steps.find((step) => step.id === ${JSON.stringify(id)}).segments[0].to`;
const statusLine = (page: Page): Promise<string> => editor<string>(page, `s.status === null ? "" : s.status.message`);

test("with the Add path tool near the south wall, the readout shows the wall snap and the click writes exactly that point", async ({ page }) => {
  await loadExample(page);
  await editor(page, "m.setSelection({})");
  await pickTool(page, "p", "addPath");

  const at = await hover(page, 30, -70);
  await expect.poll(async () => (await readout(page)).snap).toBe("wall");
  const shown = (await readout(page)).pose;
  if (shown === null) throw new Error("the readout shows no point");
  // The robot rests flush against the wall, so the point the readout shows is north of the pointer.
  expect(shown.yIn).toBeGreaterThan(-68);
  expect(shown.xIn).toBeCloseTo(30, 0);

  await page.mouse.click(at.x, at.y);
  await expect.poll(() => editor<string | undefined>(page, "s.selection.stepId")).toBe("path1");
  expect(await editor(page, endOf("path1"))).toEqual({ xIn: shown.xIn, yIn: shown.yIn, provenance: "SET FROM EDITOR" });
});

test("clearing the selection with the Add path tool and the pointer still keeps the preview snapped, from the step it now continues from, and the click writes it", async ({ page }) => {
  await loadExample(page);
  // The wall rests the robot at the bearing it drives along, which is what makes the two anchors differ;
  // with Start a new path with the previous path's end heading on it rests at the arrival heading (#435).
  await editor(page, `m.setSetting("editing.newPathKeepsHeading", false)`);
  // Inserting after driveOut, which ends on the scoreSouth waypoint, (-13, -36).
  await editor(page, `m.setSelection({ stepId: "driveOut" })`);
  await pickTool(page, "p", "addPath");
  await hover(page, 30, -70);
  const before = await snappedPreview(page, "wall");
  expect(before.band.fromIn.xIn).toBeCloseTo(-13, 3);
  expect(before.band.fromIn.yIn).toBeCloseTo(-36, 3);

  // With the selection cleared, a click now continues from the routine's last end, scoreNorth at
  // (-13, 44), along another bearing, and the robot rests against the wall a little differently.
  // (Esc no longer does this with a tool on: it leaves the tool for Select, issue #412.)
  await editor(page, "m.setSelection({})");
  await expect.poll(() => editor<string | undefined>(page, "s.selection.stepId")).toBeUndefined();
  expect(await editor<string>(page, "s.tool")).toBe("addPath");
  await expect.poll(async () => (await rubberBand(page))?.fromIn.yIn ?? null).toBeCloseTo(44, 3);
  const after = await snappedPreview(page, "wall");
  expect(after.band.fromIn.xIn).toBeCloseTo(-13, 3);
  expect(after.readout.xIn).toBeCloseTo(30, 0);
  expect(after.readout.yIn).toBeGreaterThan(-68);
  expect(Math.abs(after.readout.yIn - before.readout.yIn)).toBeGreaterThan(0.05);

  await clickInPlace(page);
  await expect.poll(() => editor<string | undefined>(page, "s.selection.stepId")).toBe("path1");
  expect(await editor(page, endOf("path1"))).toEqual({ xIn: after.readout.xIn, yIn: after.readout.yIn, provenance: "SET FROM EDITOR" });
});

test("pressing P with the pointer held still shows the snapped preview at once, and the click writes it", async ({ page }) => {
  await loadExample(page);
  await editor(page, "m.setSelection({})");
  await hover(page, 30, -70);
  // The select tool's readout is the pointer itself, with no snap and no dashed line.
  await expect.poll(async () => (await readout(page)).pose?.yIn ?? null).toBeCloseTo(-70, 3);
  expect((await readout(page)).snap).toBe("");
  expect(await rubberBand(page)).toBeNull();

  await pickTool(page, "p", "addPath");
  const shown = await snappedPreview(page, "wall");
  expect(shown.readout.xIn).toBeCloseTo(30, 0);
  expect(shown.readout.yIn).toBeGreaterThan(-68);

  await clickInPlace(page);
  await expect.poll(() => editor<string | undefined>(page, "s.selection.stepId")).toBe("path1");
  expect(await editor(page, endOf("path1"))).toEqual({ xIn: shown.readout.xIn, yIn: shown.readout.yIn, provenance: "SET FROM EDITOR" });
});

test("the preview goes with a tool that adds nothing and when the pointer leaves the field", async ({ page }) => {
  await loadExample(page);
  await editor(page, "m.setSelection({})");
  await pickTool(page, "p", "addPath");
  await hover(page, 30, -70);
  await snappedPreview(page, "wall");

  // The select tool, with the pointer still: no dashed line and no snap, and the readout is the pointer.
  await pickTool(page, "v", "select");
  await expect.poll(() => rubberBand(page)).toBeNull();
  expect((await readout(page)).snap).toBe("");
  expect((await readout(page)).pose?.yIn).toBeCloseTo(-70, 3);

  // Back to Add path, then off the field: nothing is left for a click to land on.
  await pickTool(page, "p", "addPath");
  await snappedPreview(page, "wall");
  const view = await canvasView(page);
  await page.mouse.move(view.x + view.width / 2, view.y - 8);
  await expect.poll(() => rubberBand(page)).toBeNull();
  expect(await readout(page)).toEqual({ pose: null, snap: "" });
});

test("after F frames the routine with the pointer still, the preview is the point under the pointer in the new view, and the click writes it", async ({ page }) => {
  await loadExample(page);
  await editor(page, "m.setSelection({})");
  await pickTool(page, "p", "addPath");
  // Far enough east that after F the pointer is not over the start pin, which would snap the click.
  await hover(page, 40, -70);
  // Zoomed in about the pointer first: since issue #412 the opening fit frames the board alone,
  // which can be the very view F frames the routine in.
  const opening = (await canvasView(page)).pxPerIn;
  await page.mouse.wheel(0, -240);
  await expect.poll(async () => (await canvasView(page)).pxPerIn).not.toBe(opening);
  const before = await snappedPreview(page, "wall");
  const viewBefore = await canvasView(page);

  await page.keyboard.press("f");
  await expect.poll(async () => (await canvasView(page)).pxPerIn).not.toBe(viewBefore.pxPerIn);
  // The pointer's pixel is now somewhere else on the field, and the preview has followed it there.
  await expect.poll(async () => (await readout(page)).pose?.xIn ?? null).not.toBeCloseTo(before.readout.xIn, 0);
  const shown = (await readout(page)).pose;
  const band = await rubberBand(page);
  if (shown === null || band === null) throw new Error("the preview shows no point or no dashed line");
  expect(band.toIn).toEqual({ xIn: shown.xIn, yIn: shown.yIn });

  await clickInPlace(page);
  await expect.poll(() => editor<string | undefined>(page, "s.selection.stepId")).toBe("path1");
  expect(await editor(page, endOf("path1"))).toMatchObject({ xIn: shown.xIn, yIn: shown.yIn });
});

test("an Add path click on a waypoint's pin makes the new end follow the waypoint", async ({ page }) => {
  await loadExample(page);
  // The park waypoint, (-40, -36), as in the getting-started walk-through. collect-and-score does not
  // follow it, so its pin shows only once it is selected in the inspector's list (issue #217).
  await editor(page, "m.setSelection({})");
  await pickTool(page, "p", "addPath");
  const hidden = await hover(page, -40, -36);
  await expect.poll(async () => (await readout(page)).snap).not.toBe("");
  expect((await readout(page)).snap).not.toBe("waypoint park");
  await page.mouse.move(hidden.x + 40, hidden.y);
  await editor(page, `m.setSelection({ waypoint: "park" })`);

  const at = await hover(page, -40, -36);
  await expect.poll(async () => (await readout(page)).snap).toBe("waypoint park");
  expect((await readout(page)).pose).toMatchObject({ xIn: -40, yIn: -36 });
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => editor<string | undefined>(page, "s.selection.stepId")).toBe("path1");
  expect(await editor(page, endOf("path1"))).toEqual({ ref: "park" });
  expect(await statusLine(page)).toBe("Point 1 of path1 now follows waypoint park.");
});

test("\"Add a path to here\" and an Add path click at the same pixel write the same end, heading included", async ({ page }) => {
  await loadExample(page);
  await editor(page, "m.setSelection({})");
  await pickTool(page, "p", "addPath");

  const at = await hover(page, 30, -70);
  await page.mouse.click(at.x, at.y, { button: "right" });
  const menu = page.getByTestId("canvas-context-menu");
  await menu.locator('[data-action="field.addPathHere"]').click();
  await expect.poll(() => editor<string | undefined>(page, "s.selection.stepId")).toBe("path1");
  const fromMenu = await editor<Record<string, unknown>>(page, endOf("path1"));
  // The menu snaps as the click does: the robot against the wall, not the raw spot.
  expect(fromMenu["yIn"]).toBeGreaterThan(-68);

  const view = await canvasView(page);
  await page.keyboard.press("Control+z");
  await expect.poll(() => editor<boolean>(page, `s.auto.steps.some((step) => step.id === "path1")`)).toBe(false);
  await editor(page, "m.setSelection({})");
  await pickTool(page, "p", "addPath");
  // The same pixel is the same spot: the view has not moved.
  expect(await canvasView(page)).toEqual(view);
  await hover(page, 30, -70);
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => editor<string | undefined>(page, "s.selection.stepId")).toBe("path1");
  expect(await editor(page, endOf("path1"))).toEqual(fromMenu);
});

test("dragging a new path's end onto the scoreSouth pin makes it follow the waypoint, and one Ctrl+Z takes the whole drag back", async ({ page }) => {
  await loadExample(page);
  await editor(page, "m.setSelection({})");
  await pickTool(page, "p", "addPath");
  const at = await hover(page, 36, 0);
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => editor<string | undefined>(page, "s.selection.stepId")).toBe("path1");
  const placed = await editor<Record<string, unknown>>(page, endOf("path1"));
  expect(placed).toEqual({ xIn: 36, yIn: 0, provenance: "SET FROM EDITOR" });
  await pickTool(page, "v", "select");

  await dragWorld(page, { xIn: 36, yIn: 0 }, { xIn: -13, yIn: -36 }, { steps: 10 });
  expect(await editor(page, endOf("path1"))).toEqual({ ref: "scoreSouth" });
  expect(await statusLine(page)).toBe("Point 1 of path1 now follows waypoint scoreSouth.");
  // The waypoint keeps its own provenance; the end only names it.
  expect(await editor<string>(page, `s.project.waypoints.waypoints.scoreSouth.provenance`)).toMatch(/^SET FROM EDITOR: starter example/);

  await page.keyboard.press("Control+z");
  await expect.poll(() => editor(page, endOf("path1"))).toEqual(placed);
});

test("dragging driveOut's end off scoreSouth and back onto it in one drag keeps it following the waypoint", async ({ page }) => {
  await loadExample(page);
  expect(await editor(page, endOf("driveOut"))).toEqual({ ref: "scoreSouth" });
  const undoBefore = await editor<number>(page, "s.undo.length");

  await dragWorld(page, { xIn: -13, yIn: -36 }, { xIn: 12, yIn: -36 }, { release: false });
  await expect.poll(() => statusLine(page)).toBe("Point 1 of driveOut no longer follows waypoint scoreSouth. Undo links it again.");
  const back = await worldToScreen(page, -13, -36);
  await page.mouse.move(back.x, back.y, { steps: 8 });
  await page.mouse.up();

  expect(await editor(page, endOf("driveOut"))).toEqual({ ref: "scoreSouth" });
  expect(await statusLine(page)).not.toMatch(/no longer follows/);
  // In the end the drag changed nothing, so there is nothing to undo.
  expect(await editor<number>(page, "s.undo.length")).toBe(undoBefore);
});
