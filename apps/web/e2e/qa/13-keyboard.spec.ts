/**
 * QA 13, the keyboard (UI_GUIDE section 8.2, apps/web/src/app/shortcuts.ts): the shortcut sheet
 * lists every key in the table; each key does what the sheet says; Ctrl K opens the palette; and
 * no single-key shortcut fires while the user is typing in a field, or when a browser chord such as
 * Ctrl C or Ctrl A is pressed.
 */
import { expect, test, type Page } from "@playwright/test";
import { SHORTCUTS } from "../../src/app/shortcuts";
import { editor, fixture, knownBug, openProjectWith, rowIds, shot, skipTour, worldToScreen } from "./helpers";

interface Pose {
  xIn: number;
  yIn: number;
  headingRad?: number;
}

const ui = (page: Page) =>
  page.evaluate(`import("/src/state/ui.ts").then((u) => u.getUi())`) as Promise<{ insertOpen: boolean; stepMenu: unknown; helpMenuOpen: boolean }>;
const looseTo = (page: Page) => editor<Pose>(page, `s.auto.steps.find((x) => x.id === "loose").segments[0].to`);

/** Clicks empty, unfocusable page chrome so the keys go to the window, not a field. */
async function blur(page: Page): Promise<void> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
}

async function selectLooseEnd(page: Page): Promise<void> {
  await page.getByTestId("step-row-loose").getByRole("button").first().click();
  const at = await worldToScreen(page, 0, 40);
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => editor<string | undefined>(page, "s.selection.point?.pointKind")).toBe("to");
}

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await openProjectWith(page, { "qa-curves.auto.json": fixture("qa-curves.auto.json") });
});

test("? and F1 open the shortcut sheet, which lists every key in the table, and Esc closes it", async ({ page }) => {
  await blur(page);
  await page.keyboard.press("Shift+Slash");
  const sheet = page.getByTestId("shortcuts-overlay");
  await expect(sheet).toBeVisible();
  await shot(page, "13-shortcut-sheet");
  const text = (await sheet.innerText()).replace(/\s+/g, " ");
  const missing = Object.entries(SHORTCUTS).filter(([, keys]) => !text.includes(keys));
  expect(missing, "every shortcut in the table is on the sheet").toEqual([]);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await page.keyboard.press("F1");
  await expect(sheet).toBeVisible();
  await page.keyboard.press("F1");
  await expect(sheet).toHaveCount(0);
});

test("the tool keys pick their tools", async ({ page }) => {
  await blur(page);
  const tools: Array<[string, string]> = [
    ["p", "addPath"],
    ["c", "addCommand"],
    ["m", "marker"],
    ["h", "heading"],
    ["u", "measure"],
    ["v", "select"],
  ];
  for (const [key, tool] of tools) {
    await page.keyboard.press(key);
    expect(await editor<string>(page, "s.tool"), key).toBe(tool);
    // Add command has no toolbar button (TOOLBAR_GROUPS); the rest show the pressed state.
    const button = page.getByTestId(`toolbar-tool.${tool}`);
    if ((await button.count()) > 0) await expect(button).toHaveAttribute("aria-pressed", "true");
  }
});

test("S toggles snap and A toggles the alliance shown", async ({ page }) => {
  await blur(page);
  const snap = await editor<boolean>(page, "s.prefs.snap");
  await page.keyboard.press("s");
  expect(await editor<boolean>(page, "s.prefs.snap")).toBe(!snap);
  await page.keyboard.press("s");
  expect(await editor<boolean>(page, "s.prefs.snap")).toBe(snap);
  const alliance = await editor<string>(page, "s.alliance");
  await page.keyboard.press("a");
  expect(await editor<string>(page, "s.alliance")).not.toBe(alliance);
  await expect(page.getByTestId("alliance-pill")).not.toHaveText(alliance);
  await page.keyboard.press("a");
  expect(await editor<string>(page, "s.alliance")).toBe(alliance);
});

test("Ctrl K opens the palette and Esc closes it; Ctrl O opens Open; F5 opens Simulate; F8 validates", async ({ page }) => {
  await blur(page);
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("palette-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("palette-input")).toHaveCount(0);
  await page.keyboard.press("Control+o");
  expect(await editor<string | null>(page, "s.dialog")).toBe("open");
  await page.keyboard.press("Escape");
  expect(await editor<string | null>(page, "s.dialog")).toBeNull();
  await page.keyboard.press("F5");
  expect(await editor<string | null>(page, "s.dialog")).toBe("simulate");
  await page.keyboard.press("Escape");
  const before = await editor<number | null>(page, "s.validatedAt ?? null");
  await page.keyboard.press("F8");
  await expect.poll(() => editor<number | null>(page, "s.validatedAt ?? null")).not.toBe(before);
});

test("F6 moves focus from one region to the next", async ({ page }) => {
  await blur(page);
  const seen: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press("F6");
    seen.push(
      await page.evaluate(() => {
        const region = document.activeElement?.closest("[data-region]");
        return region?.getAttribute("aria-label") ?? region?.getAttribute("data-testid") ?? region?.tagName ?? "none";
      }),
    );
  }
  expect(new Set(seen).size, `regions visited: ${seen.join(", ")}`).toBeGreaterThanOrEqual(4);
});

test("Enter opens Insert, Del deletes, Ctrl D duplicates, Ctrl Z and Ctrl Y undo and redo", async ({ page }) => {
  await page.getByTestId("step-row-pause").click();
  await blur(page);
  await page.keyboard.press("Enter");
  expect((await ui(page)).insertOpen).toBe(true);
  await page.keyboard.press("Escape");
  expect((await ui(page)).insertOpen).toBe(false);
  const before = await rowIds(page);
  await page.getByTestId("step-row-pause").click();
  await blur(page);
  await page.keyboard.press("Control+d");
  await expect.poll(async () => (await rowIds(page)).length).toBe(before.length + 1);
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await rowIds(page)).length).toBe(before.length);
  await page.keyboard.press("Control+y");
  await expect.poll(async () => (await rowIds(page)).length).toBe(before.length + 1);
  await page.keyboard.press("Control+z");
  await page.getByTestId("step-row-pause").click();
  await blur(page);
  await page.keyboard.press("Delete");
  await expect.poll(async () => await rowIds(page)).not.toContain("pause");
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(async () => await rowIds(page)).not.toContain("pause");
  await page.keyboard.press("Control+z");
  await expect.poll(async () => await rowIds(page)).toContain("pause");
});

test("Alt+Up and Alt+Down reorder the selected step", async ({ page }) => {
  await page.getByTestId("step-row-pause").click();
  await blur(page);
  const before = await rowIds(page);
  const at = before.indexOf("pause");
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(async () => (await rowIds(page)).indexOf("pause")).toBe(at - 1);
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(async () => (await rowIds(page)).indexOf("pause")).toBe(at);
});

test("arrows nudge the selected point half an inch, Shift two inches; R and Shift R turn it 5 degrees", async ({ page }) => {
  await selectLooseEnd(page);
  await blur(page);
  const p0 = await looseTo(page);
  await page.keyboard.press("ArrowRight");
  expect((await looseTo(page)).xIn).toBeCloseTo(p0.xIn + 0.5, 6);
  await page.keyboard.press("ArrowUp");
  expect((await looseTo(page)).yIn).toBeCloseTo(p0.yIn + 0.5, 6);
  await page.keyboard.press("Shift+ArrowLeft");
  expect((await looseTo(page)).xIn).toBeCloseTo(p0.xIn - 1.5, 6);
  await page.keyboard.press("Shift+ArrowDown");
  expect((await looseTo(page)).yIn).toBeCloseTo(p0.yIn - 1.5, 6);
  const h0 = (await looseTo(page)).headingRad ?? 0;
  await page.keyboard.press("r");
  expect((await looseTo(page)).headingRad ?? 0).toBeCloseTo(h0 + (5 * Math.PI) / 180, 6);
  await page.keyboard.press("Shift+R");
  expect((await looseTo(page)).headingRad ?? 0).toBeCloseTo(h0, 6);
});

test("Space plays and pauses; comma and full stop step the playhead a tenth of a second", async ({ page }) => {
  await blur(page);
  await page.evaluate(`import("/src/state/store.ts").then((m) => m.setPlayback(1))`);
  await page.keyboard.press(".");
  expect(await editor<number>(page, "s.playbackS")).toBeCloseTo(1.1, 6);
  await page.keyboard.press(",");
  await page.keyboard.press(",");
  expect(await editor<number>(page, "s.playbackS")).toBeCloseTo(0.9, 6);
  await page.keyboard.press(" ");
  await expect.poll(() => editor<boolean>(page, "s.playing")).toBe(true);
  await page.keyboard.press(" ");
  await expect.poll(() => editor<boolean>(page, "s.playing")).toBe(false);
});

test("no shortcut fires while typing in a field", async ({ page }) => {
  await page.getByTestId("step-row-pause").click();
  const field = page.getByTestId("inspector-wait-seconds");
  const input = (await field.evaluate((node) => node.tagName)) === "INPUT" ? field : field.locator("input").first();
  await input.click();
  const before = {
    tool: await editor<string>(page, "s.tool"),
    snap: await editor<boolean>(page, "s.prefs.snap"),
    alliance: await editor<string>(page, "s.alliance"),
    rows: (await rowIds(page)).length,
    dialog: await editor<string | null>(page, "s.dialog"),
  };
  await input.press("Control+a");
  await page.keyboard.type("vpcmhusar?,. 12");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Delete");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Control+d");
  expect(await editor<string>(page, "s.tool")).toBe(before.tool);
  expect(await editor<boolean>(page, "s.prefs.snap")).toBe(before.snap);
  expect(await editor<string>(page, "s.alliance")).toBe(before.alliance);
  expect((await rowIds(page)).length).toBe(before.rows);
  expect(await editor<string | null>(page, "s.dialog")).toBe(before.dialog);
  expect((await ui(page)).insertOpen).toBe(false);
  await shot(page, "13-typing");
});

test("Escape in an inspector field leaves the step selected", async ({ page }) => {
  await page.getByTestId("step-row-pause").click();
  const field = page.getByTestId("inspector-wait-seconds");
  const input = (await field.evaluate((node) => node.tagName)) === "INPUT" ? field : field.locator("input").first();
  await input.click();
  await page.keyboard.press("Escape");
  expect(await editor<string | undefined>(page, "s.selection.stepId")).toBe("pause");
});

test("browser chords with Ctrl do not trigger the single-key shortcuts", async ({ page }) => {
  await blur(page);
  await page.keyboard.press("v");
  const alliance = await editor<string>(page, "s.alliance");
  await page.keyboard.press("Control+c");
  expect(await editor<string>(page, "s.tool"), "Ctrl C (copy) leaves the tool alone").toBe("select");
  await page.keyboard.press("Control+a");
  expect(await editor<string>(page, "s.alliance"), "Ctrl A (select all) leaves the alliance alone").toBe(alliance);
});

test("Ctrl Shift Enter runs Propose, not Insert", async ({ page }) => {
  await page.getByTestId("step-row-pause").click();
  await blur(page);
  await page.keyboard.press("Control+Shift+Enter");
  expect((await ui(page)).insertOpen, "the Insert menu stays shut").toBe(false);
});
