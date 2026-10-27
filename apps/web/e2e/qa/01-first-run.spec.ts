/**
 * QA 1, first run (site/docs/editor.md, UI_GUIDE section 10): the empty
 * state, the core tour, the choice card, the full tour, Jump in, replay, and persistence.
 *
 * Every stop is checked against the DOM directly: its `data-tour` anchor must exist, be visible,
 * have a size, and sit inside the window, at both 1440 x 900 and 1280 x 720, and the coach mark
 * must sit inside the window too. A stop whose anchor is missing still renders a centred card, so
 * checking the card alone would not catch it.
 */
import { expect, test, type Page } from "@playwright/test";
import { CORE_STOPS, FULL_STOPS } from "../../src/tour/stops";
import { LAYOUT_SIZES as SIZES } from "../viewports";
import { choosePreset, editor, loadExample, shot, skipTour } from "./helpers";
import { turnOnFeatures } from "../features";

// The full tour has a stop for every feature, so every switch is on; `features.spec.ts` checks the
// stops a switch hides.
test.beforeEach(async ({ page }) => {
  await turnOnFeatures(page);
});

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

async function anchorBox(page: Page, anchor: string): Promise<Box | null> {
  return page.evaluate((name) => {
    const element = document.querySelector<HTMLElement>(`[data-tour="${name}"]`);
    if (element === null) return null;
    const r = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none") return null;
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }, anchor);
}

async function cardBox(page: Page, testId: string): Promise<Box> {
  const box = await page.getByTestId(testId).boundingBox();
  if (box === null) throw new Error(`${testId} has no box`);
  return { left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height, width: box.width, height: box.height };
}

/** Anchor present, sized, and inside the window; the card inside the window. */
async function expectStopOnScreen(page: Page, anchor: string | null, size: { width: number; height: number }) {
  if (anchor !== null) {
    const box = await anchorBox(page, anchor);
    expect(box, `anchor [data-tour="${anchor}"] exists and is visible`).not.toBeNull();
    if (box === null) return;
    expect(box.width, `anchor ${anchor} has a width`).toBeGreaterThan(4);
    expect(box.height, `anchor ${anchor} has a height`).toBeGreaterThan(4);
    expect(box.left, `anchor ${anchor} left edge on screen`).toBeGreaterThanOrEqual(-1);
    expect(box.top, `anchor ${anchor} top edge on screen`).toBeGreaterThanOrEqual(-1);
    expect(box.right, `anchor ${anchor} right edge on screen`).toBeLessThanOrEqual(size.width + 1);
    expect(box.bottom, `anchor ${anchor} bottom edge on screen`).toBeLessThanOrEqual(size.height + 1);
  }
  const card = await cardBox(page, "tour-card");
  expect(card.left).toBeGreaterThanOrEqual(0);
  expect(card.top).toBeGreaterThanOrEqual(0);
  expect(card.right).toBeLessThanOrEqual(size.width);
  expect(card.bottom).toBeLessThanOrEqual(size.height);
}

test.describe("empty state", () => {
  test("with the tour done, the welcome screen says what to do with one primary action", async ({ page }) => {
    await skipTour(page);
    await page.goto("/");
    const empty = page.getByTestId("canvas-empty");
    await expect(empty).toBeVisible();
    await expect(empty).toContainText("Plan your first autonomous");
    await expect(page.getByTestId("canvas-load-example")).toBeVisible();
    await expect(page.getByTestId("canvas-load-example")).toContainText(/example/i);
    await expect(page.getByTestId("canvas-open-project")).toBeVisible();
    await expect(page.getByTestId("canvas-open-other")).toBeVisible();
    // Exactly one primary button on the screen (UI_GUIDE 9.9): the example.
    const primaries = await page.evaluate(() =>
      [...document.querySelectorAll("button")].filter((b) => b.getBoundingClientRect().width > 0 && /primary/i.test(b.className)).length,
    );
    expect(primaries).toBe(1);
    await expect(page.getByTestId("tour-card")).toHaveCount(0);
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await shot(page, `01-empty-state-${String(size.width)}`);
    }
  });
});

test.describe("the core tour", () => {
  test("has about six stops, starts by itself on a first visit, and shows 1 / N", async ({ page }) => {
    expect(CORE_STOPS.length).toBeGreaterThanOrEqual(5);
    expect(CORE_STOPS.length).toBeLessThanOrEqual(7);
    await page.goto("/");
    await choosePreset(page);
    await expect(page.getByTestId("tour-card")).toBeVisible();
    await expect(page.getByTestId("tour-card")).toHaveAttribute("data-stop", CORE_STOPS[0]?.id ?? "");
    await expect(page.getByTestId("tour-card")).toContainText(`1 / ${String(CORE_STOPS.length)}`);
    // The card is a labelled dialog, and not a modal one: the app stays usable round it.
    await expect(page.getByTestId("tour-card")).toHaveAttribute("role", "dialog");
    await expect(page.getByTestId("tour-card")).toHaveAttribute("aria-modal", "false");
  });

  for (const size of SIZES) {
    test(`every core stop is anchored to a visible element at ${String(size.width)}x${String(size.height)}`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await page.goto("/");
      await choosePreset(page);
      for (const [index, stop] of CORE_STOPS.entries()) {
        await expect(page.getByTestId("tour-card")).toHaveAttribute("data-stop", stop.id);
        await page.waitForTimeout(350); // the cut-out moves over --dur-tour
        await expectStopOnScreen(page, stop.anchor, size);
        await shot(page, `01-core-${String(index + 1)}-${stop.id}-${String(size.width)}`);
        await page.getByTestId("tour-next").click();
      }
      await expect(page.getByTestId("tour-choice")).toBeVisible();
      const choice = await cardBox(page, "tour-choice");
      expect(choice.right).toBeLessThanOrEqual(size.width);
      expect(choice.bottom).toBeLessThanOrEqual(size.height);
      await shot(page, `01-choice-${String(size.width)}`);
    });

    test(`"Take the full tour" walks every stop on screen at ${String(size.width)}x${String(size.height)}`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await page.goto("/");
      await choosePreset(page, "full");
      for (let i = 0; i < CORE_STOPS.length; i += 1) await page.getByTestId("tour-next").click();
      await page.getByTestId("tour-full").click();
      const problems: string[] = [];
      // The example is not a GitHub project, so the toolbar draws no Propose and the tour skips its
      // stop (issue #412).
      const full = FULL_STOPS.filter((stop) => stop.id !== "run.propose");
      for (const [index, stop] of full.entries()) {
        await expect(page.getByTestId("tour-card")).toHaveAttribute("data-stop", stop.id);
        await page.waitForTimeout(350);
        try {
          await expectStopOnScreen(page, stop.anchor, size);
          // The example opens collect-and-score so these two stops have something to point at: a
          // group row with its fold chevron, and a path with a marker.
          if (stop.id === "groups") {
            await expect(page.getByTestId("step-row-returnToScore")).toBeVisible({ timeout: 1_000 });
            await expect(page.getByTestId("step-fold-returnToScore")).toBeVisible({ timeout: 1_000 });
          }
          if (stop.id === "section.markers") {
            await expect(page.locator('[data-tour="section.markers"]')).toBeVisible({ timeout: 1_000 });
            // The heading stop selected toOtherSide, the first path with draggable heading arrows, which has no marker, so
            // the stop moves to the first path that has one, collectFlower, whose
            // marker row is on show.
            expect(await editor<string | undefined>(page, "s.selection.stepId")).toBe("collectFlower");
            await expect(page.locator('[data-tour="section.markers"]').getByTestId("inspector-marker-open-0")).toBeVisible({ timeout: 1_000 });
          }
        } catch (error) {
          problems.push(`${stop.id}: ${(error as Error).message.split("\n")[0] ?? ""}`);
        }
        await shot(page, `01-full-${String(index + 1).padStart(2, "0")}-${stop.id}-${String(size.width)}`);
        await expect(page.getByTestId("tour-card")).toContainText(`${String(index + 1)} / ${String(full.length)}`);
        await page.getByTestId("tour-next").click();
      }
      expect(problems, "every full-tour stop has an on-screen anchor").toEqual([]);
      await expect(page.getByTestId("tour-finished")).toBeVisible();
      await shot(page, `01-finished-${String(size.width)}`);
      await page.getByTestId("tour-done").click();
      await expect(page.getByTestId("tour")).toHaveCount(0);
      const tour = await editor<{ fullDone: boolean }>(page, "s.prefs.tour");
      expect(tour.fullDone).toBe(true);
    });
  }

  test("Back walks backwards, and is hidden on the first stop", async ({ page }) => {
    await page.goto("/");
    await choosePreset(page);
    await expect(page.getByTestId("tour-back")).toHaveCount(0);
    await page.getByTestId("tour-next").click();
    await expect(page.getByTestId("tour-card")).toHaveAttribute("data-stop", CORE_STOPS[1]?.id ?? "");
    await page.getByTestId("tour-back").click();
    await expect(page.getByTestId("tour-card")).toHaveAttribute("data-stop", CORE_STOPS[0]?.id ?? "");
  });

  test("clicks outside the ring still reach the app while the tour shows", async ({ page }) => {
    // The tour is non-modal (UI_GUIDE section 10.1).
    await page.goto("/");
    await choosePreset(page);
    await expect(page.getByTestId("tour-card")).toHaveAttribute("data-stop", "field");
    // The toolbar's Save sits outside the field's ring; on the read-only example it asks where the
    // copy goes, so the question showing is the click reaching the app.
    const save = await page.getByTestId("toolbar-run.save").boundingBox();
    if (save === null) throw new Error("no save button");
    await page.mouse.click(save.x + save.width / 2, save.y + save.height / 2);
    await expect(page.getByTestId("save-choice")).toBeVisible();
    await page.getByTestId("save-choice-cancel").click();
    await expect(page.getByTestId("tour-card")).toHaveAttribute("data-stop", "field");
  });
});

test.describe("leaving and replaying", () => {
  test("Jump in ends the tour, completion survives a reload, and the tour never returns by itself", async ({
    page,
  }) => {
    await page.goto("/");
    await choosePreset(page);
    for (let i = 0; i < CORE_STOPS.length; i += 1) await page.getByTestId("tour-next").click();
    await expect(page.getByTestId("tour-jump-in")).toBeFocused();
    await page.getByTestId("tour-jump-in").click();
    await expect(page.getByTestId("tour")).toHaveCount(0);
    const tour = await editor<{ seen: boolean; coreDone: boolean }>(page, "s.prefs.tour");
    expect(tour.seen).toBe(true);
    expect(tour.coreDone).toBe(true);
    await page.reload();
    await expect(page.getByTestId("toolbar")).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.getByTestId("tour")).toHaveCount(0);
  });

  test("Escape on the choice card counts as Jump in", async ({ page }) => {
    await page.goto("/");
    await choosePreset(page);
    for (let i = 0; i < CORE_STOPS.length; i += 1) await page.getByTestId("tour-next").click();
    await expect(page.getByTestId("tour-choice")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("tour")).toHaveCount(0);
    expect((await editor<{ coreDone: boolean }>(page, "s.prefs.tour")).coreDone).toBe(true);
  });

  test("Skip tour on the first stop still counts as seen after a reload", async ({ page }) => {
    await page.goto("/");
    await choosePreset(page);
    await page.getByTestId("tour-skip").click();
    await expect(page.getByTestId("tour")).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("toolbar")).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.getByTestId("tour")).toHaveCount(0);
  });

  test("the help menu replays the core tour and the full tour", async ({ page }) => {
    await skipTour(page);
    await page.goto("/");
    await page.getByTestId("toolbar-help").click();
    await shot(page, "01-help-menu");
    await page.getByTestId("menu-help.tour").click();
    await expect(page.getByTestId("tour-card")).toHaveAttribute("data-stop", CORE_STOPS[0]?.id ?? "");
    // With nothing open, the tour opened the example first so it has something to point at.
    await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByTestId("toolbar-help").click();
    await page.getByTestId("menu-help.fullTour").click();
    await expect(page.getByTestId("tour-card")).toHaveAttribute("data-stop", FULL_STOPS[0]?.id ?? "");
  });

  test("the command palette replays the tour", async ({ page }) => {
    await skipTour(page);
    await page.goto("/");
    await page.getByTestId("canvas-load-example").click();
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("tour");
    await expect(page.getByTestId("palette-item-help.tour")).toBeVisible();
    await page.getByTestId("palette-item-help.tour").click();
    await expect(page.getByTestId("tour-card")).toHaveAttribute("data-stop", CORE_STOPS[0]?.id ?? "");
  });
});

test("typing \"tour\" in the palette finds both tours", async ({ page }) => {
  await skipTour(page);
  await page.goto("/");
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("tour");
  await expect(page.getByTestId("palette-item-help.fullTour")).toBeVisible({ timeout: 2_000 });
});

/**
 * The first run's preset card (UI_GUIDE 10.4): "How much of Zenith do you want to see?" on the true
 * first run, over the example, before the tour.
 */
test.describe("the first-run preset card", () => {
  const presetFile = JSON.stringify({
    kind: "zenith-preset",
    presetVersion: 1,
    name: "Drive team",
    description: "",
    basedOn: "essential",
    settings: { "features.ledger": true },
  });

  const chosen = (page: Page) => editor<{ id: string; chosen: boolean }>(page, "s.prefs.preset");

  test("shows over the example before the tour, with Essential recommended and focused", async ({ page }) => {
    await page.goto("/");
    const card = page.getByTestId("preset-card");
    await expect(card).toBeVisible();
    await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
    await expect(card).toContainText("How much of Zenith do you want to see?");
    await expect(card).toHaveAttribute("role", "dialog");
    await expect(card).toHaveAttribute("aria-modal", "false");
    for (const id of ["basic", "essential", "full"]) await expect(page.getByTestId(`preset-card-${id}`)).toBeVisible();
    await expect(page.getByTestId("preset-card-essential")).toContainText("Recommended");
    await expect(page.getByTestId("preset-card-basic")).not.toContainText("Recommended");
    await expect(page.getByTestId("preset-card-essential")).toBeFocused();
    // Each choice says what you get, in plain words, never a list of what it turns off (issue #414).
    await expect(page.getByTestId("preset-card-gets-basic")).toHaveText("Draw paths, add commands, play and save, with few buttons.");
    await expect(card).not.toContainText("Off:");
    await expect(card).not.toContainText("returning student");
    await expect(card).not.toContainText("expert programmer");
    await expect(page.getByTestId("tour")).toHaveCount(0);
    // Nothing is chosen or seen yet, so a reload asks again.
    expect(await chosen(page)).toEqual({ id: "essential", chosen: false });
    expect((await editor<{ seen: boolean }>(page, "s.prefs.tour")).seen).toBe(false);
    await shot(page, "01-preset-card");
    await page.reload();
    await expect(page.getByTestId("preset-card")).toBeVisible();
  });

  test("Basic applies Basic and starts a tour with no group, waypoint or optimizer stops", async ({ page }) => {
    await page.goto("/");
    await choosePreset(page, "basic");
    expect(await chosen(page)).toEqual({ id: "basic", chosen: true });
    expect(await editor<boolean>(page, "s.prefs.features.groups")).toBe(false);
    await expect(page.getByTestId("tour-card")).toHaveAttribute("data-stop", "field");
    const seen: string[] = [];
    // Basic's core tour has every stop but the one on the Waypoints list, which goes with the list.
    for (let i = 0; i < CORE_STOPS.filter((stop) => stop.id !== "waypoints").length; i += 1) {
      seen.push((await page.getByTestId("tour-card").getAttribute("data-stop")) ?? "");
      await page.getByTestId("tour-next").click();
    }
    // The line the card leads to, on the choice card.
    await expect(page.getByTestId("tour-choice")).toBeVisible();
    await expect(page.getByTestId("tour-chose")).toHaveText("You chose Basic. Change it any time in Settings, Presets.");
    await page.getByTestId("tour-full").click();
    for (let i = 0; i < 40; i += 1) {
      const card = page.getByTestId("tour-card");
      if ((await card.count()) === 0) break;
      const stop = (await card.getAttribute("data-stop")) ?? "";
      seen.push(stop);
      await page.getByTestId("tour-next").click();
      await expect
        .poll(async () => ((await card.count()) === 0 ? "" : await card.getAttribute("data-stop")))
        .not.toBe(stop);
    }
    for (const hidden of ["groups", "ledger"]) expect(seen).not.toContain(hidden);
    expect(seen.join(" ")).not.toMatch(/waypoint|optimi/);
    expect(seen).toContain("timeline");
  });

  test("Full applies Full and starts the tour", async ({ page }) => {
    await page.goto("/");
    await choosePreset(page, "full");
    expect(await chosen(page)).toEqual({ id: "full", chosen: true });
    expect(await editor<boolean>(page, "s.prefs.features.ledger")).toBe(true);
    await expect(page.getByTestId("tour-card")).toHaveAttribute("data-stop", "field");
  });

  test("Escape, with focus in the card, counts as Essential and starts the tour", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("preset-card-essential")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("preset-card")).toHaveCount(0);
    expect(await chosen(page)).toEqual({ id: "essential", chosen: true });
    await expect(page.getByTestId("tour-card")).toHaveAttribute("data-stop", "field");
  });

  test("Skip counts as Essential too", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("preset-card-skip").click();
    await expect(page.getByTestId("preset-card")).toHaveCount(0);
    expect(await chosen(page)).toEqual({ id: "essential", chosen: true });
    expect(await editor<boolean>(page, "s.prefs.features.groups")).toBe(true);
    await expect(page.getByTestId("tour-card")).toHaveAttribute("data-stop", "field");
  });

  test("every button is reachable by keyboard, and Enter on one chooses it", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("preset-card-essential")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("preset-card-full")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("preset-card-import")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("preset-card-skip")).toBeFocused();
    for (let i = 0; i < 4; i += 1) await page.keyboard.press("Shift+Tab");
    await expect(page.getByTestId("preset-card-basic")).toBeFocused();
    await page.keyboard.press("Enter");
    expect(await chosen(page)).toEqual({ id: "basic", chosen: true });
  });

  test("the choices and the buttons stack at phone width, and every one can be reached", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await expect(page.getByTestId("preset-card")).toBeVisible();
    const boxes = async (ids: string[]) =>
      Promise.all(ids.map(async (id) => (await page.getByTestId(id).boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 }));
    const [basic, essential, full] = await boxes(["preset-card-basic", "preset-card-essential", "preset-card-full"]);
    expect(Math.abs((basic?.x ?? 0) - (essential?.x ?? 1))).toBeLessThan(1);
    expect(Math.abs((essential?.x ?? 0) - (full?.x ?? 1))).toBeLessThan(1);
    expect(essential?.y ?? 0).toBeGreaterThan((basic?.y ?? 0) + (basic?.height ?? 0) - 1);
    expect(full?.y ?? 0).toBeGreaterThan((essential?.y ?? 0) + (essential?.height ?? 0) - 1);
    const card = await page.getByTestId("preset-card").boundingBox();
    expect(card?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((card?.x ?? 0) + (card?.width ?? 999)).toBeLessThanOrEqual(375);
    expect((card?.y ?? 0) + (card?.height ?? 999)).toBeLessThanOrEqual(812);
    // The card scrolls inside itself when the stack is taller than the window.
    await page.getByTestId("preset-card-import").scrollIntoViewIfNeeded();
    await page.getByTestId("preset-card-skip").scrollIntoViewIfNeeded();
    const [importBox, skipBox] = await boxes(["preset-card-import", "preset-card-skip"]);
    expect(Math.abs((importBox?.x ?? 0) - (skipBox?.x ?? 1))).toBeLessThan(1);
    expect(skipBox?.y ?? 0).toBeGreaterThan((importBox?.y ?? 0) + (importBox?.height ?? 0) - 1);
    await shot(page, "01-preset-card-375");
    await page.getByTestId("preset-card-skip").click();
    await expect(page.getByTestId("preset-card")).toHaveCount(0);
  });

  for (const size of SIZES) {
    test(`fits the window at ${String(size.width)}x${String(size.height)}`, async ({ page }) => {
      await page.setViewportSize(size);
      await page.goto("/");
      const box = await page.getByTestId("preset-card").boundingBox();
      expect(box).not.toBeNull();
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(size.width);
      expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(size.height);
      await shot(page, `01-preset-card-${String(size.width)}`);
    });
  }

  test("a choice is remembered: no card and no tour after a reload", async ({ page }) => {
    await page.goto("/");
    await choosePreset(page, "basic");
    await page.getByTestId("tour-skip").click();
    await page.reload();
    await expect(page.getByTestId("toolbar")).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.getByTestId("preset-card")).toHaveCount(0);
    await expect(page.getByTestId("tour")).toHaveCount(0);
    expect(await chosen(page)).toEqual({ id: "basic", chosen: true });
  });

  test("Import adds a preset file's preset, applies it and starts the tour", async ({ page }) => {
    await page.goto("/");
    await page
      .getByTestId("preset-card-file")
      .setInputFiles({ name: "drive.zenith-preset.json", mimeType: "application/json", buffer: Buffer.from(presetFile) });
    await expect(page.getByTestId("preset-card")).toHaveCount(0);
    const now = await chosen(page);
    expect(now.chosen).toBe(true);
    expect(now.id.startsWith("user:")).toBe(true);
    expect(await editor<boolean>(page, "s.prefs.features.ledger")).toBe(true);
    await expect(page.getByTestId("tour-card")).toHaveAttribute("data-stop", "field");
  });

  test("Import of a file that is not a preset says why, naming it, and leaves the card where it was", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("preset-card")).toBeVisible();
    const before = await page.getByTestId("preset-card").boundingBox();
    await page
      .getByTestId("preset-card-file")
      .setInputFiles({ name: "nope.json", mimeType: "application/json", buffer: Buffer.from("not json") });
    await expect(page.getByTestId("preset-card-problem")).toHaveText(/^nope\.json is not valid JSON.*Pick a \.zenith-preset\.json file made by Export\.$/);
    await expect(page.getByTestId("preset-card")).toBeVisible();
    // The reason's line was kept for it, so the card did not grow or move (UX review, S5).
    expect(await page.getByTestId("preset-card").boundingBox()).toEqual(before);
    expect((await chosen(page)).chosen).toBe(false);
  });

  test("Import of a file that cannot be read says so and leaves the card", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await expect(page.getByTestId("preset-card")).toBeVisible();
    // As when the file is removed, or loses its permission, after it was picked.
    await page.evaluate(() => {
      File.prototype.text = () => Promise.reject(new DOMException("The file is gone.", "NotReadableError"));
    });
    await page
      .getByTestId("preset-card-file")
      .setInputFiles({ name: "drive.zenith-preset.json", mimeType: "application/json", buffer: Buffer.from(presetFile) });
    await expect(page.getByTestId("preset-card-problem")).toHaveText(/could not be read/);
    await expect(page.getByTestId("preset-card")).toBeVisible();
    expect((await chosen(page)).chosen).toBe(false);
    expect(errors).toEqual([]);
  });

  test("a profile that has seen the tour never sees the card", async ({ page }) => {
    await skipTour(page);
    await page.goto("/");
    await page.getByTestId("canvas-load-example").click();
    await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.getByTestId("preset-card")).toHaveCount(0);
  });

  test("a host address and a share link on a fresh profile show no card", async ({ page }) => {
    await page.goto("/?host=dsim");
    await expect(page.getByTestId("host-gate")).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.getByTestId("preset-card")).toHaveCount(0);
    await page.goto("/#/s/AAAAAAAAAAAAAAAAAAAAAA");
    await expect(page.getByTestId("cloud-off-link")).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.getByTestId("preset-card")).toHaveCount(0);
  });

  test("Help, Choose a preset… opens Settings, Presets, and replaying the tour does not show the card", async ({ page }) => {
    await skipTour(page);
    await loadExample(page);
    await page.getByTestId("toolbar-help").click();
    await page.getByTestId("menu-help.presets").click();
    await expect(page.getByTestId("settings-section-presets")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings-section-presets")).toHaveCount(0);
    await page.getByTestId("toolbar-help").click();
    await page.getByTestId("menu-help.tour").click();
    await expect(page.getByTestId("tour-card")).toHaveAttribute("data-stop", CORE_STOPS[0]?.id ?? "");
    await expect(page.getByTestId("preset-card")).toHaveCount(0);
  });

  test("the palette finds Choose a preset…", async ({ page }) => {
    await skipTour(page);
    await loadExample(page);
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("preset");
    await expect(page.getByTestId("palette-item-help.presets")).toBeVisible();
  });
});
