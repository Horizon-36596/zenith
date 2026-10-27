/**
 * Issues #239 and #431: the Inspector's building blocks.
 *
 * - Folds are remembered per person and per kind of section (`prefs.inspectorFolds`), not by where
 *   a section happens to sit in the tree: folding Heading on driveOut keeps it folded on
 *   toOtherSide and after a reload, and folds nothing on a command.
 * - The selection header shows the estimate (`1.59 s`) in place of the Estimated and Strafe
 *   fraction rows, and the rare rows sit in Advanced, which starts closed, as Notes does.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { editor, loadExample, openAutoNamed, selectStep, skipTour } from "./qa/helpers";

const section = (page: Page, foldId: string): Locator =>
  page.getByTestId("inspector").locator(`section[data-fold="${foldId}"]`);
const header = (page: Page, foldId: string): Locator => section(page, foldId).locator("button[aria-expanded]").first();

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
  await openAutoNamed(page, "collect-and-score.auto.json");
});

test("folding Heading on driveOut keeps it folded on toOtherSide and after a reload, and folds nothing on a command", async ({
  page,
}) => {
  await selectStep(page, "driveOut");
  await expect(header(page, "path.heading")).toHaveAttribute("aria-expanded", "true");
  await header(page, "path.heading").click();
  await expect(header(page, "path.heading")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("inspector-heading-mode")).toHaveCount(0);
  expect(await editor<Record<string, boolean>>(page, "s.prefs.inspectorFolds")).toEqual({ "path.heading": false });

  // Another path chain: the same kind of section, so the same memory.
  await selectStep(page, "toOtherSide");
  await expect(header(page, "path.heading")).toHaveAttribute("aria-expanded", "false");
  await expect(header(page, "path.speed")).toHaveAttribute("aria-expanded", "true");

  // Fold Speed too: on a command, Advanced sits in the next place after its Command section, and
  // must not inherit whatever fold was left there.
  await header(page, "path.speed").click();
  const foldIds = () =>
    page
      .getByTestId("inspector")
      .locator("section[data-fold]")
      .evaluateAll((all) => all.map((node) => node.getAttribute("data-fold")));
  expect(await foldIds()).toContain("path.speed");

  // A command: its rows sit in its own Command section (issue #431), which takes its own memory.
  await selectStep(page, "shootPreloads");
  expect(await foldIds()).not.toContain("path.speed");
  await expect(header(page, "command")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("inspector-command-name")).toBeVisible();

  await page.reload();
  await page.getByTestId("canvas-load-example").click();
  await openAutoNamed(page, "collect-and-score.auto.json");
  await selectStep(page, "toOtherSide");
  await expect(header(page, "path.heading")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("inspector-heading-mode")).toHaveCount(0);
});

test("the header's estimate replaces the Estimated and Strafe fraction rows on every step kind", async ({ page }) => {
  // A path chain, a command, a wait, a parallel group and a sequence inside it.
  for (const id of ["driveOut", "shootPreloads", "waitForFull", "returnToScore", "clearThenSpinUp"]) {
    await editor(page, `m.selectStep(${JSON.stringify(id)})`);
    await expect(page.getByTestId("inspector-head").getByTestId("inspector-title")).toHaveText(id);
    const inspector = page.getByTestId("inspector");
    await expect(page.getByTestId("inspector-estimate"), id).toBeVisible();
    await expect(page.getByTestId("inspector-estimate"), id).not.toContainText("—");
    await expect(inspector.locator("label", { hasText: /^Estimated$/ }), id).toHaveCount(0);
    await expect(inspector.locator("label", { hasText: /^Strafe fraction$/ }), id).toHaveCount(0);
  }
  await selectStep(page, "driveOut");
  await expect(page.getByTestId("inspector-estimate")).toHaveText(/^\d+\.\d\d s$/);
  // A wait-until with a Timeout is bounded by it, and says so instead of a dash.
  await selectStep(page, "waitForFull");
  await expect(page.getByTestId("inspector-estimate")).toHaveText("≤ 1.00 s");
});

test("Advanced starts closed and holds + Stay inside and Rejoin pose; Notes is its own closed section", async ({ page }) => {
  await selectStep(page, "driveOut");
  await expect(header(page, "step.more")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("inspector-envelope-draw")).toHaveCount(0);
  // A path's time limit is in Speed, beside Stop early, not in Advanced (issue #431).
  await expect(section(page, "path.speed").getByTestId("inspector-timeout")).toBeVisible();
  // driveOut has notes: a closed Notes section with a dot, whatever the notes say.
  await expect(header(page, "step.notes")).toHaveAttribute("aria-expanded", "false");
  await expect(header(page, "step.notes").getByTestId("section-dot")).toHaveCount(1);
  await expect(page.getByLabel("Notes")).toHaveCount(0);

  await header(page, "step.more").click();
  const more = section(page, "step.more");
  await expect(more.getByTestId("inspector-timeout")).toHaveCount(0);
  await expect(more.getByTestId("inspector-envelope-draw")).toBeVisible();
  await expect(more.getByLabel("Notes")).toHaveCount(0);

  // A step with no notes keeps its empty Notes section, with no dot, and its box when opened.
  await editor(page, `m.commit({ ...s.auto, steps: s.auto.steps.map((x) => x.id === "driveOut" ? { ...x, notes: undefined } : x) })`);
  await expect(header(page, "step.notes").getByTestId("section-dot")).toHaveCount(0);
  await header(page, "step.notes").click();
  await expect(section(page, "step.notes").getByLabel("Notes")).toBeVisible();

  // A path after a command that drives the robot by itself offers a rejoin pose in Advanced.
  await editor(
    page,
    `m.replaceProjectRobot({ ...s.project.robot, commands: s.project.robot.commands.map((c) => c.name === s.auto.steps.find((x) => x.id === "shootPreloads").name ? { ...c, movesRobot: true } : c) })`,
  );
  await editor(
    page,
    `m.commit({ ...s.auto, steps: s.auto.steps.map((x) => x.id === "toOtherSide" ? { ...x, segments: x.segments.map((g, i) => i === 0 ? { ...g, from: "current" } : g) } : x) })`,
  );
  await selectStep(page, "toOtherSide");
  // Advanced was opened on driveOut, and the memory is per kind of section.
  await expect(header(page, "step.more")).toHaveAttribute("aria-expanded", "true");
  await expect(more.getByTestId("inspector-rejoin-add")).toBeVisible();
  await expect(more.getByTestId("inspector-rejoin-add")).toHaveText("Add");
  await expect(section(page, "rejoin")).toHaveCount(0);
});

test("an envelope or rejoin the file already has shows as its own section above Advanced", async ({ page }) => {
  await selectStep(page, "driveOut");
  await header(page, "step.more").click();
  await section(page, "step.more").getByTestId("inspector-envelope-add").click();
  const envelope = section(page, "envelope");
  await expect(envelope).toBeVisible();
  await expect(envelope.getByTestId("inspector-envelope-seconds")).toBeVisible();
  await expect(section(page, "step.more").getByTestId("inspector-envelope-add")).toHaveCount(0);
  // The envelope's section comes before Notes, and Advanced, with nothing left to hold, is not drawn.
  const order = await page
    .getByTestId("inspector")
    .locator("section[data-fold]")
    .evaluateAll((all) => all.map((node) => node.getAttribute("data-fold")));
  expect(order).not.toContain("step.more");
  expect(order.indexOf("envelope")).toBeGreaterThan(-1);
  expect(order.indexOf("envelope")).toBeLessThan(order.indexOf("step.notes"));
  // Its title is the students' word for it (issue #431).
  await expect(envelope.locator("button[aria-expanded]").first()).toHaveText("Stay-inside box");

  // A rejoin pose the file has is its own section too, above Advanced, with its bin in the header.
  await editor(
    page,
    `m.commit({ ...s.auto, steps: s.auto.steps.map((x) => x.id === "toOtherSide" ? { ...x, rejoinFrom: { xIn: 0, yIn: 0, headingRad: 0, provenance: "SET BY HAND: e2e" } } : x) })`,
  );
  await selectStep(page, "toOtherSide");
  await expect(section(page, "rejoin").getByTestId("inspector-rejoin-x")).toBeVisible();
  await expect(section(page, "rejoin").locator(":scope > div").first().getByTestId("inspector-rejoin-remove")).toHaveCount(1);
  await expect(section(page, "step.more").getByTestId("inspector-rejoin-add")).toHaveCount(0);
  const after = await page
    .getByTestId("inspector")
    .locator("section[data-fold]")
    .evaluateAll((all) => all.map((node) => node.getAttribute("data-fold")));
  expect(after.indexOf("rejoin")).toBeLessThan(after.indexOf("step.more"));
});

test("a header click folds a held-open start section, and the hold comes back once it lets go", async ({ page }) => {
  await editor(page, "m.setSelection({ start: true })");
  // Closed by default, but the start was clicked, so it is held open, and nothing is written.
  await expect(header(page, "routine.start")).toHaveAttribute("aria-expanded", "true");
  expect(await editor<Record<string, boolean>>(page, "s.prefs.inspectorFolds")).toEqual({});

  // A click while held folds it anyway, and the next opens it again.
  await header(page, "routine.start").click();
  await expect(header(page, "routine.start")).toHaveAttribute("aria-expanded", "false");
  expect(await editor<Record<string, boolean>>(page, "s.prefs.inspectorFolds")).toEqual({ "routine.start": false });
  await header(page, "routine.start").click();
  await expect(header(page, "routine.start")).toHaveAttribute("aria-expanded", "true");
  await header(page, "routine.start").click();
  await expect(header(page, "routine.start")).toHaveAttribute("aria-expanded", "false");

  // Clicking the start again, after a step, holds it open again over the folded memory.
  await selectStep(page, "driveOut");
  await editor(page, "m.setSelection({ start: true })");
  await expect(header(page, "routine.start")).toHaveAttribute("aria-expanded", "true");
  expect(await editor<Record<string, boolean>>(page, "s.prefs.inspectorFolds")).toEqual({ "routine.start": false });
});

test("a folded waypoint list held open by a selected waypoint lets go when nothing holds it, and holds again", async ({
  page,
}) => {
  const name = await editor<string>(page, "Object.keys(s.project.waypoints.waypoints)[0]");
  await editor(page, `m.setSelection({ waypoint: ${JSON.stringify(name)} })`);
  await expect(header(page, "waypoint.list")).toHaveAttribute("aria-expanded", "true");
  expect(await editor<Record<string, boolean>>(page, "s.prefs.inspectorFolds")).toEqual({});

  await header(page, "waypoint.list").click();
  await expect(header(page, "waypoint.list")).toHaveAttribute("aria-expanded", "false");
  expect(await editor<Record<string, boolean>>(page, "s.prefs.inspectorFolds")).toEqual({ "waypoint.list": false });

  // The Routine view keeps the same list, now held by nothing: folded, as remembered. The start's own
  // view shows its section alone (issue #244), so nothing is selected here.
  await editor(page, "m.setSelection({})");
  const routineList = page
    .getByTestId("inspector-routine")
    .locator('section[data-fold="waypoint.list"]')
    .locator("button[aria-expanded]")
    .first();
  await expect(routineList).toHaveAttribute("aria-expanded", "false");
  // Selecting a waypoint again holds it open again; the earlier click released only that hold.
  await editor(page, `m.setSelection({ waypoint: ${JSON.stringify(name)} })`);
  await expect(header(page, "waypoint.list")).toHaveAttribute("aria-expanded", "true");
  expect(await editor<Record<string, boolean>>(page, "s.prefs.inspectorFolds")).toEqual({ "waypoint.list": false });
});

test("the tour's reveal opens a folded section only while its stop points there, and writes no memory", async ({ page }) => {
  const reveal = (detail: string | null) =>
    page.evaluate((anchor) => {
      window.dispatchEvent(new CustomEvent("zenith:tour-reveal", { detail: anchor }));
    }, detail);
  await selectStep(page, "driveOut");
  await header(page, "path.paths").click();
  await expect(header(page, "path.paths")).toHaveAttribute("aria-expanded", "false");
  const folded = { "path.paths": false };
  expect(await editor<Record<string, boolean>>(page, "s.prefs.inspectorFolds")).toEqual(folded);

  await reveal("section.segment");
  await expect(header(page, "path.paths")).toHaveAttribute("aria-expanded", "true");
  expect(await editor<Record<string, boolean>>(page, "s.prefs.inspectorFolds")).toEqual(folded);
  // The Paths section is the same on every path step (issue #431), and the reveal does not follow it there.
  await reveal("section.heading");
  await expect(header(page, "path.paths")).toHaveAttribute("aria-expanded", "false");
  await reveal("section.segment");
  await expect(header(page, "path.paths")).toHaveAttribute("aria-expanded", "true");
  await reveal(null);
  await expect(header(page, "path.paths")).toHaveAttribute("aria-expanded", "false");
  await selectStep(page, "toOtherSide");
  await expect(header(page, "path.paths")).toHaveAttribute("aria-expanded", "false");
  expect(await editor<Record<string, boolean>>(page, "s.prefs.inspectorFolds")).toEqual(folded);
});
