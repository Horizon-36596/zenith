/**
 * Report a bug with the cloud off, as a build from source without a cloud config is: the dialog works,
 * shows the setup block, and offers Copy report instead of Send, with a line that links the public
 * repository's new-issue page to paste the copied report into (owner ruling 2026-10-23, #495). That
 * is the one public link, so the opt-in snapshot of the auto file says plainly that its paths become
 * public there. Copy report says why while it cannot copy (UX review, S16).
 *
 * Screenshots go to test-results/report-bug/, which git ignores, or to ZENITH_E2E_SHOTS when set.
 */
import { fileURLToPath } from "node:url";
import { expect, test, type Locator } from "@playwright/test";
import { turnOnFeatures } from "./features";

const SHOTS = process.env["ZENITH_E2E_SHOTS"] ?? fileURLToPath(new URL("../test-results/report-bug/", import.meta.url));

/**
 * Fails when any label of the dialog overlaps any of its text boxes, or sits closer than 2 px to
 * the one above it. Measured in the page, so a box that grew past its row is caught.
 */
async function expectLabelsClear(dialog: Locator, when: string): Promise<void> {
  const boxes = await dialog.evaluate((root) => {
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, text: (el.textContent ?? "").trim().slice(0, 40) };
    };
    return { labels: [...root.querySelectorAll("label")].map(rect), areas: [...root.querySelectorAll("textarea")].map(rect) };
  });
  expect(boxes.labels.length, when).toBeGreaterThanOrEqual(3);
  for (const label of boxes.labels) {
    for (const area of boxes.areas) {
      const apart = label.bottom <= area.top || label.top >= area.bottom || label.right <= area.left || label.left >= area.right;
      expect(apart, `${when}: "${label.text}" overlaps a text box`).toBe(true);
      if (area.bottom <= label.top) expect(label.top - area.bottom, `${when}: "${label.text}" sits against the box above`).toBeGreaterThanOrEqual(2);
    }
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
    }
    window.localStorage.removeItem("zenith.cloudFake");
  });
  await turnOnFeatures(page);
});

test("with the cloud off, Report a bug offers Copy report and no Send", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();

  await page.getByTestId("toolbar-help").click();
  await page.getByTestId("help-menu").getByTestId("menu-help.reportBug").click();
  const dialog = page.getByTestId("report-bug");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("report-bug-where")).toHaveText(
    "This build of Zenith cannot send reports. Copy the report, then paste it into a new issue on GitHub. Anyone can read issues there.",
  );
  await expect(dialog.getByTestId("report-bug-send")).toHaveCount(0);
  await expect(dialog.getByTestId("report-bug-sign-in")).toHaveCount(0);
  // The one link is the public repository's new-issue page, opened outside the app.
  await expect(dialog.getByRole("link")).toHaveCount(1);
  const issue = dialog.getByTestId("report-bug-new-issue");
  await expect(issue).toHaveAttribute("href", "https://github.com/Horizon-36596/zenith/issues/new");
  await expect(issue).toHaveAttribute("target", "_blank");
  await expect(dialog.getByTestId("report-bug-setup")).toContainText("Off (no accounts in this build)");
  await expect(page.getByTestId("toolbar-sign-in")).toHaveCount(0);

  // Every label has room above its box, before and after a text box is resized, and in a narrow window.
  await expectLabelsClear(dialog, "as opened");
  await dialog.getByTestId("report-bug-what").evaluate((el) => {
    (el as HTMLTextAreaElement).style.height = "260px";
  });
  await dialog.getByTestId("report-bug-expected").evaluate((el) => {
    (el as HTMLTextAreaElement).style.height = "40px";
  });
  await expectLabelsClear(dialog, "after resizing");
  await page.setViewportSize({ width: 420, height: 700 });
  await expectLabelsClear(dialog, "at 420 px wide");
  await page.setViewportSize({ width: 1280, height: 720 });
  await dialog.getByTestId("report-bug-what").evaluate((el) => {
    (el as HTMLTextAreaElement).style.height = "";
  });
  await dialog.getByTestId("report-bug-expected").evaluate((el) => {
    (el as HTMLTextAreaElement).style.height = "";
  });

  const copy = dialog.getByTestId("report-bug-copy");
  await expect(copy).toBeDisabled();
  // A greyed Copy report says why on hover. It is aria-disabled, not disabled, so the pointer reaches
  // the button itself (#521).
  await copy.hover();
  await expect(page.getByRole("tooltip")).toContainText("Unavailable: Say what happened first.");
  await page.mouse.move(0, 0);
  await dialog.getByTestId("report-bug-what").fill("The estimate bar did not update after an undo.");
  const include = dialog.getByTestId("report-bug-include-auto");
  await expect(include).not.toBeChecked();
  await expect(dialog.getByTestId("report-bug-include-auto-note")).toContainText("Pasted into an issue, this file's paths are public");
  await include.check();
  await expect(copy).toBeEnabled();
  // A taller window for the picture, so the whole dialog shows.
  await page.setViewportSize({ width: 1280, height: 1000 });
  await dialog.getByTestId("report-bug-where").scrollIntoViewIfNeeded();
  await dialog.screenshot({ path: `${SHOTS.replace(/\/?$/, "/")}report-bug-cloud-off.png` });
  await copy.click();
  // Copy answers on the button, as every Copy does, and on the status line under the dialog.
  await expect(dialog.getByTestId("report-bug-copy")).toHaveText("Copied");
  await expect(page.getByTestId("status")).toContainText("Copied the report.");
  // With the cloud off, the dialog also says where the report goes.
  await expect(dialog.getByTestId("report-bug-copied")).toHaveText("Now paste it into a new issue on GitHub.");
  await expect(dialog.getByTestId("report-bug-copied").getByRole("link")).toHaveAttribute("href", "https://github.com/Horizon-36596/zenith/issues/new");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("The estimate bar did not update after an undo.");
  expect(copied).toContain("Cloud: Off (no accounts in this build)");
  expect(copied).toContain("Auto file:");
  expect(copied).not.toMatch(/"authors"/);
});
