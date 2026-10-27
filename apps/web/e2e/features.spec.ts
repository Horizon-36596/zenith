/**
 * The feature switches of Settings, General (issue #101). Commands starts on, because the example
 * uses it (issue #112), and partner sharing and the ledger start off. Off takes the
 * feature out of the whole editor, not only one panel; turning a switch on brings everything back
 * at once, with no reload. An auto that already has command steps keeps them: the step list says
 * how many are hidden, and saving writes them back unchanged.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { openServedFolder, readServed, serveFolder, starterFiles } from "./opfsProject";
import { dragWorld, editor, openAutoNamed, openMore, selectStep, worldToScreen } from "./qa/helpers";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
    }
    window.localStorage.removeItem("zenith.cloudFake");
  });
});

/** The example, collect-and-score: four command steps, a marker, a ledger and a partner to load. */
async function loadExample(page: Page): Promise<void> {
  await page.goto("/?cloud=fake");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
}

/**
 * Stores Commands as switched off before the page loads, the way a person who turned it off has it.
 * Runs after the tour preference above, and only while no switches are stored, so a reload keeps
 * whatever the test changed.
 */
async function storeCommandsOff(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const prefs = JSON.parse(window.localStorage.getItem("zenith.ui") ?? "{}") as Record<string, unknown>;
    if (prefs["features"] !== undefined) return;
    prefs["features"] = { partners: false, ledger: false, commands: false };
    // At the current preferences version, so this reads as the person's choice and is kept.
    prefs["version"] = 1;
    window.localStorage.setItem("zenith.ui", JSON.stringify(prefs));
  });
}

async function openGeneral(page: Page): Promise<void> {
  await page.getByTestId("toolbar-settings").click();
  await page.getByTestId("settings-nav-general").click();
  await expect(page.getByTestId("settings-section-general")).toBeVisible();
}

async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings")).toHaveCount(0);
}

/**
 * Stores the named switches before the page loads, over Commands on and the other two original
 * switches off; a switch it does not name is not stored, so it takes Essential's value, on.
 */
async function storeSwitches(page: Page, switches: Record<string, boolean>, extra: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript(
    ({ wanted, more }) => {
      const prefs = JSON.parse(window.localStorage.getItem("zenith.ui") ?? "{}") as Record<string, unknown>;
      if (prefs["features"] !== undefined) return;
      prefs["features"] = { partners: false, ledger: false, commands: true, ...wanted };
      prefs["version"] = 1;
      Object.assign(prefs, more);
      window.localStorage.setItem("zenith.ui", JSON.stringify(prefs));
    },
    { wanted: switches, more: extra },
  );
}

async function setSwitch(page: Page, feature: string, on: boolean): Promise<void> {
  await openGeneral(page);
  const choice = page.getByTestId(`settings-feature-${feature}-choice-${on ? "on" : "off"}`);
  await choice.click();
  await expect(choice).toHaveAttribute("aria-pressed", "true");
  await closeSettings(page);
}

async function paletteHas(page: Page, query: string, id: string): Promise<boolean> {
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill(query);
  const count = await page.getByTestId(`palette-item-${id}`).count();
  await page.keyboard.press("Escape");
  return count > 0;
}

test("Commands starts on and the other switches off, and General says so with pathing always on", async ({ page }) => {
  await loadExample(page);
  // The example's command steps are listed from the first load (issue #112).
  await expect(page.getByTestId("step-row-shootPreloads")).toBeVisible();
  await expect(page.getByTestId("steps-hidden-commands")).toHaveCount(0);
  await openGeneral(page);
  await expect(page.getByTestId("settings-feature-commands-choice-on")).toHaveAttribute("aria-pressed", "true");
  for (const feature of ["partners", "ledger"]) {
    await expect(page.getByTestId(`settings-feature-${feature}-choice-off`)).toHaveAttribute("aria-pressed", "true");
  }
  // The switches the presets added are on, as in Essential, Optimize path among them now that it exists.
  for (const feature of ["groups", "waypoints", "advancedHeading", "optimizer", "codeTab"]) {
    await expect(page.getByTestId(`settings-feature-${feature}-choice-on`)).toHaveAttribute("aria-pressed", "true");
  }
  // General has no Pathing row any more (issue #414).
  await expect(page.getByTestId("settings-feature-pathing")).toHaveCount(0);
  await expect(page.getByTestId("settings-nav-commands")).toBeVisible();
  await expect(page.getByTestId("settings-nav-robot")).toBeVisible();
  // The command library stays, in Robot under Follower: the generated code needs its runtime even for an auto of paths alone.
  await page.getByTestId("settings-nav-robot").click();
  await expect(page.getByTestId("settings-command-library")).toBeVisible();
  await expect(page.getByTestId("settings-pathing")).toBeVisible();
});

test("Commands off saved before it started on is switched on once (issue #112)", async ({ page }) => {
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem("seeded") !== null) return;
    window.sessionStorage.setItem("seeded", "1");
    const prefs = JSON.parse(window.localStorage.getItem("zenith.ui") ?? "{}") as Record<string, unknown>;
    // As every save wrote it before the preferences had a version.
    prefs["features"] = { partners: false, ledger: false, commands: false };
    window.localStorage.setItem("zenith.ui", JSON.stringify(prefs));
  });
  await loadExample(page);
  await expect(page.getByTestId("step-row-shootPreloads")).toBeVisible();
  const stored = await page.evaluate(
    () => JSON.parse(window.localStorage.getItem("zenith.ui") ?? "{}") as { version?: number; features?: { commands?: boolean } },
  );
  expect(stored.version).toBe(1);
  expect(stored.features?.commands).toBe(true);
});

test("a person who switched Commands off keeps it off after a reload", async ({ page }) => {
  await loadExample(page);
  await setSwitch(page, "commands", false);
  await expect(page.getByTestId("step-row-shootPreloads")).toHaveCount(0);
  await page.reload();
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await expect(page.getByTestId("step-row-shootPreloads")).toHaveCount(0);
  await expect(page.getByTestId("steps-hidden-commands")).toBeVisible();
});

test("Commands off hides command steps, markers and every way to add one, and on brings them back", async ({ page }) => {
  await storeCommandsOff(page);
  await loadExample(page);

  // Off: the command steps are kept but not listed, and one line says where they went.
  await expect(page.getByTestId("steps-hidden-commands")).toHaveText(
    "This auto has 6 command steps and 2 markers. Turn on Commands in Settings, General to see them.",
  );
  for (const id of ["shootPreloads", "stopIntake", "scoreGardenPollen"]) await expect(page.getByTestId(`step-row-${id}`)).toHaveCount(0);
  await expect(page.getByTestId("step-row-sweepGarden")).toBeVisible();
  await expect(page.getByTestId("toolbar-tool.marker")).toHaveCount(0);
  await expect(page.getByTestId("toolbar-tool.addCommand")).toHaveCount(0);
  // No marker section on a path that has one, and no way to insert a command or a parallel group.
  await page.getByTestId("step-row-sweepGarden").click();
  await expect(page.locator('[data-tour="section.markers"]')).toHaveCount(0);
  await page.getByTestId("insert-step").click();
  await expect(page.getByTestId("insert-kind-path")).toBeVisible();
  await expect(page.getByTestId("insert-kind-command")).toHaveCount(0);
  await expect(page.getByTestId("insert-kind-parallel")).toHaveCount(0);
  await page.keyboard.press("Escape");
  // C does nothing, and the palette offers neither commands nor the Java import.
  await page.keyboard.press("c");
  await expect(page.getByTestId("toolbar-tool.select")).toHaveAttribute("aria-pressed", "true");
  expect(await paletteHas(page, "Import commands", "project.importCommands")).toBe(false);
  expect(await paletteHas(page, "Insert score", "command:score")).toBe(false);

  // On: everything is back without a reload.
  await setSwitch(page, "commands", true);
  await expect(page.getByTestId("steps-hidden-commands")).toHaveCount(0);
  for (const id of ["shootPreloads", "stopIntake", "scoreGardenPollen"]) await expect(page.getByTestId(`step-row-${id}`)).toBeVisible();
  await expect(page.getByTestId("toolbar-tool.marker")).toBeVisible();
  await page.getByTestId("step-row-sweepGarden").click();
  await expect(page.locator('[data-tour="section.markers"]')).toBeVisible();
  expect(await paletteHas(page, "Import commands", "project.importCommands")).toBe(true);
  await page.getByTestId("toolbar-settings").click();
  await expect(page.getByTestId("settings-nav-commands")).toBeVisible();
  await closeSettings(page);

  // And off again hides them again.
  await setSwitch(page, "commands", false);
  await expect(page.getByTestId("step-row-shootPreloads")).toHaveCount(0);
  await expect(page.getByTestId("toolbar-tool.marker")).toHaveCount(0);
});

test("Ledger off hides the Ledger panel, its counts and its problems, and on brings them back", async ({ page }) => {
  await loadExample(page);
  await expect(page.getByTestId("ledger-panel")).toHaveCount(0);
  await expect(page.getByTestId("ledger-resizer")).toHaveCount(0);
  expect(await paletteHas(page, "Ledger counts", "view.ledgerCounts")).toBe(false);
  await page.getByTestId("insert-step").click();
  await expect(page.getByTestId("insert-kind-transfer")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await setSwitch(page, "ledger", true);
  await expect(page.getByTestId("ledger-panel")).toBeVisible();
  expect(await paletteHas(page, "Ledger counts", "view.ledgerCounts")).toBe(true);
  await page.getByTestId("insert-step").click();
  await expect(page.getByTestId("insert-kind-transfer")).toBeVisible();
  await page.keyboard.press("Escape");

  await setSwitch(page, "ledger", false);
  await expect(page.getByTestId("ledger-panel")).toHaveCount(0);
});

test("Partner sharing off hides the Partners panel and every share entry point, and on brings them back", async ({ page }) => {
  await loadExample(page);
  await expect(page.getByTestId("partners-panel")).toHaveCount(0);
  await expect(page.getByTestId("toolbar-share.open")).toHaveCount(0);
  expect(await paletteHas(page, "share file", "project.downloadShareFile")).toBe(false);
  expect(await paletteHas(page, "proposal", "proposal.open")).toBe(false);

  await setSwitch(page, "partners", true);
  await expect(page.getByTestId("partners-panel")).toBeVisible();
  await expect(page.getByTestId("toolbar-share.open")).toBeVisible();
  expect(await paletteHas(page, "share file", "project.downloadShareFile")).toBe(true);

  await setSwitch(page, "partners", false);
  await expect(page.getByTestId("partners-panel")).toHaveCount(0);
  await expect(page.getByTestId("toolbar-share.open")).toHaveCount(0);
});

test("the full tour skips the stops of features that are off", async ({ page }) => {
  await storeCommandsOff(page);
  await loadExample(page);
  await page.getByTestId("toolbar-help").click();
  await page.getByTestId("menu-help.fullTour").click();
  const card = page.getByTestId("tour-card");
  await expect(card).toBeVisible();
  const seen: string[] = [];
  for (let index = 0; index < 30; index += 1) {
    if ((await card.count()) === 0) break;
    const stop = (await card.getAttribute("data-stop")) ?? "";
    seen.push(stop);
    await page.getByTestId("tour-next").click();
    // The next stop, or the end of the tour.
    await expect.poll(async () => ((await card.count()) === 0 ? "" : await card.getAttribute("data-stop"))).not.toBe(stop);
  }
  expect(seen).toContain("tool.select");
  expect(seen).toContain("timeline");
  for (const hidden of ["tool.marker", "section.markers", "ledger"]) expect(seen).not.toContain(hidden);
});

test("an auto with hidden command steps saves them back unchanged", async ({ page }) => {
  await storeCommandsOff(page);
  const files = starterFiles();
  await serveFolder(page, files);
  await page.goto("/");
  await openServedFolder(page);
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await expect(page.getByTestId("steps-hidden-commands")).toHaveText(
    "This auto has 1 command step. Turn on Commands in Settings, General to see them.",
  );
  await expect(page.getByTestId("step-row-scorePreload")).toHaveCount(0);

  // An edit somewhere else, then Save.
  await page.getByTestId("step-row-park").click();
  await openMore(page);
  await page.getByTestId("inspector-timeout").fill("4");
  await page.getByTestId("inspector-timeout").press("Enter");
  await page.keyboard.press("Control+s");
  await expect.poll(async () => (JSON.parse(await readServed(page, "autos/first-auto.auto.json")) as { steps: Array<{ id: string; timeoutS?: number }> }).steps.find((step) => step.id === "park")?.timeoutS).toBe(4);

  const before = JSON.parse(files["autos/first-auto.auto.json"] ?? "{}") as { steps: Array<Record<string, unknown>> };
  const after = JSON.parse(await readServed(page, "autos/first-auto.auto.json")) as { steps: Array<Record<string, unknown>> };
  expect(after.steps.map((step) => step["id"])).toEqual(before.steps.map((step) => step["id"]));
  expect(after.steps.find((step) => step["id"] === "scorePreload")).toEqual(before.steps.find((step) => step["id"] === "scorePreload"));
});

/** The ids of the step rows the list shows, top level and nested, in order. */
async function rowIds(page: Page): Promise<string[]> {
  return page
    .locator("[data-testid^='step-row-']")
    .evaluateAll((rows) => rows.map((row) => (row.getAttribute("data-testid") ?? "").slice("step-row-".length)));
}

test("moving a step with Alt and an arrow skips the hidden command steps around it", async ({ page }) => {
  await storeCommandsOff(page);
  await loadExample(page);
  const before = await rowIds(page);
  const at = before.indexOf("toGarden");
  expect(at).toBeGreaterThan(0);
  await page.getByTestId("step-row-toGarden").getByRole("button").first().click();
  await page.keyboard.press("Alt+ArrowUp");
  // It swaps with the visible step above it, whatever hidden command steps sit between them.
  const expected = [...before];
  [expected[at - 1], expected[at]] = [expected[at] ?? "", expected[at - 1] ?? ""];
  await expect.poll(() => rowIds(page)).toEqual(expected);
});

test("deleting a group that holds hidden command steps asks first, and Undo brings it all back", async ({ page }) => {
  await storeCommandsOff(page);
  await loadExample(page);
  const group = page.getByTestId("step-row-returnToScore");
  // The row's first button opens and closes the group; its name button selects it.
  const select = group.getByRole("button", { name: /^returnToScore/ });
  await select.click();
  await page.keyboard.press("Delete");
  const dialog = page.getByTestId("delete-hidden-dialog");
  await expect(dialog).toContainText(/This group also holds \d+ command steps? that (is|are) hidden\. Delete (it|them) too\?/);

  await page.getByTestId("delete-hidden-cancel").click();
  await expect(dialog).toHaveCount(0);
  await expect(group).toBeVisible();

  await select.click();
  await page.keyboard.press("Delete");
  await page.getByTestId("delete-hidden-confirm").click();
  await expect(dialog).toHaveCount(0);
  await expect(group).toHaveCount(0);

  await page.keyboard.press("Control+z");
  await expect(group).toBeVisible();
  // The hidden steps came back with it: turning Commands on shows them inside the group.
  await setSwitch(page, "commands", true);
  await expect(page.getByTestId("step-row-readyLauncher")).toBeVisible();
});

test("a ledger error while Ledger is off is counted at the end of Problems, Validate still checks it, and Show turns Ledger on", async ({ page }) => {
  // Forty pollen at the start, where the robot holds at most four: CAPACITY, an error the ledger raises.
  const files = starterFiles({ "autos/first-auto.auto.json": (text) => text.replace('"pollen": 4', '"pollen": 40') });
  await serveFolder(page, files);
  await page.goto("/");
  await openServedFolder(page);
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();

  const hidden = page.getByTestId("findings-hidden");
  // The header counts only listed problems, so the hidden error is named on the line itself, and the
  // error count carries it for its tooltip: "0 errors" is never all the panel says (0.1.2 UX sweep).
  await expect(hidden).toContainText(/^\d+ more problems? in hidden features, (and it is an error|\d+ of them (an error|errors)|all of them errors)\.\s*Show$/);
  await expect(hidden).toHaveAttribute("data-has-errors", "true");
  await expect(page.getByTestId("findings-count-error")).toHaveAttribute("data-hidden-errors", /^[1-9]\d*$/);
  await expect(page.getByTestId("finding-code").filter({ hasText: "CAPACITY" })).toHaveCount(0);
  // With a problem hidden, the list never calls the routine clean above the line that counts it.
  await expect(page.getByTestId("findings-list").getByText("No problems found.")).toHaveCount(0);

  // Validate (F8) runs the whole check: the hidden problem is still counted, and still not listed.
  await page.keyboard.press("F8");
  await expect(page.getByTestId("bottom-tab-problems")).toHaveAttribute("aria-selected", "true");
  await expect(hidden).toBeVisible();
  await expect(page.getByTestId("finding-code").filter({ hasText: "CAPACITY" })).toHaveCount(0);

  await page.getByTestId("findings-hidden-show").click();
  await expect(page.getByTestId("finding-code").filter({ hasText: "CAPACITY" })).toHaveCount(1);
  await expect(hidden).toHaveCount(0);
  await expect(page.getByTestId("findings-count-error")).not.toHaveAttribute("data-hidden-errors");
  await expect(page.getByTestId("ledger-panel")).toBeVisible();
  await openGeneral(page);
  await expect(page.getByTestId("settings-feature-ledger-choice-on")).toHaveAttribute("aria-pressed", "true");
  // Showing changed a setting, not the file.
  expect(await readServed(page, "autos/first-auto.auto.json")).toBe(files["autos/first-auto.auto.json"]);
});

test("a shot from an illegal spot shows with Ledger off: listed, counted and drawn, not in hidden features", async ({ page }) => {
  // Essential's switches: Ledger off, Commands on.
  await storeSwitches(page, {});
  await loadExample(page);
  // A shot from inside the hive frame, which is not a legal approach: LEGAL_APPROACH, a rule error.
  await page.evaluate(
    `import("/src/state/store.ts").then((m) => m.commit({ ...m.getState().auto, steps: ${JSON.stringify([
      { id: "path2", kind: "path", segments: [{ kind: "line", from: "current", to: { xIn: -24, yIn: -10, provenance: "SET BY HAND: e2e fixture" } }], heading: { mode: "tangent" } },
      { id: "shoot", kind: "command", name: "score", args: { count: 4 } },
    ])} }))`,
  );
  await expect(page.getByTestId("finding-code").filter({ hasText: "LEGAL_APPROACH" })).toHaveCount(1);
  await expect(page.getByTestId("ledger-panel")).toHaveCount(0);
  // The header counts it, and no hidden line takes it.
  await expect(page.getByTestId("findings-count-error")).toContainText(/^[1-9]\d*/);
  await expect(page.getByTestId("findings-count-error")).not.toHaveAttribute("data-hidden-errors");
  await expect(page.getByTestId("findings-hidden")).toHaveCount(0);
  // The field draws what the store's shown findings hold.
  expect(await editor<string[]>(page, `m.currentDerived().findings.map((f) => f.code)`)).toContain("LEGAL_APPROACH");
});

test("a palette search lists a switched-off action greyed and last, and choosing it opens Settings at the switch", async ({ page }) => {
  await storeCommandsOff(page);
  await loadExample(page);
  const before = await rowIds(page);

  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("parallel");
  const off = page.getByTestId("palette-off:insert.parallel");
  await expect(off).toBeVisible();
  await expect(off).toHaveAttribute("data-off", "true");
  await expect(off).toContainText("Off in your settings. Opens Commands in Settings, General.");
  await expect(off).toBeEnabled();
  // Listed after every row that works, under its own header, and never as a working row.
  const options = page.getByTestId("palette-results").getByRole("option");
  expect(await options.count()).toBeGreaterThan(1);
  await expect(options.last()).toHaveAttribute("data-off", "true");
  await expect(options.first()).not.toHaveAttribute("data-off", "true");
  await expect(page.getByTestId("palette-results")).toContainText("Off in your settings");
  await expect(page.getByTestId("palette-item-insert.parallel")).toHaveCount(0);

  // An empty search lists only what works.
  await page.getByTestId("palette-input").fill("");
  await expect(page.locator("[data-off='true']")).toHaveCount(0);

  await page.getByTestId("palette-input").fill("Insert a parallel");
  await page.getByTestId("palette-off:insert.parallel").click();
  await expect(page.getByTestId("palette-input")).toHaveCount(0);
  await expect(page.getByTestId("settings-section-general")).toBeVisible();
  // Focus is on the Commands switch itself.
  await expect(page.locator("[data-setting='features.commands'] :focus")).toHaveCount(1);
  await expect(page.getByTestId("settings-feature-commands-choice-off")).toHaveAttribute("aria-pressed", "true");
  await closeSettings(page);
  // Nothing ran: no group was inserted.
  expect(await rowIds(page)).toEqual(before);
});

/* ---- The switches the presets added ----------------------------------------------------------- */

const ALL_STEP_KINDS = readFileSync(
  fileURLToPath(new URL("../../../examples/starter/autos/all-step-kinds.auto.json", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

test("Step groups off takes the group kinds and Wrap away, and a parallel group a file has still shows, edits and saves unchanged", async ({ page }) => {
  await storeSwitches(page, { groups: false });
  const files = { ...starterFiles(), "autos/all-step-kinds.auto.json": ALL_STEP_KINDS };
  await serveFolder(page, files);
  await page.goto("/");
  await openServedFolder(page);
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await openAutoNamed(page, "all-step-kinds.auto.json");
  await expect(page.getByTestId("step-row-toGarden")).toBeVisible();

  // No group kind in Insert, and neither Insert nor Wrap of a group in the palette.
  await page.getByTestId("insert-step").click();
  await expect(page.getByTestId("insert-kind-path")).toBeVisible();
  for (const kind of ["sequence", "parallel", "branch"]) await expect(page.getByTestId(`insert-kind-${kind}`)).toHaveCount(0);
  await page.keyboard.press("Escape");
  expect(await paletteHas(page, "Wrap in a parallel group", "edit.wrapParallel")).toBe(false);
  expect(await paletteHas(page, "Insert a sequence", "insert.sequence")).toBe(false);
  expect(await paletteHas(page, "Unwrap group", "edit.unwrap")).toBe(true);

  // The group shows, with the quiet chip, and edits as usual.
  // A group row's first button folds it; its name button selects it.
  await page.getByTestId("step-row-toGarden").getByRole("button", { name: /^toGarden/ }).click();
  await expect(page.getByTestId("inspector-made-with")).toHaveText(/^Made with Step groups, which your settings turn off\.\s*Turn on Step groups$/);
  const mode = page.getByTestId("inspector-parallel-mode");
  await mode.selectOption("race");
  await expect.poll(() => editor<string>(page, `s.auto.steps.find((x) => x.id === "toGarden").mode`)).toBe("race");
  await mode.selectOption("all");
  await expect.poll(() => editor<string>(page, `s.auto.steps.find((x) => x.id === "toGarden").mode`)).toBe("all");

  // Saved, the file is byte for byte what it was.
  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("status")).toContainText("Saved");
  expect(await readServed(page, "autos/all-step-kinds.auto.json")).toBe(ALL_STEP_KINDS);

  // Turn on brings the group kinds back at once.
  await page.getByTestId("inspector-made-with-turn-on").click();
  await expect(page.getByTestId("inspector-made-with")).toHaveCount(0);
  await page.getByTestId("insert-step").click();
  await expect(page.getByTestId("insert-kind-parallel")).toBeVisible();
  await page.keyboard.press("Escape");
});

test("Advanced heading off keeps Piecewise from a tangent path, and a piecewise path still edits fully", async ({ page }) => {
  await storeSwitches(page, { advancedHeading: false });
  await loadExample(page);
  await selectStep(page, "driveOut");
  await page.getByTestId("inspector-heading-mode").click();
  await expect(page.getByTestId("inspector-heading-mode-option-linear")).toBeVisible();
  await expect(page.getByTestId("inspector-heading-mode-option-piecewise")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("inspector-made-with")).toHaveCount(0);

  // A path that is piecewise already, as a file may have it.
  await editor(
    page,
    `m.commit({ ...s.auto, steps: s.auto.steps.map((x) => x.id === "driveOut" ? { ...x, heading: { mode: "piecewise", ranges: [
      { startT: 0, endT: 0.5, heading: { mode: "tangent" } },
      { startT: 0.5, endT: 1, heading: { mode: "constant", headingRad: 1 } } ] } } : x) })`,
  );
  await selectStep(page, "driveOut");
  await expect(page.getByTestId("inspector-made-with")).toContainText("Made with Advanced heading, which your settings turn off");
  await expect(page.getByTestId("heading-ranges")).toBeVisible();
  await page.getByTestId("heading-range-0-split").click();
  await expect(page.getByTestId("heading-range-2")).toBeVisible();
  await expect.poll(() => editor<number>(page, `s.auto.steps.find((x) => x.id === "driveOut").heading.ranges.length`)).toBe(3);
  await page.getByTestId("inspector-heading-mode").click();
  await expect(page.getByTestId("inspector-heading-mode-option-piecewise")).toBeVisible();
  await page.keyboard.press("Escape");
});

test("Waypoints off takes the list and making one away, while a pin still draws, drags and keeps its row", async ({ page }) => {
  await storeSwitches(page, { waypoints: false });
  await loadExample(page);
  await expect(page.getByTestId("inspector-routine")).toBeVisible();
  await expect(page.getByTestId("inspector-waypoints")).toHaveCount(0);
  expect(await paletteHas(page, "Add waypoint", "waypoint.add")).toBe(false);

  const name = await editor<string>(page, `Object.keys(s.project.waypoints.waypoints)[0]`);
  const before = await editor<{ xIn: number; yIn: number }>(page, `s.project.waypoints.waypoints[${JSON.stringify(name)}]`);
  await editor(page, `m.setSelection({ waypoint: ${JSON.stringify(name)} })`);
  await expect(page.getByTestId("inspector-made-with")).toContainText("Made with Waypoints, which your settings turn off");
  await expect(page.getByTestId("inspector-waypoint-x")).toBeVisible();
  await expect(page.getByTestId(`inspector-waypoint-more-${name}`)).toHaveCount(0);
  await expect(page.getByTestId("inspector-waypoints-add")).toHaveCount(0);

  // The selected pin takes the press, and a drag moves it and every point that follows it.
  await dragWorld(page, { xIn: before.xIn, yIn: before.yIn }, { xIn: before.xIn + 6, yIn: before.yIn });
  await expect.poll(() => editor<number>(page, `s.project.waypoints.waypoints[${JSON.stringify(name)}].xIn`)).toBeCloseTo(before.xIn + 6, 0);

  // A double-click on the pin, which renames it while waypoints are on, opens no dialog and leaves it in place.
  const moved = await editor<{ xIn: number; yIn: number }>(page, `s.project.waypoints.waypoints[${JSON.stringify(name)}]`);
  const at = await worldToScreen(page, moved.xIn, moved.yIn);
  await page.mouse.dblclick(at.x, at.y);
  await expect(page.getByTestId("waypoint-dialog")).toHaveCount(0);
  expect(await editor<{ xIn: number; yIn: number }>(page, `s.project.waypoints.waypoints[${JSON.stringify(name)}]`)).toEqual(moved);

  // Delete on the selected pin deletes nothing while waypoints are off.
  await page.getByTestId("field-canvas").focus();
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("waypoint-dialog")).toHaveCount(0);
  expect(await editor<boolean>(page, `${JSON.stringify(name)} in s.project.waypoints.waypoints`)).toBe(true);
});

test("a toolbar button hidden in Settings, Editor leaves the toolbar, and its key and palette row still work", async ({ page }) => {
  await loadExample(page);
  await page.getByTestId("toolbar-settings").click();
  await page.getByTestId("settings-nav-editor").click();
  // Each toolbar button is an icon toggle, pressed while its button shows (issue #414).
  for (const id of ["tool.measure", "run.validate"]) {
    const toggle = page.getByTestId(`settings-toolbar-${id}`);
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
  }
  await closeSettings(page);
  await expect(page.getByTestId("toolbar-tool.measure")).toHaveCount(0);
  await expect(page.getByTestId("toolbar-run.validate")).toHaveCount(0);
  await expect(page.getByTestId("toolbar-tool.select")).toBeVisible();

  // U still picks Measure, and both are still in the palette.
  await page.getByTestId("field-canvas").focus();
  await page.keyboard.press("u");
  await expect.poll(() => editor<string>(page, "s.tool")).toBe("measure");
  await page.keyboard.press("Escape");
  expect(await paletteHas(page, "Measure", "tool.measure")).toBe(true);
  expect(await paletteHas(page, "Validate", "run.validate")).toBe(true);

  // Kept after a reload, as every setting is.
  await page.reload();
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await expect(page.getByTestId("toolbar-tool.measure")).toHaveCount(0);
  await expect(page.getByTestId("toolbar-tool.addPath")).toBeVisible();
});

test("the Code tab off shows Problems over a stored Code tab, and on opens the Code tab again", async ({ page }) => {
  await storeSwitches(page, { codeTab: false });
  await page.addInitScript(() => {
    window.localStorage.setItem("zenith.bottomTab", "code");
  });
  await loadExample(page);
  await expect(page.getByTestId("bottom-tab-code")).toHaveCount(0);
  await expect(page.getByTestId("code-panel")).toHaveCount(0);
  await expect(page.getByTestId("findings-list")).toBeVisible();

  await setSwitch(page, "codeTab", true);
  await expect(page.getByTestId("bottom-tab-code")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("code-panel")).toBeVisible();
});

test("at a phone's width, choosing a switched-off action focuses its switch in the one-column Settings", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?cloud=fake");

  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("ledger");
  await page.getByTestId("palette-off:view.ledgerCounts").click();
  await expect(page.getByTestId("palette-input")).toHaveCount(0);
  // The section replaced the list, and focus went with it rather than falling to the page.
  await expect(page.getByTestId("settings")).toHaveAttribute("data-view", "section");
  await expect(page.getByTestId("settings-section-general")).toBeVisible();
  await expect(page.locator("[data-setting='features.ledger']")).toBeInViewport();
  await expect(page.getByTestId("settings-feature-ledger-choice-off")).toBeFocused();
  await expect(page.locator("[data-setting='features.ledger'] :focus")).toHaveCount(1);
});
