/**
 * Setting a value's provenance by hand (#87): the chip beside a pose in the inspector opens a menu
 * of the provenance labels with the current one checked and a note field, choosing a label writes
 * only the provenance, and Ctrl+Z takes it back.
 */
import { expect, test, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem(
        "zenith.ui",
        JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }),
      );
    }
  });
  await turnOnFeatures(page);
});

/** The example's endpoints are waypoints; this writes driveOut's end as a literal pose to label. */
async function openLiteralDriveOutEnd(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await page.evaluate(
    `import("/src/state/store.ts").then((m) => { const s = m.getState(); m.commit({ ...s.auto, steps: s.auto.steps.map((x) => x.id !== "driveOut" ? x : { ...x, segments: x.segments.map((seg) => ({ ...seg, to: { xIn: -12, yIn: -36, headingRad: 1.5708, provenance: "SET BY HAND: e2e, the scoreSouth waypoint" } })) }) }); m.selectStep("driveOut"); })`,
  );
  await expect(page.getByTestId("inspector-to-x-0")).toHaveValue("-12.00");
}

const driveOutEnd = (page: Page): Promise<unknown> =>
  page.evaluate(
    `import("/src/state/store.ts").then((m) => m.getState().auto.steps.find((x) => x.id === "driveOut").segments[0].to)`,
  );

test("the chip menu sets a pose's provenance and note, leaves the numbers, and undoes", async ({ page }) => {
  await openLiteralDriveOutEnd(page);
  const chip = page.getByTestId("inspector-to-provenance-0");
  await expect(chip).toHaveText("Set by hand");

  await chip.click();
  const menu = page.getByTestId("inspector-to-provenance-0-menu");
  await expect(menu).toBeVisible();
  // Every label of CLAUDE.md rule 4, with the current one checked and focused.
  await expect(menu.getByRole("menuitemradio")).toHaveCount(11);
  await expect(menu.getByRole("menuitemradio", { checked: true })).toHaveText("Set by hand");
  await expect(menu.getByRole("menuitemradio", { name: "Set by hand" })).toBeFocused();
  // The note is what came after the label.
  const note = page.getByTestId("inspector-to-provenance-0-note");
  await expect(note).toHaveValue("e2e, the scoreSouth waypoint");

  await note.fill("tape, 2026-09-30");
  await menu.getByRole("menuitemradio", { name: "Measured" }).click();
  await expect(menu).toBeHidden();
  await expect(chip).toHaveText("Measured");
  expect(await driveOutEnd(page)).toEqual({
    xIn: -12,
    yIn: -36,
    headingRad: 1.5708,
    provenance: "MEASURED: tape, 2026-09-30",
  });
  await expect(page.getByTestId("inspector-to-x-0")).toHaveValue("-12.00");

  await page.keyboard.press("Control+z");
  await expect(chip).toHaveText("Set by hand");
  expect(await driveOutEnd(page)).toMatchObject({ provenance: "SET BY HAND: e2e, the scoreSouth waypoint" });
});

test("the chip menu works from the keyboard, and Escape changes nothing", async ({ page }) => {
  await openLiteralDriveOutEnd(page);
  const chip = page.getByTestId("inspector-to-provenance-0");
  const menu = page.getByTestId("inspector-to-provenance-0-menu");

  await chip.focus();
  await page.keyboard.press("Enter");
  await expect(menu.getByRole("menuitemradio", { name: "Set by hand" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(chip).toBeFocused();
  expect(await driveOutEnd(page)).toMatchObject({ xIn: -12, provenance: "SET BY HAND: e2e, the scoreSouth waypoint" });

  // Down from Set by hand is Spec; Enter chooses it and keeps the note.
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  expect(await driveOutEnd(page)).toMatchObject({ xIn: -12, provenance: "SPEC: e2e, the scoreSouth waypoint" });
});
