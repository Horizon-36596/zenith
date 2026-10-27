/**
 * The Horizon admins' review page at `#/admin` (spec 13 section 4.4, M-C7), against the in-memory
 * fake cloud (`?cloud=fake`), which the account signs in to: the fake's demonstration reviewer brings
 * the demonstration data of src/admin/fakeVerification.ts with them. The queue lists an appeal, a
 * dispute and a request; a decision needs a one-sentence reason; and the page is not modal. Anyone
 * who is not a signed-in Horizon admin sees nothing of the page: `#/admin` opens nothing and leaves
 * the address (issue #99). With the cloud off there is no review page at all (cloud-off.spec.ts).
 * The All shares view lists two teams' shares by their settings and filters them, and offers no way
 * to see what a share shows. The Beta access view adds testers by the user code they send; nobody
 * can ask for access from the app.
 */
import { expect, test, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";

async function start(page: Page, query: string): Promise<void> {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
    }
    window.localStorage.removeItem("zenith.cloudFake");
  });
  await turnOnFeatures(page);
  await page.goto(`/${query}#/admin`);
}

/** Puts `#/admin` in the address on the page already open, as typing it or a bookmark would. */
async function openAdminAddress(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = "#/admin";
  });
}

/** Signs in as the fake's demonstration reviewer, a Horizon admin in no team, and closes the Teams sheet. */
async function signInAsReviewer(page: Page): Promise<void> {
  await page.getByTestId("toolbar-sign-in").click();
  await page.getByTestId("signin-sheet").getByTestId("fake-demo-reviewer").click();
  await expect(page.getByTestId("toolbar-account")).toContainText("Demonstration reviewer");
  // The reviewer is in no team, so the Teams sheet opens by itself; close it.
  await page.getByTestId("teams-sheet-close").click();
}

test("a reviewer works the queue with a one-sentence reason for each decision", async ({ page }) => {
  await start(page, "?cloud=fake");
  const admin = page.getByTestId("admin-page");
  // Signed out, the address opens nothing.
  await expect.poll(() => new URL(page.url()).hash).toBe("");
  await expect(admin).toHaveCount(0);

  await signInAsReviewer(page);
  await openAdminAddress(page);
  const queue = admin.getByTestId("admin-queue");
  await expect(queue.getByRole("button")).toHaveCount(3);

  await queue.getByTestId("admin-queue-request-fakeRequestHorizonXXXX").click();
  const request = admin.getByTestId("admin-request");
  await expect(request.getByTestId("admin-claim-code")).toHaveText("Z-33333-FAKE");
  const evidence = request.getByTestId("admin-request-evidence");
  // A team's pasted address is shown as text with a Copy button, never as a link (spec 13 section 13).
  await expect(evidence.getByTestId("evidence-address")).toHaveText("https://example.org/zenith-demo/robot.jpg");
  await expect(evidence.getByRole("link")).toHaveCount(0);
  await expect(evidence.getByTestId("evidence-copy")).toBeVisible();
  const decide = request.getByTestId("admin-decide");
  await expect(decide).toHaveAttribute("aria-disabled", "true");
  await request.getByTestId("admin-verdict-verified").click();
  await request.getByTestId("admin-reason").fill("Two sentences. Not one.");
  await expect(decide).toHaveAttribute("aria-disabled", "true");
  await request.getByTestId("admin-reason").fill("The photo shows the claim code on the robot.");
  await expect(decide).toHaveAttribute("aria-disabled", "false");
  await decide.click();
  await expect(admin.getByTestId("admin-notice")).toHaveText("Verified 33333.");
  await expect(queue.getByRole("button")).toHaveCount(2);

  await queue.getByTestId("admin-queue-appeal-fakeDisputeAppealedXXX").click();
  await expect(admin.getByTestId("admin-appeal-reason")).toContainText("Our banner photo shows the number.");
  // The fake's one reviewer made the first decision and may decide the appeal too, with a plain note.
  await expect(admin.getByTestId("admin-reviewer-note")).toHaveText("You made the first decision. Your appeal decision is recorded with your name too.");

  // Not modal: the editor keeps working while the page is open, and Escape inside it closes it.
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await expect(admin).toBeVisible();
  await admin.getByTestId("admin-reason").focus();
  await page.keyboard.press("Escape");
  await expect(admin).toHaveCount(0);
  expect(new URL(page.url()).hash).toBe("");
});

test("opening another item starts its decision afresh, not with the last item's reason", async ({ page }) => {
  await start(page, "?cloud=fake");
  await signInAsReviewer(page);
  await openAdminAddress(page);
  const admin = page.getByTestId("admin-page");
  const queue = admin.getByTestId("admin-queue");
  await queue.getByTestId("admin-queue-dispute-fakeDisputeOpenXXXXXXX").click();
  await expect(admin.getByTestId("admin-dispute")).toBeVisible();
  await admin.getByTestId("admin-reason").fill("The banner photo shows the number.");
  // Straight to the appeal, with no other page between: its form is empty.
  await queue.getByTestId("admin-queue-appeal-fakeDisputeAppealedXXX").click();
  await expect(admin.getByTestId("admin-appeal-reason")).toBeVisible();
  await expect(admin.getByTestId("admin-reason")).toHaveValue("");
});

test("signed out, #/admin opens nothing and quietly leaves the address", async ({ page }) => {
  await start(page, "?cloud=fake");
  await expect.poll(() => new URL(page.url()).hash).toBe("");
  await expect(page.getByTestId("admin-page")).toHaveCount(0);
  await expect(page.getByText("Only Horizon admins")).toHaveCount(0);
  // The editor is as it always is.
  await expect(page.getByTestId("toolbar-sign-in")).toBeVisible();
});

test("a signed-in account that is not an admin sees nothing of the admin page at #/admin", async ({ page }) => {
  await start(page, "?cloud=fake");
  await signIn(page, "github", "Ada");
  await expect(page.getByTestId("toolbar-account")).toContainText("Ada");
  await openAdminAddress(page);
  await expect.poll(() => new URL(page.url()).hash).toBe("");
  await expect(page.getByTestId("admin-page")).toHaveCount(0);
  await expect(page.getByTestId("admin-queue")).toHaveCount(0);
  await expect(page.getByText("Only Horizon admins")).toHaveCount(0);
});

test("an admin opens #/admin, and signing out beside the page closes it", async ({ page }) => {
  await start(page, "?cloud=fake");
  await signInAsReviewer(page);
  await openAdminAddress(page);
  const admin = page.getByTestId("admin-page");
  await expect(admin.getByTestId("admin-queue")).toBeVisible();
  await page.getByTestId("toolbar-account").click();
  await page.getByTestId("settings").getByTestId("account-sign-out").click();
  await expect(page.getByTestId("toolbar-sign-in")).toBeVisible();
  await expect(admin).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).hash).toBe("");
});

/** A provider and a display name, as in the sharing tests. */
async function signIn(page: Page, provider: "github" | "google", name: string): Promise<void> {
  await page.getByTestId("toolbar-sign-in").click();
  const sheet = page.getByTestId("signin-sheet");
  await sheet.getByTestId(`signin-${provider}`).click();
  await sheet.getByTestId("signin-display-name").fill(name);
  await sheet.getByTestId("signin-display-name-save").click();
}

/** Creates a team from the Teams sheet, which opens by itself for someone with none, and closes it. */
async function createTeam(page: Page, number: number, name: string): Promise<void> {
  const teams = page.getByTestId("teams-sheet");
  await teams.getByTestId("teams-create-number").fill(String(number));
  await teams.getByTestId("teams-create-name").fill(name);
  await teams.getByTestId("teams-create-submit").click();
  // The recovery code comes first, once: tick that it is saved to continue.
  await teams.getByTestId("recovery-code-saved").check();
  await teams.getByTestId("recovery-code-continue").click();
  await expect(teams.getByTestId("teams-my-role")).toHaveText("Owner");
  await page.getByTestId("teams-sheet-close").click();
}

/** Opens the share dialog and publishes the open auto to the team library, which a share needs. */
async function openShareAndPublish(page: Page): Promise<ReturnType<Page["getByTestId"]>> {
  await page.getByTestId("toolbar-share.open").click();
  const sheet = page.getByTestId("share-sheet");
  await expect(sheet).toBeVisible();
  await sheet.getByTestId("share-publish").click();
  await expect(sheet.getByTestId("share-publish-first")).toHaveCount(0);
  return sheet;
}

test("All shares lists every team's shares by their settings, filters them, and never shows one", async ({ page }) => {
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

  // Grace's team shares the example with anyone who has the link.
  await signIn(page, "google", "Grace");
  await createTeam(page, 12345, "Partner team");
  let sheet = await openShareAndPublish(page);
  await sheet.getByTestId("share-audience-link").click();
  await sheet.getByTestId("share-submit").click();
  await sheet.getByTestId("share-confirm-link").click();
  await expect(sheet.getByTestId("share-link")).toBeVisible();
  await sheet.getByTestId("share-done").click();
  await page.getByTestId("toolbar-account").click();
  await page.getByTestId("settings").getByTestId("account-sign-out").click();
  await expect(page.getByTestId("toolbar-sign-in")).toBeVisible();

  // Ada's team shares it with Grace's team.
  await signIn(page, "github", "Ada");
  await createTeam(page, 23456, "Second team");
  sheet = await openShareAndPublish(page);
  await sheet.getByTestId("share-team-input").fill("12345");
  await sheet.getByTestId("share-team-input").press("Enter");
  await sheet.getByTestId("share-submit").click();
  // The first share with a team shows its safety code, and one click shares.
  await sheet.getByTestId("first-share-code").getByTestId("first-share-code-share").click();
  await expect(sheet.getByTestId("share-done")).toBeVisible();
  await sheet.getByTestId("share-done").click();

  // The demonstration reviewer, a Horizon admin in neither team, opens All shares.
  await page.getByTestId("toolbar-account").click();
  await page.getByTestId("settings-nav-developer").click();
  await page.getByTestId("settings").getByTestId("fake-demo-reviewer").click();
  await expect(page.getByTestId("toolbar-account")).toContainText("Demonstration reviewer");
  // The reviewer is in no team, so the Teams sheet opens by itself; close it.
  await page.getByTestId("teams-sheet-close").click();
  // The Admin section of Settings opens the admin page, and Settings makes way for it.
  await page.getByTestId("toolbar-account").click();
  await page.getByTestId("settings-nav-admin").click();
  await page.getByTestId("settings").getByTestId("account-admin-dashboard").click();
  await expect(page).toHaveURL(/#\/admin$/);
  await expect(page.getByTestId("settings")).toHaveCount(0);
  const admin = page.getByTestId("admin-page");
  await expect(admin.getByTestId("admin-queue")).toBeVisible();
  await admin.getByTestId("admin-view-shares").click();
  await expect(admin.getByRole("heading", { name: "All shares" })).toBeVisible();

  const rows = admin.getByTestId("admin-shares").locator(":scope > li");
  await expect(rows).toHaveCount(2);
  await expect(admin.getByTestId("admin-shares-count")).toHaveText("2 shares");
  // Newest first: Ada's share to Grace's team, then Grace's link.
  await expect(rows.nth(0).getByTestId("admin-share-owner")).toHaveText("23456 Second team");
  await expect(rows.nth(0).getByTestId("admin-share-audience")).toHaveText("Team 12345 Partner team");
  await expect(rows.nth(1).getByTestId("admin-share-owner")).toHaveText("12345 Partner team");
  await expect(rows.nth(1).getByTestId("admin-share-audience")).toHaveText("Anyone with the link");
  for (const index of [0, 1]) {
    await expect(rows.nth(index)).toHaveAttribute("data-status", "live");
    await expect(rows.nth(index)).toContainText("Unverified");
    await expect(rows.nth(index)).toContainText("View only");
    await expect(rows.nth(index)).toContainText("Pinned to revision 1");
    await expect(rows.nth(index)).toContainText("Ends");
    await expect(rows.nth(index).getByTestId("admin-share-id")).toHaveText(/^Share [A-Za-z0-9_-]{6}$/);
    await expect(rows.nth(index).getByTestId("admin-share-level")).toHaveText("View only");
    await expect(rows.nth(index).getByTestId("admin-share-version")).toHaveText("Pinned to revision 1");
    await expect(rows.nth(index).getByTestId("admin-share-expiry")).not.toBeEmpty();
    await expect(rows.nth(index).getByTestId("admin-share-status")).toHaveText("Live");
  }

  // The filters: who a share is for, its status, and a search over team numbers and names.
  await admin.getByTestId("admin-shares-audience-link").click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first().getByTestId("admin-share-owner")).toHaveText("12345 Partner team");
  await expect(admin.getByTestId("admin-shares-count")).toHaveText("1 of 2 shares");
  await admin.getByTestId("admin-shares-audience-all").click();
  await admin.getByTestId("admin-shares-status-revoked").click();
  await expect(admin.getByTestId("admin-shares-empty")).toHaveText("No share matches these filters.");
  await admin.getByTestId("admin-shares-status-live").click();
  await expect(rows).toHaveCount(2);
  await admin.getByTestId("admin-shares-search").fill("second TEAM");
  await expect(rows).toHaveCount(1);
  await expect(rows.first().getByTestId("admin-share-owner")).toHaveText("23456 Second team");
  await admin.getByTestId("admin-shares-search").fill("12345");
  await expect(rows).toHaveCount(2);
  await admin.getByTestId("admin-shares-search").fill("");

  // No preview: nothing on the page shows what a share shows, and nothing offers to.
  await expect(admin.getByRole("button", { name: /preview/i })).toHaveCount(0);
  await expect(admin.locator('[data-testid^="admin-share-preview"]')).toHaveCount(0);
  await expect(admin.getByTestId("admin-share-open")).toHaveCount(0);
  await expect(admin.getByTestId("share-projection")).toHaveCount(0);
  await expect(admin.getByTestId("share-preview-field")).toHaveCount(0);
  await expect(admin).not.toContainText("Collect and score");
  await expect(admin.getByTestId("admin-shares-note")).toContainText("never for Horizon admins");

  // Back as another user, the reviewer is listed once, as its own button, not again among the users
  // to switch to.
  await page.evaluate(() => {
    window.location.hash = "";
  });
  await page.getByTestId("toolbar-account").click();
  await expect(page.getByTestId("settings-nav-admin")).toBeVisible();
  await page.getByTestId("settings-nav-developer").click();
  const users = page.getByTestId("settings").getByTestId("fake-users");
  await users.locator('[data-testid^="fake-switch-"]').first().click();
  await expect(page.getByTestId("toolbar-account")).not.toContainText("Demonstration reviewer");
  // Someone who is not a Horizon admin is never offered the admin page.
  await expect(page.getByTestId("settings-nav-admin")).toHaveCount(0);
  await expect(page.getByTestId("settings").getByTestId("account-admin-dashboard")).toHaveCount(0);
  await expect(users.getByText("Demonstration reviewer")).toHaveCount(1);
  await expect(users.getByTestId("fake-switch-fake-reviewer")).toHaveCount(0);
});

test("a person sends their user code, a Horizon admin adds it, and the person carries on", async ({ page }) => {
  // The development fake with the private beta closed, as a real project starts.
  await start(page, "?cloud=fake&beta=closed");
  const admin = page.getByTestId("admin-page");
  await expect.poll(() => new URL(page.url()).hash).toBe("");

  // Not on the list: the private-beta screen shows the user code to send, and asks nothing.
  await page.getByTestId("toolbar-sign-in").click();
  const signIn = page.getByTestId("signin-sheet");
  await signIn.getByTestId("signin-github").click();
  const beta = signIn.getByTestId("signin-beta");
  await expect(beta).toBeVisible();
  await expect(beta.getByTestId("signin-beta-code")).toHaveValue("memory-github-user");
  await expect(beta.getByTestId("signin-beta-copy")).toBeVisible();
  await expect(beta.getByTestId("signin-beta-send-code")).toHaveText(
    "Send your user code to a Horizon (FTC 36596) admin, then press Check again.",
  );
  await expect(beta.getByRole("textbox", { name: "Your name" })).toHaveCount(0);
  await expect(beta.getByText(/ask for access/i)).toHaveCount(0);
  await expect(beta.locator('[data-testid="signin-beta-ask"], [data-testid="signin-beta-name"]')).toHaveCount(0);
  await beta.getByTestId("signin-beta-check").click();
  await expect(signIn).toContainText("This account is still not on the beta list.");
  // Nor can a person who is not an admin reach the admin page to add themselves.
  await openAdminAddress(page);
  await expect.poll(() => new URL(page.url()).hash).toBe("");
  await expect(admin).toHaveCount(0);
  await beta.getByTestId("signin-beta-sign-out").click();
  await expect(page.getByTestId("toolbar-sign-in")).toBeVisible();

  // The demonstration reviewer adds the code from the Beta access view, which lists no requests.
  await signInAsReviewer(page);
  await openAdminAddress(page);
  await admin.getByTestId("admin-view-beta").click();
  await expect(admin.getByRole("heading", { name: "Beta access" })).toBeVisible();
  await expect(admin.getByTestId("admin-beta-testers")).toBeVisible();
  await expect(admin.locator('[data-testid^="admin-beta-request"]')).toHaveCount(0);
  await expect(admin).not.toContainText("Waiting for access");
  // The reviewer cannot remove themselves.
  await expect(admin.getByTestId("admin-beta-remove-admin-fake-reviewer")).toHaveAttribute("aria-disabled", "true");
  await admin.getByTestId("admin-beta-add-code").fill("memory-github-user");
  await admin.getByTestId("admin-beta-add-name").fill("Ada Lovelace");
  await admin.getByTestId("admin-beta-add-tester").click();
  await expect(admin.getByTestId("admin-notice")).toHaveText("Added Ada Lovelace to the beta list.");
  await expect(admin.getByTestId("admin-beta-tester-memory-github-user")).toContainText("Ada Lovelace");
  await page.getByTestId("toolbar-account").click();
  await page.getByTestId("settings").getByTestId("account-sign-out").click();
  await expect(page.getByTestId("toolbar-sign-in")).toBeVisible();

  // Signing in again, the person is on the list and makes their profile.
  await page.getByTestId("toolbar-sign-in").click();
  await signIn.getByTestId("signin-github").click();
  await expect(signIn.getByTestId("signin-display-name")).toBeVisible();
  await expect(signIn.getByTestId("signin-beta")).toHaveCount(0);
});
