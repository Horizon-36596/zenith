/**
 * "Sign in with GitHub" in GitHub mode, against the in-memory fake cloud (`?cloud=fake`), whose
 * popup hands back a development token at once. api.github.com is stubbed with `page.route`, so
 * nothing leaves the machine. Checked: the dialog opens on GitHub's sign-in and says what the access
 * reaches, the token paste is still one click away, "in this browser" survives a reload, and sign-out
 * removes it. Screenshots go to test-results/, which git ignores.
 */
import { expect, test, type Page } from "@playwright/test";

const shot = (page: Page, name: string) =>
  page.getByTestId("github-signin").screenshot({ path: `test-results/github-oauth-${name}.png` });

const TOKEN_KEY = "zenith.github.token";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
    }
  });
  // GitHub's /user, with the scopes header an OAuth token carries and the CORS headers GitHub sends.
  await page.route("https://api.github.com/user", async (route) => {
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, accept, x-github-api-version",
      "access-control-expose-headers": "x-oauth-scopes",
    };
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { ...cors, "x-oauth-scopes": "repo" },
      body: JSON.stringify({ login: "octo-horizon" }),
    });
  });
});

async function openSignIn(page: Page): Promise<void> {
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Sign in");
  await page.getByTestId("palette-item-project.signIn").click();
  await expect(page.getByTestId("github-signin")).toBeVisible();
}

test("Sign in with GitHub needs no token, and can stay signed in in this browser", async ({ page }) => {
  await page.goto("/?cloud=fake");
  await expect(page.getByTestId("toolbar")).toBeVisible();
  await openSignIn(page);

  // It opens on GitHub's own sign-in, and says plainly how far the access reaches.
  await expect(page.getByTestId("github-oauth-offer")).toBeVisible();
  await expect(page.getByTestId("github-signin")).toContainText("every repository your account can");
  await expect(page.getByTestId("github-keep-tab")).toBeChecked();
  await shot(page, "offer");

  // The token paste is still there, for access to one repository only.
  await page.getByTestId("github-use-token").click();
  await expect(page.getByTestId("github-token")).toBeVisible();
  await expect(page.getByTestId("github-signin")).toContainText("Contents: read and write");
  await shot(page, "token");
  await page.getByTestId("github-use-oauth").click();

  await page.getByTestId("github-keep-browser").check();
  await page.getByTestId("github-signin-oauth").click();
  await expect(page.getByTestId("github-signed-in")).toHaveText("Signed in as octo-horizon with GitHub.");
  await expect(page.getByTestId("github-signin")).toContainText("remembered in this browser until you sign out");
  await shot(page, "signed-in");
  expect(await page.evaluate((key) => window.localStorage.getItem(key) !== null, TOKEN_KEY)).toBe(true);
  expect(await page.evaluate((key) => window.sessionStorage.getItem(key), TOKEN_KEY)).toBeNull();

  // Reopened: signed straight back in, with no token to make and no button to press.
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByTestId("toolbar")).toBeVisible();
  await openSignIn(page);
  await expect(page.getByTestId("github-signed-in")).toContainText("Signed in as octo-horizon");

  await page.getByTestId("github-signout").click();
  await expect.poll(() => page.evaluate((key) => window.localStorage.getItem(key), TOKEN_KEY)).toBeNull();
});
