/**
 * Request more time (spec 13 section 8.4), against the fake cloud (`?cloud=fake`): team 36596
 * shares an auto with team 12345, team 12345 asks for more time from its Partners panel, and team
 * 36596 grants it from its Sharing page, which moves the share's end; team 12345 then reads the
 * answer. The second test is a request, and a share, made while this computer is offline: each
 * confirmation says it is saved on this computer and links to the Outbox (spec 13 section 6).
 *
 * Screenshots go to test-results/time-requests/, which git ignores, or to ZENITH_E2E_SHOTS when set.
 */
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";

const SHOTS = process.env["ZENITH_E2E_SHOTS"] ?? fileURLToPath(new URL("../test-results/time-requests/", import.meta.url));
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS.replace(/\/?$/, "/")}time-requests-${name}.png` });

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

/** The fake cloud's switch of user, from the Developer section of Settings: no second sign-in. */
async function switchTo(page: Page, uid: string, name: string): Promise<void> {
  await page.getByTestId("toolbar-account").click();
  await page.getByTestId("settings-nav-developer").click();
  await page.getByTestId("settings").getByTestId(`fake-switch-${uid}`).click();
  await expect(page.getByTestId("toolbar-account")).toContainText(name);
  await page.getByTestId("settings-close").click();
  await expect(page.getByTestId("settings")).toHaveCount(0);
}

/** The fake cloud's connection switch. The dev server serves the account store module itself. */
async function setOnline(page: Page, online: boolean): Promise<void> {
  await page.evaluate(async (on) => {
    const path = "/src/account/store.ts";
    const store = (await import(/* @vite-ignore */ path)) as { account: { setFakeOnline(online: boolean): Promise<void> } };
    await store.account.setFakeOnline(on);
  }, online);
}

/** Grace makes team 12345, then Ada makes team 36596 with the example auto open, and stays signed in. */
async function twoTeams(page: Page): Promise<void> {
  await page.goto("/?cloud=fake");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await signIn(page, "google", "Grace");
  await createTeam(page, 12345, "Partner team");
  await page.getByTestId("toolbar-account").click();
  await page.getByTestId("settings").getByTestId("account-sign-out").click();
  await expect(page.getByTestId("toolbar-sign-in")).toBeVisible();
  await signIn(page, "github", "Ada");
  await createTeam(page, 36596, "Horizon");
  await page.getByTestId("teams-sheet-close").click();
}

/** Opens the share dialog, publishes the open auto from it and fills in team 12345. */
async function shareDialogFor12345(page: Page): Promise<Locator> {
  await page.getByTestId("toolbar-share.open").click();
  const sheet = page.getByTestId("share-sheet");
  await sheet.getByTestId("share-publish").click();
  await expect(sheet.getByTestId("share-publish-first")).toHaveCount(0);
  await sheet.getByTestId("share-team-input").fill("12345");
  await sheet.getByTestId("share-team-input").press("Enter");
  return sheet;
}

/** Ada shares the example auto with team 12345, then Grace opens her Partners panel. */
async function sharedWithGrace(page: Page): Promise<Locator> {
  await twoTeams(page);
  const sheet = await shareDialogFor12345(page);
  await sheet.getByTestId("share-submit").click();
  // The first share with a team shows its safety code, and one click shares.
  await sheet.getByTestId("first-share-code").getByTestId("first-share-code-share").click();
  await expect(sheet.getByTestId("share-done")).toBeVisible();
  await expect(sheet.getByTestId("share-queued")).toHaveCount(0);
  await sheet.getByTestId("share-done").click();
  await switchTo(page, GRACE, "Grace");
  await page.getByTestId("partners-panel-fold").click();
  const received = page.getByTestId("received-list");
  await expect(received).toBeVisible();
  // Request more time sits under the row's Details.
  await received.locator('[data-testid^="received-"][data-testid$="-details"]').click();
  return received.locator('[data-testid^="received-"][data-testid$="-time"]');
}

async function openSharingPage(page: Page): Promise<Locator> {
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Sharing");
  await page.getByTestId("palette-item-share.page").click();
  const sharing = page.getByTestId("sharing-page");
  await expect(sharing).toBeVisible();
  return sharing;
}

test("team 12345 asks for more time, and team 36596 grants it from the Sharing page", async ({ page }) => {
  const ask = await sharedWithGrace(page);
  await expect(ask).toHaveCount(1);
  await expect(ask.locator('[data-testid$="-time-status"]')).toHaveCount(0);

  // Grace asks for thirty more days because of an event, picked from the list.
  await ask.locator('[data-testid$="-time-open"]').click();
  const form = ask.locator('[data-testid$="-time-form"]');
  await expect(form).toBeVisible();
  await form.locator('[data-testid$="-time-end-30"]').click();
  await form.locator('[data-testid$="-time-reason"]').selectOption("next-event");
  await shot(page, "1-ask");
  await form.locator('[data-testid$="-time-send"]').click();
  await expect(ask.locator('[data-testid$="-time-outcome"]')).toContainText("Asked Team 36596 (unverified) for more time.");
  await expect(ask.locator('[data-testid$="-time-status"]')).toHaveText("Waiting");
  await expect(ask.locator('[data-testid$="-time-open"]')).toHaveAttribute("aria-disabled", "true");

  // Ada sees the request under the share and grants the end Grace asked for.
  await switchTo(page, ADA, "Ada");
  const sharing = await openSharingPage(page);
  const row = sharing.locator('li[data-testid^="time-request-"][data-status="open"]');
  await expect(row).toHaveCount(1);
  await expect(row.locator('[data-testid$="-team"]')).toHaveText("Team 12345 (unverified)");
  await expect(row.locator('[data-testid$="-reason"]')).toHaveText("We need it through our next event.");
  await expect(sharing.locator('[data-testid^="time-requests-"]')).toContainText("1 team asks for more time");
  await row.locator('[data-testid$="-grant"]').click();
  await expect(row.locator('[data-testid$="-choices"]')).toBeVisible();
  await expect(row.locator('[data-testid$="-end-asked"]')).toHaveAttribute("aria-pressed", "true");
  await shot(page, "2-grant");
  await row.locator('[data-testid$="-give"]').click();

  const granted = sharing.locator('li[data-testid^="time-request-"][data-status="granted"]');
  await expect(granted).toHaveCount(1);
  await expect(granted.locator('[data-testid$="-status"]')).toHaveText("Granted");
  // No status line says the grant was refused. Opening the sheet cleared the old line (#514), so
  // there may be no status line at all.
  await expect(page.getByTestId("status").filter({ hasText: "refused" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Grace reads the answer on the same row.
  await switchTo(page, GRACE, "Grace");
  const partners = page.getByTestId("received-list");
  if (!(await partners.isVisible())) await page.getByTestId("partners-panel-fold").click();
  const answered = partners.locator('[data-testid^="received-"][data-testid$="-time"]');
  if ((await answered.count()) === 0) await partners.locator('[data-testid^="received-"][data-testid$="-details"]').click();
  await expect(answered.locator('[data-testid$="-time-status"]')).toHaveText("Granted");
  await expect(answered.locator('[data-testid$="-time-answer"]')).toContainText("Team 36596 (unverified) gave more time, until");
  await shot(page, "3-granted");
});

test("a request and a share made offline each say they are saved on this computer, with the Outbox a click away", async ({ page }) => {
  const ask = await sharedWithGrace(page);

  await setOnline(page, false);
  await expect(page.getByTestId("offline-badge")).toBeVisible();
  await ask.locator('[data-testid$="-time-open"]').click();
  await ask.locator('[data-testid$="-time-form"] [data-testid$="-time-send"]').click();
  const outcome = ask.locator('[data-testid$="-time-outcome"]');
  await expect(outcome).toContainText("Your request is saved on this computer. It reaches Team 36596 (unverified) when this computer is back online.");
  await shot(page, "4-ask-offline");
  await outcome.locator('[data-testid$="-time-outcome-outbox"]').click();
  await expect(page.getByTestId("outbox-sheet")).toBeVisible();
  await page.keyboard.press("Escape");
  await setOnline(page, true);
  await expect(page.getByTestId("offline-badge")).toHaveCount(0);

  // Ada, offline, shares the auto again: the dialog says it waits in the Outbox.
  await switchTo(page, ADA, "Ada");
  await setOnline(page, false);
  // The auto is published already, so the dialog opens straight on the form.
  await page.getByTestId("toolbar-share.open").click();
  const sheet = page.getByTestId("share-sheet");
  await sheet.getByTestId("share-team-input").fill("12345");
  await sheet.getByTestId("share-team-input").press("Enter");
  await sheet.getByTestId("share-submit").click();
  const queued = sheet.getByTestId("share-queued");
  await expect(queued).toContainText("This computer is offline, so the share is saved here and waits in the Outbox.");
  await expect(page.getByTestId("status")).toContainText("Share saved on this computer.");
  await shot(page, "5-share-offline");
  await queued.getByTestId("share-queued-outbox").click();
  await expect(page.getByTestId("outbox-sheet")).toBeVisible();
  await setOnline(page, true);
});
