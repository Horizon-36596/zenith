/**
 * Issues #241 and #431: the path chain's Inspector, decluttered, then calmed.
 *
 * - With driveOut selected, the headers of Path, Heading, Speed and Markers show without scrolling
 *   at 1440x900, and the Inspector's scroll area holds at most 780 px there and 700 px at 1280x720
 *   (it was 1455 px).
 * - No how-to paragraph: a path step shows no note at all.
 * - Each end is one SourceSelect with a crosshair for the waypoint it follows, or a bookmark-plus to
 *   save it as one. Only the selected end has a heading row, the angle alone in mono (issue #409).
 * - In a chain of several paths, every path but the first (or the one holding the selected point)
 *   folds to a summary such as `Path 2 line → scoreNorth`.
 * - Notes are a folded section of their own, whose well is the box.
 *
 * The bundled example opens collect-and-score, where driveOut drives north from waypoint start to
 * waypoint scoreSouth with Heading: Tangent, so the robot faces 90° at both ends.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { LARGE_VIEWPORT, VIEWPORT } from "./viewports";
import { editor, loadExample, selectStep, skipTour, waitForFonts } from "./qa/helpers";

const inspector = (page: Page): Locator => page.getByTestId("inspector");
const header = (page: Page, title: RegExp): Locator =>
  inspector(page).locator("section > div > button[aria-expanded]", { hasText: title });

/** The Inspector's scroll area: its own height and the height of what it holds. */
const scrollArea = (page: Page) =>
  inspector(page).evaluate((node) => {
    let at: HTMLElement | null = node as HTMLElement;
    while (at !== null && at !== document.body) {
      const overflow = getComputedStyle(at).overflowY;
      if ((overflow === "auto" || overflow === "scroll") && at.clientHeight > 0) {
        return { scrollHeight: at.scrollHeight, clientHeight: at.clientHeight, scrollTop: at.scrollTop };
      }
      at = at.parentElement;
    }
    return null;
  });

/** Elements styled as an Inspector note: a paragraph of always-visible prose. */
const noteCount = (page: Page) =>
  inspector(page)
    .locator("*")
    .evaluateAll((all) => all.filter((node) => [...node.classList].some((name) => /^_?note(_|$)/.test(name))).length);

const DRIVE_OUT = 's.auto.steps.find((x) => x.id === "driveOut")';

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
  await waitForFonts(page);
});

test.describe("at 1440x900", () => {
  test.use({ viewport: LARGE_VIEWPORT });

  test("driveOut's everyday sections show without scrolling, in at most 780 px, with no note", async ({ page }) => {
    await selectStep(page, "driveOut");
    // A lone path's rows sit straight under its Path section's header (issue #431).
    await expect(page.getByTestId("inspector-title")).toBeInViewport({ ratio: 1 });
    for (const title of [/^Path$/, /^Heading/, /^Speed/, /^Markers/]) {
      await expect(header(page, title).first(), String(title)).toBeInViewport({ ratio: 1 });
    }
    const area = await scrollArea(page);
    expect(area).not.toBeNull();
    expect(area?.scrollTop).toBe(0);
    expect(area?.scrollHeight ?? Infinity).toBeLessThanOrEqual(780);
    expect(await noteCount(page)).toBe(0);
  });
});

test.describe("at 1280x720", () => {
  test.use({ viewport: VIEWPORT });

  test("driveOut's Inspector holds at most 700 px", async ({ page }) => {
    await selectStep(page, "driveOut");
    await expect(header(page, /^Markers/)).toBeVisible();
    const area = await scrollArea(page);
    expect(area?.scrollHeight ?? Infinity).toBeLessThanOrEqual(700);
  });
});

test("only the selected end has a heading row, the angle alone in mono, with the mode in its hint", async ({ page }) => {
  await selectStep(page, "driveOut");
  // Issue #409: heading is shown in the Heading section; an end not selected has no row.
  await expect(page.getByTestId("inspector-to-0-heading")).toHaveCount(0);
  await expect(page.getByTestId("inspector-from-0-heading")).toHaveCount(0);
  await editor(page, `m.setSelection({ stepId: "driveOut", point: { segmentIndex: 0, pointKind: "to" } })`);
  await expect(page.getByTestId("inspector-to-0-heading")).toHaveText("90.0°");
  const font = await page.getByTestId("inspector-to-0-heading").evaluate((node) => getComputedStyle(node).fontFamily.toLowerCase());
  expect(font).toContain("mono");
  // What decides it is the row's hint, not a sentence under it, and the pencil is on the row.
  await expect(page.getByTestId("inspector-to-0-heading-row").locator("span[hidden]")).toContainText(
    "Set by Heading: Tangent.",
  );
  await expect(page.getByTestId("inspector-to-0-heading-row").getByTestId("inspector-to-0-heading-edit")).toBeVisible();
});

test("a waypoint chosen in SourceSelect is followed, This pose writes a pose of its own, and the end's button follows suit", async ({
  page,
}) => {
  await selectStep(page, "driveOut");
  const to = page.getByTestId("inspector-to-source-0");
  await expect(to).toHaveValue("ref:scoreSouth");
  // The previous end is offered only to a From.
  await expect(to.locator("option", { hasText: "Last step's end" })).toHaveCount(0);
  await expect(page.getByTestId("inspector-from-source-0").locator("option", { hasText: "Last step's end" })).toHaveCount(1);
  await expect(to.locator("optgroup[label='Waypoints'] option", { hasText: "scoreNorth" })).toHaveCount(1);

  await to.selectOption("ref:park");
  await expect.poll(() => editor<unknown>(page, `${DRIVE_OUT}.segments[0].to`)).toEqual({ ref: "park" });
  await page.getByTestId("inspector-to-0-select-waypoint").click();
  await expect.poll(() => editor<unknown>(page, "s.selection.waypoint")).toBe("park");

  await selectStep(page, "driveOut");
  await page.getByTestId("inspector-to-source-0").selectOption("pose");
  await expect.poll(() => editor<unknown>(page, `${DRIVE_OUT}.segments[0].to`)).toMatchObject({ xIn: -40, yIn: -36 });
  await expect(page.getByTestId("inspector-to-source-0")).toHaveValue("pose");
  await expect(page.getByTestId("inspector-to-x-0")).toBeVisible();
  await expect(page.getByTestId("inspector-to-0-save-waypoint")).toBeVisible();
  await expect(page.getByTestId("inspector-to-0-select-waypoint")).toHaveCount(0);
});

test("on a three-path chain, Paths 2 and 3 fold to their summaries, and the selected point's path opens", async ({ page }) => {
  await selectStep(page, "driveOut");
  await page.getByTestId("inspector-chain-add").click();
  await page.getByTestId("inspector-chain-add").click();
  await expect.poll(() => editor<number>(page, `${DRIVE_OUT}.segments.length`)).toBe(3);
  await editor(page, `m.selectStep("driveOut")`);

  await expect(header(page, /^Path 1/)).toHaveAttribute("aria-expanded", "true");
  for (const n of [2, 3]) {
    const path = header(page, new RegExp(`^Path ${String(n)}`));
    await expect(path).toHaveAttribute("aria-expanded", "false");
    await expect(path).toContainText(/line → -?\d+\.\d, -?\d+\.\d/);
  }
  // Path 1 folded shows where it ends, too.
  await editor(page, `m.setSelection({ stepId: "driveOut", point: { segmentIndex: 2, pointKind: "to" } })`);
  await expect(header(page, /^Path 3/)).toHaveAttribute("aria-expanded", "true");
  await expect(header(page, /^Path 1/)).toHaveAttribute("aria-expanded", "false");
  await expect(header(page, /^Path 1/)).toContainText("line → scoreSouth");
});

test("notes are a folded section, and opening it shows them in the box that edits them", async ({ page }) => {
  await selectStep(page, "driveOut");
  await editor(page, `m.commit({ ...s.auto, steps: s.auto.steps.map((x) => x.id === "driveOut" ? { ...x, notes: "Line one.\\nLine two." } : x) })`);
  // No prose in the panel (issue #431): a dot on the folded header says there are notes.
  await expect(page.getByTestId("inspector-notes-preview")).toHaveCount(0);
  await expect(inspector(page).locator("textarea")).toHaveCount(0);
  const notes = inspector(page).locator('section[data-fold="step.notes"] button[aria-expanded]').first();
  await expect(notes.getByTestId("section-dot")).toBeVisible();
  await notes.click();
  const box = page.getByTestId("inspector-notes");
  await expect(box).toHaveValue("Line one.\nLine two.");
  await box.fill("Changed.");
  await page.getByTestId("inspector-estimate").click();
  await expect.poll(() => editor<string>(page, `${DRIVE_OUT}.notes`)).toBe("Changed.");
  await expect(page.getByTestId("inspector-notes")).toHaveValue("Changed.");
});

test("an empty marker list is its header, whose + names the Marker tool in its tooltip", async ({ page }) => {
  await selectStep(page, "driveOut");
  // Issue #431: no Add marker row and no "No markers"; the + in the header adds one.
  await expect(page.getByTestId("inspector-markers-empty")).toHaveCount(0);
  const markers = inspector(page).locator('section[data-fold="path.markers"]');
  await expect(markers.locator(":scope > div")).toHaveCount(1);
  const add = page.getByTestId("inspector-marker-add");
  await expect(add).toHaveAccessibleName("Add marker");
  await add.hover();
  await expect(page.locator('[role="tooltip"]')).toContainText("Marker tool (M)");
  await add.click();
  await expect.poll(() => editor<number>(page, `${DRIVE_OUT}.markers.length`)).toBe(1);
});
