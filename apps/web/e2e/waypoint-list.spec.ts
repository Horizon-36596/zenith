/**
 * Issue #245: the Inspector's one compact Waypoints list. Each of the example's 9 waypoints is one
 * row of at most 26 px: an eye, the name, x, y and heading edited in place, and a ⋯ with the items a
 * right-click on the pin has. Only the selected row opens, to its chip, one "Used by" line whose hint
 * has the full lists, and Rename and Delete. The header's + waits for a click on the field, and Show
 * all forgets the eyes set in this project only. No instruction note stands in the section.
 */
import { expect, test, type Page } from "@playwright/test";
import { canvasView, editor, loadExample, skipTour, waitForFonts, worldToScreen } from "./qa/helpers";
import { VIEWPORT } from "./viewports";

const OTHER_PROJECT_PIN = "folder:robot-repo#park";

test.use({ viewport: VIEWPORT });

test.beforeEach(async ({ page }) => {
  // Another project's hidden pin, which Show all in this one must leave alone.
  // Every pin shown, so "Other waypoints" starts open too; the default is This auto's (issue #217).
  await skipTour(page, { waypointPins: "all", waypointPinOverrides: { [OTHER_PROJECT_PIN]: "hide" } });
  await loadExample(page);
  await waitForFonts(page);
});

const waypointNames = (page: Page): Promise<string[]> => editor<string[]>(page, "Object.keys(s.project.waypoints.waypoints)");

/** The pins the pointer can reach now, as the canvas publishes them. */
async function pins(page: Page): Promise<string[]> {
  const value = (await page.getByTestId("field-canvas").getAttribute("data-pins")) ?? "";
  return value === "" ? [] : value.split(",").sort();
}

/** The ids and labels of an open menu's items, in order. */
const menuItems = (page: Page, testId: string): Promise<Array<{ id: string; label: string; disabled: boolean }>> =>
  page
    .getByTestId(testId)
    .locator("[data-action]")
    .evaluateAll((buttons) =>
      buttons.map((button) => ({
        id: button.getAttribute("data-action") ?? "",
        label: button.querySelector("span")?.textContent ?? "",
        disabled: button.getAttribute("aria-disabled") === "true",
      })),
    );

test("at 1280x720 with a waypoint selected, all 9 rows show without scrolling the list, each at most 26 px tall", async ({ page }) => {
  await page.evaluate(`import("/src/state/store.ts").then((m) => m.setSelection({ waypoint: "scoreSouth" }))`);
  await expect(page.getByTestId("inspector-waypoint-x")).toBeVisible();
  const names = await waypointNames(page);
  expect(names).toHaveLength(9);
  const fit = await page.evaluate((all) => {
    const first = document.querySelector(`[data-testid="inspector-waypoint-line-${all[0] ?? ""}"]`);
    let scroller: HTMLElement | null = first?.parentElement ?? null;
    while (scroller !== null && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const view = (scroller ?? document.documentElement).getBoundingClientRect();
    return all.map((name) => {
      const box = document.querySelector(`[data-testid="inspector-waypoint-line-${name}"]`)?.getBoundingClientRect();
      return { name, height: box?.height ?? 0, inside: box !== undefined && box.top >= view.top - 0.5 && box.bottom <= view.bottom + 0.5 };
    });
  }, names);
  for (const row of fit) {
    expect(row.height, row.name).toBeGreaterThan(0);
    expect(row.height, row.name).toBeLessThanOrEqual(26);
    expect(row.inside, `${row.name} is in view`).toBe(true);
  }
});

test("a row's numbers fit their cells at every inspector width, down to -179.9° and -76.0 in", async ({ page }) => {
  // A heading is anywhere from -180.0 to 180.0 (a pose may also sit a little off the field), and no
  // digit of it may be cut under the degree sign (the 0.1.2 sweep found "-125.9°" cut to "-125.¢°").
  await page.evaluate(
    `import("/src/app/waypointEdits.ts").then((m) => m.writeWaypointNumbers("park", { xIn: -76, yIn: -72, headingRad: ${(-179.9 * Math.PI) / 180} }))`,
  );
  const heading = page.getByTestId("inspector-waypoint-park-h");
  await expect(heading).toHaveValue("-179.9");
  const widths = [240, 300, 560];
  for (const width of widths) {
    await page.evaluate(`import("/src/state/store.ts").then((m) => m.setPrefs({ panelRightW: ${width} }))`);
    for (const axis of ["h", "x", "y"]) {
      const cell = await page.getByTestId(`inspector-waypoint-park-${axis}`).evaluate((input: HTMLInputElement) => {
        const box = input.getBoundingClientRect();
        const unit = input.nextElementSibling instanceof HTMLElement && input.nextElementSibling.classList.contains("unit") ? input.nextElementSibling : null;
        const row = input.closest('[data-testid^="inspector-waypoint-line-"]')?.getBoundingClientRect();
        return {
          scrollWidth: input.scrollWidth,
          clientWidth: input.clientWidth,
          // The degree sign starts at or after the digits' own end: the box's right edge less its border and padding.
          unitClear:
            unit === null
              ? true
              : unit.getBoundingClientRect().left >=
                box.right - parseFloat(getComputedStyle(input).paddingRight) - parseFloat(getComputedStyle(input).borderRightWidth) - 0.5,
          rowHeight: row?.height ?? 0,
        };
      });
      expect(cell.scrollWidth, `${axis} at ${String(width)} px: the text is cut`).toBeLessThanOrEqual(cell.clientWidth);
      expect(cell.unitClear, `${axis} at ${String(width)} px: the degree sign sits over the digits`).toBe(true);
      expect(cell.rowHeight, `${axis} at ${String(width)} px: the row stays 24 px`).toBeLessThanOrEqual(24);
    }
    // The name column keeps room to read.
    const name = await page.getByTestId("inspector-waypoint-row-park").boundingBox();
    expect(name?.width ?? 0, `the name column at ${String(width)} px`).toBeGreaterThanOrEqual(40);
  }
});

test("typing x = -30 in park's row moves the pin and keeps its PLACEHOLDER label", async ({ page }) => {
  const field = page.getByTestId("inspector-waypoint-park-x");
  await field.click();
  await field.fill("-30");
  await field.press("Enter");
  await expect.poll(() => editor<number>(page, "s.project.waypoints.waypoints.park.xIn")).toBe(-30);
  expect(await editor<string>(page, "s.project.waypoints.waypoints.park.provenance")).toMatch(/^PLACEHOLDER/);
});

test("Enter or a blur on a row's untouched number writes nothing, so a pose the field shows rounded stays exact", async ({ page }) => {
  // A heading of 1.3 rad shows as 74.5° and an x of -40.25 as -40.3; neither may be written back.
  await page.evaluate(`import("/src/app/waypointEdits.ts").then((m) => m.writeWaypointNumbers("park", { xIn: -40.25, headingRad: 1.3 }))`);
  await expect(page.getByTestId("inspector-waypoint-park-h")).toHaveValue("74.5");
  await expect(page.getByTestId("inspector-waypoint-park-x")).toHaveValue("-40.3");
  const undoBefore = await editor<number>(page, "s.undo.length");
  for (const axis of ["h", "x", "y"]) {
    const field = page.getByTestId(`inspector-waypoint-park-${axis}`);
    await field.click();
    await field.press("Enter");
    await field.click();
    await field.blur();
  }
  expect(await editor<number>(page, "s.project.waypoints.waypoints.park.headingRad")).toBe(1.3);
  expect(await editor<number>(page, "s.project.waypoints.waypoints.park.xIn")).toBe(-40.25);
  expect(await editor<number>(page, "s.undo.length")).toBe(undoBefore);
  // Typing a different number still writes it.
  const heading = page.getByTestId("inspector-waypoint-park-h");
  await heading.click();
  await heading.fill("90");
  await heading.press("Enter");
  await expect.poll(() => editor<number>(page, "s.project.waypoints.waypoints.park.headingRad")).toBeCloseTo(Math.PI / 2, 9);
  expect(await editor<number>(page, "s.undo.length")).toBe(undoBefore + 1);
});

test("an eye hides its pin on the field and dims the row, and Show all clears this project's eyes only", async ({ page }) => {
  await expect.poll(() => pins(page)).toContain("park");
  await page.getByTestId("inspector-waypoint-eye-park").click();
  await expect.poll(() => pins(page)).not.toContain("park");
  await expect(page.getByTestId("inspector-waypoint-line-park")).toHaveAttribute("data-hidden", "");
  await expect(page.locator('section[data-fold="waypoint.list"] button').first()).toHaveText(/^Waypoints\s*7$/);
  // How many pins are hidden is said only in the Pins choice's tooltip, on the column heads' line (issue #431).
  await page.getByTestId("inspector-waypoints-show").hover();
  await expect(page.locator('[role="tooltip"]')).toContainText("1 of 9 pins are hidden now.");
  expect(await editor(page, "s.prefs.waypointPinOverrides")).toEqual({
    [OTHER_PROJECT_PIN]: "hide",
    "example:examples/starter#park": "hide",
  });

  await page.getByTestId("inspector-waypoints-show-all").click();
  await expect.poll(() => pins(page)).toContain("park");
  await expect(page.getByTestId("inspector-waypoint-line-park")).not.toHaveAttribute("data-hidden", "");
  expect(await editor(page, "s.prefs.waypointPinOverrides")).toEqual({ [OTHER_PROJECT_PIN]: "hide" });
  await expect(page.getByTestId("inspector-waypoints-show-all")).toHaveCount(0);
});

test("the Pins row sets which pins the field shows, in the words All, This auto's and None", async ({ page }) => {
  await page.getByTestId("inspector-waypoints-show").click();
  await expect(page.getByTestId("inspector-waypoints-show-list").getByRole("option")).toHaveText(["All", "This auto's", "None"]);
  await page.getByTestId("inspector-waypoints-show-option-none").click();
  await expect.poll(() => editor(page, "s.prefs.waypointPins")).toBe("none");
  await expect.poll(() => pins(page)).toEqual([]);
  await expect(page.locator('section[data-fold="waypoint.list"] button').first()).toHaveText(/^Waypoints\s*7$/);
  await expect(page.getByTestId("inspector-waypoints-show")).toHaveText("None");
});

test("the + then a field click opens Add waypoint at the clicked spot, and Esc while armed changes nothing", async ({ page }) => {
  const before = await editor<string>(page, "JSON.stringify(s.project.waypoints)");
  await page.getByTestId("inspector-waypoints-add").click();
  await expect(page.getByTestId("status")).toContainText("Click the field to place the waypoint. Esc cancels.");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("status")).toContainText("cancelled");
  const away = await worldToScreen(page, 30, 0);
  await page.mouse.click(away.x, away.y);
  await expect(page.getByTestId("waypoint-dialog")).toHaveCount(0);
  expect(await editor<string>(page, "JSON.stringify(s.project.waypoints)")).toBe(before);
  expect(await editor<number>(page, "s.undo.length")).toBe(0);

  await page.getByTestId("inspector-waypoints-add").click();
  await page.mouse.click(away.x, away.y);
  const dialog = page.getByTestId("waypoint-dialog");
  await expect(dialog).toContainText("Add waypoint");
  await expect(page.getByTestId("waypoint-dialog-name")).toHaveValue("waypoint1");
  await page.keyboard.press("Enter");
  await expect.poll(() => editor<number | undefined>(page, "s.project.waypoints.waypoints.waypoint1?.xIn")).toBeCloseTo(30, 0);
  expect(await editor<number>(page, "s.project.waypoints.waypoints.waypoint1.yIn")).toBeCloseTo(0, 0);
});

test("the ⋯ on park's row selects it and opens the items a right-click on the pin opens", async ({ page }) => {
  await page.getByTestId("inspector-waypoint-more-park").click();
  await expect(page.getByTestId("inspector-waypoint-menu")).toBeVisible();
  await expect.poll(() => editor(page, "s.selection")).toEqual({ waypoint: "park" });
  const fromList = await menuItems(page, "inspector-waypoint-menu");
  expect(fromList.map((item) => item.label)).toContain("Rename…");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("inspector-waypoint-menu")).toHaveCount(0);
  await expect(page.getByTestId("inspector-waypoint-more-park")).toBeFocused();

  const park = await editor<{ xIn: number; yIn: number }>(page, "s.project.waypoints.waypoints.park");
  const at = await worldToScreen(page, park.xIn, park.yIn);
  await page.mouse.move(at.x - 3, at.y);
  await page.mouse.click(at.x, at.y, { button: "right" });
  await expect(page.getByTestId("canvas-context-menu")).toBeVisible();
  // The same items, but for the two zooms the list's menu adds: on the field they are its corner
  // controls and F (issue #412).
  const zooms = new Set(["Zoom to it", "Zoom to fit"]);
  expect(await menuItems(page, "canvas-context-menu")).toEqual(fromList.filter((item) => !zooms.has(item.label)));
});

test("the ⋯ menu's Zoom to it zooms the field in on park, and its Zoom to fit zooms back out", async ({ page }) => {
  const scale = async (): Promise<number> => (await canvasView(page)).pxPerIn;
  const before = await scale();
  const park = await editor<{ xIn: number; yIn: number }>(page, "s.project.waypoints.waypoints.park");
  // How far park sits from the middle of the canvas, in pixels.
  const offCentre = async (): Promise<number> => {
    const view = await canvasView(page);
    const at = await worldToScreen(page, park.xIn, park.yIn);
    return Math.hypot(at.x - (view.x + view.width / 2), at.y - (view.y + view.height / 2));
  };

  await page.getByTestId("inspector-waypoint-more-park").click();
  await page.getByTestId("inspector-waypoint-menu").locator('[data-action="canvas.zoomSelection"]').click();
  await expect.poll(scale).toBeGreaterThan(before);
  await expect.poll(offCentre).toBeLessThan(40);
  const zoomed = await scale();

  await page.getByTestId("inspector-waypoint-more-park").click();
  await page.getByTestId("inspector-waypoint-menu").locator('[data-action="canvas.fit"]').click();
  await expect.poll(scale).toBeLessThan(zoomed);
  await expect.poll(scale).toBeCloseTo(before, 1);
});

test("no instruction note stands in the section, and the Used by line shows the full lists on hover", async ({ page }) => {
  const section = page.locator('section[data-fold="waypoint.list"]');
  await expect(page.getByTestId("inspector-waypoints-note")).toHaveCount(0);
  await expect(section.locator("p")).toHaveCount(0);

  await page.getByTestId("inspector-waypoint-row-start").click();
  const used = page.getByTestId("inspector-waypoint-used-by");
  await expect(page.getByTestId("inspector-waypoint-followers")).toHaveText("2 points here");
  await expect(page.getByTestId("inspector-waypoint-others")).not.toHaveText("checking…");
  await expect(section).not.toContainText("Drag the pin");
  await expect(section).not.toContainText("Click one to select");
  await used.hover();
  await expect(page.getByRole("tooltip")).toContainText("In this auto: the start and the first point of driveOut.");
  await expect(page.getByRole("tooltip")).toContainText("In other autos:");
});
