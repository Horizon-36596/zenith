/**
 * An admin invite never lets anyone in at once (owner ruling 2026-10-25), against the in-memory fake
 * cloud (`?cloud=fake`). Checked: with the admin role picked, "Approve automatically" is off and
 * cannot be ticked, and the line under it says each one is approved; an editor invite can still let
 * people in at once. Screenshots go to test-results/, which git ignores.
 */
import { expect, test } from "@playwright/test";
import { turnOnFeatures } from "./features";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
    }
  });
  await turnOnFeatures(page);
});

test("an admin invite always waits for approval, and an editor invite can still let people in at once", async ({ page }) => {
  await page.goto("/?cloud=fake");
  await page.getByTestId("canvas-load-example").click();
  await page.getByTestId("toolbar-sign-in").click();
  const sheet = page.getByTestId("signin-sheet");
  await sheet.getByTestId("signin-github").click();
  await sheet.getByTestId("signin-display-name").fill("Ada");
  await sheet.getByTestId("signin-display-name-save").click();
  const teams = page.getByTestId("teams-sheet");
  await teams.getByTestId("teams-create-number").fill("36596");
  await teams.getByTestId("teams-create-name").fill("Horizon");
  await teams.getByTestId("teams-create-submit").click();
  await teams.getByTestId("recovery-code-saved").check();
  await teams.getByTestId("recovery-code-continue").click();

  const invites = teams.getByTestId("teams-invites");
  const auto = invites.getByTestId("invite-auto-approve");
  await auto.check();
  await expect(invites).toContainText("let in at once.");

  await invites.getByTestId("invite-role-admin").click();
  await expect(auto).not.toBeChecked();
  await expect(auto).toBeDisabled();
  await expect(invites).toContainText("An admin invite for one person, each approved by an owner or admin.");
  await invites.screenshot({ path: "test-results/admin-invite-admin.png" });

  await invites.getByTestId("invite-create").click();
  await expect(teams.getByTestId("invite-link-text")).toBeVisible();

  // Back to an editor: the choice made before comes back.
  await invites.getByTestId("invite-role-editor").click();
  await expect(auto).toBeChecked();
  await expect(invites).toContainText("let in at once.");
  await invites.screenshot({ path: "test-results/admin-invite-editor.png" });
});
