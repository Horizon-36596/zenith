/**
 * The description rules applied to the sheets and dialogs (issue #248, UI_GUIDE section 9.13): the
 * sharing, teams, sign-in, admin, library, outbox, Settings account and report dialogs draw state,
 * warnings and empty states, and what explained a control now lives in its tooltip. Each test runs
 * at both layout sizes and leaves a screenshot and the sheet's text beside it, so a reviewer can read
 * every visible sentence against the rules.
 *
 * Screenshots and text go to test-results/texts-sheets-dialogs/, which git ignores, or to
 * ZENITH_E2E_SHOTS when set.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";
import { LAYOUT_SIZES } from "./viewports";

const SHOTS = (process.env["ZENITH_E2E_SHOTS"] ?? fileURLToPath(new URL("../test-results/texts-sheets-dialogs/", import.meta.url))).replace(
  /\/?$/,
  "/",
);

for (const size of LAYOUT_SIZES) {
  const tag = `${String(size.width)}x${String(size.height)}`;

  test.describe(`at ${tag}`, () => {
    test.use({ viewport: size });

    /** A screenshot, and the visible words of `area`, named for the sheet. */
    async function record(page: Page, area: Locator, name: string): Promise<void> {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: `${SHOTS}${tag}-${name}.png` });
      writeFileSync(`${SHOTS}${tag}-${name}.txt`, await area.innerText());
    }

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

    test("the sign-in, Teams, Library and Outbox sheets and Settings, Account explain nothing inline", async ({ page }) => {
      await start(page);
      await page.getByTestId("toolbar-sign-in").click();
      const signIn = page.getByTestId("signin-sheet");
      await expect(signIn.getByTestId("signin-providers")).toBeVisible();
      await expect(signIn).not.toContainText("Choose how to sign in");
      await expect(signIn.getByTestId("signin-terms")).toContainText("13 or older");
      await record(page, signIn, "signin");

      await signIn.getByTestId("signin-github").click();
      await expect(signIn.getByTestId("signin-profile")).toBeVisible();
      await expect(signIn).not.toContainText("Your teammates see this name");
      await record(page, signIn, "signin-profile");
      await signIn.getByTestId("signin-display-name").fill("Ada");
      await signIn.getByTestId("signin-display-name-save").click();

      const teams = page.getByTestId("teams-sheet");
      await expect(teams.getByTestId("teams-create")).toBeVisible();
      await expect(teams).not.toContainText("no adult is needed");
      await record(page, teams, "teams-create");
      await teams.getByTestId("teams-create-number").fill("36596");
      await teams.getByTestId("teams-create-name").fill("Horizon");
      await teams.getByTestId("teams-create-submit").click();
      await teams.getByTestId("recovery-code-saved").check();
      await teams.getByTestId("recovery-code-continue").click();
      await expect(teams.getByTestId("teams-my-role")).toHaveText("Owner");
      await expect(teams).not.toContainText("A coach or mentor makes a good admin");
      await expect(teams).not.toContainText("newest first");
      await record(page, teams, "teams");

      // The device list's reason is a hover on its heading now, not a paragraph under it.
      const devices = teams.getByTestId("team-devices");
      await expect(devices).toBeVisible();
      await expect(devices).not.toContainText("A new device gets the key only when");
      await devices.getByRole("heading").hover();
      await expect(page.getByRole("tooltip")).toContainText("A new device gets the key only when");
      // Making a new recovery code says when to, and that the old one stops, on its button's hover.
      await teams.getByTestId("team-codes-open").click();
      await teams.getByTestId("team-recovery-new").hover();
      await expect(page.getByRole("tooltip")).toContainText("The old code stops working.");

      await page.getByTestId("toolbar-account.library").click();
      const library = page.getByTestId("library-sheet");
      await expect(library.getByTestId("library-empty")).toContainText("No autos in the library yet");
      await record(page, library, "library");

      await page.getByTestId("toolbar-account.outbox").click();
      const outbox = page.getByTestId("outbox-sheet");
      await expect(outbox).not.toContainText("This list is kept until the page is closed");
      await record(page, outbox, "outbox");

      await page.getByTestId("toolbar-account").click();
      const settings = page.getByTestId("settings");
      await expect(settings.getByTestId("settings-sign-out")).not.toContainText("offline copy");
      await settings.getByTestId("account-sign-out").hover();
      await expect(page.getByRole("tooltip")).toContainText("clears the team library's offline copy");
      await record(page, settings, "settings-account");
    });

    test("the share dialog and the Sharing page keep their warnings and move their explanations into tooltips", async ({ page }) => {
      await start(page);
      await page.getByTestId("toolbar-sign-in").click();
      await page.getByTestId("signin-sheet").getByTestId("signin-github").click();
      await page.getByTestId("signin-sheet").getByTestId("signin-display-name").fill("Ada");
      await page.getByTestId("signin-sheet").getByTestId("signin-display-name-save").click();
      const teams = page.getByTestId("teams-sheet");
      await teams.getByTestId("teams-create-number").fill("36596");
      await teams.getByTestId("teams-create-name").fill("Horizon");
      await teams.getByTestId("teams-create-submit").click();
      await teams.getByTestId("recovery-code-saved").check();
      await teams.getByTestId("recovery-code-continue").click();
      await teams.getByTestId("teams-sheet-close").click();

      await page.getByTestId("toolbar-share.open").click();
      const share = page.getByTestId("share-sheet");
      const first = share.getByTestId("share-publish-first");
      await expect(first).toContainText("Publish this auto to your team library first.");
      await expect(first).not.toContainText("A share shows one published version");
      await share.getByTestId("share-publish").hover();
      await expect(page.getByRole("tooltip")).toContainText("Adds a revision to the team library");
      await record(page, share, "share-publish-first");
      await share.getByTestId("share-publish").click();
      await expect(first).toHaveCount(0);

      await expect(share.getByTestId("share-include-commands-help")).toHaveCount(0);
      await expect(share).not.toContainText("What they see still shows how fast your robot drives");
      await share.getByTestId("share-more-options").click();
      await share.getByTestId("share-include-commands").hover();
      await expect(page.getByRole("tooltip")).toContainText("commands show as stand-ins");
      await share.getByTestId("share-see-as-they-will").click();
      await expect(share.getByTestId("share-preview")).not.toContainText("This is exactly what will be sent");
      await expect(share.getByTestId("share-preview")).not.toContainText("An envelope is the area a step promises");
      await record(page, share, "share");

      await share.getByTestId("share-audience-link").click();
      await expect(share).not.toContainText("The link is the only way in");
      await record(page, share, "share-link");
      await page.getByTestId("share-sheet-close").click();
      await page.getByTestId("toolbar-share.page").click();
      const sharing = page.getByTestId("sharing-page");
      await expect(sharing).not.toContainText("Every share and invite");
      await expect(sharing.getByTestId("sharing-no-shares")).toHaveText("Nothing is shared outside the team.");
      await expect(sharing.getByTestId("sharing-no-invites")).toHaveText("No invites.");
      await record(page, sharing, "sharing");
    });

    test("the admin page and the report dialog say state and warnings only", async ({ page }) => {
      await page.addInitScript(() => {
        if (window.localStorage.getItem("zenith.ui") === null) {
          window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
        }
        window.localStorage.removeItem("zenith.cloudFake");
      });
      await turnOnFeatures(page);
      await page.goto("/?cloud=fake#/admin");
      await page.getByTestId("toolbar-sign-in").click();
      await page.getByTestId("signin-sheet").getByTestId("fake-demo-reviewer").click();
      await page.getByTestId("teams-sheet-close").click();
      await page.evaluate(() => {
        window.location.hash = "#/admin";
      });
      const admin = page.getByTestId("admin-page");
      await expect(admin.getByTestId("admin-queue")).toBeVisible();
      await expect(admin).not.toContainText("Open an item from the queue to review it");
      await record(page, admin, "admin-queue");

      await admin.getByTestId("admin-queue-request-fakeRequestHorizonXXXX").click();
      await expect(admin.getByTestId("admin-request")).not.toContainText("Check an event result against");
      await record(page, admin, "admin-request");

      for (const [view, absent] of [
        ["shares", "Live, expired and revoked, newest first"],
        ["beta", "Paste the user code the person sent you"],
        ["reports", "Newest first. Only Horizon admins can read these"],
      ] as const) {
        const tab = admin.getByTestId(`admin-view-${view}`);
        await expect(tab).toBeVisible();
        await tab.click();
        await expect(admin).not.toContainText(absent);
        await record(page, admin, `admin-${view}`);
      }

      await page.getByTestId("toolbar-help").click();
      await page.getByTestId("help-menu").getByTestId("menu-help.reportBug").click();
      const report = page.getByTestId("report-bug");
      await expect(report).toBeVisible();
      await expect(report.getByTestId("report-bug-where")).toContainText("goes privately to Horizon");
      await expect(report).not.toContainText("Collected by the app so Horizon can reproduce the bug");
      await record(page, report, "report-bug");
    });

    test("the Open project and Save dialogs say what they do in one line, without teaching", async ({ page }) => {
      await page.addInitScript(() => {
        window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
      });
      await page.goto("/");
      await page.getByTestId("canvas-open-other").click();
      const open = page.getByTestId("open-project");
      await expect(open).toBeVisible();
      await expect(open).not.toContainText("A blank auto for this robot");
      await expect(open).not.toContainText("A folder without one offers Set up");
      await record(page, open, "open-project");

      await open.getByRole("tab", { name: "GitHub" }).click();
      await expect(open).not.toContainText("Nothing is fetched until you do");
      await record(page, open, "open-project-github");
      await open.getByTestId("github-open-signin").click();
      const github = page.getByTestId("github-signin");
      await expect(github).toBeVisible();
      await expect(github).not.toContainText("There is no OAuth app to authorise");
      await record(page, github, "github-signin");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");

      await page.getByTestId("canvas-load-example").click();
      await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
      await page.keyboard.press("Control+s");
      const choice = page.getByTestId("save-choice");
      await expect(choice).toBeVisible();
      await expect(choice).not.toContainText("to try Zenith out");
      await record(page, choice, "save-choice");
    });
  });
}
