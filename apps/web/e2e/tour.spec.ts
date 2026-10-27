/**
 * The first-run tour (site/docs/editor.md): on a first visit the example loads and
 * the core tour starts by itself; it ends on a choice between the full tour and jumping in, and once
 * dismissed it does not come back on its own. Each test starts from an empty browser profile.
 */
import { expect, test, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";
import { choosePreset } from "./qa/helpers";

// The tour's stops for every feature; `features.spec.ts` checks the ones a switch hides.
test.beforeEach(async ({ page }) => {
  await turnOnFeatures(page);
});

const CORE_STOPS = ["field", "steps", "insert", "inspector", "waypoints", "findings", "run"];

async function firstVisit(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  // The first run asks for a preset before the tour; Full keeps a stop for every feature.
  await choosePreset(page, "full");
  await expect(page.getByTestId("tour-card")).toBeVisible();
}

test("a first visit loads the example and starts the tour on the field", async ({ page }) => {
  await firstVisit(page);
  await expect(page.getByTestId("toolbar-auto-name")).toContainText("collect-and-score.auto.json");
  await expect(page.getByTestId("tour-card")).toHaveAttribute("data-stop", "field");
  await expect(page.getByTestId("tour-title")).toContainText("This is the field");
  await expect(page.getByTestId("tour-card")).toContainText(`1 / ${String(CORE_STOPS.length)}`);
});

test("the core tour walks every stop and ends on the choice card", async ({ page }) => {
  await firstVisit(page);
  for (const stop of CORE_STOPS) {
    await expect(page.getByTestId("tour-card")).toHaveAttribute("data-stop", stop);
    await page.getByTestId("tour-next").click();
  }
  await expect(page.getByTestId("tour-choice")).toBeVisible();
  await expect(page.getByTestId("tour-choice")).toContainText("You have the basics");

  // "Take the full tour" carries on into the full tour, starting at the toolbar.
  await page.getByTestId("tour-full").click();
  await expect(page.getByTestId("tour-card")).toHaveAttribute("data-stop", "tool.select");
});

/** Issue #217: the core tour explains waypoints on the inspector's Waypoints list, opened for it. */
test("the waypoints stop explains what a waypoint is beside the Waypoints list", async ({ page }) => {
  await firstVisit(page);
  for (const stop of CORE_STOPS.slice(0, CORE_STOPS.indexOf("waypoints"))) {
    await expect(page.getByTestId("tour-card")).toHaveAttribute("data-stop", stop);
    await page.getByTestId("tour-next").click();
  }
  await expect(page.getByTestId("tour-card")).toHaveAttribute("data-stop", "waypoints");
  await expect(page.getByTestId("tour-card")).toContainText("measured once on the real field");
  await expect(page.getByTestId("tour-card")).toContainText("moving it once moves every auto that uses it");
  await expect(page.getByTestId("inspector-waypoints")).toBeVisible();
  await expect(page.getByTestId("inspector-waypoints-others")).toHaveText(/^Other waypoints\s*2$/);
});

/**
 * The example opens collect-and-score so the full tour has a marker, a group and a folding chevron
 * to point at. The markers stop spotlights the inspector's Markers section; the groups stop comes
 * with a group row, returnToScore, and its fold chevron on screen in the steps list.
 */
test("the full tour's marker and group stops find their targets on the example", async ({ page }) => {
  await firstVisit(page);
  for (let i = 0; i < CORE_STOPS.length; i += 1) await page.getByTestId("tour-next").click();
  await page.getByTestId("tour-full").click();

  const seen: string[] = [];
  for (let i = 0; i < 40; i += 1) {
    const stop = (await page.getByTestId("tour-card").getAttribute("data-stop")) ?? "";
    seen.push(stop);
    if (stop === "section.markers") {
      // The heading stop selected toOtherSide, which has no marker, so this stop moves to the first
      // path that has one, collectFlower, and the section is not empty.
      await expect(page.locator('[data-tour="section.markers"]')).toBeVisible();
      await expect(page.locator('[data-tour="section.markers"]').getByTestId("inspector-marker-open-0")).toBeVisible();
      await expect(page.getByTestId("inspector-title")).toHaveText("collectFlower");
    }
    if (stop === "groups") {
      await expect(page.getByTestId("step-row-returnToScore")).toBeVisible();
      await expect(page.getByTestId("step-fold-returnToScore")).toBeVisible();
      await expect(page.getByTestId("step-row-clearThenSpinUp")).toBeVisible();
      // The 0.1.2 UX sweep (W1-5): the ring is on the group row, not on Insert step, and the card
      // does not cover it.
      await expect(page.locator('[data-tour="groups"]')).toHaveAttribute("data-testid", "step-row-returnToScore");
      const row = await page.getByTestId("step-row-returnToScore").boundingBox();
      const ring = await page.getByTestId("tour-ring").boundingBox();
      const card = await page.getByTestId("tour-card").boundingBox();
      expect(ring !== null && row !== null && ring.y < row.y && ring.y + ring.height > row.y + row.height).toBe(true);
      expect(card !== null && row !== null && (card.x >= row.x + row.width - 1 || card.y >= row.y + row.height || card.y + card.height <= row.y)).toBe(true);
      // And the selected step's row is whole in the steps list, not half under its top edge.
      const list = await page.getByTestId("steps-list").evaluate((element) => {
        let scroller: HTMLElement | null = element;
        while (scroller !== null && getComputedStyle(scroller).overflowY !== "auto") scroller = scroller.parentElement;
        const box = (scroller ?? element).getBoundingClientRect();
        return { top: box.top, bottom: box.bottom };
      });
      const selected = await page.locator('[data-testid^="step-row-"][data-selected="true"]').first().boundingBox();
      expect(selected !== null && selected.y >= list.top - 0.5 && selected.y + selected.height <= list.bottom + 0.5).toBe(true);
      break;
    }
    await page.getByTestId("tour-next").click();
  }
  expect(seen).toContain("section.markers");
  expect(seen).toContain("groups");

  // And the marker is really there: sweepGarden starts the intake from a marker at t 0.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("tour-card")).toHaveCount(0);
  await page.getByTestId("step-row-sweepGarden").getByRole("button").first().click();
  await expect(page.locator('[data-tour="section.markers"]').getByTestId("inspector-marker-open-0")).toBeVisible();
});

/**
 * The 0.1.2 UX sweep (W1-6): with Advanced heading off (Basic), the heading stops pick a path whose
 * heading is not piecewise, so the inspector does not say it was made with a switch that is off.
 */
test("with Basic the heading stops select a path that is not piecewise", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await choosePreset(page, "basic");
  await expect(page.getByTestId("tour-card")).toBeVisible();
  for (let i = 0; i < 20 && (await page.getByTestId("tour-choice").count()) === 0; i += 1) await page.getByTestId("tour-next").click();
  await page.getByTestId("tour-full").click();
  const seen: string[] = [];
  for (let i = 0; i < 30; i += 1) {
    const stop = (await page.getByTestId("tour-card").getAttribute("data-stop")) ?? "";
    seen.push(stop);
    if (stop === "tool.heading" || stop === "section.heading") {
      await expect(page.getByTestId("inspector-title")).not.toHaveText("toOtherSide");
      await expect(page.getByTestId("inspector-panel")).not.toContainText("Made with Advanced heading");
    }
    if (stop === "section.heading") break;
    await page.getByTestId("tour-next").click();
  }
  expect(seen).toContain("section.heading");
});

test("a stop with a task moves on when the task is done", async ({ page }) => {
  await firstVisit(page);
  await page.getByTestId("tour-next").click();
  await expect(page.getByTestId("tour-card")).toHaveAttribute("data-stop", "steps");

  // The steps stop asks for a step to be selected: doing it inside the spotlight moves the tour on.
  await page.getByTestId("step-row-driveOut").getByRole("button").first().click();
  await expect(page.getByTestId("tour-task")).toHaveAttribute("data-done", "true");
  await expect(page.getByTestId("tour-card")).toHaveAttribute("data-stop", "insert");
});

/**
 * The 0.1.2 UX sweep (W1-1): the steps stop has a task, so focus is on the card itself, not on
 * Next. Enter there goes to the next stop, as getting-started.md says, and the editor's own Enter,
 * which opens Insert, does not run behind it.
 */
test("Enter on the focused card goes to the next stop and does not open Insert", async ({ page }) => {
  await firstVisit(page);
  await page.getByTestId("tour-next").click();
  await expect(page.getByTestId("tour-card")).toHaveAttribute("data-stop", "steps");
  await expect(page.getByTestId("tour-card")).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(page.getByTestId("tour-card")).toHaveAttribute("data-stop", "insert");
  // The insert stop opens Insert itself; what matters is that the second Enter did not insert a step.
  const rows = await page.locator('[data-testid^="step-row-"]').count();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("tour-card")).toHaveAttribute("data-stop", "inspector");
  await expect(page.locator('[data-testid^="step-row-"]')).toHaveCount(rows);
  await expect(page.getByTestId("step-row-path1")).toHaveCount(0);

  // A held Enter's repeats and a modified Enter are not Next, and the editor does not act on them
  // behind the card either.
  await page.getByTestId("tour-card").focus();
  await page.getByTestId("tour-card").evaluate((card) => {
    for (const init of [{ repeat: true }, { repeat: true }, { shiftKey: true }, { ctrlKey: true }]) {
      card.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }));
    }
  });
  await expect(page.getByTestId("tour-card")).toHaveAttribute("data-stop", "inspector");
  await expect(page.locator('[data-testid^="step-row-"]')).toHaveCount(rows);
});

test("Jump in dismisses the tour, and it does not come back after a reload", async ({ page }) => {
  await firstVisit(page);
  for (let i = 0; i < CORE_STOPS.length; i += 1) await page.getByTestId("tour-next").click();
  await page.getByTestId("tour-jump-in").click();
  await expect(page.getByTestId("tour-card")).toHaveCount(0);
  await expect(page.getByTestId("tour-choice")).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId("toolbar")).toBeVisible();
  await expect(page.getByTestId("tour-card")).toHaveCount(0);
  await expect(page.getByTestId("tour-choice")).toHaveCount(0);

  // It can still be replayed from the help menu.
  await page.getByTestId("toolbar-help").click();
  await page.getByTestId("menu-help.tour").click();
  await expect(page.getByTestId("tour-card")).toBeVisible();
});

/**
 * Escape is pressed straight after the Next that reaches each stop, with no wait between them. Each
 * stop mounts a new card, and the key must reach that card rather than the page, where Escape only
 * clears the selection (issue #139). The last Next lands on the choice card, where Escape is Jump in.
 */
test("Escape leaves the tour from any stop", async ({ page }) => {
  await firstVisit(page);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("tour-card")).toHaveCount(0);

  for (let stop = 1; stop <= CORE_STOPS.length; stop += 1) {
    await page.getByTestId("toolbar-help").click();
    await page.getByTestId("menu-help.tour").click();
    await expect(page.getByTestId("tour-card")).toHaveAttribute("data-stop", CORE_STOPS[0] ?? "");
    for (let i = 0; i < stop; i += 1) await page.getByTestId("tour-next").click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("tour-card"), `Escape after Next to stop ${String(stop + 1)}`).toHaveCount(0);
    await expect(page.getByTestId("tour-choice")).toHaveCount(0);
  }
});
