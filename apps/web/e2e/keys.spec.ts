/**
 * End-to-end encryption on the page (spec 14), against the fake cloud (`?cloud=fake`): the recovery
 * code shown once after a team is created, approving a new member by typing the code their device
 * shows (and the new recovery code the notice suggests once they are removed), a member's second
 * device waiting and approved from their first, the recovery code unlocking a device, and the
 * warning before sharing with a team whose key changed.
 *
 * The fake cloud plays a second device of the same member on one page ("Another device" in the
 * Developer section of Settings), with keys of its own. Screenshots go to test-results/keys/, which git ignores, or
 * to ZENITH_E2E_SHOTS when set.
 */
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { LARGE_VIEWPORT, VIEWPORT } from "./viewports";
import { turnOnFeatures } from "./features";

const SHOTS = process.env["ZENITH_E2E_SHOTS"] ?? fileURLToPath(new URL("../test-results/keys/", import.meta.url));
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS.replace(/\/?$/, "/")}keys-${name}.png` });

/** The fake cloud's users: the provider buttons sign in a fixed user each. */
const ADA = "memory-github-user";
const GRACE = "memory-google-user";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
    }
    window.localStorage.removeItem("zenith.cloudFake");
    // The print dialog would wait for a person; the test only needs to know it was asked for.
    (window as unknown as { printed: number }).printed = 0;
    window.print = () => {
      (window as unknown as { printed: number }).printed += 1;
    };
  });
  await turnOnFeatures(page);
});

async function openExample(page: Page): Promise<void> {
  await page.goto("/?cloud=fake");
  await page.getByTestId("canvas-load-example").click();
  // Attached, not visible: below 640 px the steps column is a sheet that starts closed (#512).
  await expect(page.getByTestId("step-row-driveOut")).toBeAttached();
}

async function signIn(page: Page, provider: "github" | "google", name: string): Promise<void> {
  await page.getByTestId("toolbar-sign-in").click();
  const sheet = page.getByTestId("signin-sheet");
  await sheet.getByTestId(`signin-${provider}`).click();
  await sheet.getByTestId("signin-display-name").fill(name);
  await sheet.getByTestId("signin-display-name-save").click();
}

/** Creates a team and saves its recovery code with the tick; returns the code. */
async function createTeam(page: Page, number: number, name: string): Promise<string> {
  const teams = page.getByTestId("teams-sheet");
  await teams.getByTestId("teams-create-number").fill(String(number));
  await teams.getByTestId("teams-create-name").fill(name);
  await teams.getByTestId("teams-create-submit").click();
  const code = (await teams.getByTestId("recovery-code-text").textContent()) ?? "";
  await teams.getByTestId("recovery-code-saved").check();
  await teams.getByTestId("recovery-code-continue").click();
  await expect(teams.getByTestId("teams-my-role")).toHaveText("Owner");
  return code;
}

async function signOut(page: Page): Promise<void> {
  await page.getByTestId("toolbar-account").click();
  await page.getByTestId("settings").getByTestId("account-sign-out").click();
  await expect(page.getByTestId("toolbar-sign-in")).toBeVisible();
}

/** The fake cloud's controls in the Developer section of Settings: another user, or another device of this one. */
async function developerSettings(page: Page): Promise<Locator> {
  if ((await page.getByTestId("settings").count()) === 0) await page.getByTestId("toolbar-account").click();
  await page.getByTestId("settings-nav-developer").click();
  return page.getByTestId("settings");
}

async function switchTo(page: Page, uid: string, name: string): Promise<void> {
  await (await developerSettings(page)).getByTestId(`fake-switch-${uid}`).click();
  await expect(page.getByTestId("toolbar-account")).toContainText(name);
  // Settings is modal, unlike the sheet it replaced, so it closes before the test goes on; a Teams
  // sheet that opened by itself for the new user has closed it already.
  const close = page.getByTestId("settings-close");
  if (await close.isVisible()) await close.click();
  await expect(page.getByTestId("settings")).toHaveCount(0);
}

async function openTeams(page: Page): Promise<Locator> {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Teams");
  await page.getByTestId("palette-item-account.teams").click();
  const teams = page.getByTestId("teams-sheet");
  await expect(teams).toBeVisible();
  return teams;
}

/**
 * The team safety code, which sits with the recovery code in a disclosure under the devices: opens
 * it and returns the safety code's section.
 */
async function safetyCode(teams: Locator): Promise<Locator> {
  const codes = teams.getByTestId("team-codes");
  if ((await codes.getAttribute("open")) === null) await codes.getByTestId("team-codes-open").click();
  return teams.getByTestId("team-safety-code");
}

/** The groups of a code a `VerificationCode` shows, joined by single spaces. */
async function codeShown(figure: Locator): Promise<string> {
  const groups = await figure.locator('span[aria-hidden="true"]').allTextContents();
  return groups.join(" ");
}

/** An approval code as a waiting device shows it: 18 Crockford base32 characters in three groups of six. */
const APPROVAL_CODE = /^[0-9A-HJKMNP-TV-Z]{6} [0-9A-HJKMNP-TV-Z]{6} [0-9A-HJKMNP-TV-Z]{6}$/;

/** `code` with one character changed, at the start (from the device's keys) or at the end (random). */
function mistyped(code: string, where: "first" | "last"): string {
  const chars = code.replace(/\s/g, "");
  const at = where === "first" ? 0 : chars.length - 1;
  return `${chars.slice(0, at)}${chars[at] === "0" ? "1" : "0"}${chars.slice(at + 1)}`;
}

test("a new team's recovery code is shown once, and Continue waits for Print or the tick", async ({ page }) => {
  await openExample(page);
  await signIn(page, "github", "Ada");
  const teams = page.getByTestId("teams-sheet");
  await teams.getByTestId("teams-create-number").fill("36596");
  await teams.getByTestId("teams-create-name").fill("Horizon");
  await teams.getByTestId("teams-create-submit").click();

  const sheet = teams.getByTestId("recovery-code-sheet");
  await expect(sheet).toBeVisible();
  await expect(teams).toContainText("Your team's recovery code");
  await expect(sheet).toContainText("Keep this code safe for 36596 Horizon.");
  await expect(sheet.getByTestId("recovery-code-text")).toHaveText(/^ZNTH(-[0-9A-Z]{5,6}){5}$/);
  // Required at creation: no Cancel, and Continue waits.
  await expect(sheet.getByTestId("recovery-code-cancel")).toHaveCount(0);
  const next = sheet.getByTestId("recovery-code-continue");
  await expect(next).toHaveAttribute("aria-disabled", "true");
  await next.click({ force: true });
  await expect(sheet).toBeVisible();
  await shot(page, "1-recovery-sheet");

  // The tick is enough, and so is Print.
  await sheet.getByTestId("recovery-code-saved").check();
  await expect(next).toHaveAttribute("aria-disabled", "false");
  await sheet.getByTestId("recovery-code-saved").uncheck();
  await expect(next).toHaveAttribute("aria-disabled", "true");
  await sheet.getByTestId("recovery-code-print").click();
  expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(1);
  await expect(sheet.getByTestId("recovery-code-printed")).toBeVisible();
  await expect(next).toHaveAttribute("aria-disabled", "false");

  // The printed page: the team, the code, the date and one line, and nothing else of the app.
  await page.emulateMedia({ media: "print" });
  const printPage = page.getByTestId("recovery-code-print-page");
  await expect(printPage).toBeVisible();
  await expect(page.getByTestId("toolbar")).toBeHidden();
  await expect(sheet.getByTestId("recovery-code-continue")).toBeHidden();
  await expect(printPage).toContainText("36596 Horizon");
  await page.screenshot({ path: `${SHOTS.replace(/\/?$/, "/")}keys-2-printed-page.png`, fullPage: true });
  await page.emulateMedia({ media: "screen" });

  await next.click();
  await expect(teams.getByTestId("recovery-code-sheet")).toHaveCount(0);
  await expect(teams.getByTestId("teams-my-role")).toHaveText("Owner");
  // What the encryption means and who may do what, then the codes one click away.
  await expect(teams.getByTestId("team-privacy")).toContainText("Horizon and Google cannot read them");
  await expect(teams.getByTestId("team-privacy-role-pending")).toContainText("Waiting for approval");
  await expect(teams.getByTestId("team-safety-code")).toBeHidden();
  await expect(await safetyCode(teams)).toBeVisible();
  await expect(teams.getByTestId("team-recovery-new")).toBeVisible();
});

/** The sizes the recovery code sheet is checked at: the two the layout is made for, and a phone's width. */
const RECOVERY_SIZES = [LARGE_VIEWPORT, VIEWPORT, { width: 390, height: 844 }] as const;

/** True when two boxes share more than a pixel of area. */
const intersects = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean =>
  Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1 && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1;

for (const size of RECOVERY_SIZES) {
  test(`at ${String(size.width)}x${String(size.height)}, Print's tooltip on the recovery code sheet leaves the saved tick and its words in view`, async ({ page }) => {
    await page.setViewportSize(size);
    await openExample(page);
    await signIn(page, "github", "Ada");
    const teams = page.getByTestId("teams-sheet");
    await teams.getByTestId("teams-create-number").fill("36596");
    await teams.getByTestId("teams-create-name").fill("Horizon");
    await teams.getByTestId("teams-create-submit").press("Enter");
    const sheet = teams.getByTestId("recovery-code-sheet");
    await expect(sheet).toBeVisible();
    const print = sheet.getByTestId("recovery-code-print");
    const saved = sheet.getByTestId("recovery-code-saved");
    const savedLabel = sheet.locator("label").filter({ has: page.getByTestId("recovery-code-saved") });
    await print.scrollIntoViewIfNeeded();
    // Keyboard focus, as when the sheet opens under a keyboard press, opens the tooltip at once.
    await print.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(print).toBeFocused();
    const bubble = page.getByRole("tooltip");
    await expect(bubble).toBeVisible();
    await expect(bubble).toContainText("Print the code");
    const clear = async (): Promise<void> => {
      for (const target of [saved, savedLabel]) {
        const [tip, box] = await Promise.all([bubble.boundingBox(), target.boundingBox()]);
        expect(tip).not.toBeNull();
        expect(box).not.toBeNull();
        expect(intersects(tip!, box!), `tooltip ${JSON.stringify(tip)} over ${JSON.stringify(box)}`).toBe(false);
      }
    };
    await clear();
    // The pointer on Print opens the same tooltip, clear of the tick too, and the tick can be clicked.
    await print.blur();
    await expect(bubble).toHaveCount(0);
    await print.hover();
    await expect(bubble).toBeVisible();
    await clear();
    await saved.check();
    await expect(saved).toBeChecked();
    await shot(page, `recovery-print-tooltip-${String(size.width)}`);
  });
}

test("an owner approves a new member only by typing the code their device shows, and is offered a new recovery code after removing them", async ({ page }) => {
  await openExample(page);
  await signIn(page, "github", "Ada");
  await createTeam(page, 36596, "Horizon");
  const teams = page.getByTestId("teams-sheet");
  await teams.getByTestId("invite-create").click();
  const link = (await teams.getByTestId("invite-link-text").textContent()) ?? "";
  expect(link).toContain("?cloud=fake#/join/");

  // Grace asks to join; her device shows its approval code.
  await signOut(page);
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, new URL(link).hash);
  const join = page.getByTestId("signin-sheet");
  await join.getByTestId("signin-google").click();
  await join.getByTestId("signin-display-name").fill("Grace");
  await join.getByTestId("signin-display-name-save").click();
  await join.getByTestId("join-submit").click();
  await join.getByTestId("join-finish").click();
  const graceTeams = page.getByTestId("teams-sheet");
  await expect(graceTeams.getByTestId("teams-pending")).toBeVisible();
  const waiting = graceTeams.getByTestId("waiting-for-key");
  await expect(waiting).toContainText("An owner or admin of 36596 Horizon approves you.");
  const code = await codeShown(waiting.getByTestId("waiting-for-key-code"));
  expect(code).toMatch(APPROVAL_CODE);
  // One code on the screen: the approval code, not the verification code as well.
  await expect(waiting.locator("figure")).toHaveCount(1);
  await shot(page, "3-waiting-member");

  // Ada, on the same page, approves Grace: a wrong code is refused, the right one lets her in.
  await switchTo(page, ADA, "Ada");
  const adaTeams = await openTeams(page);
  const row = adaTeams.getByTestId("member-grace");
  await row.getByTestId("member-grace-approve").click();
  const check = row.getByTestId("member-grace-check");
  await expect(check).toContainText("Ask Grace to read out the code on their screen, and type it here.");
  await expect(check).not.toContainText("The codes match");
  const approve = check.getByTestId("member-grace-check-approve");
  const count = check.getByTestId("member-grace-check-count");
  await expect(approve).toHaveAttribute("aria-disabled", "true");
  await expect(count).toHaveText("0 of 18 characters");
  const wrong = mistyped(code, "first");
  await check.getByTestId("member-grace-check-input").fill(wrong.slice(0, 5));
  await expect(count).toHaveText("5 of 18 characters");
  await expect(approve).toHaveAttribute("aria-disabled", "true");
  await check.getByTestId("member-grace-check-input").fill(wrong);
  await expect(count).toHaveText("18 of 18 characters");
  await expect(approve).toHaveAttribute("aria-disabled", "false");
  await approve.click();
  await expect(check.getByTestId("member-grace-check-error")).toHaveText(
    "That code does not match the waiting device. Check it with them and type it again.",
  );
  await expect(row).toHaveAttribute("data-role", "pending");
  await shot(page, "4-wrong-code");

  // Typed any way: lower case, with dashes.
  await check.getByTestId("member-grace-check-input").fill(code.toLowerCase().replace(/\s+/g, "-"));
  await expect(check.getByTestId("member-grace-check-error")).toHaveCount(0);
  await expect(count).toHaveText("18 of 18 characters");
  await check.getByTestId("member-grace-check-input").blur();
  await shot(page, "4b-approval-typed");
  await approve.click();
  await expect(row).toHaveAttribute("data-role", "editor");

  // Grace's device now has the key: no waiting, and her team's safety code.
  await switchTo(page, GRACE, "Grace");
  const after = await openTeams(page);
  await expect(after.getByTestId("waiting-for-key")).toHaveCount(0);
  await expect(await safetyCode(after)).toBeVisible();

  // Ada removes Grace. The notice suggests a new recovery code, and its button opens Recovery code's question.
  await switchTo(page, ADA, "Ada");
  const removing = await openTeams(page);
  await removing.getByTestId("member-grace-remove").click();
  await removing.getByTestId("member-grace-confirm-yes").click();
  await expect(removing.getByTestId("member-grace")).toHaveCount(0);
  await expect(removing.getByTestId("account-notice")).toContainText("If they ever saw the team's recovery code, make a new one");
  // The status line says one short line, whose words end clear of the open sheet; the whole notice is in the sheet.
  const status = page.getByTestId("status");
  await expect(status).toContainText("Removed the member. See Teams for what to do next.");
  await expect(status).not.toContainText("recovery code");
  const words = await status.locator("span").first().boundingBox();
  const sheetBox = await removing.boundingBox();
  if (words === null || sheetBox === null) throw new Error("the status line or the Teams sheet is not on screen");
  expect(words.x + words.width).toBeLessThanOrEqual(sheetBox.x);
  await shot(page, "4c-removed-status");
  await removing.getByTestId("account-notice-new-recovery-code").click();
  await expect(removing.getByTestId("team-recovery-confirm")).toBeVisible();
  await expect(removing.getByTestId("account-notice-new-recovery-code")).toHaveCount(0);

  // Grace opens Teams and is told which team she is no longer in.
  await switchTo(page, GRACE, "Grace");
  const removed = await openTeams(page);
  await expect(removed.getByTestId("teams-removed-from")).toHaveText(
    "You are no longer a member of 36596 Horizon. If you did not leave it, an owner or admin removed you or deleted the team. To come back, ask an owner or admin for a new invite.",
  );
  await expect(removed).not.toContainText("You are not in a team yet.");
  await shot(page, "4d-removed-member");
});

test("a member's second device waits, and their first device approves it by typing its 18-character code", async ({ page }) => {
  await openExample(page);
  await signIn(page, "github", "Ada");
  await createTeam(page, 36596, "Horizon");

  // The same member on a new device of the fake cloud.
  const account = await developerSettings(page);
  await expect(account.getByTestId("fake-device-now")).toContainText("fake device 1 of 1");
  await account.getByTestId("fake-device-new").click();
  await expect(account.getByTestId("fake-device-now")).toContainText("fake device 2 of 2");
  const teams = await openTeams(page);
  const waiting = teams.getByTestId("waiting-for-key");
  await expect(waiting).toContainText("One of your own devices, or an owner or admin of the team, approves this one.");
  const code = await codeShown(waiting.getByTestId("waiting-for-key-code"));
  expect(code).toMatch(APPROVAL_CODE);

  // The library says the same, and local mode still works: the example auto is still open.
  await page.getByTestId("toolbar-account.library").click();
  await expect(page.getByTestId("library-sheet").getByTestId("waiting-for-key")).toBeVisible();
  await expect(page.getByTestId("library-publish")).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await shot(page, "5-second-device-waiting");

  // Back on the first device: the request is Ada's own.
  await (await developerSettings(page)).getByTestId("fake-device-1").click();
  await expect((await developerSettings(page)).getByTestId("fake-device-now")).toContainText("fake device 1 of 2");
  const first = await openTeams(page);
  const requests = first.getByTestId("device-requests");
  await expect(requests).toContainText("Your new device");
  const row = requests.locator('li[data-testid^="device-request-"]').first();
  await row.locator('[data-testid$="-approve"]').first().click();
  const check = row.locator('[data-testid$="-check"]');
  await expect(check).toContainText("Type the approval code your new device shows.");
  const input = check.locator('[data-testid$="-check-input"]');

  // A mistake in the first part is caught here: it is not this device's code.
  await input.fill(mistyped(code, "first"));
  await check.locator('[data-testid$="-check-approve"]').click();
  await expect(check.locator('[data-testid$="-check-error"]')).toHaveText(
    "That code does not match the waiting device. Check it with them and type it again.",
  );
  await expect(requests).toContainText("Your new device");

  // A mistake in the random last part is caught here too, since the first part is computed from it.
  await input.fill(mistyped(code, "last"));
  await check.locator('[data-testid$="-check-approve"]').click();
  await expect(check.locator('[data-testid$="-check-error"]')).toHaveText(
    "That code does not match the waiting device. Check it with them and type it again.",
  );
  await expect(requests).toContainText("Your new device");

  // Declined, the new device says its request is gone, keeps its code, and asks again.
  await check.locator('[data-testid$="-check-decline"]').click();
  await expect(first.getByTestId("device-requests")).toHaveCount(0);
  await (await developerSettings(page)).getByTestId("fake-device-2").click();
  const refused = await openTeams(page);
  const gone = refused.getByTestId("waiting-for-key");
  await expect(gone.getByTestId("waiting-for-key-not-waiting")).toBeVisible();
  expect(await codeShown(gone.getByTestId("waiting-for-key-code"))).toBe(code);
  await shot(page, "5a-second-device-ask-again");
  await gone.getByTestId("waiting-for-key-ask-again").click();
  await expect(gone.getByTestId("waiting-for-key-not-waiting")).toHaveCount(0);

  // The first device types the whole code right, and the second device has the key.
  await (await developerSettings(page)).getByTestId("fake-device-1").click();
  const again = await openTeams(page);
  const retry = again.getByTestId("device-requests").locator('li[data-testid^="device-request-"]').first();
  await retry.locator('[data-testid$="-approve"]').first().click();
  const retryCheck = retry.locator('[data-testid$="-check"]');
  await retryCheck.locator('[data-testid$="-check-input"]').fill(code);
  await expect(retryCheck.locator('[data-testid$="-check-count"]')).toHaveText("18 of 18 characters");
  await retryCheck.locator('[data-testid$="-check-input"]').blur();
  await shot(page, "5b-second-device-approval");
  await retryCheck.locator('[data-testid$="-check-approve"]').click();
  await expect(again.getByTestId("device-requests")).toHaveCount(0);
  await expect(again.getByTestId("team-devices")).toContainText("Your device");

  await (await developerSettings(page)).getByTestId("fake-device-2").click();
  const second = await openTeams(page);
  await expect(second.getByTestId("waiting-for-key")).toHaveCount(0);
  await expect(await safetyCode(second)).toBeVisible();
});

test("the recovery code unlocks a device when no approver is at hand", async ({ page }) => {
  await openExample(page);
  await signIn(page, "github", "Ada");
  const recovery = await createTeam(page, 36596, "Horizon");
  await (await developerSettings(page)).getByTestId("fake-device-new").click();
  const teams = await openTeams(page);
  await teams.getByTestId("waiting-for-key-recovery").click();
  const entry = teams.getByTestId("recovery-code-entry");
  await expect(entry).toContainText("Use the recovery code for 36596 Horizon");
  await entry.getByTestId("recovery-entry-input").fill("ZNTH-AAAAA-AAAAA-AAAAA-AAAAA-AAAAAA");
  await entry.getByTestId("recovery-entry-submit").click();
  await expect(entry.getByTestId("recovery-entry-error")).toBeVisible();
  await expect(teams.getByTestId("team-safety-code")).toHaveCount(0);
  // Typed without the prefix and in lower case.
  await entry.getByTestId("recovery-entry-input").fill(recovery.replace(/^ZNTH-/, "").toLowerCase());
  await entry.getByTestId("recovery-entry-submit").click();
  await expect(teams.getByTestId("recovery-code-entry")).toHaveCount(0);
  await expect(teams.getByTestId("waiting-for-key")).toHaveCount(0);
  await expect(await safetyCode(teams)).toBeVisible();
  await expect(teams).toContainText("Unlocked the team library on this device with the recovery code.");
});

test("a partner team's safety code is shown before the first share, and its changed key before the next", async ({ page }) => {
  await openExample(page);
  await signIn(page, "google", "Grace");
  await createTeam(page, 12345, "Partner team");
  const partnerCode = await codeShown(page.getByTestId("teams-sheet").getByTestId("team-safety-code-code"));
  await signOut(page);
  await signIn(page, "github", "Ada");
  await createTeam(page, 36596, "Horizon");
  await page.getByTestId("teams-sheet-close").click();

  // The first share shows the partner's safety code, and one click shares and pins its key.
  await page.getByTestId("toolbar-share.open").click();
  const sheet = page.getByTestId("share-sheet");
  await sheet.getByTestId("share-publish").click();
  await expect(sheet.getByTestId("share-publish-first")).toHaveCount(0);
  await sheet.getByTestId("share-team-input").fill("12345");
  await sheet.getByTestId("share-team-input").press("Enter");
  await sheet.getByTestId("share-submit").click();
  const first = sheet.getByTestId("first-share-code");
  await expect(first).toBeVisible();
  await expect(first).toContainText("Check 12345 Partner team's safety code");
  await expect(first).toContainText("Compare this code with that team, by phone or in person, before you share. How to check");
  await expect(first.getByTestId("first-share-code-how")).toHaveAttribute("href", /teams-and-sharing\/#keys-and-your-team$/);
  expect(await codeShown(first.getByTestId("first-share-code-code"))).toBe(partnerCode);
  await shot(page, "5c-first-share-code");
  await first.getByTestId("first-share-code-share").click();
  await expect(sheet.getByTestId("share-done")).toBeVisible();
  await sheet.getByTestId("share-done").click();
  await expect(page.getByTestId("sharing-chip")).toHaveText("Shared with 1 team");

  // A server that swaps the partner's key: the pin no longer matches what it shows.
  await page.evaluate(() => {
    for (const pins of window.__zenithFakePins ?? []) {
      for (const key of pins.keys()) {
        if (!key.startsWith("zenith.pin.partner.")) continue;
        // Only the fingerprint changes: the pin keeps its version and signing key.
        const pin = JSON.parse(pins.get(key) ?? "{}") as { v: number; sk: string };
        pins.set(key, JSON.stringify({ ...pin, fp: "A".repeat(43) }));
      }
    }
  });

  await page.getByTestId("toolbar-share.open").click();
  await sheet.getByTestId("share-team-input").fill("12345");
  await sheet.getByTestId("share-team-input").press("Enter");
  await sheet.getByTestId("share-submit").click();
  const warning = sheet.getByTestId("key-changed-warning");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("12345 Partner team's key changed");
  await expect(warning.getByTestId("key-changed-warning-code")).toBeVisible();
  await shot(page, "6-key-changed");
  await warning.getByTestId("key-changed-warning-dont-send").click();
  await expect(sheet.getByTestId("key-changed-warning")).toHaveCount(0);
  await expect(sheet.getByTestId("share-submit")).toBeVisible();
  const liveShares = async (): Promise<number> => {
    await page.getByTestId("toolbar-share.page").click();
    const list = page.getByTestId("sharing-page");
    await expect(list).toBeVisible();
    const count = await list.locator('li[data-state="active"]').count();
    await page.getByTestId("sharing-page-close").click();
    return count;
  };
  expect(await liveShares()).toBe(1);

  // Continue, after comparing the codes, trusts the key and sends.
  await page.getByTestId("toolbar-share.open").click();
  await sheet.getByTestId("share-team-input").fill("12345");
  await sheet.getByTestId("share-team-input").press("Enter");
  await sheet.getByTestId("share-submit").click();
  await sheet.getByTestId("key-changed-warning").getByTestId("key-changed-warning-continue").click();
  await expect(sheet.getByTestId("share-done")).toBeVisible();
  await sheet.getByTestId("share-done").click();
  await expect.poll(liveShares).toBe(2);
});

test("a share made on a removed member's device stops, and the owner shares it again in one click from the Sharing page", async ({ page }) => {
  const MO = "memory-microsoft-user";
  await openExample(page);
  await signIn(page, "google", "Grace");
  await createTeam(page, 12345, "Partner team");
  await signOut(page);
  await signIn(page, "github", "Ada");
  await createTeam(page, 36596, "Horizon");
  const teams = page.getByTestId("teams-sheet");
  await teams.getByTestId("invite-create").click();
  const link = (await teams.getByTestId("invite-link-text").textContent()) ?? "";

  // Mo joins Horizon and Ada approves Mo's device with the code it shows.
  await signOut(page);
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, new URL(link).hash);
  const join = page.getByTestId("signin-sheet");
  await join.getByTestId("signin-microsoft").click();
  await join.getByTestId("signin-display-name").fill("Mo");
  await join.getByTestId("signin-display-name-save").click();
  await join.getByTestId("join-submit").click();
  await join.getByTestId("join-finish").click();
  const code = await codeShown(page.getByTestId("teams-sheet").getByTestId("waiting-for-key").getByTestId("waiting-for-key-code"));
  await switchTo(page, ADA, "Ada");
  const approving = await openTeams(page);
  await approving.getByTestId("member-mo").getByTestId("member-mo-approve").click();
  await approving.getByTestId("member-mo-check-input").fill(code);
  await approving.getByTestId("member-mo-check-approve").click();
  await expect(approving.getByTestId("member-mo")).toHaveAttribute("data-role", "editor");

  // On Mo's device, Mo publishes the example and shares it with team 12345 for 30 days.
  await switchTo(page, MO, "Mo");
  await page.keyboard.press("Escape");
  await page.getByTestId("toolbar-share.open").click();
  const sheet = page.getByTestId("share-sheet");
  await sheet.getByTestId("share-publish").click();
  await expect(sheet.getByTestId("share-publish-first")).toHaveCount(0);
  await sheet.getByTestId("share-team-input").fill("12345");
  await sheet.getByTestId("share-team-input").press("Enter");
  await sheet.getByTestId("share-more-options").click();
  await sheet.getByTestId("share-mode-follow").click();
  await sheet.getByTestId("share-expiry-30").click();
  await sheet.getByTestId("share-submit").click();
  await sheet.getByTestId("first-share-code").getByTestId("first-share-code-share").click();
  await expect(sheet.getByTestId("share-done")).toBeVisible();
  await sheet.getByTestId("share-done").click();

  // Ada removes Mo. The team key changes, and the notice says one share stopped with it.
  await switchTo(page, ADA, "Ada");
  const removing = await openTeams(page);
  await removing.getByTestId("member-mo-remove").click();
  await removing.getByTestId("member-mo-confirm-yes").click();
  await expect(removing.getByTestId("member-mo")).toHaveCount(0);
  await expect(removing.getByTestId("account-notice")).toContainText(
    "1 share stopped, made or last changed on a removed device. Share it again from the Sharing page.",
  );

  // The Sharing page lists it as stopped, with who it was for, and no longer among the shares.
  await page.keyboard.press("Escape");
  await page.getByTestId("toolbar-share.page").click();
  const sharing = page.getByTestId("sharing-page");
  const notice = sharing.getByTestId("stopped-shares");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("These shares stopped when your team key changed.");
  const row = notice.locator('li[data-testid^="stopped-share-"]');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Team 12345");
  await expect(row).toContainText("Made or last changed on a device that was removed");
  await expect(row).toContainText("Follows the latest version");
  await expect(sharing.getByTestId("sharing-no-shares")).toBeVisible();
  await shot(page, "7-stopped-shares");

  // Share again opens the share dialog with the same team, version mode and end, and shares after
  // this device shows team 12345's safety code, as for any first share.
  await row.locator('[data-testid$="-again"]').click();
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("share-again-note")).toBeVisible();
  await expect(sheet.getByTestId("share-team-12345")).toBeVisible();
  await expect(sheet.getByTestId("share-mode-follow")).toHaveAttribute("aria-pressed", "true");
  await expect(sheet.getByTestId("share-expiry-date")).toHaveAttribute("aria-pressed", "true");
  await shot(page, "8-share-again");
  await sheet.getByTestId("share-submit").click();
  await sheet.getByTestId("first-share-code").getByTestId("first-share-code-share").click();
  await expect(sheet.getByTestId("share-done")).toBeVisible();
  await sheet.getByTestId("share-open-page").click();
  await expect(sharing.getByTestId("stopped-shares")).toHaveCount(0);
  await expect(sharing.getByTestId("sharing-shares").locator('li[data-state="active"]')).toHaveCount(1);
});

test("a share made before a member is removed still opens for the partner after the team key changes", async ({ page }) => {
  const MO = "memory-microsoft-user";
  await openExample(page);
  await signIn(page, "google", "Grace");
  await createTeam(page, 12345, "Partner team");
  await signOut(page);
  await signIn(page, "github", "Ada");
  await createTeam(page, 36596, "Horizon");
  const teams = page.getByTestId("teams-sheet");
  await teams.getByTestId("invite-create").click();
  const link = (await teams.getByTestId("invite-link-text").textContent()) ?? "";

  // Mo joins Horizon and Ada approves Mo's device with the code it shows.
  await signOut(page);
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, new URL(link).hash);
  const join = page.getByTestId("signin-sheet");
  await join.getByTestId("signin-microsoft").click();
  await join.getByTestId("signin-display-name").fill("Mo");
  await join.getByTestId("signin-display-name-save").click();
  await join.getByTestId("join-submit").click();
  await join.getByTestId("join-finish").click();
  const code = await codeShown(page.getByTestId("teams-sheet").getByTestId("waiting-for-key").getByTestId("waiting-for-key-code"));
  await switchTo(page, ADA, "Ada");
  const approving = await openTeams(page);
  await approving.getByTestId("member-mo").getByTestId("member-mo-approve").click();
  await approving.getByTestId("member-mo-check-input").fill(code);
  await approving.getByTestId("member-mo-check-approve").click();
  await expect(approving.getByTestId("member-mo")).toHaveAttribute("data-role", "editor");

  // Ada shares the example, pinned, with team 12345.
  await page.keyboard.press("Escape");
  await page.getByTestId("toolbar-share.open").click();
  const sheet = page.getByTestId("share-sheet");
  await sheet.getByTestId("share-publish").click();
  await expect(sheet.getByTestId("share-publish-first")).toHaveCount(0);
  const shareWithPartner = async (): Promise<void> => {
    await sheet.getByTestId("share-team-input").fill("12345");
    await sheet.getByTestId("share-team-input").press("Enter");
    await sheet.getByTestId("share-submit").click();
    const first = sheet.getByTestId("first-share-code");
    if ((await first.count()) > 0) await first.getByTestId("first-share-code-share").click();
    await expect(sheet.getByTestId("share-done")).toBeVisible();
    await sheet.getByTestId("share-done").click();
  };
  await shareWithPartner();

  // Grace opens it once: her device now knows Horizon's key and shows its safety code as a first share.
  await switchTo(page, GRACE, "Grace");
  await page.getByTestId("partners-panel-fold").click();
  const firstSeen = page.getByTestId("received-list");
  // The first-share check is one of the row's Details.
  await firstSeen.locator('[data-testid$="-details"]').click();
  await expect(firstSeen.locator('[data-testid$="-first"]')).toContainText("First share from team 36596 on this device.");
  await page.getByTestId("partners-panel-fold").click();
  await switchTo(page, ADA, "Ada");

  // Ada removes Mo, which changes the team key, and nothing stops: Ada made the share.
  const removing = await openTeams(page);
  await removing.getByTestId("member-mo-remove").click();
  await removing.getByTestId("member-mo-confirm-yes").click();
  await expect(removing.getByTestId("member-mo")).toHaveCount(0);
  await expect(removing.getByTestId("account-notice")).not.toContainText("stopped");
  await page.keyboard.press("Escape");

  // A second share, made at the new key, shows Grace's device Horizon's newer key.
  await page.getByTestId("toolbar-share.open").click();
  await shareWithPartner();

  // Grace lists both, and still both once her device has seen the newer key: the first share was
  // signed again with it when Ada removed Mo, so nothing waits.
  await switchTo(page, GRACE, "Grace");
  await page.getByTestId("partners-panel-fold").click();
  const received = page.getByTestId("received-list");
  const rows = received.locator('li[data-testid^="received-"]');
  await expect(rows).toHaveCount(2);
  await page.getByTestId("received-refresh").click();
  await expect(rows).toHaveCount(2);
  await expect(page.getByTestId("waiting-list")).toHaveCount(0);
  // Horizon's key changed since Grace's device first saw it, so each row says its safety code changed.
  const changed = received.locator('[data-testid$="-changed"]');
  await expect(changed).toHaveCount(2);
  await expect(changed.first()).toContainText(
    "Team 36596's safety code changed, because they replaced their team key. Compare the new code with them before you trust this share:",
  );
  await expect(received).not.toContainText("First share from team 36596");
  await page.keyboard.press("Escape");
  await changed.first().scrollIntoViewIfNeeded();
  await shot(page, "9b-changed-safety-code");
  await received.evaluate((element) => {
    element.scrollIntoView({ block: "center" });
  });
  await shot(page, "9-carried-share");
});
