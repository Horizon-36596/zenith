/**
 * Issue #236: hiding waypoint pins. The show mode (all, the pins this auto uses, or none) and a
 * per-pin Hide or Show decide which pins the field draws, hit tests and snaps onto. The canvas
 * publishes the pins the pointer can reach as `data-pins`, from the same list its hit scene holds.
 * Hiding is a view choice: waypoints.json, the undo history and the unsaved state never change, the
 * choice survives a reload, and the downloaded SVG leaves the hidden pins out too.
 */
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { loadAuto, waypointsUsed } from "@horizon36596/zenith-core";
import { turnOnFeatures } from "./features";

const EXAMPLE = new URL("../../../examples/starter/autos/collect-and-score.auto.json", import.meta.url);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      // These tests start from every pin shown; the default is This auto's (issues #211 and #217).
      window.localStorage.setItem(
        "zenith.ui",
        JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false }, waypointPins: "all" }),
      );
    }
  });
  await turnOnFeatures(page);
});

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

/** The pins the pointer can reach now, sorted, as the canvas publishes them. */
async function pins(page: Page): Promise<string[]> {
  const value = (await page.getByTestId("field-canvas").getAttribute("data-pins")) ?? "";
  return value === "" ? [] : value.split(",").sort();
}

/** waypoints.json as the editor holds it, whether anything is unsaved, and how many undo steps there are. */
const fileState = (page: Page): Promise<{ waypoints: string; dirty: boolean; undo: number }> =>
  page.evaluate(
    `import("/src/state/store.ts").then((m) => { const s = m.getState(); return { waypoints: JSON.stringify(s.project.waypoints), dirty: m.isDirty(), undo: s.undo.length }; })`,
  ) as Promise<{ waypoints: string; dirty: boolean; undo: number }>;

async function worldToScreen(page: Page, xIn: number, yIn: number): Promise<{ x: number; y: number }> {
  const canvas = page.getByTestId("field-canvas");
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("the canvas has no box");
  const pxPerIn = Number(await canvas.getAttribute("data-px-per-in"));
  const originXPx = Number(await canvas.getAttribute("data-origin-x-px"));
  const originYPx = Number(await canvas.getAttribute("data-origin-y-px"));
  return { x: box.x + originXPx + pxPerIn * xIn, y: box.y + originYPx - pxPerIn * yIn };
}

async function rightClickAt(page: Page, xIn: number, yIn: number): Promise<void> {
  const at = await worldToScreen(page, xIn, yIn);
  await page.mouse.move(at.x - 3, at.y);
  await page.mouse.click(at.x, at.y, { button: "right" });
  await expect(page.getByTestId("canvas-context-menu")).toBeVisible();
}

const menuItem = (page: Page, id: string) => page.getByTestId("canvas-context-menu").locator(`[data-action="${id}"]`);

async function runFromPalette(page: Page, query: string, id: string): Promise<void> {
  await page.getByTestId("field-canvas").focus();
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill(query);
  await page.getByTestId(`palette-item-${id}`).click();
}

async function selectFromList(page: Page, name: string): Promise<void> {
  const row = page.getByTestId(`inspector-waypoint-row-${name}`);
  if (!(await page.getByTestId("inspector-waypoints").isVisible())) {
    await page.getByRole("button", { name: /^Waypoints \(\d+\)/ }).click();
  }
  // A waypoint this auto does not follow waits under "Other waypoints" (issue #217).
  const others = page.getByTestId("inspector-waypoints-others");
  if (!(await row.isVisible()) && (await others.getAttribute("aria-expanded")) === "false") await others.click();
  await row.click();
  await expect.poll(() => editor(page, "s.selection")).toEqual({ waypoint: name });
}

test("This auto's leaves exactly the pins the auto follows, None leaves only the selected pin, and the file never changes", async ({ page }) => {
  await loadExample(page);
  const before = await fileState(page);
  const all = Object.keys(JSON.parse(before.waypoints).waypoints as Record<string, unknown>).sort();
  await expect.poll(() => pins(page)).toEqual(all);

  // The palette's Waypoint pins goes from All to This auto's.
  await runFromPalette(page, "Waypoint pins", "view.waypointPins");
  await expect.poll(() => editor(page, "s.prefs.waypointPins")).toBe("used");
  const used = waypointsUsed(loadAuto(JSON.parse(readFileSync(EXAMPLE, "utf8")))).sort();
  expect(used.length).toBeLessThan(all.length);
  await expect.poll(() => pins(page)).toEqual(used);

  // The field's right-click Pins choice, None: no pin but the selected one. The menu checks the
  // pins shown now, This auto's (issue #412).
  await rightClickAt(page, 30, 0);
  await expect(menuItem(page, "pins.used")).toHaveAttribute("aria-checked", "true");
  await expect(menuItem(page, "pins.none")).toHaveText(/None/);
  await menuItem(page, "pins.none").click();
  await expect.poll(() => editor(page, "s.prefs.waypointPins")).toBe("none");
  await expect.poll(() => pins(page)).toEqual([]);
  await selectFromList(page, "park");
  await expect.poll(() => pins(page)).toEqual(["park"]);

  expect(await fileState(page)).toEqual(before);
});

test("right-click Hide on park removes its pin, Show brings it back, and a reload keeps each choice", async ({ page }) => {
  await loadExample(page);
  const before = await fileState(page);
  const park = await editor<{ xIn: number; yIn: number }>(page, "s.project.waypoints.waypoints.park");

  await rightClickAt(page, park.xIn, park.yIn);
  await expect.poll(() => editor(page, "s.selection")).toEqual({ waypoint: "park" });
  await expect(menuItem(page, "waypoint.hide")).toHaveText(/^Hide/);
  await menuItem(page, "waypoint.hide").click();
  await expect.poll(() => pins(page)).not.toContain("park");
  expect(await editor(page, "s.selection")).toEqual({});
  expect(await fileState(page)).toEqual(before);

  await page.reload();
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await expect.poll(() => pins(page)).toEqual(expect.arrayContaining(["scoreSouth"]));
  expect(await pins(page)).not.toContain("park");

  // A hidden pin is reached from the list; selected, it is drawn faintly and its menu offers Show.
  await selectFromList(page, "park");
  await expect.poll(() => pins(page)).toContain("park");
  await rightClickAt(page, park.xIn, park.yIn);
  await expect(menuItem(page, "waypoint.hide")).toHaveText(/^Show/);
  await menuItem(page, "waypoint.hide").click();
  await expect.poll(() => editor(page, "s.prefs.waypointPinOverrides")).toEqual({});
  expect(await fileState(page)).toEqual({ ...before, undo: 0 });

  await page.reload();
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await expect.poll(() => pins(page)).toContain("park");
});

test("the downloaded SVG leaves out a hidden pin", async ({ page }) => {
  await loadExample(page);
  await selectFromList(page, "park");
  await runFromPalette(page, "Hide waypoint", "waypoint.hide");
  await expect.poll(() => pins(page)).not.toContain("park");

  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Download picture (SVG)");
  const waiting = page.waitForEvent("download");
  await page.getByTestId("palette-item-project.downloadPictureSvg").click();
  const svg = readFileSync(await (await waiting).path(), "utf8");
  expect(svg).toContain(">scoreSouth</text>");
  expect(svg).not.toContain(">park</text>");
});

test("a hidden pin is no snap target: an Add path click on it writes a pose of its own", async ({ page }) => {
  await loadExample(page);
  const park = await editor<{ xIn: number; yIn: number }>(page, "s.project.waypoints.waypoints.park");
  await page.evaluate(`import("/src/state/store.ts").then((m) => { m.setSelection({}); m.setPrefs({ snap: true }); })`);
  await page.getByTestId("field-canvas").focus();
  await page.keyboard.press("p");
  await expect.poll(() => editor<string>(page, "s.tool")).toBe("addPath");

  // Shown, the pin catches the pointer, as add-path-snap.spec.ts checks.
  const at = await worldToScreen(page, park.xIn, park.yIn);
  const hover = async (): Promise<void> => {
    await page.mouse.move(at.x - 12, at.y + 6);
    await page.mouse.move(at.x, at.y, { steps: 3 });
  };
  const snapNow = async (): Promise<string> => (await page.getByTestId("field-canvas").getAttribute("data-readout-snap")) ?? "";
  await hover();
  await expect.poll(snapNow).toBe("waypoint park");

  // Hidden, the same spot snaps onto nothing named park, and the click follows no waypoint.
  await page.evaluate(`import("/src/state/store.ts").then((m) => m.setWaypointPinShown("park", false))`);
  await expect.poll(() => pins(page)).not.toContain("park");
  await hover();
  await expect.poll(snapNow).not.toBe("waypoint park");
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => editor<string | undefined>(page, "s.selection.stepId")).toBe("path1");
  const end = await editor<Record<string, unknown>>(page, `s.auto.steps.find((step) => step.id === "path1").segments[0].to`);
  expect(end["ref"]).toBeUndefined();
  expect(typeof end["xIn"]).toBe("number");
});
