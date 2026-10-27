/**
 * The public web build has no fake cloud (owner ruling 2026-09-30): `?cloud=fake` in the address and
 * `zenith.cloudFake` in browser storage do nothing there, so no Sign in, Share or Sharing control
 * appears and a share link still says sharing is not in this build. The dev server keeps the fake
 * for the end-to-end specs in e2e/.
 */
import { expect, test, type Page } from "@playwright/test";

const BASE = "/zenith/app/";

const CLOUD_TEST_IDS = ["toolbar-share.open", "toolbar-share.page", "account-toolbar", "toolbar-sign-in", "sharing-chip", "signin-sheet", "fake-users"];

async function expectNoCloudUi(page: Page): Promise<void> {
  for (const id of CLOUD_TEST_IDS) await expect(page.getByTestId(id), id).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
    window.localStorage.setItem("zenith.cloudFake", "on");
  });
});

test("?cloud=fake and the stored fake switch leave the cloud off in the public build", async ({ page }) => {
  await page.goto(`${BASE}?cloud=fake`);
  await expect(page.getByTestId("toolbar")).toBeVisible();
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await expectNoCloudUi(page);

  await page.goto(`${BASE}?cloud=fake#/s/AAAAAAAAAAAAAAAAAAAAAA`);
  await expect(page.getByTestId("cloud-off-link")).toContainText("Sharing isn't available in this build");
  await expectNoCloudUi(page);
});
