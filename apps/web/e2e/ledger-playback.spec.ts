/**
 * The Ledger follows the playhead (UI_GUIDE section 9.8): the strip at the top says what the robot
 * carries and how full our hive's up cell is at the playhead, the running step is marked, the steps
 * still to come are drawn hollow, and the running step stays in view. With no playhead the whole
 * auto shows as it is.
 */
import { expect, test, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem(
        "zenith.ui",
        JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false }, ledgerOpen: true }),
      );
    }
  });
  await turnOnFeatures(page);
});

async function loadExample(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
}

async function scrubTo(page: Page, atS: number): Promise<void> {
  await page.evaluate(`import("/src/state/store.ts").then((m) => m.setPlayback(${String(atS)}))`);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

const phase = (page: Page, stepId: string) => page.getByTestId(`ledger-step-${stepId}`).getAttribute("data-phase");

/** Moves the playhead forward until `stepId` is the running step, and says when that was. */
async function scrubInto(page: Page, stepId: string): Promise<number> {
  const end = Number(await page.getByTestId("playback").getAttribute("max"));
  for (let atS = 0; atS <= end; atS += 0.25) {
    await scrubTo(page, atS);
    if ((await phase(page, stepId)) === "now") return atS;
  }
  throw new Error(`${stepId} never ran`);
}

test("the Ledger draws the auto as pieces and follows the playhead", async ({ page }) => {
  await loadExample(page);
  const ledger = page.getByTestId("ledger");

  // No playhead yet: every step as it is, the robot with its 4 preloads, the hive with its staged nectar.
  await expect(ledger.locator('[data-phase="idle"]')).toHaveCount(5);
  await expect(page.getByTestId("ledger-now")).toContainText("4/4");
  await expect(page.getByTestId("ledger-now-hive")).toContainText("0/3");
  // Every movement is a flow from a place to a place: the shot robot to hive, the tip hive to the
  // floor quarter it dumps onto, the collect flower to robot.
  const shoot = page.getByTestId("ledger-step-shootPreloads");
  await expect(shoot.locator('[data-flow="score"]')).toHaveText(/robot\s*4\s*hive/);
  await expect(shoot.locator('[data-flow="tip"]')).toHaveText(/hive tips\s*4\s*3\s*floor, garden side/);
  const collect = page.getByTestId("ledger-step-collectFlower").locator('[data-flow="collect"]');
  await expect(collect.locator('[data-place="flower1"]')).toBeVisible();
  await expect(collect.locator('[aria-label="4 pollen"]')).toHaveCount(1);
  await expect(collect.locator('[data-place="robot"]')).toBeVisible();

  // While collectFlower runs, the preloads are shot and the hive has tipped once; the rest is to come.
  await scrubInto(page, "collectFlower");
  await expect.poll(() => phase(page, "shootPreloads")).toBe("done");
  await expect.poll(() => phase(page, "scoreGardenPollen")).toBe("next");
  await expect(page.getByTestId("ledger-now")).toContainText("0/4");
  await expect(page.getByTestId("ledger-now-hive")).toContainText("Hive · 1 tip");
  await expect(page.getByTestId("ledger-step-scoreGardenPollen").locator('svg[data-empty="true"]')).not.toHaveCount(0);
  await expect(ledger).toHaveAttribute("data-running", "collectFlower");

  // While playing, the running step is in view inside the panel, whichever step that has become.
  await page.evaluate(`import("/src/state/store.ts").then((m) => m.setPlaying(true))`);
  await expect
    .poll(async () => {
      const running = await ledger.getAttribute("data-running");
      if (running === null) return "nothing running";
      const body = await page.getByTestId("ledger-panel").boundingBox();
      const row = await page.getByTestId(`ledger-step-${running}`).boundingBox();
      if (body === null || row === null) return "no box";
      return row.y >= body.y - 1 && row.y + row.height <= body.y + body.height + 1 ? "in view" : `${running} out of view`;
    })
    .toBe("in view");
  await page.evaluate(`import("/src/state/store.ts").then((m) => m.setPlaying(false))`);

  // At the end everything has run: the robot is empty and the hive has tipped twice.
  await scrubTo(page, Number(await page.getByTestId("playback").getAttribute("max")));
  await expect(ledger.locator('[data-phase="done"]')).toHaveCount(5);
  await expect(page.getByTestId("ledger-now")).toContainText("0/4");
  await expect(page.getByTestId("ledger-now-hive")).toContainText("Hive · 2 tips");
});
