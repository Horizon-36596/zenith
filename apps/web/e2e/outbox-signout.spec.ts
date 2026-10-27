/**
 * Signing out with changes still waiting in the Outbox (issue #319), against the fake cloud
 * (`?cloud=fake`). Signing out clears the offline cache those changes live in (spec 13 section 6), so
 * Settings asks first, in the pane, and staying signed in keeps them to be sent when the connection
 * returns. Signing out anyway drops them, and the Outbox says "Dropped", never "Refused": the server
 * did not refuse them.
 */
import { expect, test, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";

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

/** The fake cloud's connection switch. The dev server serves the account store module itself. */
async function setOnline(page: Page, online: boolean): Promise<void> {
  await page.evaluate(async (on) => {
    const path = "/src/account/store.ts";
    const store = (await import(/* @vite-ignore */ path)) as { account: { setFakeOnline(online: boolean): Promise<void> } };
    await store.account.setFakeOnline(on);
  }, online);
}

/** Ada signs in, makes team 36596, goes offline and publishes the example: two changes wait. */
async function publishOffline(page: Page): Promise<void> {
  await page.goto("/?cloud=fake");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await page.getByTestId("toolbar-sign-in").click();
  const signIn = page.getByTestId("signin-sheet");
  await signIn.getByTestId("signin-github").click();
  await signIn.getByTestId("signin-display-name").fill("Ada");
  await signIn.getByTestId("signin-display-name-save").click();
  const teams = page.getByTestId("teams-sheet");
  await teams.getByTestId("teams-create-number").fill("36596");
  await teams.getByTestId("teams-create-name").fill("Horizon");
  await teams.getByTestId("teams-create-submit").click();
  await teams.getByTestId("recovery-code-saved").check();
  await teams.getByTestId("recovery-code-continue").click();
  await expect(teams.getByTestId("teams-my-role")).toHaveText("Owner");
  await page.getByTestId("teams-sheet-close").click();

  await setOnline(page, false);
  await expect(page.getByTestId("offline-badge")).toBeVisible();
  await page.getByTestId("toolbar-account.library").click();
  await page.getByTestId("library-sheet").getByTestId("library-publish").click();
  await expect(page.getByTestId("outbox-count")).toBeVisible();
}

async function signBackIn(page: Page): Promise<void> {
  await page.getByTestId("toolbar-sign-in").click();
  await page.getByTestId("signin-sheet").getByTestId("signin-github").click();
  await expect(page.getByTestId("toolbar-account")).toContainText("Ada");
}

test("signing out with a publish waiting asks first, and staying signed in sends it when back online", async ({ page }) => {
  await publishOffline(page);

  await page.getByTestId("toolbar-account").click();
  const settings = page.getByTestId("settings");
  await settings.getByTestId("account-sign-out").click();
  const confirm = settings.getByTestId("account-sign-out-confirm");
  await expect(confirm).toContainText("2 changes in the Outbox are not confirmed by the server yet");
  await expect(confirm).toContainText("until this computer is back online");
  // Asking signs nobody out.
  await expect(page.getByTestId("toolbar-account")).toContainText("Ada");
  await confirm.getByTestId("account-sign-out-no").click();
  await expect(confirm).toHaveCount(0);
  await settings.getByTestId("settings-close").click();

  await setOnline(page, true);
  await expect(page.getByTestId("outbox-count")).toHaveCount(0);

  // Nothing waits now, so signing out goes straight through.
  await page.getByTestId("toolbar-account").click();
  await page.getByTestId("settings").getByTestId("account-sign-out").click();
  await expect(page.getByTestId("toolbar-sign-in")).toBeVisible();

  await signBackIn(page);
  await page.getByTestId("toolbar-account.library").click();
  await expect(page.getByTestId("library-sheet").getByTestId("revision-collect-and-score-1")).toBeVisible();
});

test("signing out anyway drops the waiting publish, and the Outbox says it was dropped, not refused", async ({ page }) => {
  await publishOffline(page);

  await page.getByTestId("toolbar-account").click();
  const settings = page.getByTestId("settings");
  await settings.getByTestId("account-sign-out").click();
  await settings.getByTestId("account-sign-out-confirm").getByTestId("account-sign-out-yes").click();
  await expect(page.getByTestId("toolbar-sign-in")).toBeVisible();

  await setOnline(page, true);
  await signBackIn(page);
  await page.getByTestId("toolbar-account.outbox").click();
  const outbox = page.getByTestId("outbox-sheet");
  await expect(outbox.getByTestId("outbox-summary")).toHaveText(
    "Online. Nothing is waiting. 2 changes dropped by signing out may not have reached the server.",
  );
  const dropped = outbox.getByTestId("outbox-list").locator("li[data-state=dropped]");
  await expect(dropped).toHaveCount(2);
  await expect(dropped.first()).toContainText("Dropped");
  await expect(dropped.first()).toContainText("It may not have reached the server.");
  await expect(outbox.getByTestId("outbox-list")).not.toContainText("Refused");

  await page.getByTestId("toolbar-account.library").click();
  await expect(page.getByTestId("library-sheet")).toBeVisible();
  await expect(page.getByTestId("library-sheet").getByTestId("revision-collect-and-score-1")).toHaveCount(0);
});
