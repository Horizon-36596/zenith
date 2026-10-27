/**
 * Proposing changes through the cloud (spec 13 section 14), against the fake cloud (`?cloud=fake`)
 * and its switch of user, so one page plays both teams:
 *
 * - Horizon (team 36596) shares the example auto with team 12345 at the propose level. Team 12345
 *   loads it into the alliance view, where it says when it was updated, suggests a wait at the
 *   start and sends the proposal to the share. Horizon finds it under that share on the Sharing
 *   page, reviews it against the revision it was made against, accepts and applies it, and its
 *   auto gains the wait. Team 12345 then sees the proposal accepted under the partner.
 * - Team 12345 sends a proposal and withdraws it again, after a confirmation; it reads Withdrawn
 *   under the partner, with no Withdraw left, and Horizon's Sharing page lists it Withdrawn with
 *   Review unavailable. The development build's count of cloud reads names the Sharing page, on
 *   window.__zenithReads and in the Developer section of Settings.
 * - A view-level share offers no Suggest changes at all.
 *
 * Screenshots go to test-results/cloud-proposals/, which git ignores, or to ZENITH_E2E_SHOTS.
 */
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";

const SHOTS = process.env["ZENITH_E2E_SHOTS"] ?? fileURLToPath(new URL("../test-results/cloud-proposals/", import.meta.url));
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS.replace(/\/?$/, "/")}cloud-proposals-${name}.png` });

/** The fake cloud's users: the provider buttons sign in a fixed user each. */
const ADA = "memory-github-user";
const GRACE = "memory-google-user";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
    }
    window.localStorage.removeItem("zenith.cloudFake");
  });
  await turnOnFeatures(page);
});

/** A provider and a display name. */
async function signIn(page: Page, provider: "github" | "google", name: string): Promise<void> {
  await page.getByTestId("toolbar-sign-in").click();
  const sheet = page.getByTestId("signin-sheet");
  await sheet.getByTestId(`signin-${provider}`).click();
  await sheet.getByTestId("signin-display-name").fill(name);
  await sheet.getByTestId("signin-display-name-save").click();
}

async function createTeam(page: Page, number: number, name: string): Promise<void> {
  const teams = page.getByTestId("teams-sheet");
  await teams.getByTestId("teams-create-number").fill(String(number));
  await teams.getByTestId("teams-create-name").fill(name);
  await teams.getByTestId("teams-create-submit").click();
  // The recovery code comes first, once: tick that it is saved to continue.
  await teams.getByTestId("recovery-code-saved").check();
  await teams.getByTestId("recovery-code-continue").click();
  await expect(teams.getByTestId("teams-my-role")).toHaveText("Owner");
}

async function signOut(page: Page): Promise<void> {
  await page.getByTestId("toolbar-account").click();
  await page.getByTestId("settings").getByTestId("account-sign-out").click();
  await expect(page.getByTestId("toolbar-sign-in")).toBeVisible();
}

/** The fake cloud's switch of user, from the Developer section of Settings: no second sign-in. */
async function switchTo(page: Page, uid: string, name: string): Promise<void> {
  await page.getByTestId("toolbar-account").click();
  await page.getByTestId("settings-nav-developer").click();
  await page.getByTestId("settings").getByTestId(`fake-switch-${uid}`).click();
  await expect(page.getByTestId("toolbar-account")).toContainText(name);
  await page.getByTestId("settings-close").click();
  await expect(page.getByTestId("settings")).toHaveCount(0);
}

/** Grace makes team 12345, then Ada makes team 36596 and stays signed in, with the example open. */
async function twoTeams(page: Page): Promise<void> {
  await page.goto("/?cloud=fake");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await signIn(page, "google", "Grace");
  await createTeam(page, 12345, "Partner team");
  await signOut(page);
  await signIn(page, "github", "Ada");
  await createTeam(page, 36596, "Horizon");
  await page.getByTestId("teams-sheet-close").click();
}

/** Ada publishes the open auto and shares it with team 12345 at `level`. */
async function shareWithGrace(page: Page, level: "view" | "propose"): Promise<void> {
  await page.getByTestId("toolbar-share.open").click();
  const sheet = page.getByTestId("share-sheet");
  await sheet.getByTestId("share-publish").click();
  await expect(sheet.getByTestId("share-publish-first")).toHaveCount(0);
  await sheet.getByTestId("share-team-input").fill("12345");
  await sheet.getByTestId("share-team-input").press("Enter");
  await sheet.getByTestId(`share-level-${level}`).click();
  await sheet.getByTestId("share-submit").click();
  // The first share with a team shows its safety code, and one click shares.
  await sheet.getByTestId("first-share-code").getByTestId("first-share-code-share").click();
  await expect(sheet.getByTestId("share-done")).toBeVisible();
  await sheet.getByTestId("share-done").click();
}

/** Grace loads the one share she received into the alliance view. */
async function graceLoadsIt(page: Page): Promise<void> {
  await switchTo(page, GRACE, "Grace");
  await page.getByTestId("partners-panel-fold").click();
  const received = page.getByTestId("received-list");
  await expect(received).toBeVisible();
  await received.locator('[data-testid$="-load"]').click();
  await expect(page.getByTestId("partners-list")).toContainText("Team 36596");
}

test("team 12345 proposes a change through the share, and Horizon reviews, accepts and applies it", async ({ page }) => {
  await twoTeams(page);
  await shareWithGrace(page, "propose");

  // ---- Team 12345: load it, see when it changed, suggest a wait and send it. ----
  await graceLoadsIt(page);
  const partner = page.getByTestId("partner-share-partner1");
  await expect(partner.locator('[data-testid$="-updated"]')).toHaveText("updated just now");
  await page.locator('[data-testid^="partner-suggest-"]').click();
  await expect(page.getByTestId("proposal-share-ref")).toContainText(/^share [A-Za-z0-9_-]{22} · revision 1$/);
  await page.getByTestId("proposal-wait-start").click();
  await expect(page.getByTestId("proposal-change-1")).toBeVisible();
  await page.getByTestId("proposal-send").click();
  await expect(page.getByTestId("status")).toContainText("Sent the proposal to Team 36596");
  await shot(page, "1-sent");
  await page.getByTestId("proposal-leave").click();
  const sentStatus = page.locator('[data-testid^="sent-proposal-"][data-testid$="-status"]');
  await expect(sentStatus).toHaveText("Open");
  await expect(page.locator('[data-testid^="sent-proposal-"][data-testid$="-changes"]')).toHaveText("1 change");

  // ---- Horizon: the Sharing page lists it under the share; review it and accept it. ----
  await switchTo(page, ADA, "Ada");
  await expect(page.getByTestId("sharing-chip")).toHaveText("Shared with 1 team");
  const stepsBefore = await page.locator('[data-testid^="step-row-"]').count();
  await page.getByTestId("toolbar-share.page").click();
  const sharing = page.getByTestId("sharing-page");
  const row = sharing.locator('li[data-testid^="received-proposal-"]');
  await expect(row).toHaveCount(1);
  await expect(row.locator('[data-testid$="-status"]')).toHaveText("Open");
  await expect(row.locator('[data-testid$="-from"]')).toHaveText("From team 12345 (unverified)");
  await expect(row).toContainText("against revision 1");
  await expect(row.locator('[data-testid$="-changes"]')).toHaveText("1 change");
  await shot(page, "2-sharing-page");
  await row.locator('[data-testid$="-review"]').click();

  await expect(page.getByTestId("owner-review-banner")).toBeVisible();
  // The review takes the editor, so the Sharing page it was opened from has closed.
  await expect(page.getByTestId("sharing-page")).toHaveCount(0);
  await expect(page.getByTestId("owner-review-cloud-status")).toHaveText("From Team 12345 (unverified): open");
  await expect(page.getByTestId("owner-review-pinned-note")).toContainText("The team library revision the proposal was made against");
  const change = page.getByTestId("owner-change-1");
  await expect(change.getByTestId("owner-change-status")).toHaveText("not accepted");
  // Undecided: neither Accept nor Reject is pressed.
  await expect(page.getByTestId("owner-accept-1")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("owner-reject-1")).toHaveAttribute("aria-pressed", "false");
  await page.getByTestId("owner-review-accept-all").click();
  await page.getByTestId("owner-review-apply").click();
  await expect(change.getByTestId("owner-change-status")).toHaveText("applied");
  await expect(page.getByTestId("owner-review-cloud-status")).toHaveText("From Team 12345 (unverified): accepted");
  await shot(page, "3-accepted");
  await page.getByTestId("owner-review-leave").click();

  // The auto has the wait at its start.
  await expect(page.locator('[data-testid^="step-row-"]')).toHaveCount(stepsBefore + 1);

  // The Sharing page says accepted too.
  await page.getByTestId("toolbar-share.page").click();
  await expect(page.getByTestId("sharing-page").locator('[data-testid^="received-proposal-"][data-testid$="-status"]')).toHaveText(
    "Accepted",
  );
  await page.keyboard.press("Escape");

  // ---- Team 12345 sees it accepted under the partner. ----
  await switchTo(page, GRACE, "Grace");
  await expect(page.locator('[data-testid^="sent-proposal-"][data-testid$="-status"]')).toHaveText("Accepted");
  await shot(page, "4-proposer-sees-accepted");
});

test("team 12345 withdraws a proposal it sent, and Horizon sees it withdrawn", async ({ page }) => {
  await twoTeams(page);
  await shareWithGrace(page, "propose");

  // ---- Team 12345: send a proposal, then take it back. ----
  await graceLoadsIt(page);
  await page.locator('[data-testid^="partner-suggest-"]').click();
  await page.getByTestId("proposal-wait-start").click();
  await page.getByTestId("proposal-send").click();
  await expect(page.getByTestId("status")).toContainText("Sent the proposal to Team 36596");
  await page.getByTestId("proposal-leave").click();
  const sent = page.locator('li[data-testid^="sent-proposal-"]');
  await expect(sent).toHaveCount(1);
  await expect(sent.locator('[data-testid$="-status"]')).toHaveText("Open");

  // Withdraw asks first; Cancel leaves the proposal open.
  await sent.locator('[data-testid$="-withdraw"]').click();
  const confirm = sent.locator('[data-testid$="-confirm"]');
  await expect(confirm).toContainText("Withdraw this proposal? Team 36596");
  await confirm.locator('[data-testid$="-confirm-cancel"]').click();
  await expect(confirm).toHaveCount(0);
  await expect(sent.locator('[data-testid$="-status"]')).toHaveText("Open");

  await sent.locator('[data-testid$="-withdraw"]').click();
  await shot(page, "5-withdraw-confirm");
  await sent.locator('[data-testid$="-confirm-yes"]').click();
  await expect(sent.locator('[data-testid$="-status"]')).toHaveText("Withdrawn");
  await expect(sent.locator('[data-testid$="-outcome"]')).toContainText("now sees it as withdrawn");
  await expect(sent.locator('[data-testid$="-withdraw"]')).toHaveCount(0);
  await shot(page, "6-withdrawn");

  // ---- Horizon: the Sharing page lists it withdrawn, with nothing to review. ----
  await switchTo(page, ADA, "Ada");
  await page.getByTestId("toolbar-share.page").click();
  const row = page.getByTestId("sharing-page").locator('li[data-testid^="received-proposal-"]');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute("data-status", "withdrawn");
  await expect(row.locator('[data-testid$="-status"]')).toHaveText("Withdrawn");
  await expect(row.locator('[data-testid$="-review"]')).toHaveAttribute("aria-disabled", "true");
  await shot(page, "7-owner-sees-withdrawn");

  // ---- The development build counts the cloud's reads by screen (spec 13 section 7.2). ----
  type Reads = { total: number; byScreen: { screen: string; reads: number }[] };
  const reads = await page.evaluate(() => (window as unknown as { __zenithReads?: { snapshot(): Reads } }).__zenithReads?.snapshot() ?? null);
  expect(reads).not.toBeNull();
  expect(reads?.total ?? 0).toBeGreaterThan(0);
  expect(reads?.byScreen.find((entry) => entry.screen === "Sharing page")?.reads ?? 0).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await page.getByTestId("toolbar-account").click();
  await page.getByTestId("settings-nav-developer").click();
  const readout = page.getByTestId("settings").getByTestId("dev-reads");
  await expect(readout.getByTestId("dev-reads-total")).toContainText("reads in all");
  await expect(readout.locator('[data-testid="dev-reads-row"][data-screen="Sharing page"]')).toBeVisible();
  await readout.getByTestId("dev-reads-reset").click();
  await expect(readout.getByTestId("dev-reads-total")).toHaveText(/^\d+ reads? in all$/);
  await shot(page, "8-dev-reads");
});

test("a view-level share offers no Suggest changes", async ({ page }) => {
  await twoTeams(page);
  await shareWithGrace(page, "view");
  await graceLoadsIt(page);
  await expect(page.getByTestId("partner-share-partner1")).toContainText("updated just now");
  await expect(page.locator('[data-testid^="partner-suggest-"]')).toHaveCount(0);
});
