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
import { editor, shot, skipTour } from "./helpers";

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

    test(`"Show me everything" walks every stop on screen at ${String(size.width)}x${String(size.height)}`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await page.goto("/");
      for (let i = 0; i < CORE_STOPS.length; i += 1) await page.getByTestId("tour-next").click();
      await page.getByTestId("tour-full").click();
      const problems: string[] = [];
      for (const [index, stop] of FULL_STOPS.entries()) {
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
            // It selects the first path with a marker, sweepGarden, so its marker row is on show.
            expect(await editor<string | undefined>(page, "s.selection.stepId")).toBe("sweepGarden");
            await expect(page.locator('[data-tour="section.markers"]')).toContainText("Markers (1)", { timeout: 1_000 });
          }
        } catch (error) {
          problems.push(`${stop.id}: ${(error as Error).message.split("\n")[0] ?? ""}`);
        }
        await shot(page, `01-full-${String(index + 1).padStart(2, "0")}-${stop.id}-${String(size.width)}`);
        await expect(page.getByTestId("tour-card")).toContainText(`${String(index + 1)} / ${String(FULL_STOPS.length)}`);
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
    await expect(page.getByTestId("tour-back")).toHaveCount(0);
    await page.getByTestId("tour-next").click();
    await expect(page.getByTestId("tour-card")).toHaveAttribute("data-stop", CORE_STOPS[1]?.id ?? "");
    await page.getByTestId("tour-back").click();
    await expect(page.getByTestId("tour-card")).toHaveAttribute("data-stop", CORE_STOPS[0]?.id ?? "");
  });

  test("clicks outside the ring still reach the app while the tour shows", async ({ page }) => {
    // The tour is non-modal (UI_GUIDE section 10.1).
    await page.goto("/");
    await expect(page.getByTestId("tour-card")).toHaveAttribute("data-stop", "field");
    // The toolbar's Save sits outside the field's ring; the example saves by downloading a copy.
    const save = await page.getByTestId("toolbar-run.save").boundingBox();
    if (save === null) throw new Error("no save button");
    const download = page.waitForEvent("download", { timeout: 5_000 }).catch(() => null);
    await page.mouse.click(save.x + save.width / 2, save.y + save.height / 2);
    expect(await download).not.toBeNull();
    await expect(page.getByTestId("tour-card")).toHaveAttribute("data-stop", "field");
  });
});

test.describe("leaving and replaying", () => {
  test("Jump in ends the tour, completion survives a reload, and the tour never returns by itself", async ({
    page,
  }) => {
    await page.goto("/");
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
    for (let i = 0; i < CORE_STOPS.length; i += 1) await page.getByTestId("tour-next").click();
    await expect(page.getByTestId("tour-choice")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("tour")).toHaveCount(0);
    expect((await editor<{ coreDone: boolean }>(page, "s.prefs.tour")).coreDone).toBe(true);
  });

  test("Skip tour on the first stop still counts as seen after a reload", async ({ page }) => {
    await page.goto("/");
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
