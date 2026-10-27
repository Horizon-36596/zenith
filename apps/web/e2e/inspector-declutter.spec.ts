/**
 * Issues #409 and #431: the Inspector, decluttered, then calmed. One selection header per step (its
 * id, the kind as the icon in front, its estimate, one `?`), the kind's own section under it, heading
 * shown and edited only in the Heading section, the selected marker or point first and alone, and a
 * Routine view that does not contradict itself.
 *
 * The bundled example opens collect-and-score: driveOut drives north from waypoint start to
 * scoreSouth with Heading: Tangent, so the robot faces 90° at both ends; shootPreloads runs the
 * stationary `score`; waitForFull waits for hopperFull with a 1 s cap; collectFlower has its own speed
 * (0.30) and one marker; toOtherSide is a curve with three control points; returnToScore is a
 * deadline group that ends with driveBack and holds the sequence clearThenSpinUp. all-step-kinds has
 * the branch checkPollen and driveBack, a chain of two paths under Reverse tangent.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { editor, loadExample, openAutoNamed, skipTour, waitForFonts } from "./qa/helpers";

/** Selects a step by its id, nested ones too, as a click on its row does. */
const pick = (page: Page, id: string): Promise<unknown> => editor(page, `m.selectStep(${JSON.stringify(id)})`);

const inspector = (page: Page): Locator => page.getByTestId("inspector");
const head = (page: Page): Locator => page.getByTestId("inspector-head");
const headers = (page: Page): Locator => inspector(page).locator("section > div > button[aria-expanded]:not([data-help])");
const header = (page: Page, title: RegExp): Locator => headers(page).filter({ hasText: title });
const section = (page: Page, fold: string): Locator => page.locator(`[data-testid^="inspector"] section[data-fold="${fold}"]`);
const tooltip = (page: Page): Locator => page.locator('[role="tooltip"]');
const step = (id: string): string => `s.auto.steps.flatMap(function f(x) { return [x, ...(x.steps ?? []).flatMap(f), ...(x.then ?? []).flatMap(f), ...(x.else ?? []).flatMap(f)]; }).find((x) => x.id === "${id}")`;

/** The titles of the Inspector's top-level sections, in order, as the DOM holds them (not uppercased). */
const sectionTitles = (page: Page): Promise<string[]> =>
  inspector(page)
    .locator(':scope > section > div > button[aria-expanded] > [class*="sectionTitle"]')
    .allTextContents();

/** The Inspector's scroll area: its own height and the height of what it holds. */
const scrollArea = (page: Page) =>
  inspector(page).evaluate((node) => {
    let at: HTMLElement | null = node as HTMLElement;
    while (at !== null && at !== document.body) {
      const overflow = getComputedStyle(at).overflowY;
      if ((overflow === "auto" || overflow === "scroll") && at.clientHeight > 0) {
        return { scrollHeight: at.scrollHeight, clientHeight: at.clientHeight };
      }
      at = at.parentElement;
    }
    return null;
  });

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
  await waitForFonts(page);
});

test.describe("the selection header", () => {
  test("is the step's id with the kind icon in front, and no kind word in the title", async ({ page }) => {
    for (const [id, kind] of [
      ["driveOut", "Path"],
      ["shootPreloads", "Command"],
      ["waitForFull", "Wait"],
      ["returnToScore", "Parallel group"],
    ] as const) {
      await pick(page, id);
      await expect(page.getByTestId("inspector-title")).toHaveText(id);
      await expect(head(page).getByTestId("inspector-kind-icon")).toHaveAttribute("aria-label", kind);
      await head(page).getByTestId("inspector-kind-icon").hover();
      await expect(tooltip(page)).toContainText(kind);
      await page.mouse.move(0, 0);
    }
    for (const word of ["Path chain", "Command ·", "Wait ·", "Sequence ·", "Parallel group ·", "Branch ·"]) {
      await expect(inspector(page)).not.toContainText(word);
    }
    // The region keeps its name, with no visible "Inspector" title over the header (issue #431).
    await expect(page.getByRole("region", { name: "Inspector" }).first()).toBeVisible();
    await expect(page.getByTestId("inspector-panel").locator("h2")).toHaveText(["returnToScore"]);
  });

  test("a command, wait, sequence or parallel step has one ? in its header and its kind's own section under it", async ({ page }) => {
    for (const [id, titles] of [
      ["shootPreloads", ["Command", "Advanced", "Notes"]],
      ["waitForFull", ["Wait", "Advanced", "Notes"]],
      ["clearThenSpinUp", ["Steps", "Notes"]],
      ["returnToScore", ["Group", "Steps", "Notes"]],
    ] as const) {
      await pick(page, id);
      await expect(page.getByTestId("inspector-title")).toHaveText(id);
      expect(await sectionTitles(page), id).toEqual(titles);
      // The kind's `?` is the header's one; its own section does not repeat it.
      await expect(head(page).locator('[data-testid^="help-"]'), id).toHaveCount(1);
      await expect(inspector(page).locator("section").first().locator('[data-testid^="help-"]'), id).toHaveCount(0);
    }
  });

  test("a branch has one header, Preview follows If true, and a guess chip with the ledger's reason", async ({ page }) => {
    await openAutoNamed(page, "all-step-kinds.auto.json");
    await editor(page, `m.selectStep("checkPollen")`);
    await expect(page.getByTestId("inspector-title")).toHaveText("checkPollen");
    expect(await sectionTitles(page)).toEqual(["Branch", "Notes"]);
    const row = page.getByTestId("inspector-branch-row");
    await expect(row).toContainText("Preview follows");
    await expect(page.getByTestId("inspector-branch-side")).toHaveText("If true");
    const text = await row.innerText();
    for (const word of [/\bthen\b/, /\belse\b/, /\(assumed\)/]) expect(text).not.toMatch(word);
    await page.getByTestId("inspector-branch-guess").hover();
    await expect(tooltip(page)).toContainText("holdingPiece");
  });

  test("has no Optimize button, and Stands still is an anchor beside the estimate, its words in its tooltip", async ({ page }) => {
    await pick(page, "driveOut");
    await expect(page.getByTestId("inspector-optimize")).toHaveCount(0);
    await expect(page.getByTestId("inspector-stands-still")).toHaveCount(0);
    await pick(page, "shootPreloads");
    await expect(page.getByTestId("inspector-estimate")).toHaveText(/^\d+\.\d\d s$/);
    const anchor = head(page).getByTestId("inspector-stands-still");
    await expect(anchor).toHaveText("Stands still");
    // Labels only: the words are for a screen reader and the tooltip, not drawn.
    await expect(anchor.locator(".visually-hidden")).toHaveText("Stands still");
    await anchor.hover();
    await expect(tooltip(page)).toContainText("The robot must stand still while it runs.");
    await expect(page.getByTestId("inspector-command-stationary")).toHaveCount(0);
    await expect(page.getByTestId("inspector-command-name-row")).toContainText("Command");
  });
});

test.describe("a path step", () => {
  test("with one path has no Path 1 level, and the + in its header makes the Path headers appear", async ({ page }) => {
    await pick(page, "driveOut");
    await expect(header(page, /^Path 1/)).toHaveCount(0);
    await expect(page.getByTestId("inspector-segment-remove-0")).toHaveCount(0);
    const paths = section(page, "path.paths");
    await expect(paths.locator("button[aria-expanded]").first()).toHaveText("Path");
    for (const id of ["inspector-segment-kind-0", "inspector-from-source-0", "inspector-to-source-0", "inspector-chain-add"]) {
      await expect(paths.getByTestId(id), id).toBeVisible();
    }
    // The + is the header's one action, named for what it does (issue #431).
    await expect(paths.locator(":scope > div").first().getByTestId("inspector-chain-add")).toHaveAccessibleName("Add path to chain");

    await page.getByTestId("inspector-chain-add").click();
    await expect.poll(() => editor<number>(page, `${step("driveOut")}.segments.length`)).toBe(2);
    await expect(paths.locator("button[aria-expanded]").first()).toHaveText(/^Paths\s*2$/);
    await expect(header(page, /^Path 1/)).toHaveCount(1);
    await expect(header(page, /^Path 2/)).toHaveCount(1);
    await expect(page.getByTestId("inspector-segment-remove-0")).toHaveAttribute("aria-disabled", "false");
    await expect(page.getByTestId("inspector-segment-remove-1")).toHaveAttribute("aria-disabled", "false");
    await page.getByTestId("inspector-segment-remove-1").click();
    await expect.poll(() => editor<number>(page, `${step("driveOut")}.segments.length`)).toBe(1);
    await expect(header(page, /^Path 1/)).toHaveCount(0);
  });

  test("a chain's bin shows on its sub-header's hover or keyboard focus, and always on touch", async ({ page }) => {
    await pick(page, "driveOut");
    await page.getByTestId("inspector-chain-add").click();
    const bin = page.getByTestId("inspector-segment-remove-1");
    const opacity = () => bin.evaluate((button) => getComputedStyle(button.closest('[class*="sectionActions"]') as HTMLElement).opacity);
    await page.mouse.move(5, 5);
    await expect.poll(opacity).toBe("0");
    await header(page, /^Path 2/).hover();
    await expect.poll(opacity).toBe("1");
    await page.mouse.move(5, 5);
    await expect.poll(opacity).toBe("0");
    await header(page, /^Path 2/).focus();
    await page.keyboard.press("Tab");
    await expect(bin).toBeFocused();
    await expect.poll(opacity).toBe("1");
  });

  test("shows heading only in the Heading section, with one planned readout and one Switch to Linear pencil", async ({ page }) => {
    await pick(page, "driveOut");
    await expect(page.getByTestId("inspector-from-0-heading")).toHaveCount(0);
    await expect(page.getByTestId("inspector-to-0-heading")).toHaveCount(0);
    await expect(page.getByTestId("inspector-heading-planned")).toHaveText("90.0° → 90.0°");
    // The planned readout is read only, so its row is drawn a step quieter.
    await expect(page.getByTestId("inspector-heading-planned-row")).toHaveAttribute("data-quiet", "");
    const heading = section(page, "path.heading");
    await expect(inspector(page).getByRole("button", { name: "Switch to Linear", exact: true })).toHaveCount(1);
    await expect(heading.locator(":scope > div").first().getByTestId("inspector-heading-linear")).toHaveCount(1);
    await page.getByTestId("inspector-heading-linear").click();
    await expect.poll(() => editor<string>(page, `${step("driveOut")}.heading.mode`)).toBe("linear");
    await expect(inspector(page).getByRole("button", { name: "Switch to Linear", exact: true })).toHaveCount(0);
  });

  test("a selected end has one heading row, the angle alone, with the mode in its tooltip and a pencil to the Heading field", async ({ page }) => {
    await editor(page, `m.setSelection({ stepId: "driveOut", point: { segmentIndex: 0, pointKind: "to" } })`);
    const block = page.getByTestId("inspector-point-to-0");
    await expect(block.locator('[data-testid$="-heading-row"]')).toHaveCount(1);
    await expect(page.getByTestId("inspector-to-0-heading")).toHaveText("90.0°");
    await expect(page.getByTestId("inspector-from-0-heading")).toHaveCount(0);
    await page.getByTestId("inspector-to-0-heading").hover();
    await expect(tooltip(page)).toContainText("Tangent");
    await expect(page.getByTestId("inspector-to-0-heading-row").locator("span[hidden]")).toContainText("Set by Heading: Tangent.");

    await page.getByTestId("inspector-to-0-heading-edit").click();
    await expect.poll(() => editor<string>(page, `${step("driveOut")}.heading.mode`)).toBe("linear");
    await expect(page.getByTestId("inspector-heading-to")).toBeFocused();
  });

  test("reads a constant heading of -π as 180.0°", async ({ page }) => {
    await editor(
      page,
      `m.commit({ ...s.auto, steps: s.auto.steps.map((x) => x.id === "driveOut" ? { ...x, heading: { mode: "constant", headingRad: -Math.PI } } : x) })`,
    );
    await editor(page, `m.setSelection({ stepId: "driveOut", point: { segmentIndex: 0, pointKind: "to" } })`);
    await expect(page.getByTestId("inspector-to-0-heading")).toHaveText("180.0°");
  });

  test("a selected end that follows a waypoint shows where it is, read only; one not selected keeps it in its tooltip", async ({ page }) => {
    await pick(page, "driveOut");
    // Not selected: the source alone, its waypoint's pose in the select's tooltip (issue #431).
    await expect(page.getByTestId("inspector-to-0-follows-pose")).toHaveCount(0);
    await expect(page.getByTestId("inspector-to-source-0")).toHaveAttribute("title", "scoreSouth: -13.00, -36.00 in");
    await editor(page, `m.setSelection({ stepId: "driveOut", point: { segmentIndex: 0, pointKind: "to" } })`);
    const line = page.getByTestId("inspector-to-0-follows-pose");
    await expect(line).toHaveText("-13.00 -36.00 in");
    await expect(line.locator("input")).toHaveCount(0);
    await expect(line.locator("xpath=ancestor::div[@data-quiet][1]")).toHaveCount(1);
    // The other end, not selected, still says nothing more than its source.
    await expect(page.getByTestId("inspector-from-0-follows-pose")).toHaveCount(0);
  });

  test("From at the last step's end is the default, drawn a step quieter than a set value", async ({ page }) => {
    await pick(page, "toOtherSide");
    const quiet = (testId: string) => page.getByTestId(testId).locator("xpath=ancestor::div[contains(@class, 'row')][1]");
    await expect(quiet("inspector-from-source-0")).toHaveAttribute("data-quiet", "");
    await expect(quiet("inspector-to-source-0")).not.toHaveAttribute("data-quiet", "");
    const colours = await page.evaluate(() => {
      const of = (id: string) => getComputedStyle(document.querySelector(`[data-testid="${id}"]`) as HTMLElement).color;
      return { from: of("inspector-from-source-0"), to: of("inspector-to-source-0") };
    });
    expect(colours.from).not.toBe(colours.to);
  });

  test("curve control points sit behind a folded Controls row, and carry no provenance chip unless one is the selected point", async ({ page }) => {
    await pick(page, "toOtherSide");
    const controls = page.getByTestId("inspector-controls-0");
    await expect(controls).toHaveAttribute("aria-expanded", "false");
    await expect(controls).toContainText("3 points");
    await expect(page.getByTestId("inspector-control-x-0-0")).toHaveCount(0);
    await controls.click();
    await expect(page.getByTestId("inspector-control-x-0-0")).toBeVisible();
    await expect(inspector(page).locator('[data-testid^="inspector-control-provenance-"]')).toHaveCount(0);
    await expect(page.getByTestId("inspector-from-provenance-0").or(page.getByTestId("inspector-to-source-0"))).not.toHaveCount(0);
    // Folded again, a control point selected on the field opens Controls for now and writes no memory.
    await controls.click();
    const folds = await editor<Record<string, boolean>>(page, "s.prefs.inspectorFolds");
    await editor(page, `m.setSelection({ stepId: "toOtherSide", point: { segmentIndex: 0, pointKind: "control", controlIndex: 1 } })`);
    await expect(controls).toHaveAttribute("aria-expanded", "true");
    expect(await editor<Record<string, boolean>>(page, "s.prefs.inspectorFolds")).toEqual(folds);
    await expect(inspector(page).locator('[data-testid^="inspector-control-provenance-"]')).toHaveCount(1);
    await expect(page.getByTestId("inspector-control-provenance-0-1")).toBeVisible();
  });

  test("a later path's From at a joint is one read-only line, End of Path 1", async ({ page }) => {
    await openAutoNamed(page, "all-step-kinds.auto.json");
    await editor(page, `m.setSelection({ stepId: "driveBack", point: { segmentIndex: 1, pointKind: "to" } })`);
    const joint = page.getByTestId("inspector-from-joint-1");
    await expect(joint).toContainText("End of Path 1");
    await expect(joint.locator("input, select")).toHaveCount(0);
    await expect(page.getByTestId("inspector-from-x-1")).toHaveCount(0);
  });

  test("the speed row reads a percent, quiet at the robot default, and its reset returns the robot default", async ({ page }) => {
    await pick(page, "driveOut");
    const row = page.getByTestId("inspector-speed-row");
    await expect(row).toContainText("Speed");
    await expect(row).toHaveAttribute("data-quiet", "");
    await expect(page.getByTestId("inspector-speed")).toHaveAttribute("placeholder", "80");
    await expect(page.getByTestId("inspector-speed-default-note")).toHaveText("default");
    await expect(page.getByTestId("inspector-speed-default")).toHaveCount(0);
    await expect(section(page, "path.speed")).toContainText("Stop early");
    await expect(page.getByTestId("inspector-end-condition").locator("option").first()).toHaveText("Never");
    // Never is the default, so it is quiet too; Give up after is the path's time limit, beside it.
    await expect(page.getByTestId("inspector-end-condition").locator("xpath=ancestor::div[contains(@class, 'row')][1]")).toHaveAttribute("data-quiet", "");
    await expect(section(page, "path.speed").getByTestId("inspector-timeout")).toHaveAttribute("placeholder", "Never");

    await pick(page, "collectFlower");
    await expect(page.getByTestId("inspector-speed")).toHaveValue("30");
    await expect(page.getByTestId("inspector-speed-row")).not.toHaveAttribute("data-quiet", "");
    await page.getByTestId("inspector-speed-default").hover();
    await expect(tooltip(page)).toContainText("Use the robot default, 80%");
    await page.getByTestId("inspector-speed-default").click();
    await expect.poll(() => editor<unknown>(page, `${step("collectFlower")}.speedFraction`)).toBeUndefined();
    await expect(inspector(page).getByRole("button", { name: "Use the robot default, 80%" })).toHaveCount(0);
  });

  test("Markers has no count while empty and its + is the header's action, a marker is a 24 px row, and At reads a percent", async ({ page }) => {
    await pick(page, "driveOut");
    const markers = section(page, "path.markers");
    await expect(markers.locator("button[aria-expanded]:not([data-help])")).toHaveText("Markers");
    await expect(page.getByTestId("inspector-markers-empty")).toHaveCount(0);
    await expect(markers.locator(":scope > div").first().getByTestId("inspector-marker-add")).toHaveAccessibleName("Add marker");

    await pick(page, "collectFlower");
    await expect(markers.locator("button[aria-expanded]:not([data-help])")).toHaveText(/^Markers\s*1$/);
    const box = await page.getByTestId("inspector-marker-open-0").boundingBox();
    expect(box?.height).toBe(24);
    await editor(page, `m.setSelection({ stepId: "collectFlower", markerIndex: 0 })`);
    const unit = page.getByTestId("inspector-marker-at-unit");
    await expect(unit.locator("option")).toHaveText(["% along", "in from start", "in from end"]);
    await editor(
      page,
      `m.commit({ ...s.auto, steps: s.auto.steps.map((x) => x.id === "collectFlower" ? { ...x, markers: x.markers.map((k) => ({ ...k, at: { t: 0.5 } })) } : x) })`,
    );
    await expect(unit).toHaveValue("t");
    await expect(page.getByTestId("inspector-marker-at")).toHaveValue("50");
    await page.getByTestId("inspector-marker-at").fill("35");
    await page.getByTestId("inspector-marker-at").press("Enter");
    await expect.poll(() => editor<unknown>(page, `${step("collectFlower")}.markers[0].at`)).toEqual({ t: 0.35 });
  });

  test("a selected marker shows alone under a breadcrumb, whose path name goes back to the path with Markers open", async ({ page }) => {
    await editor(page, `m.setSelection({ stepId: "collectFlower", markerIndex: 0 })`);
    await expect(inspector(page).locator('[data-tour="section.marker"]')).toBeVisible();
    for (const fold of ["path.heading", "path.speed", "path.markers", "path.paths"]) {
      await expect(section(page, fold), fold).toHaveCount(0);
    }
    await expect(page.getByTestId("inspector-title")).toHaveText("Marker 1");
    const back = head(page).getByTestId("inspector-marker-back");
    await expect(back).toHaveText("collectFlower");
    // The person folded Markers on a path; coming back from a marker opens it for now.
    await editor(page, `m.setPrefs({ inspectorFolds: { "path.markers": false } })`);
    await back.click();
    await expect.poll(() => editor<unknown>(page, "s.selection")).toEqual({ stepId: "collectFlower" });
    await expect(section(page, "path.heading")).toHaveCount(1);
    await expect(section(page, "path.markers").locator("button[aria-expanded]").first()).toHaveAttribute("aria-expanded", "true");
    expect(await editor<Record<string, boolean>>(page, "s.prefs.inspectorFolds")).toEqual({ "path.markers": false });
  });

  test("notes are a folded Notes section with a dot, whose well is the box", async ({ page }) => {
    await pick(page, "driveOut");
    const notes = section(page, "step.notes");
    const notesHead = notes.locator("button[aria-expanded]").first();
    await expect(notesHead).toHaveAttribute("aria-expanded", "false");
    // driveOut has notes, so the folded header carries the set-value dot, and no prose shows.
    await expect(notesHead.getByTestId("section-dot")).toHaveAttribute("data-tone", "set");
    await expect(page.getByTestId("inspector-notes-preview")).toHaveCount(0);
    await expect(inspector(page).locator("textarea")).toHaveCount(0);
    // The last section, after the path's own rows.
    const folds = await inspector(page).locator(":scope > section[data-fold]").evaluateAll((all) => all.map((node) => node.getAttribute("data-fold")));
    expect(folds.at(-1)).toBe("step.notes");
    await notesHead.click();
    const box = page.getByTestId("inspector-notes");
    await expect(box).toBeVisible();
    await expect(box).toHaveValue(await editor<string>(page, `${step("driveOut")}.notes`));
    await expect(notesHead.getByTestId("section-dot")).toHaveCount(0);
    await box.fill("Changed.");
    await page.getByTestId("inspector-estimate").click();
    await expect.poll(() => editor<string>(page, `${step("driveOut")}.notes`)).toBe("Changed.");
  });
});

test.describe("other kinds", () => {
  test("a wait for a condition says its cap once, as Give up after, and Advanced never says envelope", async ({ page }) => {
    await pick(page, "waitForFull");
    await expect(page.getByTestId("inspector-wait-cap")).toHaveCount(0);
    await expect(inspector(page).locator("label", { hasText: "Give up after" })).toHaveCount(1);
    for (const id of ["waitForFull", "driveOut", "shootPreloads"]) {
      await pick(page, id);
      await expect(section(page, "step.more"), id).not.toContainText(/envelope/i);
    }
  });

  test("Give up after is the one name for a step's time limit, on every kind that has one", async ({ page }) => {
    for (const id of ["driveOut", "waitForFull", "shootPreloads"]) {
      await pick(page, id);
      await expect(section(page, "step.more").locator("button[aria-expanded]").first()).toBeVisible();
      if ((await section(page, "step.more").locator("button[aria-expanded]").first().getAttribute("aria-expanded")) === "false") {
        await section(page, "step.more").locator("button[aria-expanded]").first().click();
      }
      await expect(inspector(page).locator("label", { hasText: /^Timeout$/ }), id).toHaveCount(0);
      await expect(page.getByTestId("inspector-timeout-row"), id).toContainText("Give up after");
    }
    // A path's sits in Speed beside Stop early, a command's in Advanced.
    await pick(page, "driveOut");
    await expect(section(page, "path.speed").getByTestId("inspector-timeout")).toHaveCount(1);
    await pick(page, "shootPreloads");
    await expect(section(page, "step.more").getByTestId("inspector-timeout")).toHaveCount(1);
  });

  test("a sequence and a parallel group list their members, and a click selects one", async ({ page }) => {
    await pick(page, "returnToScore");
    await expect(inspector(page).locator("label", { hasText: "Ends with" })).toHaveCount(1);
    const driveBack = page.getByTestId("inspector-member-driveBack");
    await expect(driveBack).toContainText("driveBack");
    await expect(driveBack).toContainText(/\d+\.\d s/);
    // The member that ends the group carries a flag; its words are its title and, in Labels only, hidden.
    const ends = driveBack.getByTestId("inspector-member-ends");
    await expect(ends).toHaveText("ends the group");
    await expect(ends).toHaveAttribute("title", "Ends the group");
    await expect(ends.locator(".visually-hidden")).toHaveCount(1);
    await expect(page.getByTestId("inspector-member-clearThenSpinUp").getByTestId("inspector-member-ends")).toHaveCount(0);
    const box = await driveBack.boundingBox();
    expect(box?.height).toBe(24);
    await page.getByTestId("inspector-member-clearThenSpinUp").click();
    await expect.poll(() => editor<unknown>(page, "s.selection.stepId")).toBe("clearThenSpinUp");
    await expect(page.getByTestId("inspector-member-clearGarden")).toBeVisible();
    await page.getByTestId("inspector-member-readyLauncher").click();
    await expect.poll(() => editor<unknown>(page, "s.selection.stepId")).toBe("readyLauncher");
  });
});

test.describe("selection", () => {
  test("several points show a Selection line under the header and a Clear selection that clears it", async ({ page }) => {
    await editor(
      page,
      `m.setSelection({ stepId: "toOtherSide", point: { segmentIndex: 0, pointKind: "to" }, points: [
        { stepId: "driveOut", point: { segmentIndex: 0, pointKind: "to" } },
        { stepId: "toOtherSide", point: { segmentIndex: 0, pointKind: "from" } },
        { stepId: "toOtherSide", point: { segmentIndex: 0, pointKind: "to" } },
      ] })`,
    );
    await expect(page.getByTestId("inspector-points-selected")).toHaveText("3 points in 2 steps");
    // One 28 px row above the first section (issue #431).
    const line = await page.getByTestId("inspector-selection").boundingBox();
    const first = await inspector(page).locator(":scope > section").first().boundingBox();
    expect(line?.height).toBeGreaterThanOrEqual(28);
    expect((line?.y ?? 0) + (line?.height ?? 0)).toBeLessThanOrEqual((first?.y ?? 0) + 1);
    const clear = page.getByTestId("inspector-clear-selection");
    await expect(clear).toHaveText("Clear selection");
    await clear.hover();
    await expect(tooltip(page)).toContainText("Esc");
    await clear.click();
    await expect.poll(() => editor<unknown>(page, "s.selection")).toEqual({});
  });

  test("nothing selected is the Routine view, whose ? says how to leave it", async ({ page }) => {
    await editor(page, "m.setSelection({})");
    const routine = page.getByTestId("inspector-routine");
    await expect(page.getByTestId("inspector-empty")).toHaveCount(0);
    await expect(page.getByTestId("descriptions-hint")).toHaveCount(0);
    await expect(page.getByTestId("inspector-routine-head")).toContainText("Routine");
    // The line moved into the header's ? (issue #431): no prose in the panel.
    await expect(page.getByTestId("inspector-routine-head")).not.toContainText("Select a step");
    await page.getByTestId("inspector-routine-head").getByTestId("help-inspector").hover();
    await expect(tooltip(page)).toContainText("Select a step or a point to edit it.");
    await expect(routine.getByText("Nothing selected.")).toHaveCount(0);
  });

  test("the start is one Pose select like a path end, and shows the waypoint it follows as quiet rows", async ({ page }) => {
    await editor(page, "m.setSelection({})");
    const start = section(page, "routine.start");
    await expect(start.locator("button[aria-expanded]:not([data-help])")).toHaveText("Start");
    const select = page.getByTestId("inspector-start-source");
    await expect(start.locator("label", { hasText: "Pose" })).toHaveCount(1);
    await expect(select.locator("option").first()).toHaveText("This pose");
    await expect(select.locator("optgroup[label='Waypoints'] option[value='ref:start']")).toHaveCount(1);
    await expect(page.getByTestId("inspector-start-ref")).toHaveCount(0);
    await expect(start.getByRole("button", { name: /^(Select waypoint|Save as waypoint…)/ }).filter({ hasText: /\w/ })).toHaveCount(0);
    await expect(page.getByTestId("inspector-start-follows-pose")).toHaveText("-13.00 -63.00 in");
    await expect(page.getByTestId("inspector-start-follows-heading")).toHaveText("90.0°");
    await expect(page.getByTestId("inspector-start-select-waypoint")).toBeVisible();

    await select.selectOption("pose");
    await expect.poll(() => editor<unknown>(page, "s.auto.start.pose")).toMatchObject({ xIn: -13, yIn: -63 });
    await expect(page.getByTestId("inspector-start-x")).toBeVisible();
    await expect(page.getByTestId("inspector-start-save-waypoint")).toBeVisible();
  });
});

test.describe("With descriptions", () => {
  test.beforeEach(async ({ page }) => {
    await editor(page, `m.setPrefs({ descriptions: "full" })`);
  });

  test("no brief shows twice, and Speed, Stop early and Mode have one", async ({ page }) => {
    for (const id of ["driveOut", "collectFlower", "toOtherSide", "waitForFull", "returnToScore"]) {
      await pick(page, id);
      await expect(inspector(page).getByTestId("row-brief").first()).toBeVisible();
      const briefs = await inspector(page).getByTestId("row-brief").allInnerTexts();
      expect(new Set(briefs).size, `${id}: ${briefs.join(" | ")}`).toBe(briefs.length);
    }
    await pick(page, "driveOut");
    await expect(page.getByTestId("inspector-speed-row").getByTestId("row-brief")).toBeVisible();
    await expect(section(page, "path.speed").getByTestId("row-brief")).toHaveCount(2);
    await expect(section(page, "path.heading").getByTestId("row-brief").first()).toHaveText("Which way the robot faces as it drives");
  });

  test("the words the icons stand for are drawn as quiet briefs: Stands still, ends the group, and a followed end's pose", async ({ page }) => {
    await pick(page, "shootPreloads");
    await expect(page.getByTestId("inspector-stands-still").locator(".visually-hidden")).toHaveCount(0);
    await expect(page.getByTestId("inspector-stands-still")).toBeVisible();
    await expect(page.getByTestId("inspector-stands-still")).toHaveText("Stands still");
    await pick(page, "returnToScore");
    await expect(page.getByTestId("inspector-member-ends").locator(".visually-hidden")).toHaveCount(0);
    await pick(page, "driveOut");
    await expect(page.getByTestId("inspector-to-0-follows-brief")).toHaveText("-13.00, -36.00 in");
    await expect(page.getByTestId("inspector-from-0-follows-brief")).toHaveText("-13.00, -63.00 in");
    // A selected end shows its Position row instead, so its brief goes.
    await editor(page, `m.setSelection({ stepId: "driveOut", point: { segmentIndex: 0, pointKind: "to" } })`);
    await expect(page.getByTestId("inspector-to-0-follows-brief")).toHaveCount(0);
    await expect(page.getByTestId("inspector-to-0-follows-pose")).toBeVisible();
  });
});

test.describe("at 1024x640", () => {
  test.use({ viewport: { width: 1024, height: 640 } });

  test("driveOut's Inspector does not scroll with Advanced and Notes folded", async ({ page }) => {
    await pick(page, "driveOut");
    await expect(section(page, "step.more").locator("button[aria-expanded]:not([data-help])")).toHaveAttribute("aria-expanded", "false");
    await expect(section(page, "step.notes").locator("button[aria-expanded]:not([data-help])")).toHaveAttribute("aria-expanded", "false");
    const area = await scrollArea(page);
    expect(area).not.toBeNull();
    expect(area?.scrollHeight ?? Infinity).toBeLessThanOrEqual(area?.clientHeight ?? 0);
  });

  test("a selected end's heading row keeps its label and value apart", async ({ page }) => {
    await openAutoNamed(page, "all-step-kinds.auto.json");
    await editor(page, `m.setSelection({ stepId: "driveBack", point: { segmentIndex: 1, pointKind: "to" } })`);
    const row = page.getByTestId("inspector-to-1-heading-row");
    await expect(row).toBeVisible();
    const label = await row.locator("label").boundingBox();
    const value = await page.getByTestId("inspector-to-1-heading").boundingBox();
    expect(label).not.toBeNull();
    expect(value).not.toBeNull();
    if (label === null || value === null) return;
    const apart =
      label.x + label.width <= value.x ||
      value.x + value.width <= label.x ||
      label.y + label.height <= value.y ||
      value.y + value.height <= label.y;
    expect(apart).toBe(true);
  });
});

test("Advanced starts folded with no prose summary, and a time limit set inside gives it a dot", async ({ page }) => {
  await pick(page, "shootPreloads");
  const more = section(page, "step.more");
  const moreHead = more.locator("button[aria-expanded]").first();
  await expect(moreHead).toHaveAttribute("aria-expanded", "false");
  await expect(moreHead).toHaveText("Advanced");
  await expect(moreHead.getByTestId("section-dot")).toHaveCount(0);
  await editor(page, `m.commit({ ...s.auto, steps: s.auto.steps.map((x) => x.id === "shootPreloads" ? { ...x, timeoutS: 3 } : x) })`);
  await expect(moreHead.getByTestId("section-dot")).toHaveAttribute("data-tone", "set");
  await moreHead.click();
  await expect(page.getByTestId("inspector-timeout")).toHaveValue("3.00");
});

test("a folded Wait with no time limit carries a lemon dot, and the warning chip shows when it opens", async ({ page }) => {
  await editor(page, `m.commit({ ...s.auto, steps: s.auto.steps.map((x) => x.id === "waitForFull" ? { ...x, timeoutS: undefined } : x) })`);
  await pick(page, "waitForFull");
  const waitHead = section(page, "wait").locator("button[aria-expanded]").first();
  await expect(page.getByTestId("inspector-wait-no-timeout")).toBeVisible();
  await waitHead.click();
  await expect(waitHead.getByTestId("section-dot")).toHaveAttribute("data-tone", "warn");
  const colour = await waitHead.getByTestId("section-dot").evaluate((dot) => getComputedStyle(dot).backgroundColor);
  const lemon = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--sev-warn)";
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  });
  expect(colour).toBe(lemon);
  await waitHead.click();
  await expect(waitHead.getByTestId("section-dot")).toHaveCount(0);
  await expect(page.getByTestId("inspector-wait-no-timeout")).toBeVisible();
});

test("a point selected on the field opens its folded section without writing the fold memory", async ({ page }) => {
  await pick(page, "driveOut");
  await section(page, "path.paths").locator("button[aria-expanded]").first().click();
  await expect(page.getByTestId("inspector-to-source-0")).toHaveCount(0);
  const folds = await editor<Record<string, boolean>>(page, "s.prefs.inspectorFolds");
  expect(folds).toEqual({ "path.paths": false });
  await editor(page, `m.setSelection({ stepId: "driveOut", point: { segmentIndex: 0, pointKind: "to" } })`);
  await expect(page.getByTestId("inspector-to-source-0")).toBeVisible();
  expect(await editor<Record<string, boolean>>(page, "s.prefs.inspectorFolds")).toEqual(folds);
  // A waypoint pin selected on the field opens the waypoint list the same way.
  await editor(page, `m.setPrefs({ inspectorFolds: { "waypoint.list": false } })`);
  await editor(page, `m.setSelection({ waypoint: "scoreSouth" })`);
  await expect(section(page, "waypoint.list").locator("button[aria-expanded]").first()).toHaveAttribute("aria-expanded", "true");
  expect(await editor<Record<string, boolean>>(page, "s.prefs.inspectorFolds")).toEqual({ "waypoint.list": false });
});
