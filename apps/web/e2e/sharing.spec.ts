/**
 * Sharing outside the team (spec 13 sections 8 and 9), against the fake
 * cloud (`?cloud=fake`), which the account, sharing and the verification UI share: one sign-in.
 *
 * The first test is the whole path: two people make two teams, the first publishes the example
 * auto from the share dialog and shares it with the second team, the fake's switch of user signs
 * the second person in, and they find it in their Partners panel and load it into the alliance
 * view. The others cover the dialog's sentence and preview, the Sharing page, the link flow's
 * second step and opening a `#/s/<id>` link, and the signed-out state.
 *
 * Screenshots go to test-results/sharing/, which git ignores, or to ZENITH_E2E_SHOTS when set.
 */
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";

const SHOTS = process.env["ZENITH_E2E_SHOTS"] ?? fileURLToPath(new URL("../test-results/sharing/", import.meta.url));
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS.replace(/\/?$/, "/")}sharing-${name}.png` });

/** The fake cloud's users: the provider buttons sign in a fixed user each. */
const ADA = "memory-github-user";
const GRACE = "memory-google-user";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem(
        "zenith.ui",
        JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }),
      );
    }
    window.localStorage.removeItem("zenith.cloudFake");
  });
  await turnOnFeatures(page);
});

async function openExample(page: Page, query = "?cloud=fake"): Promise<void> {
  await page.goto(`/${query}`);
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
}

/** A provider and a display name. */
async function signIn(page: Page, provider: "github" | "google", name: string): Promise<void> {
  await page.getByTestId("toolbar-sign-in").click();
  const sheet = page.getByTestId("signin-sheet");
  await sheet.getByTestId(`signin-${provider}`).click();
  await sheet.getByTestId("signin-display-name").fill(name);
  await sheet.getByTestId("signin-display-name-save").click();
}

/** Creates a team from the Teams sheet, which opens by itself for someone with none. */
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

/** Grace makes team 12345, then Ada makes team 36596 and stays signed in. */
async function twoTeams(page: Page): Promise<void> {
  await openExample(page);
  await signIn(page, "google", "Grace");
  await createTeam(page, 12345, "Partner team");
  await signOut(page);
  await signIn(page, "github", "Ada");
  await createTeam(page, 36596, "Horizon");
  await page.getByTestId("teams-sheet-close").click();
}

/** Opens the share dialog and publishes the open auto from it, which a share needs first. */
async function openShareAndPublish(page: Page): Promise<ReturnType<Page["getByTestId"]>> {
  await page.getByTestId("toolbar-share.open").click();
  const sheet = page.getByTestId("share-sheet");
  await expect(sheet).toBeVisible();
  const first = sheet.getByTestId("share-publish-first");
  await expect(first).toContainText("Publish this auto to your team library first.");
  await expect(sheet.getByTestId("share-submit")).toHaveAttribute("aria-disabled", "true");
  await sheet.getByTestId("share-publish").click();
  await expect(first).toHaveCount(0);
  return sheet;
}

test("share with a second team, who finds it in the Partners panel and loads it into the alliance view", async ({ page }) => {
  await twoTeams(page);
  const chip = page.getByTestId("sharing-chip");
  await expect(chip).toHaveText("Not in the team library");

  await page.getByTestId("toolbar-share.open").click();
  const sheet = page.getByTestId("share-sheet");
  await expect(sheet.getByTestId("share-publish-first")).toContainText("Publish this auto to your team library first.");
  await shot(page, "1-publish-first");
  await sheet.getByTestId("share-publish").click();
  await expect(sheet.getByTestId("share-publish-first")).toHaveCount(0);

  await sheet.getByTestId("share-team-input").fill("12345");
  await sheet.getByTestId("share-team-input").press("Enter");
  // Which version is under More options, whose line says the default until it is opened.
  await expect(sheet.getByTestId("share-more-now")).toHaveText("Command names hidden · Name hidden · This version");
  await sheet.getByTestId("share-more-options").click();
  await sheet.getByTestId("share-mode-follow").click();
  await expect(sheet.getByTestId("share-sentence")).toContainText("Team 12345 can view this auto until");
  await shot(page, "2-share-dialog");
  await sheet.getByTestId("share-submit").click();
  // The first share with a team shows its safety code, and one click shares.
  await sheet.getByTestId("first-share-code").getByTestId("first-share-code-share").click();
  await expect(sheet.getByTestId("share-done")).toBeVisible();
  await expect(chip).toHaveText("Shared with 1 team");
  await sheet.getByTestId("share-done").click();

  // Grace, on the same page through the fake's switch of user, is in team 12345.
  await switchTo(page, GRACE, "Grace");
  await expect(page.getByTestId("sharing-chip")).toHaveText("Not in the team library");
  await page.getByTestId("partners-panel-fold").click();
  const received = page.getByTestId("received-list");
  await expect(received).toBeVisible();
  const row = received.locator('[data-testid^="received-"][data-testid$="-from"]');
  // Every team name carries its number's status: nobody has checked 36596 yet.
  await expect(row).toHaveText("Team 36596 (unverified)");
  await expect(received).toContainText("View only");
  // Which version they see is under Details.
  await expect(received).not.toContainText("Follows their latest version");
  await received.locator('[data-testid$="-details"]').click();
  await expect(received).toContainText("Follows their latest version, updated just now");
  await received.evaluate((element) => {
    element.scrollIntoView({ block: "center" });
  });
  await shot(page, "3-received");

  await received.locator('[data-testid$="-load"]').click();
  await expect(page.getByTestId("partners-list")).toContainText("Team 36596 (unverified)");
  await expect(page.locator('[data-testid^="alliance-lane-"]')).toHaveCount(1);
  await expect(page.locator("canvas").first()).toHaveAttribute("data-partners", /^partner\d+@/);
  await shot(page, "4-alliance-view");
});

test("the dialog's sentence and preview, and the share on the Sharing page", async ({ page }) => {
  await twoTeams(page);
  // An invite that ends tomorrow, so the Sharing page has something to warn about.
  await page.getByTestId("toolbar-account").click();
  await page.getByTestId("settings-nav-teams").click();
  await page.getByTestId("settings").getByTestId("account-open-teams").click();
  const teams = page.getByTestId("teams-sheet");
  await teams.getByTestId("invite-expiry-1").click();
  await teams.getByTestId("invite-create").click();
  await expect(teams.getByTestId("invites-list").locator('[data-state="live"]')).toHaveCount(1);
  await page.getByTestId("teams-sheet-close").click();

  // It ends within two days, so the app warns about it, without email, until it is dismissed.
  const notice = page.getByTestId("expiry-notice");
  await expect(notice).toBeVisible();
  await expect(notice.getByTestId("expiry-notice-list")).toContainText("The editor invite");
  await expect(notice.getByTestId("expiry-notice-list")).toContainText("hours left.");
  await shot(page, "9-expiry-notice");
  // One line has one close, the header's; a second × on the line would do the same thing.
  await expect(notice.locator('[data-testid^="expiry-notice-invite-"][data-testid$="-dismiss"]')).toHaveCount(0);
  await notice.getByTestId("expiry-notice-dismiss-all").click();
  await expect(notice).toHaveCount(0);

  const chip = page.getByTestId("sharing-chip");
  const sheet = await openShareAndPublish(page);
  const sentence = sheet.getByTestId("share-sentence");
  await expect(sentence).toContainText("Nobody outside your team can see this auto yet.");

  // The app stays usable while the sheet is open: it is not modal.
  await page.getByTestId("step-row-driveOut").getByRole("button").first().click();
  await expect(sheet).toBeVisible();

  // A team that has not joined Zenith is refused when the share is sent, in a sentence.
  await sheet.getByTestId("share-team-input").fill("99999");
  await sheet.getByTestId("share-team-input").press("Enter");
  await sheet.getByTestId("share-submit").click();
  await expect(sheet.getByRole("alert")).toContainText("No team on Zenith has claimed number 99999");
  await sheet.getByLabel("Remove team 99999").click();

  await sheet.getByTestId("share-team-input").fill("12345");
  await sheet.getByTestId("share-team-input").press("Enter");
  await expect(sheet.getByTestId("share-team-12345")).toBeVisible();
  await expect(sentence).toContainText("Team 12345 can view this auto until");
  await expect(sentence).toContainText("They will see this version: where your robot drives and when.");
  await expect(sentence).toContainText("They cannot propose changes.");

  await sheet.getByTestId("share-level-propose").click();
  await expect(sentence).toContainText("Team 12345 can view this auto and propose changes to it until");
  await sheet.getByTestId("share-more-options").click();
  await sheet.getByTestId("share-mode-follow").click();
  await expect(sentence).toContainText("They will see the latest version, updated each time you publish");
  await sheet.getByTestId("share-level-view").click();
  await sheet.getByTestId("share-mode-pinned").click();

  // Every expiry is calendar time: a number of days, or a date with an optional time.
  await expect(sheet.getByTestId("share-expiry").getByRole("button")).toHaveText(["1 day", "7 days", "30 days", "Until a date"]);
  await sheet.getByTestId("share-expiry-date").click();
  await sheet.getByTestId("share-expiry-time").fill("15:30");
  await expect(sheet.getByTestId("share-submit")).not.toHaveAttribute("aria-disabled", "true");
  await sheet.getByTestId("share-expiry-7").click();

  // See it as they will: exactly what would be sent, before anything is, drawn from the projection.
  await sheet.getByTestId("share-see-as-they-will").click();
  const preview = sheet.getByTestId("share-preview");
  await expect(preview.getByTestId("share-projection")).toHaveAttribute("data-level", "view");
  await expect(preview.getByTestId("share-preview-field")).toBeVisible();
  await expect(preview.getByTestId("share-preview-phases")).toBeVisible();
  await expect(preview.getByTestId("share-preview-structure")).toHaveCount(0);
  const time = preview.getByTestId("share-preview-time");
  await preview.getByTestId("share-preview-play").click();
  await expect.poll(async () => Number(await time.getAttribute("data-at-s"))).toBeGreaterThan(1);
  await preview.getByTestId("share-preview-play").click();
  await preview.getByTestId("share-preview-scrub").fill("0");
  await expect(time).toHaveAttribute("data-at-s", "0.00");

  // The exact data is the canonical projection, with its size, and Coarsen changes it.
  await preview.getByTestId("share-preview-exact").locator("summary").click();
  const json = preview.getByTestId("share-preview-json");
  await expect(json).toContainText('"kind": "projection"');
  await expect(json).toContainText('"positionQuantumIn": 0.5');
  await expect(json).not.toContainText("driveOut");
  await sheet.getByTestId("share-coarsen").check();
  await expect(json).toContainText('"positionQuantumIn": 2');
  await sheet.getByTestId("share-coarsen").uncheck();

  // At the propose level they also see the structure, by stand-in names only.
  await sheet.getByTestId("share-level-propose").click();
  const structure = preview.getByTestId("share-preview-structure");
  await expect(structure).toContainText("cmd1");
  await expect(structure).not.toContainText("driveOut");
  await sheet.getByTestId("share-level-view").click();

  // Include command names: off by default, and reflected live in the sentence and the preview.
  if ((await sheet.getByTestId("share-more").getAttribute("open")) === null) await sheet.getByTestId("share-more-options").click();
  const include = sheet.getByTestId("share-include-commands");
  await expect(include).toBeVisible();
  await expect(include).not.toBeChecked();
  await expect(sentence).toContainText("They will not see command names, notes or any robot settings.");
  await expect(preview.getByTestId("share-preview-commands")).toHaveCount(0);
  await include.check();
  await expect(sentence).toContainText("They will see command names and their settings, but not your code, notes or any robot settings.");
  await expect(preview.getByTestId("share-preview-commands")).toContainText("score (count 4)");
  await expect(json).toContainText('"commands"');
  await expect(json).toContainText('"name": "intakeOn"');
  await expect(json).not.toContainText("driveOut");
  await include.uncheck();
  await expect(sentence).toContainText("They will not see command names, notes or any robot settings.");
  await expect(json).not.toContainText('"commands"');

  const said = await sentence.textContent();
  await sheet.getByTestId("share-submit").click();
  // The first share with a team shows its safety code, and one click shares.
  await sheet.getByTestId("first-share-code").getByTestId("first-share-code-share").click();
  await expect(sheet.getByTestId("share-done")).toBeVisible();
  // The stored share reads back as the same sentence the dialog showed.
  await expect(sheet.getByTestId("share-sentence")).toHaveText(said ?? "");
  await expect(chip).toHaveText("Shared with 1 team");

  await sheet.getByTestId("share-open-page").click();
  const pageSheet = page.getByTestId("sharing-page");
  await expect(pageSheet).toBeVisible();
  const row = pageSheet.getByTestId("sharing-shares").locator('[data-testid^="share-row-"][data-state="active"]');
  await expect(row).toHaveCount(1);
  await expect(row.locator('[data-testid$="-who"]')).toHaveText("Team 12345 (unverified)");
  await expect(row.locator('[data-testid$="-level"]')).toHaveText("View only");
  await expect(row).toContainText("collect-and-score.auto.json");
  await expect(row.locator('[data-testid$="-revision"]')).toContainText("revision 1");
  // When it was made, so two shares of one auto can be told apart.
  await expect(row.locator('[data-testid$="-made"]')).toHaveText(/^made \S/);

  // Allowing proposals rebuilds what they get from the revision, at the propose level.
  await row.locator('[data-testid$="-level-toggle"]').click();
  await expect(row.locator('[data-testid$="-level"]')).toHaveText("View and propose");
  await expect(page.getByTestId("status")).toContainText("can now propose changes");

  // The invite ends within two days, so it carries the expiry warning.
  await expect(pageSheet.getByTestId("sharing-invites").getByTestId("expiry-warning")).toBeVisible();
  await shot(page, "5-sharing-page");

  const revoke = row.locator('[data-testid$="-revoke"]');
  await expect(revoke).toHaveText("Revoke");
  await revoke.click();
  await expect(pageSheet.locator('[data-testid$="-confirm"]').getByRole("button")).toHaveText(["Cancel", "Revoke"]);
  await pageSheet.locator('[data-testid$="-confirm-yes"]').click();
  await expect(pageSheet.getByTestId("sharing-no-shares")).toBeVisible();
  await expect(pageSheet.getByTestId("sharing-past").locator('[data-state="revoked"]')).toHaveCount(1);
  await expect(chip).toHaveText("Team only");

  await page.keyboard.press("Escape");
  await expect(pageSheet).toBeHidden();
});

test("with Include command names, the Sharing page marks the share and the partner sees the real names", async ({ page }) => {
  await twoTeams(page);
  const sheet = await openShareAndPublish(page);
  await sheet.getByTestId("share-team-input").fill("12345");
  await sheet.getByTestId("share-team-input").press("Enter");
  await sheet.getByTestId("share-more-options").click();
  await sheet.getByTestId("share-include-commands").check();
  await expect(sheet.getByTestId("share-sentence")).toContainText("They will see command names and their settings");
  await shot(page, "7-include-commands");
  await sheet.getByTestId("share-submit").click();
  // The first share with a team shows its safety code, and one click shares.
  await sheet.getByTestId("first-share-code").getByTestId("first-share-code-share").click();
  await expect(sheet.getByTestId("share-sentence")).toContainText("They will see command names and their settings");

  await sheet.getByTestId("share-open-page").click();
  const row = page.getByTestId("sharing-page").locator('[data-testid^="share-row-"][data-state="active"]');
  await expect(row).toHaveCount(1);
  await expect(row.locator('[data-testid$="-commands"]')).toHaveText("Commands included");
  await expect(row.locator('[data-testid$="-newer"]')).toHaveCount(0);
  await page.keyboard.press("Escape");

  await switchTo(page, GRACE, "Grace");
  await page.getByTestId("partners-panel-fold").click();
  const received = page.getByTestId("received-list");
  await expect(received).toBeVisible();
  await received.locator('[data-testid$="-load"]').click();
  const lane = page.locator('[data-testid^="alliance-lane-"]');
  await expect(lane).toHaveCount(1);
  const named = lane.locator("[data-commands]");
  await expect(named.first()).toBeAttached();
  const all = (await named.evaluateAll((blocks) => blocks.map((block) => block.getAttribute("data-commands") ?? ""))).join(", ");
  expect(all).toContain("intakeOn");
  expect(all).toContain("score (count 4)");
  expect(all).not.toMatch(/\bcmd[0-9]+\b/);
  const scoring = lane.locator('[data-commands*="score (count 4)"]').first();
  await scoring.hover();
  await expect(page.getByRole("tooltip")).toContainText("Commands: ");
  await expect(page.getByRole("tooltip")).toContainText("score (count 4)");
  await shot(page, "8-partner-command-names");
});

test("the auto's name kept, seen by the partner, and an extension to a date and time", async ({ page }) => {
  await twoTeams(page);
  const sheet = await openShareAndPublish(page);
  await sheet.getByTestId("share-team-input").fill("12345");
  await sheet.getByTestId("share-team-input").press("Enter");
  const sentence = sheet.getByTestId("share-sentence");

  // Include the auto's name: off by default, beside Command names, and followed by the sentence
  // and the preview.
  await sheet.getByTestId("share-more-options").click();
  const include = sheet.getByTestId("share-include-title");
  await expect(include).not.toBeChecked();
  await expect(sheet.getByTestId("share-include-title-help")).toHaveText("Your partner will see it named “Collect and score”.");
  await expect(sentence).not.toContainText("this auto's name");
  await sheet.getByTestId("share-see-as-they-will").click();
  const preview = sheet.getByTestId("share-preview");
  await expect(preview.getByTestId("share-projection-title")).toHaveCount(0);
  await include.check();
  await expect(sentence).toContainText("They will see this auto's name, but not command names, notes or any robot settings.");
  await expect(preview.getByTestId("share-projection-title")).toHaveText("Named “Collect and score”");
  await preview.getByTestId("share-preview-exact").locator("summary").click();
  await expect(preview.getByTestId("share-preview-json")).toContainText('"title": "Collect and score"');
  await shot(page, "10-include-title");
  await sheet.getByTestId("share-submit").click();
  // The first share with a team shows its safety code, and one click shares.
  await sheet.getByTestId("first-share-code").getByTestId("first-share-code-share").click();
  await expect(sheet.getByTestId("share-sentence")).toContainText("They will see this auto's name");

  await sheet.getByTestId("share-open-page").click();
  const pageSheet = page.getByTestId("sharing-page");
  const row = pageSheet.locator('[data-testid^="share-row-"][data-state="active"]');
  await expect(row).toHaveCount(1);
  await expect(row.locator('[data-testid$="-title"]')).toHaveText("Name included");

  // Extend to a date and time, with the same picker the team's invites use.
  await row.locator('[data-testid$="-extend"]').click();
  const choices = row.locator('[data-testid$="-extend-choices"]');
  await expect(choices.getByRole("button", { name: "Date and time" })).toBeVisible();
  await choices.getByRole("button", { name: "Date and time" }).click();
  const when = choices.locator('input[type="datetime-local"]');
  // A time before the share's current end is refused, and says why.
  const local = (days: number) =>
    page.evaluate((offsetDays) => {
      const at = new Date(Date.now() + offsetDays * 86_400_000);
      const pad = (value: number) => String(value).padStart(2, "0");
      return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
    }, days);
  await when.fill(await local(2));
  await expect(choices.locator('[data-testid$="-why"]')).toHaveText("That is not later than when it ends now. Pick a later time.");
  await expect(choices.locator('[data-testid$="-apply"]')).toHaveAttribute("aria-disabled", "true");
  await when.fill(await local(20.5));
  await expect(choices.locator('[data-testid$="-why"]')).toHaveCount(0);
  await shot(page, "11-extend-date-time");
  await choices.locator('[data-testid$="-apply"]').click();
  await expect(page.getByTestId("status")).toContainText("Extended the share with Team 12345 (unverified).");
  await expect(row).toContainText("20 days left");
  await page.keyboard.press("Escape");

  // Grace sees the auto by its name, with the team and its status in the tooltip.
  await switchTo(page, GRACE, "Grace");
  await page.getByTestId("partners-panel-fold").click();
  const received = page.getByTestId("received-list");
  await received.locator('[data-testid$="-load"]').click();
  await expect(page.getByTestId("partners-list").getByTestId("partner-label")).toHaveText("Collect and score");
});

test("anyone with the link asks a second time, and the link opens read only for someone signed out", async ({ page }) => {
  await openExample(page);
  await signIn(page, "github", "Ada");
  await createTeam(page, 36596, "Horizon");
  await page.getByTestId("teams-sheet-close").click();
  const sheet = await openShareAndPublish(page);
  await sheet.getByTestId("share-audience-link").click();
  await expect(sheet.getByTestId("share-sentence")).toContainText("Anyone with the link can view this auto until");
  await expect(sheet.getByTestId("share-level-propose")).toHaveAttribute("aria-disabled", "true");

  await sheet.getByTestId("share-submit").click();
  await expect(sheet.getByTestId("share-link-warning")).toHaveText(
    "Anyone who gets this link will be able to see it, without signing in.",
  );
  await expect(sheet.getByTestId("share-preview")).toBeVisible();
  await expect(page.getByTestId("sharing-chip")).toHaveText("Team only");

  await sheet.getByTestId("share-confirm-link").click();
  const link = await sheet.getByTestId("share-link").textContent();
  expect(link).toMatch(/#\/s\/[A-Za-z0-9_-]{22}$/);
  await expect(page.getByTestId("sharing-chip")).toHaveText("Anyone with the link");
  await sheet.getByTestId("share-done").click();

  // Signed out, the link still opens: beside the open auto, in the alliance view.
  const hash = new URL(link ?? "").hash;
  await signOut(page);
  await page.evaluate((next) => {
    window.location.hash = next;
  }, hash);
  await expect(page.getByTestId("partners-list")).toContainText("Shared link");
  await expect.poll(() => new URL(page.url()).hash).toBe("");

  // And with no auto open, alone and read only. The dev server serves the editor's own store
  // module, so the test closes the example through it; the app has no Close button to press.
  await page.evaluate(async () => {
    const path = "/src/state/store.ts";
    const store = (await import(/* @vite-ignore */ path)) as { closeProject: () => void };
    store.closeProject();
  });
  await expect(page.getByTestId("canvas-empty")).toBeVisible();
  await page.evaluate((next) => {
    window.location.hash = next;
  }, hash);
  const viewer = page.getByTestId("share-viewer");
  await expect(viewer).toBeVisible();
  await expect(viewer.getByTestId("share-viewer-sentence")).toContainText("Read only.");
  await expect(viewer.getByTestId("share-preview-field")).toBeVisible();
  await shot(page, "6-link-viewer");
});

test("signed out on the fake cloud, Share stays in the toolbar and says to sign in", async ({ page }) => {
  await openExample(page);
  await expect(page.getByTestId("sharing-chip")).toHaveCount(0);
  const share = page.getByTestId("toolbar-share.open");
  await expect(share).toHaveAttribute("aria-disabled", "true");
  await share.hover();
  await expect(page.getByRole("tooltip")).toContainText("Sign in to share.");
  await share.click({ force: true });
  await expect(page.getByTestId("share-sheet")).toHaveCount(0);
});

test("Share on an auto that is already shared asks for another team, and never says nobody can see it", async ({ page }) => {
  await twoTeams(page);
  const sheet = await openShareAndPublish(page);
  await expect(sheet.getByTestId("share-sentence")).toContainText("Nobody outside your team can see this auto yet.");
  await sheet.getByTestId("share-team-input").fill("12345");
  await sheet.getByTestId("share-team-input").press("Enter");
  await sheet.getByTestId("share-submit").click();
  await sheet.getByTestId("first-share-code").getByTestId("first-share-code-share").click();
  await sheet.getByTestId("share-done").click();
  await expect(page.getByTestId("sharing-chip")).toHaveText("Shared with 1 team");

  await page.getByTestId("toolbar-share.open").click();
  const again = page.getByTestId("share-sheet");
  await expect(again).toContainText("This auto already has 1 share.");
  await expect(again.getByTestId("share-sentence")).toHaveText("Add a team number to share this auto with another team.");
  await expect(again).not.toContainText("Nobody outside your team");
  await shot(page, "12-already-shared");
  // Once a team is typed, the usual sentence is back.
  await again.getByTestId("share-team-input").fill("23456");
  await again.getByTestId("share-team-input").press("Enter");
  await expect(again.getByTestId("share-sentence")).toContainText("Team 23456 can view this auto until");
});
test("a share to a team that was deleted since reads as ended, with the team named as deleted", async ({ page }) => {
  await twoTeams(page);
  const sheet = await openShareAndPublish(page);
  await sheet.getByTestId("share-team-input").fill("12345");
  await sheet.getByTestId("share-team-input").press("Enter");
  await sheet.getByTestId("share-submit").click();
  // The first share with a team shows its safety code, and one click shares.
  await sheet.getByTestId("first-share-code").getByTestId("first-share-code-share").click();
  await sheet.getByTestId("share-done").click();
  await expect(page.getByTestId("sharing-chip")).toHaveText("Shared with 1 team");

  // Grace deletes team 12345.
  await switchTo(page, GRACE, "Grace");
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Teams");
  await page.getByTestId("palette-item-account.teams").click();
  const teams = page.getByTestId("teams-sheet");
  await teams.getByTestId("teams-delete").click();
  await teams.getByTestId("teams-delete-typed").fill("Partner team");
  await teams.getByTestId("teams-delete-yes").click();
  await expect(teams).toContainText("You are not in a team yet.");
  await page.getByTestId("teams-sheet-close").click();

  // Ada's share to it is ended, and says why in plain words.
  await switchTo(page, ADA, "Ada");
  await page.getByTestId("toolbar-share.page").click();
  const past = page.getByTestId("sharing-past");
  const row = past.locator('[data-testid^="share-row-"][data-state="team-deleted"]');
  await expect(row).toHaveCount(1);
  await expect(row.locator('[data-testid$="-who"]')).toHaveText("A deleted team");
  await expect(row).toContainText("Ended: team deleted");
  await expect(page.getByTestId("sharing-no-shares")).toBeVisible();
  await page.getByTestId("sharing-page-close").click();
  await expect(page.getByTestId("sharing-chip")).toHaveText("Team only");
});
