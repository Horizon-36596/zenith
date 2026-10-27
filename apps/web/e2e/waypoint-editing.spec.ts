/**
 * Issue #134: waypoints can be moved, added, renamed and deleted in the editor, and Save writes
 * waypoints.json wherever the project can write it.
 *
 * In the bundled example the start and driveOut's first point both follow the waypoint `start`, at
 * (-13, -63), so the start mark and driveOut's first dot sit on its pin and keep the press there. The
 * pin is selected from the inspector instead, and the selected pin then takes the press: dragging it
 * moves the start and driveOut together, and one Ctrl+Z puts it back. A rename and a delete first say
 * which autos follow the waypoint; a rename points the open auto at the new name, and a delete gives
 * its points poses of their own and says so. Save the full project writes the changed waypoints, a
 * folder project writes them on Save, and host mode turns waypoint editing off with a sentence.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { canonicalize, loadWaypoints } from "@horizon36596/zenith-core";
import { turnOnFeatures } from "./features";
import { installCanvasProbe, nextFrame } from "./qa/helpers";
import { openServedFolder, readServed, serveFolder, starterFiles } from "./opfsProject";

const STARTER = fileURLToPath(new URL("../../../examples/starter/", import.meta.url));
const FAKE_HOST = fileURLToPath(new URL("./fixtures/fake-host.html", import.meta.url));
const read = (path: string): string => readFileSync(join(STARTER, path), "utf8");

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
    `import("/src/state/store.ts").then((m) => { const s = m.getState(); return (${expr}); })`,
  )) as T;
}

interface Waypoint {
  xIn: number;
  yIn: number;
  headingRad: number;
  provenance?: string;
}

const waypoint = (page: Page, name: string): Promise<Waypoint | undefined> =>
  editor<Waypoint | undefined>(page, `s.project.waypoints.waypoints[${JSON.stringify(name)}]`);
const stepEnd = (page: Page, stepId: string, end: "from" | "to"): Promise<unknown> =>
  editor(page, `s.auto.steps.find((step) => step.id === ${JSON.stringify(stepId)}).segments[0].${end}`);

/** Where the planner draws the start and driveOut's first point now, after waypoints are resolved. */
async function drawnStart(page: Page): Promise<{ start: { xIn: number; yIn: number }; driveOut: { xIn: number; yIn: number } }> {
  return (await page.evaluate(
    `import("/src/state/store.ts").then((m) => { const r = m.currentDerived().resolved; return { start: r.startPose, driveOut: r.steps.find((x) => x.id === "driveOut").segments[0].fromPose }; })`,
  )) as { start: { xIn: number; yIn: number }; driveOut: { xIn: number; yIn: number } };
}

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

/** Opens the inspector's Waypoints list, unless it is open already. */
async function openList(page: Page): Promise<void> {
  if (!(await page.getByTestId("inspector-waypoints").isVisible())) {
    await page.getByRole("button", { name: /^Waypoints \(\d+\)/ }).click();
  }
  await expect(page.getByTestId("inspector-waypoints")).toBeVisible();
}

/**
 * Shows every pin (Waypoint pins: All), for a test of what a pin does rather than which pins show:
 * by default the field hides the ones the open auto does not follow, such as park (issue #217).
 */
async function showAllPins(page: Page): Promise<void> {
  await page.evaluate(`import("/src/state/store.ts").then((m) => m.setWaypointPins("all"))`);
  await expect.poll(async () => ((await page.getByTestId("field-canvas").getAttribute("data-pins")) ?? "").split(",")).toContain("park");
}

/**
 * Opens the inspector's list of waypoints and selects one, opening "Other waypoints" when the open
 * auto does not follow it (issue #217).
 */
async function selectFromList(page: Page, name: string): Promise<void> {
  const row = page.getByTestId(`inspector-waypoint-row-${name}`);
  await openList(page);
  const others = page.getByTestId("inspector-waypoints-others");
  if (!(await row.isVisible()) && (await others.count()) > 0 && (await others.getAttribute("aria-expanded")) === "false") {
    await others.click();
  }
  await row.click();
  await expect.poll(() => editor(page, "s.selection")).toEqual({ waypoint: name });
}

/** Drags on the canvas from one field point to another, in small steps as a hand would. */
async function drag(page: Page, from: { xIn: number; yIn: number }, to: { xIn: number; yIn: number }): Promise<void> {
  const a = await worldToScreen(page, from.xIn, from.yIn);
  const b = await worldToScreen(page, to.xIn, to.yIn);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 6 });
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
}

test("dragging the start pin moves the start and driveOut with it, and one undo puts it back", async ({ page }) => {
  await loadExample(page);
  expect(await editor(page, "s.auto.start.pose")).toEqual({ ref: "start" });
  expect(await stepEnd(page, "driveOut", "from")).toEqual({ ref: "start" });

  // On the pin's spot the start mark keeps the press: a click there selects the start.
  const at = await worldToScreen(page, -13, -63);
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => editor(page, "s.selection")).toEqual({ start: true });

  // The start's section leads to the waypoint it follows; selected, the pin takes the press.
  await page.getByTestId("inspector-start-select-waypoint").click();
  await expect.poll(() => editor(page, "s.selection")).toEqual({ waypoint: "start" });
  await expect(page.getByTestId("inspector-waypoint-followers")).toHaveText("2 points here");
  const canvas = page.getByTestId("field-canvas");
  await page.mouse.move(at.x - 4, at.y);
  await page.mouse.move(at.x, at.y);
  await expect(canvas).toHaveCSS("cursor", "move");

  await drag(page, { xIn: -13, yIn: -63 }, { xIn: -37, yIn: -63 });

  const moved = await waypoint(page, "start");
  expect(moved?.xIn).toBeGreaterThan(-39);
  expect(moved?.xIn).toBeLessThan(-35);
  expect(Math.abs((moved?.yIn ?? 0) + 63)).toBeLessThan(1.5);
  expect(moved?.headingRad).toBeCloseTo(1.5708, 4);
  expect(moved?.provenance).toBe("SET FROM EDITOR");
  // Both still follow the waypoint, and both moved with it at once.
  expect(await editor(page, "s.auto.start.pose")).toEqual({ ref: "start" });
  expect(await stepEnd(page, "driveOut", "from")).toEqual({ ref: "start" });
  const drawn = await drawnStart(page);
  expect(drawn.start.xIn).toBeCloseTo(moved?.xIn ?? 0, 6);
  expect(drawn.driveOut.xIn).toBeCloseTo(moved?.xIn ?? 0, 6);
  await expect(page.getByTestId("toolbar-auto-name").getByLabel("Unsaved changes")).toBeVisible();

  // The arrow keys nudge the selected pin, and R turns it.
  await page.keyboard.press("ArrowUp");
  expect((await waypoint(page, "start"))?.yIn).toBeCloseTo((moved?.yIn ?? 0) + 0.5, 6);
  await page.keyboard.press("Control+z");

  // One undo takes the whole drag back.
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await waypoint(page, "start"))?.xIn).toBe(-13);
  expect((await waypoint(page, "start"))?.provenance).toMatch(/^SET FROM EDITOR: starter example/);
  expect((await drawnStart(page)).driveOut.xIn).toBe(-13);
});

/**
 * Issue #217. collect-and-score follows every starter waypoint but park and parkLoadingZone, so the
 * field draws neither: park's spot at (-40, -36) takes no press. Selected from "Other waypoints", park
 * shows and takes the press; once something else is selected it is gone again. The start's waypoint
 * picker still lists every waypoint.
 */
test("the field shows only this auto's waypoints, and a selected other one until it is deselected", async ({ page }) => {
  await loadExample(page);
  const canvas = page.getByTestId("field-canvas");
  const park = await worldToScreen(page, -40, -36);
  const hoverPark = async (): Promise<void> => {
    await page.mouse.move(park.x - 4, park.y);
    await page.mouse.move(park.x, park.y);
  };
  await hoverPark();
  await expect(canvas).not.toHaveCSS("cursor", "move");
  await page.mouse.click(park.x, park.y);
  expect(await editor(page, "s.selection")).not.toEqual({ waypoint: "park" });
  // toOtherSide passes near park, so the click may have picked the path: start the list from nothing selected.
  await editor(page, "m.setSelection({})");

  // The list leads with the 7 this auto follows; the other 2 wait behind a closed group.
  await openList(page);
  const others = page.getByTestId("inspector-waypoints-others");
  await expect(others).toHaveText(/^Other waypoints\s*2$/);
  await expect(others).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("inspector-waypoint-row-start")).toBeVisible();
  await expect(page.getByTestId("inspector-waypoint-row-park")).toHaveCount(0);
  // Both are followed by another starter auto, so neither is called unused.
  await others.click();
  await expect(page.getByTestId("inspector-waypoint-row-park")).toBeVisible();
  await expect(page.getByTestId("inspector-waypoint-unused-park")).toHaveCount(0);

  await selectFromList(page, "park");
  await hoverPark();
  await expect(canvas).toHaveCSS("cursor", "move");

  // Deselected, it hides again and its spot takes no press.
  await page.getByTestId("step-row-driveOut").getByRole("button").first().click();
  await hoverPark();
  await expect(canvas).not.toHaveCSS("cursor", "move");

  // The start's picker still lists every waypoint, the hidden ones included.
  const start = await worldToScreen(page, -12, -63);
  await page.mouse.click(start.x, start.y);
  await expect.poll(() => editor(page, "s.selection")).toEqual({ start: true });
  const options = await page.getByTestId("inspector-start-source").locator("optgroup option").allTextContents();
  expect(options).toContain("park");
  expect(options).toContain("parkLoadingZone");
  expect(options).toHaveLength(9);
});

test("a waypoint no auto follows says so in the list, and stays in waypoints.json", async ({ page }) => {
  await loadExample(page);
  // A waypoint that nothing follows, as an old one left behind by a deleted path is.
  await page.evaluate(
    `import("/src/state/store.ts").then((m) => { const s = m.getState(); const w = s.project.waypoints; m.commitWithWaypoints(s.auto, { ...w, waypoints: { ...w.waypoints, oldSpot: { xIn: 24, yIn: 24, headingRad: 0, provenance: "PLACEHOLDER: test" } } }); })`,
  );
  await openList(page);
  await expect(page.getByTestId("inspector-waypoints-others")).toHaveText(/^Other waypoints\s*3$/);
  await page.getByTestId("inspector-waypoints-others").click();
  await expect(page.getByTestId("inspector-waypoint-unused-oldSpot")).toHaveText("Not used by any auto");
  await expect(page.getByTestId("inspector-waypoint-unused-park")).toHaveCount(0);
  expect(await waypoint(page, "oldSpot")).toMatchObject({ xIn: 24, yIn: 24 });
});

test("a rename says which autos follow the waypoint and points this auto at the new name", async ({ page }) => {
  await loadExample(page);
  await selectFromList(page, "scoreSouth");
  await page.getByTestId("inspector-waypoint-more-scoreSouth").click();
  await page.getByTestId("inspector-waypoint-menu").locator('[data-action="waypoint.rename"]').click();

  const dialog = page.getByTestId("waypoint-dialog");
  await expect(page.getByTestId("waypoint-dialog-followers")).toContainText("In this auto, point 1 of driveOut follows scoreSouth.");
  await expect(page.getByTestId("waypoint-dialog-followers")).toContainText(
    "all-step-kinds.auto.json, cycle-and-park.auto.json and first-auto.auto.json follow scoreSouth too, and are not changed here",
  );
  const name = page.getByTestId("waypoint-dialog-name");
  await name.fill("park");
  await expect(page.getByTestId("waypoint-dialog-problem")).toHaveText("There is already a waypoint named park.");
  await expect(page.getByTestId("waypoint-dialog-confirm")).toBeDisabled();
  await name.fill("southScore");
  await page.getByTestId("waypoint-dialog-confirm").click();
  await expect(dialog).toHaveCount(0);

  await expect(page.getByTestId("status")).toContainText(
    "Renamed waypoint scoreSouth to southScore. The point in this auto that followed it follows southScore now.",
  );
  expect(await stepEnd(page, "driveOut", "to")).toEqual({ ref: "southScore" });
  expect(await waypoint(page, "scoreSouth")).toBeUndefined();
  expect(await waypoint(page, "southScore")).toMatchObject({ xIn: -13, yIn: -36 });
  // It keeps its place in the file.
  expect((await editor<string[]>(page, "Object.keys(s.project.waypoints.waypoints)"))[1]).toBe("southScore");
  expect(await editor(page, "s.selection")).toEqual({ waypoint: "southScore" });

  await page.keyboard.press("Control+z");
  await expect.poll(() => stepEnd(page, "driveOut", "to")).toEqual({ ref: "scoreSouth" });
  expect(await waypoint(page, "southScore")).toBeUndefined();
});

test("a delete unlinks this auto's points to poses of their own and says so, and undo brings it back", async ({ page }) => {
  await loadExample(page);
  await selectFromList(page, "flowerNorthApproach");
  await page.getByTestId("inspector-waypoint-more-flowerNorthApproach").click();
  await page.getByTestId("inspector-waypoint-menu").locator('[data-action="waypoint.delete"]').click();

  const followers = page.getByTestId("waypoint-dialog-followers");
  await expect(followers).toContainText("In this auto, point 1 of toOtherSide follows flowerNorthApproach.");
  await expect(followers).toContainText("It keeps the waypoint's pose as its own.");
  await expect(followers).not.toContainText("too");
  await page.getByTestId("waypoint-dialog-confirm").click();

  await expect(page.getByTestId("status")).toContainText(
    "Deleted waypoint flowerNorthApproach. Point 1 of toOtherSide no longer follows waypoint flowerNorthApproach. Undo links it again.",
  );
  expect(await waypoint(page, "flowerNorthApproach")).toBeUndefined();
  const end = (await stepEnd(page, "toOtherSide", "to")) as Waypoint;
  expect(end).toMatchObject({ xIn: -24, yIn: 46, headingRad: 1.5708 });
  expect(end.provenance).toMatch(/^PLACEHOLDER: starter example/);
  expect(await editor(page, "s.selection")).toEqual({});
  // Nothing follows a waypoint that is gone.
  const missing = await page.evaluate(
    `import("/src/state/store.ts").then((m) => m.currentDerived().findings.filter((f) => /No waypoint named/.test(f.message)).length)`,
  );
  expect(missing).toBe(0);

  await page.keyboard.press("Control+z");
  await expect.poll(() => stepEnd(page, "toOtherSide", "to")).toEqual({ ref: "flowerNorthApproach" });
  expect(await waypoint(page, "flowerNorthApproach")).toMatchObject({ xIn: -24, yIn: 46 });
});

const waypointCount = (page: Page): Promise<number> => editor<number>(page, "Object.keys(s.project.waypoints.waypoints).length");

test("Delete on a selected pin opens the delete dialog with focus on Delete, and Enter deletes it; Undo brings it back selected", async ({ page }) => {
  await loadExample(page);
  await selectFromList(page, "park");
  expect(await waypointCount(page)).toBe(9);

  await page.keyboard.press("Delete");
  const confirm = page.getByTestId("waypoint-dialog-confirm");
  await expect(page.getByTestId("waypoint-dialog")).toBeVisible();
  await expect(confirm).toBeFocused();
  // Nothing goes until the dialog is answered.
  expect(await waypointCount(page)).toBe(9);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("waypoint-dialog")).toHaveCount(0);
  expect(await waypointCount(page)).toBe(8);
  await expect(page.getByTestId("status")).toContainText("Deleted waypoint park.");

  await page.keyboard.press("Control+z");
  await expect.poll(() => waypointCount(page)).toBe(9);
  expect(await editor(page, "s.selection")).toEqual({ waypoint: "park" });
  await expect(page.getByTestId("status")).toHaveText(/Waypoint park is back\./);
  await expect(page.getByTestId("status")).not.toContainText("Deleted");
});

test("Backspace on a selected pin behaves like Delete", async ({ page }) => {
  await loadExample(page);
  await selectFromList(page, "park");
  await page.keyboard.press("Backspace");
  await expect(page.getByTestId("waypoint-dialog-confirm")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => waypointCount(page)).toBe(8);
});

test("Delete in the Inspector's number field edits the field and does not open the dialog", async ({ page }) => {
  await loadExample(page);
  await selectFromList(page, "park");
  const field = page.getByTestId("inspector-waypoint-x");
  await field.fill("-44");
  await field.press("End");
  await page.keyboard.press("Delete");
  await page.keyboard.press("Backspace");
  await expect(page.getByTestId("waypoint-dialog")).toHaveCount(0);
  expect(await waypointCount(page)).toBe(9);
  // The field itself took the keys: Delete at the end does nothing, Backspace drops the last digit.
  await expect(field).toHaveValue("-4");
});

test("the palette names the delete 'Delete waypoint…' for a pin, and 'Delete step' for a step", async ({ page }) => {
  await loadExample(page);
  await selectFromList(page, "park");
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("delete");
  await expect(page.getByTestId("palette-item-waypoint.delete")).toContainText("Delete waypoint…");
  await page.keyboard.press("Escape");
  await page.getByTestId("step-row-driveOut").click();
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("delete");
  await expect(page.getByTestId("palette-item-edit.delete")).toContainText("Delete step");
});

test("keys do not run behind the open delete dialog, and Escape cancels it", async ({ page }) => {
  await loadExample(page);
  await selectFromList(page, "park");
  await moveInStore(page, "park", -44, -60);
  const moved = await waypoint(page, "park");
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("waypoint-dialog")).toBeVisible();
  // Ctrl+Z would undo the move behind the dialog and leave its list of followers stale.
  await page.keyboard.press("Control+z");
  expect(await waypoint(page, "park")).toEqual(moved);
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByTestId("waypoint-dialog-cancel")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("waypoint-dialog")).toHaveCount(0);
  expect(await waypointCount(page)).toBe(9);
});

/** Where waypoint `name` is, in field inches, from the project's waypoints. */
const pinAt = (page: Page, name: string): Promise<{ xIn: number; yIn: number; headingRad: number }> =>
  editor(page, `s.project.waypoints.waypoints[${JSON.stringify(name)}]`);

/** Right-clicks the field at a spot in field inches and waits for the menu. */
async function rightClickAt(page: Page, xIn: number, yIn: number): Promise<void> {
  const at = await worldToScreen(page, xIn, yIn);
  await page.mouse.move(at.x - 3, at.y);
  await page.mouse.click(at.x, at.y, { button: "right" });
  await expect(page.getByTestId("canvas-context-menu")).toBeVisible();
}

const menuItem = (page: Page, id: string) => page.getByTestId("canvas-context-menu").locator(`[data-action="${id}"]`);

test("right-clicking the unselected pin park selects it and shows the pin's own menu", async ({ page }) => {
  await loadExample(page);
  await showAllPins(page);
  expect(await editor(page, "s.selection")).toEqual({});
  const park = await pinAt(page, "park");
  await rightClickAt(page, park.xIn, park.yIn);
  await expect.poll(() => editor(page, "s.selection")).toEqual({ waypoint: "park" });
  const menu = page.getByTestId("canvas-context-menu");
  await expect(menuItem(page, "waypoint.rename")).toHaveText(/Rename…/);
  await expect(menuItem(page, "waypoint.delete")).toHaveText(/Delete…/);
  await expect(menuItem(page, "waypoint.copyPosition")).toHaveText("Copy position");
  // A greyed item shows its reason in its row (issue #412).
  await expect(menuItem(page, "waypoint.selectFollowers")).toHaveText("Select the points that follow itNothing in this auto follows park.");
  // The zooms are the field's corner controls and F since issue #412; the Inspector's ⋯ keeps Zoom to it.
  await expect(menu.getByText("Zoom to it")).toHaveCount(0);
  await expect(menu.getByText("Add a path here")).toHaveCount(0);
  // Nothing in this auto follows park, so there is nothing to select.
  await expect(menuItem(page, "waypoint.selectFollowers")).toHaveAttribute("aria-disabled", "true");
});

test("Rename… on a pin's menu opens the rename dialog, and Delete… the delete dialog", async ({ page }) => {
  await loadExample(page);
  await showAllPins(page);
  const park = await pinAt(page, "park");
  await rightClickAt(page, park.xIn, park.yIn);
  await menuItem(page, "waypoint.rename").click();
  await expect(page.getByTestId("waypoint-dialog")).toBeVisible();
  await expect(page.getByTestId("waypoint-dialog-name")).toHaveValue("park");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("waypoint-dialog")).toHaveCount(0);
  await rightClickAt(page, park.xIn, park.yIn);
  await menuItem(page, "waypoint.delete").click();
  await expect(page.getByTestId("waypoint-dialog-confirm")).toBeFocused();
  await page.keyboard.press("Escape");
  expect(await waypointCount(page)).toBe(9);
});

const COVERED = ["start", "scoreSouth", "scoreNorth", "flowerNorthApproach", "flowerNorthPickup", "gardenSweepEnd", "gardenSweepStart"];

for (const name of COVERED) {
  test(`right-clicking the dot or start mark on ${name} reaches waypoint ${name}, and selects it`, async ({ page }) => {
    await loadExample(page);
    const at = await pinAt(page, name);
    await rightClickAt(page, at.xIn, at.yIn);
    const menu = page.getByTestId("canvas-context-menu");
    // The pin the dot follows is a group of its own, "Waypoint X" (issue #412); a pin it only
    // covers is a "Select waypoint X" row.
    const group = menu.getByTestId("canvas-menu-group").filter({ hasText: new RegExp(`^Waypoint ${name}$`) });
    const near = menu.locator(`[data-action="waypoint.select:${name}"]`);
    await expect(group.or(near)).toBeVisible();
    if ((await group.count()) > 0) {
      await expect(menu.locator('[data-action="waypoint.followRename"]')).toHaveText(/Rename…/);
      await menu.locator('[data-action="waypoint.followSelect"]').click();
    } else {
      await near.click();
    }
    await expect.poll(() => editor(page, "s.selection")).toEqual({ waypoint: name });
  });
}

test("Rename… under Waypoint X on a dot opens the rename dialog for the waypoint it follows", async ({ page }) => {
  await loadExample(page);
  const at = await pinAt(page, "scoreSouth");
  await rightClickAt(page, at.xIn, at.yIn);
  const menu = page.getByTestId("canvas-context-menu");
  await expect(menu.getByTestId("canvas-menu-group").filter({ hasText: "Waypoint scoreSouth" })).toBeVisible();
  await menu.locator('[data-action="waypoint.followRename"]').click();
  await expect(page.getByTestId("waypoint-dialog-name")).toHaveValue("scoreSouth");
});

test("a point with a pose of its own offers Save as waypoint…, which opens the add dialog", async ({ page }) => {
  await loadExample(page);
  // "Add a path to here" writes a new end with a pose of its own, away from every waypoint.
  await rightClickAt(page, 30, 0);
  await menuItem(page, "field.addPathHere").click();
  const end = await editor<{ xIn: number; yIn: number }>(
    page,
    "s.auto.steps[s.auto.steps.length - 1].segments[0].to",
  );
  expect(end).toHaveProperty("xIn");
  await rightClickAt(page, end.xIn, end.yIn);
  const save = page.getByTestId("canvas-context-menu").getByText("Save as waypoint…", { exact: true });
  await expect(save).toBeVisible();
  await save.click();
  await expect(page.getByTestId("waypoint-dialog")).toBeVisible();
  await expect(page.getByTestId("waypoint-dialog-name")).toBeVisible();
});

test("double-clicking a pin opens the rename dialog and leaves the pin where it was", async ({ page }) => {
  await loadExample(page);
  await showAllPins(page);
  const park = await pinAt(page, "park");
  const at = await worldToScreen(page, park.xIn, park.yIn);
  await page.mouse.dblclick(at.x, at.y);
  await expect(page.getByTestId("waypoint-dialog")).toBeVisible();
  await expect(page.getByTestId("waypoint-dialog-name")).toHaveValue("park");
  expect(await pinAt(page, "park")).toEqual(park);
  expect(await editor(page, "s.undo.length")).toBe(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("waypoint-dialog")).toHaveCount(0);
  expect(await pinAt(page, "park")).toEqual(park);
});

test("F2 with a pin selected opens the rename dialog, and with nothing selected does nothing", async ({ page }) => {
  await loadExample(page);
  await page.keyboard.press("F2");
  await expect(page.getByTestId("waypoint-dialog")).toHaveCount(0);
  await selectFromList(page, "park");
  const park = await pinAt(page, "park");
  await page.keyboard.press("F2");
  await expect(page.getByTestId("waypoint-dialog-name")).toHaveValue("park");
  expect(await pinAt(page, "park")).toEqual(park);
});

test("Copy position writes the pose as the files write it", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          (window as unknown as { __copied: string }).__copied = text;
          return Promise.resolve();
        },
      },
    });
  });
  await loadExample(page);
  const south = await pinAt(page, "scoreSouth");
  await selectFromList(page, "scoreSouth");
  await rightClickAt(page, south.xIn, south.yIn);
  await menuItem(page, "waypoint.copyPosition").click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __copied?: string }).__copied))
    .toBe(JSON.stringify({ xIn: south.xIn, yIn: south.yIn, headingRad: south.headingRad }));
});

test("Select the points that follow it selects the points that follow scoreSouth", async ({ page }) => {
  await loadExample(page);
  await selectFromList(page, "scoreSouth");
  const south = await pinAt(page, "scoreSouth");
  await rightClickAt(page, south.xIn, south.yIn);
  await menuItem(page, "waypoint.selectFollowers").click();
  // In the example, driveOut's end is the one point of this auto that follows scoreSouth.
  await expect.poll(() => editor(page, "s.selection")).toEqual({ stepId: "driveOut", point: { segmentIndex: 0, pointKind: "to" } });
});

test("hovering a dot that follows scoreSouth says it follows the waypoint", async ({ page }) => {
  await installCanvasProbe(page);
  await loadExample(page);
  const south = await pinAt(page, "scoreSouth");
  const at = await worldToScreen(page, south.xIn, south.yIn);
  await page.mouse.move(at.x - 6, at.y);
  await page.mouse.move(at.x, at.y);
  await expect
    .poll(async () => (await nextFrame(page)).texts.some((text) => text.includes("follows waypoint scoreSouth")))
    .toBe(true);
});

test("the palette lists Rename waypoint and Delete waypoint while a pin is selected", async ({ page }) => {
  await loadExample(page);
  await selectFromList(page, "park");
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("waypoint");
  await expect(page.getByTestId("palette-item-waypoint.rename")).toContainText("Rename waypoint");
  await expect(page.getByTestId("palette-item-waypoint.delete")).toContainText("Delete waypoint");
  await expect(page.getByTestId("palette-item-waypoint.rename")).not.toHaveAttribute("aria-disabled", "true");
});

test("Save as waypoint makes one from the start, which then follows it", async ({ page }) => {
  await loadExample(page);
  const at = await worldToScreen(page, -13, -63);
  await page.mouse.click(at.x, at.y);
  // A start that follows a waypoint already has one; as a pose of its own it can be saved as one.
  await expect(page.getByTestId("inspector-start-save-waypoint")).toHaveCount(0);
  await page.getByTestId("inspector-start-source").selectOption("pose");
  await page.getByTestId("inspector-start-save-waypoint").click();

  const name = page.getByTestId("waypoint-dialog-name");
  await expect(name).toHaveValue("start-2");
  await name.fill("home");
  await page.getByTestId("waypoint-dialog-confirm").click();

  await expect(page.getByTestId("status")).toContainText("Saved the start as waypoint home. The start now follows it.");
  expect(await editor(page, "s.auto.start.pose")).toEqual({ ref: "home" });
  const home = await waypoint(page, "home");
  expect(home).toMatchObject({ xIn: -13, yIn: -63, headingRad: 1.5708 });
  expect(home?.provenance).toMatch(/^SET FROM EDITOR: starter example/);
  expect((await editor<string[]>(page, "Object.keys(s.project.waypoints.waypoints)")).at(-1)).toBe("home");

  await page.keyboard.press("Control+z");
  await expect.poll(() => waypoint(page, "home")).toBeUndefined();
});

test("the example's full project saves the changed waypoints, and Just this auto waits for them", async ({ page }) => {
  await serveFolder(page, {});
  await loadExample(page);
  await selectFromList(page, "park");
  await page.getByTestId("inspector-waypoint-x").fill("-44");
  await page.getByTestId("inspector-waypoint-x").press("Enter");
  await expect.poll(async () => (await waypoint(page, "park"))?.xIn).toBe(-44);

  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("save-choice")).toBeVisible();
  await expect(page.getByTestId("save-choice-auto")).toBeDisabled();
  await expect(page.getByTestId("save-choice-auto-detail")).toContainText("Your waypoint changes are saved only with the full project");
  await page.getByTestId("save-choice-project").click();
  await expect(page.getByTestId("status")).toContainText("Saved the project to robot-repo and opened it.");

  const saved = await readServed(page, "autos/waypoints.json");
  const starter = loadWaypoints(JSON.parse(read("autos/waypoints.json")));
  const park = starter.waypoints["park"];
  if (park === undefined) throw new Error("the starter has no park waypoint");
  expect(saved).toBe(canonicalize("waypoints", { ...starter, waypoints: { ...starter.waypoints, park: { ...park, xIn: -44 } } }));
  // A typed number keeps the label it had, as a point's typed numbers do.
  expect((JSON.parse(saved) as { waypoints: Record<string, Waypoint> }).waypoints["park"]?.provenance).toMatch(/^PLACEHOLDER/);
  await expect(page.getByTestId("toolbar-auto-name").getByLabel("Unsaved changes")).toHaveCount(0);
});

test("a folder project writes waypoints.json on Save", async ({ page }) => {
  await serveFolder(page, starterFiles());
  await page.goto("/");
  await openServedFolder(page);
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await selectFromList(page, "start");

  await page.getByTestId("field-canvas").focus();
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("r");
  const moved = await waypoint(page, "start");
  expect(moved?.xIn).toBeCloseTo(-15, 6);
  expect(moved?.provenance).toBe("SET FROM EDITOR");
  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("toolbar-auto-name").getByLabel("Unsaved changes")).toHaveCount(0);

  const saved = JSON.parse(await readServed(page, "autos/waypoints.json")) as { waypoints: Record<string, Waypoint> };
  expect(saved.waypoints["start"]).toMatchObject({ xIn: -15, yIn: -63, provenance: "SET FROM EDITOR" });
  expect(saved.waypoints["start"]?.headingRad).toBeCloseTo(1.5708 + (5 * Math.PI) / 180, 4);
  // Every other waypoint is written as it was, in canonical form.
  const before = JSON.parse(starterFiles()["autos/waypoints.json"] ?? "{}") as { waypoints: Record<string, Waypoint> };
  expect(Object.keys(saved.waypoints)).toEqual(Object.keys(before.waypoints));
  expect(saved.waypoints["park"]).toEqual(before.waypoints["park"]);
});

/** The starter's folder with every starter auto in it, so a waypoint has other autos that follow it. */
function allAutos(): Record<string, string> {
  const autos = ["all-step-kinds", "collect-and-score", "cycle-and-park"].map((name) => `autos/${name}.auto.json`);
  return { ...starterFiles(), ...Object.fromEntries(autos.map((path) => [path, read(path).replace(/\r\n/g, "\n")])) };
}

/** Moves a waypoint as the inspector's numbers do, through the dev server's module graph. */
async function moveInStore(page: Page, name: string, xIn: number, yIn: number): Promise<void> {
  await page.evaluate(
    `import("/src/app/waypointEdits.ts").then((m) => m.moveWaypoint(${JSON.stringify(name)}, { xIn: ${String(xIn)}, yIn: ${String(yIn)} }, "drag"))`,
  );
}

test("moving a shared waypoint says which other autos it breaks, in the inspector and when Save writes it", async ({ page }) => {
  await serveFolder(page, allAutos());
  await page.goto("/");
  await openServedFolder(page);
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  expect(await editor(page, "s.fileName")).toBe("all-step-kinds.auto.json");
  await selectFromList(page, "gardenSweepStart");
  // Before any change the line only counts the other autos that follow it; its hint names them.
  await expect(page.getByTestId("inspector-waypoint-others")).toHaveText("2 other autos");
  await page.getByTestId("inspector-waypoint-used-by").hover();
  await expect(page.getByRole("tooltip")).toContainText("In other autos: collect-and-score and cycle-and-park.");

  await moveInStore(page, "gardenSweepStart", -54, -58);
  await expect(page.getByTestId("inspector-waypoint-others")).toHaveText("2 other autos, 1 new error");
  await page.mouse.move(0, 0);
  await page.getByTestId("inspector-waypoint-used-by").hover();
  await expect(page.getByRole("tooltip")).toContainText("In other autos: cycle-and-park (1 new error) and collect-and-score.");

  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("status")).toContainText(
    "Saved all-step-kinds.auto.json and waypoints.json. cycle-and-park now has 1 error.",
  );
  const saved = JSON.parse(await readServed(page, "autos/waypoints.json")) as { waypoints: Record<string, Waypoint> };
  expect(saved.waypoints["gardenSweepStart"]).toMatchObject({ xIn: -54, yIn: -58 });
});

test("a waypoint-only edit, then switching autos, asks about waypoints.json and not the auto", async ({ page }) => {
  await serveFolder(page, allAutos());
  await page.goto("/");
  await openServedFolder(page);
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await moveInStore(page, "gardenSweepStart", -54, -58);

  await page.evaluate(`import("/src/app/projectActions.ts").then((m) => { void m.openAutoNamed("first-auto.auto.json"); })`);
  const question = page.getByTestId("unsaved-dialog");
  await expect(question).toContainText(
    "waypoints.json has changes that are not saved (2 other autos follow gardenSweepStart). Discard puts them back.",
  );
  await expect(question).not.toContainText("has edits that are not saved");
  await page.getByTestId("unsaved-cancel").click();
  await expect(question).toHaveCount(0);
});

test("dragging a waypoint pin says which label it replaced and which other autos follow it", async ({ page }) => {
  await loadExample(page);
  await selectFromList(page, "park");
  await drag(page, { xIn: -40, yIn: -36 }, { xIn: -30, yIn: -36 });
  const status = page.getByTestId("status");
  await expect(status).toContainText("Moved waypoint park, which was PLACEHOLDER: starter example");
  await expect(status).toContainText("it is now SET FROM EDITOR.");
  await expect(status).toContainText("all-step-kinds and first-auto follow it too, so they move with it.");
  await expect(status).toContainText("Ctrl+Z puts it back.");
});

test("host mode turns waypoint editing off and says why", async ({ page, context }) => {
  // The popup Zenith opens in gets the same settings as the page.
  await context.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
    }
  });
  await turnOnFeatures(context);
  await page.route("**/__fake-host.html", (route) =>
    route.fulfill({ contentType: "text/html", body: readFileSync(FAKE_HOST, "utf8") }),
  );
  await page.goto("/__fake-host.html");
  const popup = page.waitForEvent("popup");
  await page.evaluate(() => {
    (window as unknown as { openZenith: (path: string) => void }).openZenith("/?host=dsim");
  });
  const zenith = await popup;
  await zenith.setViewportSize({ width: 1440, height: 900 });
  // The project goes once Zenith says it is ready.
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { received: Array<{ data: { type: string } }> }).received.some((message) => message.data.type === "ready")),
    )
    .toBe(true);
  await page.evaluate((data) => {
    (window as unknown as { sendToZenith: (message: unknown) => void }).sendToZenith(data);
  }, {
    type: "open",
    protocol: "zenith-host/1",
    project: {
      name: "starter",
      robot: JSON.parse(read("autos/robot.json")) as unknown,
      field: read("autos/field/biobuzz.field.json"),
      waypoints: read("autos/waypoints.json"),
      autos: { "collect-and-score": read("autos/collect-and-score.auto.json") },
    },
    open: "collect-and-score",
    readOnlyRobot: true,
  });
  await expect(zenith.getByTestId("step-row-driveOut")).toBeVisible();

  await selectFromList(zenith, "start");
  const why = "Waypoints are read only here: DSIM takes back only the autos, so a change to waypoints.json could not be saved.";
  await expect(zenith.getByTestId("inspector-waypoints-note")).toHaveText(why);
  // The pin's own menu offers Rename and Delete greyed, with the same reason.
  await zenith.getByTestId("inspector-waypoint-more-start").click();
  await expect(zenith.getByTestId("inspector-waypoint-menu").locator('[data-action="waypoint.rename"]')).toHaveAttribute("aria-disabled", "true");
  await expect(zenith.getByTestId("inspector-waypoint-menu").locator('[data-action="waypoint.delete"]')).toHaveAttribute("aria-disabled", "true");
  await zenith.keyboard.press("Escape");
  await expect(zenith.getByTestId("inspector-waypoint-x")).toBeDisabled();

  // The keys do not move the selected pin either, and say why.
  await zenith.getByTestId("field-canvas").focus();
  await zenith.keyboard.press("ArrowLeft");
  await expect(zenith.getByTestId("status")).toContainText(why);
  expect((await waypoint(zenith, "start"))?.xIn).toBe(-13);
});

// ---- Issue #234: Add waypoint here on the field. ----

/** Whether waypoints.json has unsaved changes. */
async function waypointsDirty(page: Page): Promise<boolean> {
  return (await page.evaluate(`import("/src/state/store.ts").then((m) => m.waypointsDirty())`)) as boolean;
}

test("Add waypoint here opens Add waypoint with waypoint1 selected, and Enter adds it at the snapped spot without a step", async ({ page }) => {
  await loadExample(page);
  const stepsBefore = await editor<number>(page, "s.auto.steps.length");
  const autoBefore = await editor<string>(page, "JSON.stringify(s.auto)");
  const countBefore = await waypointCount(page);

  await rightClickAt(page, 30, 0);
  const item = menuItem(page, "field.addWaypointHere");
  await expect(item).toHaveText(/Add a waypoint here/);
  await expect(item).not.toHaveAttribute("aria-disabled", "true");
  await item.click();

  const dialog = page.getByTestId("waypoint-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Add waypoint");
  const name = page.getByTestId("waypoint-dialog-name");
  await expect(name).toHaveValue("waypoint1");
  await expect(name).toBeFocused();
  // The suggested name is selected, so typing replaces it and Enter takes it.
  expect(await name.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([0, 9]);
  expect(await waypointCount(page)).toBe(countBefore);

  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  expect(await waypointCount(page)).toBe(countBefore + 1);
  const made = await waypoint(page, "waypoint1");
  expect(made?.provenance).toBe("SET FROM EDITOR");
  expect(made?.xIn).toBeCloseTo(30, 0);
  expect(await editor(page, "s.selection")).toEqual({ waypoint: "waypoint1" });
  // The auto has the same steps and is unchanged: only waypoints.json is unsaved.
  expect(await editor<number>(page, "s.auto.steps.length")).toBe(stepsBefore);
  expect(await editor<string>(page, "JSON.stringify(s.auto)")).toBe(autoBefore);
  expect(await waypointsDirty(page)).toBe(true);
  expect(await editor<number>(page, "s.undo.length")).toBe(1);

  await page.keyboard.press("Control+z");
  await expect.poll(() => waypoint(page, "waypoint1")).toBeUndefined();
  expect(await waypointCount(page)).toBe(countBefore);
  expect(await waypointsDirty(page)).toBe(false);
});

test("Add waypoint here is greyed with the pin's name where the spot snaps onto a waypoint", async ({ page }) => {
  await loadExample(page);
  // The start mark covers the pin start: the menu there keeps the field's items.
  await rightClickAt(page, -13, -63);
  const item = menuItem(page, "field.addWaypointHere");
  await expect(item).toHaveAttribute("aria-disabled", "true");
  await item.hover();
  await expect(page.getByRole("tooltip")).toContainText("Waypoint start is already here.");
});

test("Save as waypoint suggests start for the start and the step's id and End for a path's end", async ({ page }) => {
  await loadExample(page);
  const startAt = await worldToScreen(page, -13, -63);
  await page.mouse.click(startAt.x, startAt.y);
  await page.getByTestId("inspector-start-source").selectOption("pose");
  await page.getByTestId("inspector-start-save-waypoint").click();
  // The example already has a waypoint named start, so the suggestion is made unique.
  await expect(page.getByTestId("waypoint-dialog-name")).toHaveValue("start-2");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("waypoint-dialog")).toHaveCount(0);

  // A path end with a pose of its own, from Add a path to here, is named for its step.
  await rightClickAt(page, 30, 0);
  await menuItem(page, "field.addPathHere").click();
  const stepId = await editor<string>(page, "s.auto.steps[s.auto.steps.length - 1].id");
  const end = await editor<{ xIn: number; yIn: number }>(page, "s.auto.steps[s.auto.steps.length - 1].segments[0].to");
  await rightClickAt(page, end.xIn, end.yIn);
  await page.getByTestId("canvas-context-menu").getByText("Save as waypoint…", { exact: true }).click();
  await expect(page.getByTestId("waypoint-dialog-name")).toHaveValue(`${stepId}End`);
});

test("the palette's Add waypoint waits for a click on the field, then asks for the name; Escape cancels", async ({ page }) => {
  await loadExample(page);
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Add waypoint");
  await expect(page.getByTestId("palette-item-waypoint.add")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("status")).toContainText("Click the field to place the waypoint. Esc cancels.");
  // The field's own line says so too, while it waits for the click.
  await expect(page.getByTestId("canvas-tool-hint")).toHaveText("Add waypoint: click the field to place it. Esc to cancel");

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("status")).toContainText("cancelled");
  await expect(page.getByText("Add waypoint: click the field to place it. Esc to cancel")).toHaveCount(0);
  const away = await worldToScreen(page, 30, 0);
  await page.mouse.click(away.x, away.y);
  await expect(page.getByTestId("waypoint-dialog")).toHaveCount(0);

  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Add waypoint");
  await page.keyboard.press("Enter");
  const stepsBefore = await editor<number>(page, "s.auto.steps.length");
  await page.mouse.click(away.x, away.y);
  await expect(page.getByTestId("waypoint-dialog-name")).toHaveValue("waypoint1");
  await page.keyboard.press("Enter");
  await expect.poll(() => waypoint(page, "waypoint1")).toBeDefined();
  expect(await editor<number>(page, "s.auto.steps.length")).toBe(stepsBefore);
});

/** Whether the palette's Add waypoint is armed. */
async function placing(page: Page): Promise<boolean> {
  return (await page.evaluate(`import("/src/state/ui.ts").then((m) => m.getUi().placingWaypoint)`)) as boolean;
}

test("Esc closes the palette over an armed Add waypoint first, and picking another tool disarms it", async ({ page }) => {
  await loadExample(page);
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Add waypoint");
  await page.keyboard.press("Enter");
  await expect.poll(() => placing(page)).toBe(true);

  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("palette-input")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("palette-input")).toHaveCount(0);
  expect(await placing(page)).toBe(true);
  await expect(page.getByTestId("status")).not.toContainText("cancelled");

  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Measure");
  await expect(page.getByTestId("palette-item-tool.measure")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect.poll(() => placing(page)).toBe(false);
  const away = await worldToScreen(page, 30, 0);
  await page.mouse.click(away.x, away.y);
  await expect(page.getByTestId("waypoint-dialog")).toHaveCount(0);
});
