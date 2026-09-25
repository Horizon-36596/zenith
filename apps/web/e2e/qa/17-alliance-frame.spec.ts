/**
 * A file's poses are in the frame of its own `alliance` (site/docs/file-format.md), the frame the
 * robot drives it in. The fixture is a BLUE auto on BLUE's half, north of the field centre. Opened,
 * it has to show BLUE and draw its poses where they are, so a point dragged in the default view is
 * stored where it was dropped. Viewed as RED it is drawn mirrored, and a drag there is un-mirrored
 * on the way back, so the file still stores its own alliance's numbers.
 */
import { expect, test, type Page } from "@playwright/test";
import { dragWorld, editor, fixture, openProjectWith, skipTour } from "./helpers";

interface Pose {
  xIn: number;
  yIn: number;
}

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await openProjectWith(page, { "qa-blue.auto.json": fixture("qa-blue.auto.json") });
});

const legEnd = (page: Page) => editor<Pose>(page, `s.auto.steps.find((x) => x.id === "leg").segments[0].to`);

test("a BLUE auto opens viewed as BLUE, unmirrored", async ({ page }) => {
  expect(await editor<string>(page, "s.alliance")).toBe("BLUE");
  await expect(page.getByTestId("alliance-pill")).toHaveText("BLUE");
  await expect(page.getByTestId("toolbar-view.alliance")).toHaveAttribute("aria-pressed", "false");
});

test("dragging a BLUE auto's point in the default view stores it where it was dropped", async ({ page }) => {
  await page.getByTestId("step-row-leg").getByRole("button").first().click();
  const from = await legEnd(page);
  expect(from).toMatchObject({ xIn: 12, yIn: 39 });
  // Drawn where it is stored: the drag starts on the point's stored numbers, on BLUE's half.
  await dragWorld(page, from, { xIn: 30, yIn: 30 }, { steps: 10 });
  const to = await legEnd(page);
  expect(to.xIn).toBeCloseTo(30, 1);
  expect(to.yIn).toBeCloseTo(30, 1);
});

test("viewed as RED the BLUE auto is mirrored, and a drag there stores BLUE's numbers", async ({ page }) => {
  await page.getByTestId("toolbar-view.alliance").click();
  expect(await editor<string>(page, "s.alliance")).toBe("RED");
  await page.getByTestId("step-row-leg").getByRole("button").first().click();
  // BIOBUZZ is point symmetric, so (12, 39) is drawn at (-12, -39) on RED's half.
  await dragWorld(page, { xIn: -12, yIn: -39 }, { xIn: -30, yIn: -30 }, { steps: 10 });
  const to = await legEnd(page);
  expect(to.xIn).toBeCloseTo(30, 1);
  expect(to.yIn).toBeCloseTo(30, 1);
});
