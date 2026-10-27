/**
 * "Play from here" in the step menu (issue #141): right-click a step, nested ones included, and the
 * playhead moves to where it starts at the playback level and plays. The same menu opens from the
 * keyboard with Shift+F10, and a step the level never reaches shows the item disabled with why.
 */
import { expect, test, type Page } from "@playwright/test";
import { skipTour } from "./qa/helpers";

/** collect-and-score's `clearGarden` is a wait inside the sequence `clearThenSpinUp`, inside the parallel `returnToScore`. */
const NESTED = "clearGarden";

async function playback(page: Page): Promise<{ playbackS: number | null; playing: boolean }> {
  return page.evaluate(async () => {
    const store = (await import("/src/state/store.ts" as string)) as {
      getState: () => { playbackS: number | null; playing: boolean };
    };
    const { playbackS, playing } = store.getState();
    return { playbackS, playing };
  });
}

/** Where a step starts on the ideal clock, from the same trajectory the editor plays. */
async function idealStart(page: Page, stepId: string): Promise<number> {
  return page.evaluate(async (id) => {
    const store = (await import("/src/state/store.ts" as string)) as {
      currentDerived: () => { plan: unknown; estimate: unknown };
    };
    const playback = (await import("/src/state/playback.ts" as string)) as {
      idealFor: (plan: unknown, estimate: unknown) => { spans: Array<{ stepId: string; startS: number }> } | null;
    };
    const derived = store.currentDerived();
    const span = playback.idealFor(derived.plan, derived.estimate)?.spans.find((candidate) => candidate.stepId === id);
    if (span === undefined) throw new Error(`no ideal span for ${id}`);
    return span.startS;
  }, stepId);
}

/**
 * Records where the playhead was at the moment playing started, so a slow machine's frames between
 * the click and the check never blur the start. Read it back with `playStartedAt`.
 */
async function watchPlayStart(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = (await import("/src/state/store.ts" as string)) as {
      getState: () => { playbackS: number | null; playing: boolean };
      subscribeEditor: (listener: () => void) => () => void;
    };
    const probe = window as unknown as { playStartedAt?: number | null };
    probe.playStartedAt = null;
    const stop = store.subscribeEditor(() => {
      const { playbackS, playing } = store.getState();
      if (playing && probe.playStartedAt === null) {
        probe.playStartedAt = playbackS;
        stop();
      }
    });
  });
}

async function playStartedAt(page: Page): Promise<number | null> {
  return page.evaluate(() => (window as unknown as { playStartedAt?: number | null }).playStartedAt ?? null);
}

/** Playing started exactly at `startS`, and is still going. */
async function expectPlayedFrom(page: Page, startS: number): Promise<void> {
  await expect.poll(() => playStartedAt(page)).not.toBeNull();
  expect(await playStartedAt(page)).toBeCloseTo(startS, 6);
  expect((await playback(page)).playing).toBe(true);
}

async function pause(page: Page): Promise<void> {
  await page.evaluate(`import("/src/state/store.ts").then((m) => m.setPlaying(false))`);
}

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await page.goto("/?cloud=fake");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId(`step-row-${NESTED}`)).toBeVisible();
});

test("Play from here on a nested step starts the playhead at that step's start and plays", async ({ page }) => {
  const startS = await idealStart(page, NESTED);
  expect(startS).toBeGreaterThan(0);
  expect((await playback(page)).playing).toBe(false);

  await page.getByTestId(`step-row-${NESTED}`).click({ button: "right" });
  const menu = page.getByTestId("step-menu");
  const item = menu.getByTestId("menu-step.playFromHere");
  await expect(item).toHaveText("Play from here");
  await expect(item).toHaveAttribute("aria-disabled", "false");
  await watchPlayStart(page);
  await item.click();
  await expect(menu).toHaveCount(0);

  await expectPlayedFrom(page, startS);
  await expect(page.getByTestId("toolbar-view.play")).toHaveAttribute("aria-pressed", "true");
  await pause(page);
});

test("Shift+F10 on a focused step opens its menu, and Enter on Play from here plays from it", async ({ page }) => {
  const startS = await idealStart(page, "toGarden");
  await page.getByTestId("step-main-toGarden").focus();
  await page.keyboard.press("Shift+F10");
  const item = page.getByTestId("step-menu").getByTestId("menu-step.playFromHere");
  await expect(item).toBeFocused();
  await watchPlayStart(page);
  await page.keyboard.press("Enter");
  await expectPlayedFrom(page, startS);
  await pause(page);
});

test("a step the full sim never reached shows Play from here disabled, with why", async ({ page }) => {
  // A full sim trace that recorded only the first step, then the Full sim level.
  await page.evaluate(async () => {
    const store = (await import("/src/state/store.ts" as string)) as {
      setTrace: (trace: unknown) => void;
      setPlaybackLevel: (level: string) => void;
    };
    store.setTrace({
      formatVersion: 1,
      auto: "collect-and-score",
      sha: null,
      simTimeS: 2,
      tickS: 0.02,
      capabilities: [],
      steps: [{ id: "driveOut", startS: 0, endS: 2, interrupted: false }],
      poses: [],
      truthPoses: [],
      structureContacts: [],
      ledger: [],
      events: [],
    });
    store.setPlaybackLevel("full");
  });
  await expect(page.getByTestId("playback-level")).toHaveAttribute("data-level", "full");
  await page.getByTestId(`step-row-${NESTED}`).click({ button: "right" });
  const item = page.getByTestId("step-menu").getByTestId("menu-step.playFromHere");
  await expect(item).toHaveAttribute("aria-disabled", "true");
  await item.hover();
  await expect(page.getByRole("tooltip")).toContainText("Unavailable: The full sim run never reached this step.");
  // Choosing it anyway does nothing.
  await item.click({ force: true });
  expect((await playback(page)).playing).toBe(false);
});

test("the palette plays from the selected step", async ({ page }) => {
  const startS = await idealStart(page, NESTED);
  await page.getByTestId(`step-main-${NESTED}`).click();
  await page.keyboard.press("Control+k");
  await page.keyboard.type("Play from the selected step");
  await watchPlayStart(page);
  await page.keyboard.press("Enter");
  await expectPlayedFrom(page, startS);
  await pause(page);
});
