/**
 * The Settings panes, the shortcut sheet, the first run, the welcome screen and the open and save
 * dialogs after the UX overhaul (issue #414): each setting lives where its effect is, Esc closes the
 * innermost thing first, an unsaved robot.json is asked about before Settings closes, the shortcut
 * sheet fits in two tabs, and the first run and the dialogs say one clear next step in plain words.
 */
import { expect, test, type Page } from "@playwright/test";
import { choosePreset, editor, loadExample, skipTour } from "./qa/helpers";
import { openServedFolder, readServed, serveFolder, starterFiles } from "./opfsProject";
import { withoutFolderPicker } from "./saveExample";

/** Opens Settings at a section. */
async function openSettings(page: Page, section: string): Promise<void> {
  await page.getByTestId("toolbar-settings").click();
  await page.getByTestId(`settings-nav-${section}`).click();
  await expect(page.getByTestId(`settings-section-${section}`)).toBeVisible();
}

/** A writable folder project, opened through the palette. */
async function openFolderProject(page: Page, files = starterFiles()): Promise<void> {
  await serveFolder(page, files);
  await page.goto("/");
  await openServedFolder(page);
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
}

test.describe("General and Robot", () => {
  test.beforeEach(async ({ page }) => {
    await skipTour(page);
  });

  test("General holds only the person's own switches, and the library and pathing system are under Follower in Robot", async ({ page }) => {
    await openFolderProject(page);
    await openSettings(page, "general");
    const general = page.getByTestId("settings-section-general");
    await expect(general).not.toContainText("This project");
    await expect(general).not.toContainText("Pathing");
    await expect(page.getByTestId("settings-command-library")).toHaveCount(0);
    await expect(general).toContainText("These switches are yours, on this computer. They never change a project's files.");

    await page.getByTestId("settings-nav-robot").click();
    const follower = page.getByTestId("settings-robot-follower");
    await expect(follower.getByTestId("settings-command-library")).toBeVisible();
    await expect(follower.getByTestId("settings-pathing")).toBeVisible();
    await expect(follower.getByTestId("settings-pathing-value")).toHaveText("Pedro Pathing");
    // Both keep their one-line brief in Labels only.
    await expect(follower.getByTestId("settings-command-library")).toContainText("The runtime your code imports");
    await expect(follower.getByTestId("settings-pathing")).toContainText("The path follower");
    // Pathing system is said once in the pane.
    await expect(page.getByTestId("settings-section-robot").getByText("Pathing system", { exact: true })).toHaveCount(1);
  });

  test("Robot puts the provenance on the value's line, in rows of at most 40 px, with one line of what is left to settle", async ({ page }) => {
    await loadExample(page);
    await openSettings(page, "robot");
    const rows = page.getByTestId("settings-section-robot").locator("[data-chip]");
    expect(await rows.count()).toBeGreaterThan(10);
    for (const row of await rows.all()) {
      // A row of one line: the chip, at its end, is on the line of the value beside it.
      const box = await row.boundingBox();
      expect(box?.height ?? 0).toBeLessThanOrEqual(40);
      const chips = row.locator("button, span").filter({ hasText: /placeholder|needs measurement|measured|set/i });
      // A value the file leaves out, such as the default clearance, has no chip.
      if ((await chips.count()) === 0) continue;
      const chip = await chips.last().boundingBox();
      if (box === null || chip === null) throw new Error("a robot row has no box");
      expect(chip.y).toBeGreaterThanOrEqual(box.y - 1);
      expect(chip.y + chip.height).toBeLessThanOrEqual(box.y + box.height + 1);
    }

    const line = page.getByTestId("settings-robot-todo-text");
    await expect(line).toHaveText(/^\d+ values? (is a placeholder|are placeholders)( and \d+ (needs|need) measuring)?$|^\d+ values? needs? measuring$/);
    const total = await rows.count();
    await page.getByTestId("settings-robot-todo-filter-todo").click();
    // Only the values left to settle show: the name, the follower and the intakes are gone, and every row left is one of them.
    await expect(page.getByTestId("settings-robot-identity")).toHaveCount(0);
    await expect(page.getByTestId("settings-robot-follower")).toHaveCount(0);
    const left = await rows.count();
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(total);
    for (const row of await rows.all()) await expect(row).toContainText(/placeholder|needs measurement/i);
    await page.getByTestId("settings-robot-todo-filter-all").click();
    await expect(page.getByTestId("settings-robot-identity")).toBeVisible();
  });

  test("with Only these on, a row the person settles stays in view, and the filter ends with the last one", async ({ page }) => {
    await openFolderProject(page);
    await openSettings(page, "robot");
    await page.getByTestId("settings-robot-todo-filter-todo").click();
    await expect(page.getByTestId("settings-robot-identity")).toHaveCount(0);
    const section = page.getByTestId("settings-section-robot");
    const rows = section.locator("[data-chip]");
    const chips = section.locator('[data-testid^="settings-robot-"][data-testid$="-provenance"]');
    const left = await rows.count();
    expect(left).toBeGreaterThan(0);
    // Settle every row in turn: each stays where it is while any is left.
    const ids = await chips.evaluateAll((all) => all.map((chip) => chip.getAttribute("data-testid") ?? ""));
    for (const [at, id] of ids.entries()) {
      await page.getByTestId(id).click();
      await page.getByTestId(`${id}-menu`).getByRole("menuitemradio", { name: "Measured" }).click();
      if (at < ids.length - 1) {
        await expect(page.getByTestId(id)).toHaveText("Measured");
        await expect(rows).toHaveCount(left);
      }
    }
    // Nothing is left to settle: the line and its toggle go, and every row shows again.
    await expect(page.getByTestId("settings-robot-todo")).toHaveCount(0);
    await expect(page.getByTestId("settings-robot-identity")).toBeVisible();
  });

  test("the clearance says 1 in (default) with a Change button, and the Editor's Safety margin sends the person to it", async ({ page }) => {
    await openFolderProject(page);
    await openSettings(page, "editor");
    const margin = page.getByTestId("settings-optimize-margin");
    await expect(margin.getByTestId("settings-optimize-margin-value")).toHaveText("1 in");
    await expect(page.getByTestId("settings-section-editor")).not.toContainText("not in robot.json");
    await margin.getByTestId("settings-optimize-margin-change").click();

    // Robot opens at Clearance, whose row reads 1 in (default) and offers Change.
    await expect(page.getByTestId("settings-section-robot")).toBeVisible();
    await expect(page.getByTestId("settings-robot-clearance-default")).toHaveText("1 in (default)");
    await expect(page.getByTestId("settings-robot-clearance-set")).toHaveText("Change");
    await expect(page.getByTestId("settings-robot-clearance-set")).toBeFocused();
    await expect(page.getByTestId("settings")).not.toContainText("not in robot.json");
    await page.getByTestId("settings-robot-clearance-set").click();
    await expect(page.getByTestId("settings-robot-clearance")).toBeVisible();
  });
});

test.describe("Presets and Editor", () => {
  test.beforeEach(async ({ page }) => {
    await skipTour(page);
  });

  test("Duplicate is in the row's menu, and what a preset action did is said in the status line", async ({ page }) => {
    await loadExample(page);
    await openSettings(page, "presets");
    await expect(page.getByTestId("presets-duplicate-basic")).toHaveCount(0);
    await page.getByTestId("presets-menu-basic").click();
    await page.getByTestId("menu-presets-duplicate-basic").click();
    await expect(page.getByTestId("status")).toContainText("Made ");
    await expect(page.getByTestId("presets-mine")).toContainText("1 of 20");
  });

  test("Editor runs Appearance, Field, Editing, then Toolbar buttons as one wrapped row of icon toggles", async ({ page }) => {
    await loadExample(page);
    await openSettings(page, "editor");
    const heads = await page.getByTestId("settings-section-editor").locator("h4").allTextContents();
    const at = (title: string) => heads.findIndex((head) => head.startsWith(title));
    expect(at("Appearance")).toBe(0);
    expect(at("Field")).toBeGreaterThan(at("Appearance"));
    expect(at("Editing")).toBeGreaterThan(at("Field"));
    expect(at("Toolbar buttons")).toBeGreaterThan(at("Editing"));

    const toggles = page.getByTestId("settings-toolbar").getByRole("button");
    expect(await toggles.count()).toBeGreaterThan(8);
    // One wrapped row: no toggle is taller than a button, and none is a labelled row of its own.
    for (const toggle of await toggles.all()) {
      const box = await toggle.boundingBox();
      expect(box?.height ?? 0).toBeLessThanOrEqual(40);
      await expect(toggle).toHaveAttribute("aria-pressed", /true|false/);
    }
    const validate = page.getByTestId("settings-toolbar-run.validate");
    await expect(validate).toHaveAttribute("aria-pressed", "true");
    await validate.click();
    await expect(validate).toHaveAttribute("aria-pressed", "false");
    // It writes display.toolbar.run.validate through the registry, and takes only the button away.
    expect(await editor<boolean>(page, "s.prefs.toolbar.run.validate")).toBe(false);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("toolbar-run.validate")).toHaveCount(0);
  });

  test("Protect measured waypoints is an On and Off switch written through its registry entry, and Grid stays a dropdown", async ({ page }) => {
    await loadExample(page);
    await openSettings(page, "editor");
    const row = page.getByTestId("settings-protect-measured-pins");
    await expect(row.getByRole("button", { name: "On" })).toHaveAttribute("aria-pressed", "true");
    await expect(row).not.toContainText("Show");
    await expect(row).not.toContainText("Hide");
    await row.getByRole("button", { name: "Off" }).click();
    expect(await editor<boolean>(page, "s.prefs.protectMeasuredPins")).toBe(false);
    await row.getByRole("button", { name: "On" }).click();
    expect(await editor<boolean>(page, "s.prefs.protectMeasuredPins")).toBe(true);
    await expect(page.getByTestId("settings-field-grid-choice")).toHaveJSProperty("tagName", "SELECT");
  });
});

test.describe("closing and Escape", () => {
  test.beforeEach(async ({ page }) => {
    await skipTour(page);
  });

  /** A draft in Robot: the top speed typed, not yet saved. */
  async function draftRobot(page: Page): Promise<void> {
    await openFolderProject(page);
    await openSettings(page, "robot");
    const speed = page.getByTestId("settings-robot-maxForward");
    await speed.fill("72");
    await speed.press("Tab");
    await expect(page.getByTestId("settings-robot-save-bar")).toContainText("Unsaved changes");
  }

  test("closing with an unsaved robot.json asks Cancel, Discard changes or Save robot.json, and nothing closes until one is picked", async ({ page }) => {
    await draftRobot(page);
    const ask = page.getByTestId("settings-close-ask");

    // The close button asks with the unsaved-changes question's own buttons, in its order, and the
    // pane's save bar steps aside so there is one Save on screen. Cancel leaves everything as it was.
    await page.getByTestId("settings-close").click();
    await expect(ask).toBeVisible();
    await expect(ask).toContainText("autos/robot.json has edits that are not saved.");
    await expect(ask.getByRole("button")).toHaveText(["Cancel", "Discard changes", "Save autos/robot.json"]);
    await expect(page.getByTestId("settings-robot-save-bar")).toHaveCount(0);
    await expect(page.getByTestId("settings")).toBeVisible();
    await page.getByTestId("settings-close-cancel").click();
    await expect(ask).toHaveCount(0);
    await expect(page.getByTestId("settings-robot-maxForward")).toHaveValue("72.0");

    // Esc asks too; Esc again answers the ask as Cancel, and the window stays.
    await page.keyboard.press("Escape");
    await expect(ask).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(ask).toHaveCount(0);
    await expect(page.getByTestId("settings")).toBeVisible();

    // A click on the backdrop asks as well.
    await page.getByTestId("settings-backdrop").click({ position: { x: 5, y: 5 } });
    await expect(ask).toBeVisible();

    // Discard closes and lets the draft go.
    await page.getByTestId("settings-close-discard").click();
    await expect(page.getByTestId("settings")).toHaveCount(0);
    await openSettings(page, "robot");
    await expect(page.getByTestId("settings-robot-maxForward")).toHaveValue("60.0");
    expect(JSON.parse(await readServed(page, "autos/robot.json")).kinematics.maxForwardVelInPerS.value).toBe(60);
  });

  test("Save robot.json from the ask writes the file and closes", async ({ page }) => {
    await draftRobot(page);
    await page.keyboard.press("Escape");
    await page.getByTestId("settings-close-save").click();
    await expect(page.getByTestId("settings")).toHaveCount(0);
    expect(JSON.parse(await readServed(page, "autos/robot.json")).kinematics.maxForwardVelInPerS.value).toBe(72);
  });

  test("with nothing unsaved the window closes at once", async ({ page }) => {
    await loadExample(page);
    await openSettings(page, "robot");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings")).toHaveCount(0);
  });

  test("Esc closes the Save as a preset form first, and the window on the next", async ({ page }) => {
    await loadExample(page);
    await openSettings(page, "presets");
    await page.getByTestId("presets-save").click();
    await page.getByTestId("presets-save-name").fill("Half typed");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("presets-save-form")).toHaveCount(0);
    await expect(page.getByTestId("settings")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings")).toHaveCount(0);
  });

  test("Esc cancels the key-conflict prompt first, and the window on the next", async ({ page }) => {
    await loadExample(page);
    await openSettings(page, "keyboard");
    await page.getByTestId("keyboard-change-run.validate").click();
    // V is Select's key, so the pick has to be settled before it is stored.
    await page.keyboard.press("v");
    await expect(page.getByTestId("keyboard-conflict")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("keyboard-conflict")).toHaveCount(0);
    await expect(page.getByTestId("settings")).toBeVisible();
    await expect(page.getByTestId("keyboard-key-run.validate")).toHaveText("F8");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings")).toHaveCount(0);
  });
});

test.describe("Keyboard and the shortcut sheet", () => {
  test("Keyboard is one row for each action with a key chip, and rows of switched-off features are absent", async ({ page }) => {
    await skipTour(page, { features: { partners: false, ledger: false, commands: true, waypoints: false } });
    await loadExample(page);
    await openSettings(page, "keyboard");
    const row = page.getByTestId("keyboard-row-run.validate");
    // The key is the button that rebinds it, and a small x takes it away; no description is drawn.
    await expect(row.getByTestId("keyboard-change-run.validate")).toContainText("F8");
    await expect(row.locator('[class*="rowDescription"]')).toHaveCount(0);
    await row.getByTestId("keyboard-change-run.validate").click();
    await page.keyboard.press("Control+e");
    await expect(page.getByTestId("keyboard-key-run.validate")).toHaveText("Ctrl E");
    await row.getByTestId("keyboard-remove-run.validate").click();
    await expect(page.getByTestId("keyboard-key-run.validate")).toHaveText("No key");

    // No "(hidden: … is off)" suffix, and no row at all for what is off.
    await expect(page.getByTestId("settings-section-keyboard")).not.toContainText("hidden:");
    await expect(page.getByTestId("keyboard-row-waypoint.rename")).toHaveCount(0);
    // Full sim is on, so Simulate keeps its row.
    await expect(page.getByTestId("keyboard-row-run.simulate")).toHaveCount(1);

    // The fixed keys are one row for each group of keys.
    const fixed = page.getByTestId("keyboard-group-fixed");
    await expect(fixed.getByTestId("keyboard-fixed-nudge")).toContainText("Arrow keys");
    await expect(fixed.getByTestId("keyboard-fixed-reorder")).toContainText("Alt + arrows");
    await expect(fixed).not.toContainText("The arrows nudge, reorder and move between screens");
  });

  test("the sheet has two tabs, lists each key once with a note where S and C do two things, and opens on the sheet itself", async ({ page }) => {
    await skipTour(page);
    await loadExample(page);
    await page.keyboard.press("F1");
    const sheet = page.getByTestId("shortcuts-overlay");
    await expect(sheet).toBeVisible();
    await expect(page.getByTestId("shortcuts-sheet")).toBeFocused();
    await expect(page.getByTestId("shortcuts-change-keys")).not.toBeFocused();
    await expect(sheet.getByRole("tab")).toHaveText(["Keys", "Mouse"]);
    await expect(page.getByTestId("shortcuts-tab-keys")).toHaveAttribute("aria-selected", "true");

    // Each key once: no kbd text is repeated on the Keys tab.
    const keys = await sheet.locator("dt kbd").allTextContents();
    expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([]);
    const s = sheet.locator("dt", { has: page.locator("kbd", { hasText: /^S$/ }) }).locator("xpath=following-sibling::dd");
    await expect(s).toContainText("Snap");
    await expect(s).toContainText("On a selected curve point: make it smooth.");
    const c = sheet.locator("dt", { has: page.locator("kbd", { hasText: /^C$/ }) }).locator("xpath=following-sibling::dd");
    await expect(c).toContainText("Add command");
    await expect(c).toContainText("make it a corner");

    // Every table is whole and starts with its heading: each title is above its keys and in the same column.
    for (const section of await sheet.locator("section").all()) {
      const head = await section.locator("h3").boundingBox();
      const first = await section.locator("dt").first().boundingBox();
      const last = await section.locator("dt").last().boundingBox();
      if (head === null || first === null || last === null) throw new Error("a table has no box");
      expect(head.y).toBeLessThan(first.y);
      expect(Math.abs(head.x - first.x)).toBeLessThan(2);
      expect(Math.abs(head.x - last.x)).toBeLessThan(2);
    }

    // The Mouse tab holds the gestures, and no lone key.
    await page.getByTestId("shortcuts-tab-mouse").click();
    await expect(page.getByTestId("shortcuts-canvas")).toContainText("Middle-drag, Ctrl + right-drag, or Space + drag");
    await expect(page.getByTestId("shortcuts-canvas").locator("dt kbd", { hasText: /^[SCF]$/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  });

  test("the Keys tab fits a 1280x720 window with no scrolling", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await skipTour(page);
    await loadExample(page);
    await page.keyboard.press("F1");
    const fits = await page.getByTestId("shortcuts-overlay").evaluate((dialog) => {
      const scrollers = [dialog, ...dialog.querySelectorAll<HTMLElement>("*")].filter(
        (el) => el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflowY !== "visible",
      );
      return scrollers.length === 0;
    });
    expect(fits).toBe(true);
  });
});

test.describe("first run", () => {
  test("the preset card says what each choice gives, and the core tour ends on Next, marks a task optional and offers the full tour", async ({ page }) => {
    await page.goto("/");
    const card = page.getByTestId("preset-card");
    await expect(card).toBeVisible();
    await expect(page.getByTestId("preset-card-gets-basic")).toHaveText("Draw paths, add commands, play and save, with few buttons.");
    await expect(card).not.toContainText(/Off:|returning student|expert programmer/);
    await expect(page.getByTestId("preset-card-essential")).toContainText("Recommended");
    await choosePreset(page, "essential");

    // A stop with a task says it is optional.
    let task = false;
    const buttons: string[] = [];
    for (let guard = 0; guard < 20; guard += 1) {
      await expect(page.getByTestId("tour-next").or(page.getByTestId("tour-full"))).toBeVisible();
      if ((await page.getByTestId("tour-full").count()) > 0) break;
      if ((await page.getByTestId("tour-task").count()) > 0) {
        task = true;
        await expect(page.getByTestId("tour-task")).toContainText("Try it (optional):");
      }
      buttons.push((await page.getByTestId("tour-next").innerText()).trim());
      await page.getByTestId("tour-next").click();
    }
    expect(task).toBe(true);
    // The core tour does not end at its last stop, so every stop says Next, and the last one leads to
    // the choice card, whose full tour is named plainly.
    expect(buttons.length).toBeGreaterThan(1);
    expect(new Set(buttons)).toEqual(new Set(["Next"]));
    await expect(page.getByTestId("tour-full")).toContainText("Take the full tour");
    await expect(page.getByTestId("tour-full")).not.toContainText("Show me everything");
  });

  test("the welcome screen is the headline, one sentence and two buttons, with the folder's explanation in its hint", async ({ page }) => {
    await skipTour(page);
    await page.goto("/");
    const welcome = page.getByTestId("canvas-empty");
    await expect(welcome).toContainText("Plan your first autonomous");
    await expect(welcome).toContainText("Start with the example, or open your robot's folder.");
    await expect(welcome).not.toContainText("zenith.json");
    await expect(welcome.getByRole("button", { name: /Open the example/ })).toBeVisible();
    // It is the first Tab stop, so Tab then Enter opens the example (0.1.2 UX sweep, W1-10).
    await page.keyboard.press("Tab");
    await expect(welcome.getByTestId("canvas-load-example")).toBeFocused();
    await expect(welcome.getByTestId("canvas-open-project")).toBeVisible();
    await welcome.getByTestId("canvas-open-project").hover();
    await expect(page.getByRole("tooltip")).toContainText("zenith.json");
  });

  test("the start screen's first Tab leaves an open dialog's Tab order alone, and only the first Tab is taken", async ({ page }) => {
    await skipTour(page);
    await page.goto("/");
    await expect(page.getByTestId("canvas-empty")).toBeVisible();
    // A Modal is a native dialog with no role. A click on its blank space leaves focus on no control.
    await page.getByTestId("canvas-open-other").click();
    const dialog = page.locator("dialog[open]");
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    if (box === null) throw new Error("the dialog has no box");
    await page.mouse.click(box.x + box.width - 12, box.y + box.height - 12);
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.querySelector("dialog[open]")?.contains(document.activeElement) ?? false)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    // That Tab was the screen's first, so a later Tab from nowhere is the browser's own.
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("canvas-load-example")).not.toBeFocused();
  });

  test("a project with no autos says so, with New auto as the primary and Open another folder beside it", async ({ page }) => {
    await skipTour(page);
    const files = starterFiles();
    delete files["autos/first-auto.auto.json"];
    await serveFolder(page, files);
    await page.goto("/");
    await openServedFolder(page);
    const empty = page.getByTestId("canvas-no-autos");
    await expect(empty).toContainText("robot-repo has no autos yet");
    await expect(page.getByTestId("canvas-empty")).toHaveCount(0);
    await expect(empty).not.toContainText("Start with the example");
    await expect(empty.getByTestId("canvas-new-auto")).toHaveClass(/primary/);
    await expect(empty.getByTestId("canvas-open-another")).toBeVisible();
    await empty.getByTestId("canvas-new-auto").click();
    await expect(page.getByTestId("step-row-driveOut").or(page.getByTestId("steps-list"))).toBeVisible();
    await expect(page.getByTestId("canvas-no-autos")).toHaveCount(0);
  });
});

test.describe("dialogs", () => {
  test.beforeEach(async ({ page }) => {
    await skipTour(page);
  });

  test("Open project with a project open leads with its autos and New auto, and folds the other ways under Open another project", async ({ page }) => {
    await openFolderProject(page);
    await page.getByTestId("toolbar-auto-name").click();
    const dialog = page.getByTestId("open-project");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("open-auto-first-auto.auto.json")).toBeVisible();
    await expect(dialog.getByTestId("open-project-new-auto")).toHaveClass(/primary/);
    // The other ways are folded away: no folder button, example or tabs yet, and one primary only.
    await expect(dialog.getByTestId("load-example")).toHaveCount(0);
    await expect(dialog.getByRole("tablist")).toHaveCount(0);
    await expect(dialog.getByTestId("open-project-primary")).toHaveCount(0);
    expect(await dialog.locator('button[class*="primary"]').count()).toBe(1);

    await dialog.getByTestId("open-project-other").click();
    await expect(dialog.getByRole("tab", { name: "Local folder" })).toBeVisible();
    await expect(dialog.getByRole("tab", { name: "GitHub" })).toBeVisible();
    await expect(dialog.getByTestId("open-project-primary")).toHaveText("Open another folder…");
    await expect(dialog.getByTestId("load-example")).toBeVisible();
    // The folder picker exists here, so the raw file input is not offered.
    await expect(dialog.getByTestId("open-project-files")).toHaveCount(0);
  });

  test("the single-file input is labelled and shows only where the browser has no folder picker", async ({ page }) => {
    await loadExample(page);
    await withoutFolderPicker(page);
    await page.getByTestId("toolbar-auto-name").click();
    const dialog = page.getByTestId("open-project");
    await dialog.getByTestId("open-project-other").click();
    await expect(dialog).toContainText("Or pick single files (opens one auto)");
    await expect(dialog.getByTestId("open-project-files")).toBeVisible();
  });

  test("Open project with nothing open keeps its folder button as the one primary", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("canvas-open-other").click();
    const dialog = page.getByTestId("open-project");
    await expect(dialog.getByTestId("open-project-primary")).toHaveClass(/primary/);
    await expect(dialog.getByRole("tablist")).toBeVisible();
    await expect(dialog.getByTestId("open-project-other")).toHaveCount(0);
  });

  test("Save the example is one line for each choice, and a link to open the team's own folder", async ({ page }) => {
    await loadExample(page);
    await page.keyboard.press("Control+s");
    const dialog = page.getByTestId("save-choice");
    await expect(dialog.getByTestId("save-choice-project-row")).toContainText("Full project");
    await expect(dialog.getByTestId("save-choice-project-detail")).toHaveText("A new folder with a copy of everything.");
    await expect(dialog.getByTestId("save-choice-auto-row")).toContainText("Just this auto");
    await expect(dialog.getByTestId("save-choice-auto-detail")).toHaveText("Add it to a project you already have.");
    // The waypoint count is for the next step, and only when the match fails.
    await expect(dialog).not.toContainText("waypoints");
    await expect(dialog.getByTestId("save-choice-open-own")).toHaveText("For your own robot, open its folder.");
  });

  test("Set up has the command library as a three-way choice and no capitalised provenance word", async ({ page }) => {
    const files: Record<string, string> = {
      "TeamCode/src/main/java/org/firstinspires/ftc/teamcode/robot/TeamRobot.java":
        "package org.firstinspires.ftc.teamcode.robot;\n\npublic class TeamRobot implements ZenithRobot {}\n",
    };
    await serveFolder(page, files);
    await page.goto("/");
    await openServedFolder(page);
    const dialog = page.getByTestId("setup-project");
    await expect(dialog).toBeVisible();
    const choice = dialog.getByTestId("setup-library");
    await expect(choice.getByRole("button")).toHaveText(["SolversLib", "Ivy", "Decide later"]);
    await expect(dialog.getByTestId("setup-library-none")).toHaveAttribute("aria-pressed", "true");
    await dialog.getByTestId("setup-library-ivy").click();
    await expect(dialog.getByTestId("setup-library-ivy")).toHaveAttribute("aria-pressed", "true");
    await expect(dialog).not.toContainText("NEEDS MEASUREMENT");
  });
});

test.describe("the Account pane", () => {
  test("shows no status line left over from elsewhere, and Sign out is one row under Profile", async ({ page }) => {
    await skipTour(page);
    await page.goto("/?cloud=fake");
    await page.getByTestId("toolbar-sign-in").click();
    await page.getByTestId("signin-sheet").getByTestId("fake-demo-reviewer").click();
    await expect(page.getByTestId("toolbar-account")).toContainText("Demonstration reviewer");
    await page.getByTestId("teams-sheet-close").click();
    await page.getByTestId("toolbar-account").click();
    const account = page.getByTestId("settings-section-account");
    await expect(account).toBeVisible();
    await expect(account.getByTestId("account-notice")).toHaveCount(0);
    await expect(account.locator("h4")).toHaveText(["Profile"]);
    await expect(account.getByTestId("settings-sign-out")).toBeVisible();
    await expect(account.getByText("Sign out", { exact: true })).toHaveCount(2);
  });
});

test("a status the editor shows is not under the Settings window", async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
  await openSettings(page, "presets");
  await page.getByTestId("presets-apply-basic").click();
  const ask = page.getByTestId("presets-ask-changes");
  if (await ask.isVisible()) await page.getByTestId("presets-ask-replace").click();
  const status = page.getByTestId("status");
  await expect(status).toContainText(/Applied Basic: (\d+ settings?|no settings) changed\./);
  // The status line is drawn over the window's own layer, so it is read where the action was.
  const z = await status.evaluate((node) => Number(getComputedStyle(node.closest("[class*=statusLayer]") ?? node).zIndex));
  const windowZ = await page.getByTestId("settings-backdrop").evaluate((node) => Number(getComputedStyle(node).zIndex));
  expect(z).toBeGreaterThan(windowZ);
});
