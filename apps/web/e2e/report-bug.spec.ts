/**
 * Report a bug (help.reportBug) with the in-memory fake cloud (`?cloud=fake`): a signed-in user opens
 * it from the help menu, fills it in, sees the setup block the report carries, and sends it; the
 * report is then on the admin page's Bug reports view for a Horizon admin, who marks it triaged. The
 * reporter cannot read it back, and signed out the dialog asks for a sign-in and still copies. With
 * the cloud off there is no Send at all (report-bug-cloud-off.spec.ts).
 *
 * Screenshots go to test-results/report-bug/, which git ignores, or to ZENITH_E2E_SHOTS when set.
 */
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";

const SHOTS = process.env["ZENITH_E2E_SHOTS"] ?? fileURLToPath(new URL("../test-results/report-bug/", import.meta.url));
const shotPath = (name: string) => `${SHOTS.replace(/\/?$/, "/")}report-bug-${name}.png`;

async function start(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
    }
    window.localStorage.removeItem("zenith.cloudFake");
  });
  await turnOnFeatures(page);
  await page.goto("/?cloud=fake");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
}

/** A provider and a display name, as in the sharing tests. */
async function signIn(page: Page, name: string): Promise<void> {
  await page.getByTestId("toolbar-sign-in").click();
  const sheet = page.getByTestId("signin-sheet");
  await sheet.getByTestId("signin-github").click();
  await sheet.getByTestId("signin-display-name").fill(name);
  await sheet.getByTestId("signin-display-name-save").click();
  await expect(page.getByTestId("toolbar-account")).toContainText(name);
  // Someone in no team gets the Teams sheet by itself; close it.
  const teams = page.getByTestId("teams-sheet-close");
  if (await teams.isVisible()) await teams.click();
}

async function openFromHelpMenu(page: Page) {
  await page.getByTestId("toolbar-help").click();
  await page.getByTestId("help-menu").getByTestId("menu-help.reportBug").click();
  const dialog = page.getByTestId("report-bug");
  await expect(dialog).toBeVisible();
  return dialog;
}

test("a signed-in user sends a private report that a Horizon admin reads and marks on the admin page", async ({ page }) => {
  await start(page);
  await signIn(page, "Ada");
  await page.getByTestId("toolbar-run.validate").click();

  const dialog = await openFromHelpMenu(page);
  await expect(dialog.getByTestId("report-bug-where")).toContainText("goes privately to Horizon");
  await expect(dialog.getByRole("link")).toHaveCount(0);
  const send = dialog.getByTestId("report-bug-send");
  await expect(send).toBeDisabled();

  // The setup block is there before anything is sent, and holds no name.
  const setup = dialog.getByTestId("report-bug-setup");
  await expect(setup).toContainText("Sent with your report");
  await expect(setup).toContainText("App version");
  await expect(setup).toContainText("Chrome");
  await expect(setup).toContainText("Fake (in this tab only)");
  await expect(setup).toContainText("run.validate");
  await expect(setup).not.toContainText("Ada");

  await dialog.getByTestId("report-bug-what").fill("The first path vanished after I saved.");
  await dialog.getByTestId("report-bug-expected").fill("The path stays on the field.");
  await dialog.getByTestId("report-bug-steps").fill("1. Open the example.\n2. Save.");
  const include = dialog.getByTestId("report-bug-include-auto");
  await expect(include).not.toBeChecked();
  await expect(dialog.getByText("Include a snapshot of my auto file")).toBeVisible();
  await expect(dialog.getByTestId("report-bug-include-auto-note")).toContainText("Horizon admins will see this file's paths");
  await include.check();
  await expect(send).toBeEnabled();
  // A taller window for the picture, so the whole dialog shows.
  await page.setViewportSize({ width: 1280, height: 1000 });
  await dialog.getByTestId("report-bug-where").scrollIntoViewIfNeeded();
  await dialog.screenshot({ path: shotPath("fake-cloud") });
  await send.click();
  await expect(dialog.getByTestId("report-bug-sent")).toContainText("went to Horizon privately");
  await dialog.getByTestId("report-bug-done").click();
  await expect(page.getByTestId("report-bug")).toHaveCount(0);

  // The reporter is not an admin, so the review page does not open for them, their report included.
  await page.evaluate(() => {
    window.location.hash = "#/admin";
  });
  await expect.poll(() => new URL(page.url()).hash).toBe("");
  await expect(page.getByTestId("admin-page")).toHaveCount(0);

  // Signed in as the fake's Horizon admin, the report is on the Bug reports view.
  await page.getByTestId("toolbar-account").click();
  await page.getByTestId("settings-nav-developer").click();
  await page.getByTestId("fake-demo-reviewer").click();
  await expect(page.getByTestId("toolbar-account")).toContainText("Demonstration reviewer");
  const teams = page.getByTestId("teams-sheet-close");
  if (await teams.isVisible()) await teams.click();
  const accountClose = page.getByTestId("settings-close");
  if (await accountClose.isVisible()) await accountClose.click();
  await page.evaluate(() => {
    window.location.hash = "#/admin";
  });
  const admin = page.getByTestId("admin-page");
  await admin.getByTestId("admin-view-reports").click();
  await expect(admin.getByRole("heading", { name: "Bug reports" })).toBeVisible();
  const list = admin.getByTestId("admin-reports");
  await expect(list.getByRole("button")).toHaveCount(1);
  await list.getByRole("button").first().click();
  const report = admin.getByTestId("admin-report");
  await expect(report.getByTestId("admin-report-what")).toHaveText("The first path vanished after I saved.");
  await expect(report.getByTestId("admin-report-expected")).toHaveText("The path stays on the field.");
  await expect(report.getByTestId("admin-report-setup")).toContainText("run.validate");
  // The snapshot the reporter chose to include, as collapsed text, never drawn.
  const snapshot = report.getByTestId("admin-report-auto");
  await expect(snapshot).toBeVisible();
  await expect(snapshot).not.toHaveAttribute("open", "");
  await expect(report.locator("canvas")).toHaveCount(0);
  await expect(report.getByTestId("admin-report-status")).toHaveText("New");
  await report.getByTestId("admin-report-triage").click();
  await expect(admin.getByTestId("admin-report-status")).toHaveText("Triaged");
  await admin.screenshot({ path: shotPath("admin-list") });
  await admin.getByTestId("admin-report-close").click();
  await expect(admin.getByTestId("admin-report-status")).toHaveText("Closed");
});

test("with nothing typed, Copy report stays focusable and says why it cannot copy yet", async ({ page }) => {
  await start(page);
  const dialog = await openFromHelpMenu(page);
  const copy = dialog.getByTestId("report-bug-copy");
  await expect(copy).toHaveAttribute("aria-disabled", "true");
  await expect(copy).not.toHaveAttribute("disabled", /.*/);
  await copy.focus();
  await expect(copy).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("tooltip")).toContainText("Unavailable: Say what happened first.");
});

test("signed out with the cloud on, the dialog asks for a sign-in, keeps what was typed and still copies", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await start(page);
  const dialog = await openFromHelpMenu(page);
  await expect(dialog.getByTestId("report-bug-send")).toHaveCount(0);
  await expect(dialog.getByTestId("report-bug-where")).toContainText("Sign in to send this report privately to Horizon.");
  await dialog.getByTestId("report-bug-what").fill("Dragging a waypoint froze the page.");
  await dialog.getByTestId("report-bug-copy").click();
  // Copy answers on the button, as every Copy does, and on the status line under the dialog.
  await expect(dialog.getByTestId("report-bug-copy")).toHaveText("Copied");
  await expect(page.getByTestId("status")).toContainText("Copied the report.");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("Dragging a waypoint froze the page.");
  expect(copied).toContain("Sent with this report:");

  await dialog.getByTestId("report-bug-sign-in").click();
  await expect(page.getByTestId("signin-sheet")).toBeVisible();
  await page.keyboard.press("Escape");
  const again = await openFromHelpMenu(page);
  await expect(again.getByTestId("report-bug-what")).toHaveValue("Dragging a waypoint froze the page.");
});

test("the command palette finds Report a bug", async ({ page }) => {
  await start(page);
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("bug");
  await page.getByTestId("palette-item-help.reportBug").click();
  await expect(page.getByTestId("report-bug")).toBeVisible();
});
