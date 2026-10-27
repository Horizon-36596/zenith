/**
 * Issue #82: a marker is edited in the inspector's Marker section. Placing one with the Marker tool
 * opens that section straight away, and clicking a marker on the field or in the path's Markers list
 * opens it again. The saved file carries what the section set.
 */
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { saveExampleAuto } from "./saveExample";
import { canonicalize, loadAuto } from "@horizon36596/zenith-core";
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

/** Where a field inch sits on screen, from the view the canvas publishes on its element. */
async function worldToScreen(page: Page, xIn: number, yIn: number): Promise<{ x: number; y: number }> {
  const canvas = page.getByTestId("field-canvas");
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("the canvas has no box");
  const pxPerIn = Number(await canvas.getAttribute("data-px-per-in"));
  const originXPx = Number(await canvas.getAttribute("data-origin-x-px"));
  const originYPx = Number(await canvas.getAttribute("data-origin-y-px"));
  return { x: box.x + originXPx + pxPerIn * xIn, y: box.y + originYPx - pxPerIn * yIn };
}

interface SavedMarker {
  at: Record<string, number>;
  command: { name: string; args?: Record<string, unknown> };
}

/** driveOut's markers in the open document, read from the editor's own store. */
const driveOutMarkers = (page: Page): Promise<SavedMarker[]> =>
  page.evaluate(
    `import("/src/state/store.ts").then((m) => m.getState().auto.steps.find((s) => s.id === "driveOut").markers ?? [])`,
  ) as Promise<SavedMarker[]>;

/** Drops a marker halfway along driveOut with the Marker tool and waits for its section. */
async function dropMarker(page: Page): Promise<void> {
  await page.goto("/?cloud=fake");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await page.getByTestId("toolbar-tool.marker").click();
  const middle = await worldToScreen(page, -13, -49.5);
  await page.mouse.click(middle.x, middle.y);
  await expect(page.getByTestId("inspector-marker-command")).toBeVisible();
}

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test("the Command picker's tooltip sits beside the Inspector, off the labels and the picker (W2-20)", async ({ page }) => {
  await dropMarker(page);
  const command = page.getByTestId("inspector-marker-command");
  await expect(command).toBeFocused();
  // Focus from the keyboard opens the picker's own tooltip, the chosen command and its summary.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(command).toBeFocused();
  const bubble = page.getByRole("tooltip");
  await expect(bubble).toBeVisible();
  await expect(bubble).toContainText("intakeOn");
  await expect(bubble).toHaveAttribute("data-state", "open");
  const box = await bubble.boundingBox();
  if (box === null) throw new Error("the tooltip has no box");
  const inspector = await page.getByTestId("inspector").boundingBox();
  const labels = await page.getByTestId("inspector").locator("[data-field-label]").all();
  for (const label of labels) {
    const at = await label.boundingBox();
    if (at !== null) expect(overlaps(box, at), `covers ${await label.innerText()}`).toBe(false);
  }
  const picker = await command.boundingBox();
  expect(picker !== null && overlaps(box, picker)).toBe(false);
  expect(inspector !== null && box.x + box.width <= inspector.x + 1).toBe(true);
});

test("a marker's distance from either end past the path's length is refused with the range (W2-11, issue #502)", async ({ page }) => {
  await dropMarker(page);
  await page.getByTestId("inspector-marker-at-unit").selectOption("distanceFromEndIn");
  const at = page.getByTestId("inspector-marker-at");
  const before = await at.inputValue();
  await at.fill("500");
  await at.press("Enter");
  // driveOut runs from (-13, -63) to (-13, -36): 27 in. The field keeps what it had and says so.
  await expect(at).toHaveValue(before);
  await expect(page.getByTestId("status")).toContainText("At runs 0 to 27 in from end.");
  await at.fill("27");
  await at.press("Enter");
  const markers = await driveOutMarkers(page);
  expect(markers[0]?.at["distanceFromEndIn"]).toBeCloseTo(27, 1);
  await expect(page.locator("body")).toContainText("At most the path's length.", { useInnerText: false });
});

test("placing a marker opens it in the inspector, where its command, args and position are edited", async ({
  page,
}) => {
  await page.goto("/?cloud=fake");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  expect(await driveOutMarkers(page)).toEqual([]);

  // driveOut is a straight line from the start, (-13, -63), to scoreSouth, (-13, -36). The Marker
  // tool puts a marker where the path is clicked, halfway along it here.
  await page.getByTestId("toolbar-tool.marker").click();
  const middle = await worldToScreen(page, -13, -49.5);
  await page.mouse.click(middle.x, middle.y);

  // The new marker is selected, and its section is at the top of the inspector, with the robot's
  // first command.
  const command = page.getByTestId("inspector-marker-command");
  await expect(command).toBeVisible();
  await expect(command).toHaveAttribute("data-value", "intakeOn");
  await expect(page.locator('[data-tour="section.marker"]')).toBeVisible();
  // The header has the one `?`; the Marker section under it draws none of its own.
  await expect(page.getByTestId("help-section.marker")).toHaveCount(1);
  await expect(page.getByTestId("inspector-head").getByTestId("help-section.marker")).toHaveCount(1);
  // The marker shows alone, under a breadcrumb back to its path (issues #409 and #431).
  await expect(page.getByTestId("inspector-title")).toHaveText("Marker 1");
  await expect(page.getByTestId("inspector-head").getByTestId("inspector-marker-back")).toHaveText("driveOut");
  await expect(page.locator('[data-tour="section.markers"]')).toHaveCount(0);
  const placed = await driveOutMarkers(page);
  expect(placed).toHaveLength(1);
  expect(placed[0]?.command).toEqual({ name: "intakeOn" });
  expect(placed[0]?.at["t"]).toBeCloseTo(0.5, 1);

  // Change the command to score, then its count argument, from the registry's own field.
  await command.click();
  await page.getByTestId("inspector-marker-command-option-score").click();
  await expect(command).toHaveAttribute("data-value", "score");
  const count = page.getByTestId("inspector-marker-arg-count");
  await count.fill("3");
  await count.press("Enter");
  await expect(count).toHaveValue("3");

  // And where it fires.
  const at = page.getByTestId("inspector-marker-at");
  await at.fill("25");
  await at.press("Enter");
  await expect(at).toHaveValue("25");

  expect(await driveOutMarkers(page)).toEqual([{ at: { t: 0.25 }, command: { name: "score", args: { count: 3 } } }]);

  // Selecting another step closes the section; the path's Markers list opens it again.
  await page.getByTestId("toolbar-tool.select").click();
  await page.getByTestId("step-row-shootPreloads").getByRole("button").first().click();
  await expect(command).toHaveCount(0);
  await page.getByTestId("step-row-driveOut").getByRole("button").first().click();
  await expect(command).toHaveCount(0);
  await page.getByTestId("inspector-marker-open-0").click();
  await expect(command).toHaveAttribute("data-value", "score");

  // Clicking the marker on the field opens it too. It now sits a quarter of the way along.
  await page.getByTestId("step-row-shootPreloads").getByRole("button").first().click();
  await expect(command).toHaveCount(0);
  const pin = await worldToScreen(page, -13, -63 + 27 * 0.25);
  await page.mouse.click(pin.x, pin.y);
  await expect(command).toHaveAttribute("data-value", "score");

  // The saved file carries the marker as the section set it, in canonical form.
  const download = saveExampleAuto(page);
  const path = await (await download).path();
  const text = readFileSync(path, "utf8");
  const written = JSON.parse(text) as { steps: Array<{ id?: string; markers?: SavedMarker[] }> };
  expect(written.steps.find((step) => step.id === "driveOut")?.markers).toEqual([
    { at: { t: 0.25 }, command: { name: "score", args: { count: 3 } } },
  ]);
  expect(text).toBe(canonicalize("auto", loadAuto(JSON.parse(text))));

  // Remove marker takes it off the path and leaves the path selected.
  await page.getByTestId("inspector-marker-remove").click();
  await expect(command).toHaveCount(0);
  await expect(page.locator('[data-tour="section.markers"]').getByTestId("inspector-marker-open-0")).toHaveCount(0);
  await expect(page.getByTestId("inspector-marker-add")).toBeVisible();
  expect(await driveOutMarkers(page)).toEqual([]);
});

test("a placed marker says what it runs, and its menu's Change command puts focus on the command", async ({ page }) => {
  await dropMarker(page);
  await expect(page.getByTestId("status")).toContainText(/Added a marker on driveOut .* that runs intakeOn\./);

  await page.getByTestId("step-main-driveOut").click();
  await expect(page.getByTestId("inspector-marker-command")).toHaveCount(0);
  const middle = await worldToScreen(page, -13, -49.5);
  await page.mouse.click(middle.x, middle.y, { button: "right" });
  const menu = page.getByTestId("canvas-context-menu");
  // Every row of the field's menu has its icon.
  const rows = menu.getByRole("menuitem");
  expect(await rows.count()).toBeGreaterThan(0);
  for (const row of await rows.all()) await expect(row.locator("svg").first()).toBeVisible();
  await menu.getByText("Change command…", { exact: true }).click();
  await expect(page.getByTestId("inspector-marker-command")).toBeFocused();
});
