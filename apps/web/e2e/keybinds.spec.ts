/**
 * Custom keys (issue #287): a key changed in Settings, Keyboard reaches the tooltip, the palette and
 * the shortcut sheet, and runs its action, while the old key runs nothing. Capture is cancelled by Esc,
 * a key another action has is settled there and then, a refused key says why, and a custom plain key
 * typed into a field types and runs nothing.
 */
import { expect, test, type Page } from "@playwright/test";
import { editor, fixture, loadExample, openProjectWith, skipTour, worldToScreen } from "./qa/helpers";

const validatedAt = (page: Page) => editor<number | null>(page, "s.validatedAt ?? null");
const capturing = (page: Page) => page.evaluate(`import("/src/state/ui.ts").then((u) => u.getUi().capturingKey)`) as Promise<boolean>;
const storedKeys = (page: Page) =>
  page.evaluate(() => (JSON.parse(window.localStorage.getItem("zenith.ui") ?? "{}") as { keys?: unknown }).keys ?? null);

async function openKeyboard(page: Page): Promise<void> {
  await page.getByTestId("toolbar-settings").click();
  await page.getByTestId("settings-nav-keyboard").click();
  await expect(page.getByTestId("settings-section-keyboard")).toBeVisible();
}

/** The tooltip of the control `testId`, once it names `label`. */
async function tooltipOf(page: Page, testId: string, label: string): Promise<string> {
  // Focus goes back to the gear when Settings closes, and a focused control shows its own tooltip.
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(150);
  await page.getByTestId(testId).hover();
  const tip = page.getByRole("tooltip");
  await expect(tip).toContainText(label);
  return tip.innerText();
}

test("rebinding Validate to Ctrl E updates the tooltip, the palette and the sheet, and Ctrl E validates while F8 does nothing", async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
  await openKeyboard(page);
  await page.getByTestId("keyboard-filter").fill("Validate");
  await expect(page.getByTestId("keyboard-key-run.validate")).toHaveText("F8");
  await page.getByTestId("keyboard-change-run.validate").click();
  await expect(page.getByTestId("keyboard-prompt")).toContainText("Press the new keys. Esc cancels.");
  await expect(page.getByTestId("keyboard-said")).toContainText("Press the new keys for Validate");
  expect(await capturing(page)).toBe(true);
  await page.keyboard.press("Control+e");
  await expect(page.getByTestId("keyboard-key-run.validate")).toHaveText("Ctrl E");
  await expect(page.getByTestId("keyboard-reset-run.validate")).toBeVisible();
  expect(await capturing(page)).toBe(false);
  expect(await storedKeys(page)).toEqual({ "run.validate": "Ctrl E" });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings")).toHaveCount(0);

  const tip = await tooltipOf(page, "toolbar-run.validate", "Validate");
  expect(tip).toContain("Ctrl E");
  expect(tip).not.toContain("F8");

  await page.mouse.move(0, 0);
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Validate");
  await expect(page.getByTestId("palette-item-run.validate")).toContainText("Ctrl E");
  await page.keyboard.press("Escape");

  await page.keyboard.press("F1");
  const sheet = page.getByTestId("shortcuts-overlay");
  await expect(sheet).toBeVisible();
  await expect(sheet.locator("dt kbd", { hasText: /^Ctrl E$/ })).toHaveCount(1);
  await expect(sheet.locator("dt kbd", { hasText: /^F8$/ })).toHaveCount(0);
  await expect(sheet.getByTestId("shortcut-custom")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  const before = await validatedAt(page);
  await page.keyboard.press("F8");
  await page.waitForTimeout(300);
  expect(await validatedAt(page), "F8 runs nothing now").toBe(before);
  await page.keyboard.press("Control+e");
  await expect.poll(() => validatedAt(page)).not.toBe(before);
});

test("Esc during capture cancels, a refused key says why, and a taken key is settled before it is stored", async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
  await openKeyboard(page);

  await page.getByTestId("keyboard-change-run.validate").click();
  await page.keyboard.press("Escape");
  // Esc ended the capture, not the window, and nothing changed.
  await expect(page.getByTestId("settings")).toBeVisible();
  await expect(page.getByTestId("keyboard-prompt")).toHaveCount(0);
  await expect(page.getByTestId("keyboard-key-run.validate")).toHaveText("F8");
  expect(await capturing(page)).toBe(false);

  // Tab is fixed: refused with the reason, and the row still waits.
  await page.getByTestId("keyboard-change-run.validate").click();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("keyboard-prompt")).toContainText("Tab moves focus");
  expect(await capturing(page)).toBe(true);

  // V is the Select tool's key: the conflict is asked about, and Cancel keeps both as they were.
  await page.keyboard.press("v");
  const conflict = page.getByTestId("keyboard-conflict");
  await expect(conflict).toContainText("V is Select's key. Select will have no key.");
  await conflict.getByTestId("keyboard-cancel").click();
  await expect(page.getByTestId("keyboard-key-run.validate")).toHaveText("F8");
  await expect(page.getByTestId("keyboard-key-tool.select")).toHaveText("V");

  // Move it here: Validate takes V, and Select is left with no key, never both on one key.
  await page.getByTestId("keyboard-change-run.validate").click();
  await page.keyboard.press("v");
  await page.getByTestId("keyboard-conflict").getByTestId("keyboard-move").click();
  await expect(page.getByTestId("keyboard-key-run.validate")).toHaveText("V");
  await expect(page.getByTestId("keyboard-key-tool.select")).toHaveText("No key");
  expect(await storedKeys(page)).toEqual({ "run.validate": "V", "tool.select": null });

  // Reset all asks first, then gives every action its default back.
  await page.getByTestId("keyboard-reset-all").click();
  await page.getByTestId("keyboard-reset-all-confirm").click();
  await expect(page.getByTestId("keyboard-key-run.validate")).toHaveText("F8");
  await expect(page.getByTestId("keyboard-key-tool.select")).toHaveText("V");
  expect(await storedKeys(page)).toEqual({});

  // The keys no one can change are listed with their reason.
  await expect(page.getByTestId("keyboard-fixed-view.play")).toContainText("Space");
  await expect(page.getByTestId("keyboard-change-view.play")).toHaveCount(0);
});

test("Reset whose default overlaps two of the person's keys names both before it takes them", async ({ page }) => {
  // ? went to Switch theme and then F1 to Clip ghosts, so the sheet's "? or F1" was left with no key.
  await skipTour(page, { keys: { "view.theme": "?", "view.clipGhosts": "F1", "help.shortcuts": null } });
  await loadExample(page);
  await openKeyboard(page);
  await expect(page.getByTestId("keyboard-key-help.shortcuts")).toHaveText("No key");
  await page.getByTestId("keyboard-reset-help.shortcuts").click();
  const conflict = page.getByTestId("keyboard-conflict");
  await expect(conflict).toContainText("? or F1 is taken by");
  await expect(conflict).toContainText("Clip ghosts will have no key.");
  await expect(conflict).toContainText("Switch theme will have no key.");
  await expect(page.getByTestId("keyboard-said")).toContainText("Switch theme");
  await expect(page.getByTestId("keyboard-said")).toContainText("Clip ghosts");
  await conflict.getByTestId("keyboard-move").click();
  await expect(page.getByTestId("keyboard-key-help.shortcuts")).toHaveText("? or F1");
  expect(await storedKeys(page)).toEqual({ "view.theme": null, "view.clipGhosts": null });
});

test("Turn on F1 names the sheet and What's this, since it takes Shift F1 too", async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
  await openKeyboard(page);
  await page.getByTestId("keyboard-change-keys.rotate").click();
  await page.keyboard.press("F1");
  const conflict = page.getByTestId("keyboard-conflict");
  await expect(conflict).toContainText("F1 is taken by");
  await expect(conflict).toContainText("Keyboard shortcuts keeps ?.");
  await expect(conflict).toContainText("What's this will have no key.");
  await conflict.getByTestId("keyboard-move").click();
  await expect(page.getByTestId("keyboard-key-keys.rotate")).toHaveText("F1");
  await expect(page.getByTestId("keyboard-key-help.shortcuts")).toHaveText("?");
  await expect(page.getByTestId("keyboard-key-help.whatsThis")).toHaveText("No key");
});

test("a custom plain PgDn, / or Home runs its binding and keeps the browser's own use of the key from running too", async ({ page }) => {
  await skipTour(page, { keys: { "run.validate": "PgDn", "edit.redo": "/", "keys.stepForward": "Home" } });
  await loadExample(page);
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  // Listened for after the editor's own handler, so it sees whether the editor kept the key.
  await page.evaluate(() => {
    const seen: Record<string, boolean> = {};
    (window as unknown as { keptKeys: Record<string, boolean> }).keptKeys = seen;
    window.addEventListener("keydown", (event) => {
      seen[event.key] = event.defaultPrevented;
    });
  });
  const kept = () => page.evaluate(() => (window as unknown as { keptKeys: Record<string, boolean> }).keptKeys);
  const before = await validatedAt(page);
  await page.keyboard.press("PageDown");
  await expect.poll(() => validatedAt(page)).not.toBe(before);
  await page.keyboard.press("/");
  await page.evaluate(`import("/src/state/store.ts").then((m) => m.setPlayback(1))`);
  await page.keyboard.press("Home");
  expect(await editor<number>(page, "s.playbackS")).toBeGreaterThan(1);
  expect(await kept()).toEqual({ PageDown: true, "/": true, Home: true });
});

test("a custom plain-letter key typed in a field types the letter and runs nothing", async ({ page }) => {
  await skipTour(page, { keys: { "run.validate": "B" } });
  await loadExample(page);
  await page.getByTestId("step-name-driveOut").dblclick();
  const input = page.getByTestId("step-id-input-driveOut");
  await expect(input).toBeFocused();
  const before = await validatedAt(page);
  await input.press("End");
  await input.press("b");
  await expect(input).toHaveValue("driveOutb");
  await page.waitForTimeout(300);
  expect(await validatedAt(page), "B in a field is a letter").toBe(before);
  await input.press("Escape");
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  // Outside a field, the same key validates.
  await page.keyboard.press("b");
  await expect.poll(() => validatedAt(page)).not.toBe(before);
});

test("a Ctrl chord with a custom binding runs its own action, never a plain key's (QA-14)", async ({ page }) => {
  await skipTour(page, { keys: { "tool.select": "Ctrl B", "tool.addPath": "B" } });
  await loadExample(page);
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await page.keyboard.press("b");
  await expect.poll(() => editor<string>(page, "s.tool")).toBe("addPath");
  await page.keyboard.press("Control+b");
  await expect.poll(() => editor<string>(page, "s.tool")).toBe("select");
  // V was Select's default and is no one's key now; Ctrl M is a browser chord, so neither picks a tool.
  await page.keyboard.press("b");
  await expect.poll(() => editor<string>(page, "s.tool")).toBe("addPath");
  await page.keyboard.press("v");
  await page.keyboard.press("Control+m");
  await page.waitForTimeout(200);
  expect(await editor<string>(page, "s.tool")).toBe("addPath");
});

/*
 * Turn, the playhead's steps and Next panel are bindings of their own (issue #290): they can be
 * changed like any action's key, and the handler finds them by the person's keys, not by R, comma,
 * full stop and F6. Shift still turns the other way, whatever Turn's key is.
 */

const DEG = Math.PI / 180;
const blur = (page: Page) =>
  page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });

test("Turn, Step back, Step forward and Next panel can be changed in Settings, Keyboard, and Turn on T turns a pin both ways while R does nothing", async ({
  page,
}) => {
  await skipTour(page);
  await loadExample(page);
  await openKeyboard(page);

  // The four rows are under Keys with Change, and none of them is a fixed row any more.
  const keys = page.getByTestId("keyboard-group-Keys");
  await expect(keys).toBeVisible();
  for (const id of ["keys.rotate", "keys.stepBack", "keys.stepForward", "keys.cycleRegion"]) {
    await expect(keys.getByTestId(`keyboard-change-${id}`), id).toBeVisible();
  }
  for (const id of ["rotate", "stepTime", "cycleRegion"]) await expect(page.getByTestId(`keyboard-fixed-${id}`), id).toHaveCount(0);
  await expect(page.getByTestId("keyboard-fixed-nudge")).toBeVisible();
  await expect(page.getByTestId("keyboard-key-keys.rotate")).toHaveText("R");

  // Shift T is taken as T: Shift is Turn's other way.
  await page.getByTestId("keyboard-change-keys.rotate").click();
  await page.keyboard.press("Shift+T");
  await expect(page.getByTestId("keyboard-key-keys.rotate")).toHaveText("T");
  expect(await storedKeys(page)).toEqual({ "keys.rotate": "T" });
  // The Heading row's text names the new key, and the filter finds it by that text.
  const headingRow = page.getByTestId("keyboard-row-tool.heading");
  await expect(headingRow).toContainText("T and Shift T turn the selected point 5°");
  await expect(headingRow).not.toContainText("R and Shift R");
  await page.getByTestId("keyboard-filter").fill("T and Shift T");
  await expect(headingRow).toBeVisible();
  await page.getByTestId("keyboard-filter").fill("R and Shift R");
  await expect(headingRow).toHaveCount(0);
  await page.getByTestId("keyboard-filter").fill("");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings")).toHaveCount(0);

  await blur(page);
  await page.keyboard.press("F1");
  const sheet = page.getByTestId("shortcuts-overlay");
  await expect(sheet.locator("dt kbd", { hasText: /^T \/ Shift T$/ })).toHaveCount(1);
  await expect(sheet.locator("dt kbd", { hasText: /^R \/ Shift R$/ })).toHaveCount(0);
  await expect(sheet.getByTestId("shortcut-custom")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  const heading = () => editor<number>(page, `s.project.waypoints.waypoints["start"].headingRad`);
  await editor(page, `m.setSelection({ waypoint: "start" })`);
  await blur(page);
  const h0 = await heading();
  await page.keyboard.press("t");
  await expect.poll(heading).toBeCloseTo(h0 + 5 * DEG, 6);
  await page.keyboard.press("Shift+T");
  await expect.poll(heading).toBeCloseTo(h0, 6);
  // Each checked on its own: R then Shift R would cancel out if R still turned.
  await page.keyboard.press("r");
  await page.waitForTimeout(200);
  expect(await heading(), "R turns nothing now").toBeCloseTo(h0, 6);
  await page.keyboard.press("Shift+R");
  await page.waitForTimeout(200);
  expect(await heading(), "Shift R turns nothing now").toBeCloseTo(h0, 6);
});

test.describe("with Turn on T, the steps on J and L, and Next panel on F7", () => {
  const looseHeading = (page: Page) => editor<number>(page, `s.auto.steps.find((x) => x.id === "loose").heading.headingRad ?? 0`);

  test.beforeEach(async ({ page }) => {
    await skipTour(page, { keys: { "keys.rotate": "T", "keys.stepBack": "J", "keys.stepForward": "L", "keys.cycleRegion": "F7" } });
    await openProjectWith(page, { "qa-curves.auto.json": fixture("qa-curves.auto.json") });
  });

  test("T and Shift T turn a selected point both ways, and neither R nor Alt T turns it (QA-14)", async ({ page }) => {
    await page.getByTestId("step-row-loose").getByRole("button").first().click();
    const at = await worldToScreen(page, 0, 40);
    await page.mouse.click(at.x, at.y);
    await expect.poll(() => editor<string | undefined>(page, "s.selection.point?.pointKind")).toBe("to");
    const h0 = await looseHeading(page);
    await page.keyboard.press("t");
    await expect.poll(() => looseHeading(page)).toBeCloseTo(h0 + 5 * DEG, 6);
    await page.keyboard.press("Shift+T");
    await expect.poll(() => looseHeading(page)).toBeCloseTo(h0, 6);
    await page.keyboard.press("r");
    await page.keyboard.press("Alt+t");
    await page.waitForTimeout(200);
    expect(await looseHeading(page)).toBeCloseTo(h0, 6);
  });

  test("T and Shift T on a focused step row are the row's, and change nothing", async ({ page }) => {
    await page.getByTestId("step-main-loose").click();
    await expect(page.getByTestId("step-main-loose")).toBeFocused();
    // Listened for after the row's and the editor's handlers, so it sees whether the row took the key.
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { rowKeys: string[] }).rowKeys = seen;
      window.addEventListener("keydown", (event) => {
        if (event.key !== "Shift") seen.push(`${event.shiftKey ? "Shift+" : ""}${event.key}:${String(event.defaultPrevented)}`);
      });
    });
    const before = await editor<string>(page, "JSON.stringify(s.auto)");
    const undo = await editor<number>(page, "s.undo.length");
    await page.keyboard.press("t");
    await page.keyboard.press("Shift+T");
    expect(await page.evaluate(() => (window as unknown as { rowKeys: string[] }).rowKeys)).toEqual(["t:true", "Shift+T:true"]);
    expect(await editor<string>(page, "JSON.stringify(s.auto)")).toBe(before);
    expect(await editor<number>(page, "s.undo.length")).toBe(undo);
    await expect(page.getByTestId("step-main-loose")).toBeFocused();
  });

  test("Settings, Keyboard names T in the Heading row, and drops the sentence once Turn has no key", async ({ page }) => {
    await openKeyboard(page);
    const headingRow = page.getByTestId("keyboard-row-tool.heading");
    await expect(headingRow).toContainText("T and Shift T turn the selected point 5°");
    await expect(headingRow).not.toContainText("R and Shift R");
    await page.getByTestId("keyboard-remove-keys.rotate").click();
    await expect(page.getByTestId("keyboard-key-keys.rotate")).toHaveText("No key");
    await expect(headingRow).toContainText("Drag the heading arrow on the selected path.");
    await expect(headingRow).not.toContainText("turn the selected point");
  });

  test("J and L step the playhead, comma and full stop do not, and Space still plays on its release", async ({ page }) => {
    await blur(page);
    await page.evaluate(`import("/src/state/store.ts").then((m) => m.setPlayback(1))`);
    await page.keyboard.press("l");
    expect(await editor<number>(page, "s.playbackS")).toBeCloseTo(1.1, 6);
    await page.keyboard.press("j");
    await page.keyboard.press("j");
    expect(await editor<number>(page, "s.playbackS")).toBeCloseTo(0.9, 6);
    await page.keyboard.press(".");
    await page.keyboard.press(",");
    expect(await editor<number>(page, "s.playbackS")).toBeCloseTo(0.9, 6);

    // Space toggles playback when it is let go, not when it goes down.
    await page.keyboard.down(" ");
    await page.waitForTimeout(150);
    expect(await editor<boolean>(page, "s.playing")).toBe(false);
    await page.keyboard.up(" ");
    await expect.poll(() => editor<boolean>(page, "s.playing")).toBe(true);
    await page.keyboard.press(" ");
    await expect.poll(() => editor<boolean>(page, "s.playing")).toBe(false);
  });

  test("F7 moves focus to the next panel and F6 does not; Esc in a field only leaves the field", async ({ page }) => {
    await blur(page);
    const region = () => page.evaluate(() => document.activeElement?.closest("[data-region]")?.getAttribute("data-region") ?? null);
    await page.keyboard.press("F6");
    expect(await region(), "F6 is no one's key now").toBeNull();
    await page.keyboard.press("F7");
    await expect.poll(region).not.toBeNull();

    await page.getByTestId("step-row-pause").click();
    const field = page.getByTestId("inspector-wait-seconds");
    const input = (await field.evaluate((node) => node.tagName)) === "INPUT" ? field : field.locator("input").first();
    await input.click();
    // The custom plain keys typed in the field are letters there.
    const playhead = await editor<number | null>(page, "s.playbackS ?? null");
    await page.keyboard.type("tjl");
    expect(await editor<number | null>(page, "s.playbackS ?? null")).toBe(playhead);
    await page.keyboard.press("Escape");
    await expect(input).not.toBeFocused();
    expect(await editor<string | undefined>(page, "s.selection.stepId")).toBe("pause");
    expect(await editor<string | null>(page, "s.dialog")).toBeNull();
  });
});
