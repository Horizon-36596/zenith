/**
 * The first-run tour (site/docs/editor.md): on a first visit the example loads and
 * the core tour starts by itself; it ends on a choice between the full tour and jumping in, and once
 * dismissed it does not come back on its own. Each test starts from an empty browser profile.
 */
import { expect, test, type Page } from "@playwright/test";

const CORE_STOPS = ["field", "steps", "insert", "inspector", "findings", "run"];

async function firstVisit(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
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

  // "Show me everything" carries on into the full tour, starting at the toolbar.
  await page.getByTestId("tour-full").click();
  await expect(page.getByTestId("tour-card")).toHaveAttribute("data-stop", "tool.select");
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
      // The stop selects the first path with a marker, sweepGarden, so the section is not empty.
      await expect(page.locator('[data-tour="section.markers"]')).toBeVisible();
      await expect(page.locator('[data-tour="section.markers"]')).toContainText("Markers (1)");
      await expect(page.getByTestId("inspector")).toContainText("sweepGarden");
    }
    if (stop === "groups") {
      await expect(page.getByTestId("step-row-returnToScore")).toBeVisible();
      await expect(page.getByTestId("step-fold-returnToScore")).toBeVisible();
      await expect(page.getByTestId("step-row-clearThenSpinUp")).toBeVisible();
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
  await expect(page.locator('[data-tour="section.markers"]')).toContainText("Markers (1)");
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

test("Escape leaves the tour from any stop", async ({ page }) => {
  await firstVisit(page);
  await page.getByTestId("tour-next").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("tour-card")).toHaveCount(0);
});
