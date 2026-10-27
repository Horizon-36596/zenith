/**
 * Accounts, teams and the team library (spec 13 sections 4, 5, 6 and 12.1)
 * against the in-memory fake cloud, `?cloud=fake`: signing in with no age screen, creating a team,
 * inviting, publishing a revision and seeing it in the Library, then a second person joining through
 * the invite link on the same page. Screenshots go to test-results/, which git ignores.
 */
import { expect, test, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";

const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/account-${name}.png` });

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

test("the cloud controls stay hidden without ?cloud=fake or a Firebase config", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("toolbar")).toBeVisible();
  await expect(page.getByTestId("account-toolbar")).toHaveCount(0);
  await expect(page.getByTestId("signin-sheet")).toHaveCount(0);
});

test("sign in, create a team, invite, publish, see the revision, and join by link", async ({ page }) => {
  await page.goto("/?cloud=fake");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();

  // Nothing asks at start-up: the sheet opens only from the toolbar.
  await expect(page.getByTestId("signin-sheet")).toHaveCount(0);
  await page.getByTestId("toolbar-sign-in").click();
  const sheet = page.getByTestId("signin-sheet");
  // No age screen (owner ruling 2026-10-02): the ways in come first, with what the Terms ask.
  await expect(sheet.getByTestId("signin-providers")).toBeVisible();
  await expect(sheet.getByTestId("signin-terms")).toContainText("13 or older, or use a school account your school approved");
  await expect(sheet.getByTestId("signin-terms-link")).toHaveAttribute("href", /\/terms\//);
  await expect(sheet.getByTestId("age-screen")).toHaveCount(0);

  // The app keeps working while the sheet is open: it is not modal.
  await page.getByTestId("step-row-driveOut").getByRole("button").first().click();
  await expect(sheet).toBeVisible();

  await expect(sheet.getByTestId("signin-providers")).toBeVisible();
  await expect(sheet.getByTestId("school-guide-link")).toHaveAttribute("href", /school-admin-guide/);
  await shot(page, "2-providers");

  await sheet.getByTestId("signin-github").click();
  await sheet.getByTestId("signin-display-name").fill("Ada");
  await sheet.getByTestId("signin-display-name-save").click();

  // No team yet: the Teams sheet opens on Create a team.
  const teams = page.getByTestId("teams-sheet");
  await expect(teams.getByTestId("teams-create")).toBeVisible();
  await teams.getByTestId("teams-create-number").fill("36596");
  await teams.getByTestId("teams-create-name").fill("Horizon");
  await teams.getByTestId("teams-create-submit").click();
  // The recovery code comes first, once: tick that it is saved to continue.
  await teams.getByTestId("recovery-code-saved").check();
  await teams.getByTestId("recovery-code-continue").click();
  await expect(teams.getByTestId("teams-status")).toHaveText("Unverified");
  await expect(teams.getByTestId("teams-my-role")).toHaveText("Owner");
  await expect(page.getByTestId("toolbar-account")).toContainText("Ada");
  // The owner's own row shows the role once, in its select, and Leave team says beside it why it
  // cannot be pressed, not only on hover.
  const me = teams.locator('li[data-role="owner"]');
  await expect(me.locator("select")).toHaveValue("owner");
  await expect(me.getByText("Owner", { exact: true }).and(page.locator(":not(option)"))).toHaveCount(0);
  await expect(teams.getByTestId("teams-leave")).toHaveAttribute("aria-disabled", "true");
  await expect(teams.getByTestId("teams-leave-why")).toHaveText(
    "An owner cannot leave. Make another member an owner, and ask them to change your role first.",
  );

  // The team's Verification section runs on the same backend as the account.
  const verification = teams.getByTestId("verification-section");
  await expect(verification).toBeVisible();
  await expect(verification).toContainText("36596");

  // An editor invite for 7 days, the default, waiting for approval.
  await expect(teams.getByTestId("invite-expiry-7")).toHaveAttribute("aria-pressed", "true");
  await expect(teams.getByTestId("invite-expiry")).not.toContainText(/season/i);
  await teams.getByTestId("invite-create").click();
  const link = await teams.getByTestId("invite-link-text").textContent();
  expect(link).toMatch(/#\/join\/[A-Za-z0-9_-]{22}$/);
  await expect(teams.getByTestId("invites-list").locator('[data-state="live"]')).toHaveCount(1);
  await expect(teams.getByTestId("invites-list")).toContainText("7 days left");
  await shot(page, "3-team-and-invite");

  // Publish the open auto, and see revision 1 in the Library.
  await page.getByTestId("toolbar-account.library").click();
  const library = page.getByTestId("library-sheet");
  await expect(library.getByTestId("library-empty")).toBeVisible();
  await library.getByTestId("library-publish").click();
  await expect(library.getByTestId("revision-collect-and-score-1")).toBeVisible();
  await expect(library.getByTestId("revision-collect-and-score-1")).toContainText("Ada");
  await shot(page, "4-library-revision");

  // Offline: the badge shows, and the outbox lists what was sent.
  await page.getByTestId("toolbar-account.outbox").click();
  const outbox = page.getByTestId("outbox-sheet");
  await outbox.getByTestId("outbox-show-sent").check();
  await expect(outbox.getByTestId("outbox-list").locator('[data-state="sent"]').first()).toBeVisible();
  await outbox.getByTestId("outbox-fake-online").click();
  await expect(page.getByTestId("offline-badge")).toBeVisible();
  await expect(outbox.getByTestId("outbox-summary")).toContainText("Offline");
  await shot(page, "5-outbox-offline");
  await outbox.getByTestId("outbox-fake-online").click();
  await expect(page.getByTestId("offline-badge")).toHaveCount(0);

  // Ada signs out; Grace opens the invite link on the same page and asks to join.
  await page.getByTestId("toolbar-account").click();
  await page.getByTestId("settings").getByTestId("account-sign-out").click();
  await expect(page.getByTestId("toolbar-sign-in")).toBeVisible();
  await page.evaluate(
    (hash) => {
      window.location.hash = hash;
    },
    new URL(link ?? "").hash,
  );
  const join = page.getByTestId("signin-sheet");
  await expect(join.getByTestId("signin-providers")).toBeVisible();
  await join.getByTestId("signin-google").click();
  await join.getByTestId("signin-display-name").fill("Grace");
  await join.getByTestId("signin-display-name-save").click();
  await expect(join.getByTestId("join-step")).toContainText("36596 Horizon");
  await expect(join.getByTestId("join-status")).toHaveText("Unverified");
  await join.getByTestId("join-submit").click();
  await expect(join.getByTestId("join-done")).toContainText("asked to join");
  await shot(page, "6-joined-pending");

});

/** A provider and a display name, in the sheet that is open. */
async function signInAs(page: Page, provider: "github" | "google", name: string): Promise<void> {
  const sheet = page.getByTestId("signin-sheet");
  await sheet.getByTestId(`signin-${provider}`).click();
  await sheet.getByTestId("signin-display-name").fill(name);
  await sheet.getByTestId("signin-display-name-save").click();
}

test("an editor's Sharing page says who sees invites, and Leave team asks first", async ({ page }) => {
  await page.goto("/?cloud=fake");
  await page.getByTestId("canvas-load-example").click();
  await page.getByTestId("toolbar-sign-in").click();
  await signInAs(page, "github", "Ada");
  const teams = page.getByTestId("teams-sheet");
  await teams.getByTestId("teams-create-number").fill("36596");
  await teams.getByTestId("teams-create-name").fill("Horizon");
  await teams.getByTestId("teams-create-submit").click();
  // The recovery code comes first, once: tick that it is saved to continue.
  await teams.getByTestId("recovery-code-saved").check();
  await teams.getByTestId("recovery-code-continue").click();
  await expect(teams.getByTestId("teams-my-role")).toHaveText("Owner");
  await teams.getByTestId("invite-auto-approve").check();
  await teams.getByTestId("invite-create").click();
  const link = await teams.getByTestId("invite-link-text").textContent();

  await page.getByTestId("toolbar-account").click();
  await page.getByTestId("settings").getByTestId("account-sign-out").click();
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, new URL(link ?? "").hash);
  await signInAs(page, "google", "Grace");
  const join = page.getByTestId("signin-sheet");
  await join.getByTestId("join-submit").click();
  await join.getByTestId("join-finish").click();

  // The team has an invite, which only owners and admins can read: the editor is told so.
  await page.getByTestId("toolbar-share.page").click();
  const sharing = page.getByTestId("sharing-page");
  await expect(sharing.getByTestId("sharing-no-invites")).toHaveText(
    "Only owners and admins see the invites.",
  );
  await expect(sharing.getByTestId("sharing-no-shares")).toHaveText("Nothing is shared outside the team.");
  await page.getByTestId("sharing-page-close").click();
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Teams");
  await page.getByTestId("palette-item-account.teams").click();

  await teams.getByTestId("teams-leave").click();
  const confirm = teams.getByTestId("teams-leave-confirm");
  await expect(confirm).toContainText("Leave Horizon? You lose access to its library at once");
  // The one confirm row: Cancel on the left, the verb as the primary on the right, Cancel focused.
  await expect(confirm.getByRole("button")).toHaveText(["Cancel", "Leave team"]);
  await expect(confirm.getByTestId("teams-leave-keep")).toBeFocused();
  await confirm.getByTestId("teams-leave-keep").click();
  await expect(confirm).toHaveCount(0);
  await expect(teams.getByTestId("teams-my-role")).toHaveText("Editor");

  await teams.getByTestId("teams-leave").click();
  await teams.getByTestId("teams-leave-confirm").getByTestId("teams-leave-yes").click();
  await expect(teams).toContainText("Left the team.");
  await expect(teams).toContainText("You are not in a team yet.");
});

test("an invite is headed by its kind, and once used up it no longer offers Extend", async ({ page }) => {
  await page.goto("/?cloud=fake");
  await page.getByTestId("canvas-load-example").click();
  await page.getByTestId("toolbar-sign-in").click();
  await signInAs(page, "github", "Ada");
  const teams = page.getByTestId("teams-sheet");
  await teams.getByTestId("teams-create-number").fill("36596");
  await teams.getByTestId("teams-create-name").fill("Horizon");
  await teams.getByTestId("teams-create-submit").click();
  await teams.getByTestId("recovery-code-saved").check();
  await teams.getByTestId("recovery-code-continue").click();
  await teams.getByTestId("invite-auto-approve").check();
  await teams.getByTestId("invite-create").click();
  const link = await teams.getByTestId("invite-link-text").textContent();
  const code = new URL(link ?? "").hash.replace("#/join/", "");

  // A live invite: headed "Editor invite" on the Sharing page, with its code under it, and Extend.
  await teams.getByTestId("teams-sheet-close").click();
  await page.getByTestId("toolbar-share.page").click();
  const sharing = page.getByTestId("sharing-page");
  const row = sharing.getByTestId(`invite-row-${code}`);
  await expect(row.getByTestId(`invite-row-${code}-kind`)).toHaveText("Editor invite");
  await expect(row.getByTestId(`invite-row-${code}-code`)).toHaveText(code);
  await expect(row.getByTestId(`invite-row-${code}-extend`)).toHaveAttribute("aria-disabled", "false");
  await page.getByTestId("sharing-page-close").click();

  // Grace takes its one use.
  await page.getByTestId("toolbar-account").click();
  await page.getByTestId("settings").getByTestId("account-sign-out").click();
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, new URL(link ?? "").hash);
  await signInAs(page, "google", "Grace");
  const join = page.getByTestId("signin-sheet");
  await join.getByTestId("join-submit").click();
  await join.getByTestId("join-finish").click();

  // Back as Ada, the used-up invite offers no more time, on the Sharing page or in the Teams sheet.
  await page.getByTestId("toolbar-account").click();
  await page.getByTestId("settings-nav-developer").click();
  await page.getByTestId("settings").getByTestId("fake-switch-memory-github-user").click();
  await expect(page.getByTestId("toolbar-account")).toContainText("Ada");
  await page.getByTestId("settings-close").click();
  await page.getByTestId("toolbar-share.page").click();
  await expect(row.getByTestId(`invite-row-${code}-kind`)).toHaveText("Editor invite");
  await expect(row).toContainText("1 of 1 used");
  await expect(row.getByTestId(`invite-row-${code}-extend`)).toHaveAttribute("aria-disabled", "true");
  await row.getByTestId(`invite-row-${code}-extend`).dispatchEvent("click");
  await expect(row.getByTestId(`invite-row-${code}-extend-choices`)).toHaveCount(0);
  await page.getByTestId("sharing-page-close").click();

  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Teams");
  await page.getByTestId("palette-item-account.teams").click();
  const used = teams.getByTestId("invites-list").locator('[data-state="usedUp"]');
  await expect(used).toHaveCount(1);
  await expect(used.locator('[data-testid$="-extend"]')).toHaveAttribute("aria-disabled", "true");
});

test("extending an invite by a date and time starts a week after its current end", async ({ page }) => {
  await page.goto("/?cloud=fake");
  await page.getByTestId("toolbar-sign-in").click();
  await signInAs(page, "github", "Ada");
  const teams = page.getByTestId("teams-sheet");
  await teams.getByTestId("teams-create-number").fill("36596");
  await teams.getByTestId("teams-create-name").fill("Horizon");
  await teams.getByTestId("teams-create-submit").click();
  await teams.getByTestId("recovery-code-saved").check();
  await teams.getByTestId("recovery-code-continue").click();
  // An invite that ends in 30 days, later than a week from now.
  await teams.getByTestId("invite-expiry-30").click();
  await teams.getByTestId("invite-create").click();
  const link = await teams.getByTestId("invite-link-text").textContent();
  const row = `invite-row-${new URL(link ?? "").hash.replace("#/join/", "").slice(0, 8)}`;

  await teams.getByTestId(`${row}-extend`).click();
  await teams.getByTestId(`${row}-extend-by-at`).click();
  // Applied as it starts, the pick is later than the current end, so the invite is extended.
  await teams.getByTestId(`${row}-extend-apply`).click();
  await expect(teams.getByTestId(`${row}-extend-apply`)).toHaveCount(0);
  await expect(teams).not.toContainText("Pick a time later than the invite's current end.");
});

test("a device that answered the old age screen goes straight to the ways in, and the flag is gone", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("zenith.ageScreen", "under13");
  });
  await page.goto("/?cloud=fake");
  await page.getByTestId("toolbar-sign-in").click();
  const sheet = page.getByTestId("signin-sheet");
  await expect(sheet.getByTestId("signin-providers")).toBeVisible();
  await expect(sheet.getByTestId("under13")).toHaveCount(0);
  await shot(page, "7-no-age-screen");
  // The init script sets the flag again before each load, so the check is of this load's clean-up.
  expect(await page.evaluate(() => window.localStorage.getItem("zenith.ageScreen"))).toBeNull();
});
