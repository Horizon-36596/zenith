/**
 * Issue #184 (decision D4): the step kind is a "path chain" and its pieces are "Path 1..n", in the
 * UI only. The file keys, the MCP tools and the generated Java keep "segment". The starter's
 * `first-auto.auto.json` has driveOut as one straight path north from (-13, -63) to (-13, -36).
 */
import { expect, test, type Page } from "@playwright/test";
import { editor, loadExample, openAutoNamed, skipTour, worldToScreen } from "./qa/helpers";

const tooltips = (page: Page) => page.locator('[role="tooltip"]');

test.beforeEach(async ({ page }) => {
  await skipTour(page);
  await loadExample(page);
  await openAutoNamed(page, "first-auto.auto.json");
  await page.getByTestId("step-row-driveOut").getByRole("button").first().click();
});

test("the Inspector names the step by its id with the Path icon, and a lone path has no Path 1 level", async ({ page }) => {
  const inspector = page.getByTestId("inspector");
  // Issues #409 and #431: the kind is the icon's name in front of the id in the selection header,
  // and one path needs no level of its own: its rows sit under one Path section.
  const head = page.getByTestId("inspector-head");
  await expect(head.getByRole("heading", { name: "driveOut", exact: true })).toBeVisible();
  await expect(head.getByRole("img", { name: "Path", exact: true })).toBeVisible();
  await expect(inspector.getByRole("button", { name: "Path", exact: true })).toBeVisible();
  await expect(inspector.getByRole("button", { name: "Path 1", exact: true })).toHaveCount(0);
  await expect(inspector.getByRole("button", { name: /^Segment/ })).toHaveCount(0);
});

test("the kind tooltip counts the paths, and splitting one makes it Drives 2 paths, followed as one", async ({ page }) => {
  // One long-hover row tooltip names the step, its kind and its time (issue #411). The click that
  // selected the row closed it, so the pointer comes back to it.
  await page.mouse.move(0, 0);
  await page.getByTestId("step-kind-driveOut").hover();
  await expect(tooltips(page)).toContainText("driveOut, a path");
  await expect(tooltips(page)).toContainText("Drives 1 path");
  await expect(tooltips(page)).not.toContainText("followed as one");

  const at = await worldToScreen(page, -13, -42);
  await page.mouse.dblclick(at.x, at.y);
  await expect.poll(() => editor<number>(page, `s.auto.steps.find((x) => x.id === "driveOut").segments.length`)).toBe(2);
  // Path 2 may be folded to its summary (issue #241), which its header's name then carries too.
  await expect(page.getByTestId("inspector").getByRole("button", { name: /^Path 2/ })).toBeVisible();

  await page.mouse.move(0, 0);
  await page.getByTestId("step-kind-driveOut").hover();
  await expect(tooltips(page)).toContainText("Drives 2 paths, followed as one");
});

test("the Path section's help links to the page that names Pedro's mapping", async ({ page }) => {
  await page.getByTestId("help-section.segment").click();
  const link = page.getByTestId("help-bubble").getByRole("link", { name: /Read more/ });
  await expect(link).toHaveAttribute("href", "https://libraries.horizon36596.org/zenith/paths-explained/#paths");
});

test("the file still says segments, and the command palette finds Add path from chain", async ({ page }) => {
  expect(await editor<string[]>(page, `s.auto.steps.map((x) => Object.keys(x).join(","))`)).toEqual(
    expect.arrayContaining([expect.stringContaining("segments")]),
  );
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("chain");
  await expect(page.getByTestId("palette-item-tool.addPath")).toBeVisible();
});
