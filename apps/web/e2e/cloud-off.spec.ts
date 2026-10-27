/**
 * The editor with the cloud off, as it is published: no `VITE_ZENITH_FIREBASE_CONFIG` in the build
 * and no `?cloud=fake` in the address. No cloud control shows anywhere (the toolbar, the command
 * palette, the shortcut sheet, `#/admin`), a share link, an invite link and `#/admin` each open a
 * plain page saying that part is not in this version, the page asks no host but its own, and everything that works without an
 * account still works: imports, envelopes and the alliance view with partner files.
 *
 * Screenshots go to test-results/cloud-off/, which git ignores, or to ZENITH_E2E_SHOTS when set.
 */
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";
import { choosePreset, openMore } from "./qa/helpers";

const SHOTS = process.env["ZENITH_E2E_SHOTS"] ?? fileURLToPath(new URL("../test-results/cloud-off/", import.meta.url));
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS.replace(/\/?$/, "/")}cloud-off-${name}.png` });

const PARTNER = fileURLToPath(
  new URL("../../../examples/starter/partners/starter-partner.projection.json", import.meta.url),
);
const PROPOSE_PARTNER = fileURLToPath(
  new URL("../../../examples/starter/partners/starter-collect-and-score.propose.projection.json", import.meta.url),
);
const fixture = (path: string): string =>
  fileURLToPath(new URL(`../../../packages/import/fixtures/${path}`, import.meta.url));

/** The test ids of every cloud control; none of them may exist with the cloud off. */
const CLOUD_TEST_IDS = [
  "toolbar-share.open",
  "toolbar-share.page",
  "account-toolbar",
  "toolbar-sign-in",
  "sharing-chip",
  "signin-sheet",
  "share-sheet",
  "sharing-page",
  "received-shares",
  "opened-links",
  "admin-page",
  "proposal-send",
];

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

async function expectNoCloudUi(page: Page): Promise<void> {
  for (const id of CLOUD_TEST_IDS) await expect(page.getByTestId(id), id).toHaveCount(0);
}

async function openExample(page: Page, hash = ""): Promise<void> {
  await page.goto(`/${hash}`);
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
}

test("no Share, Sharing, Sign in or account control in the toolbar, the palette or the shortcut sheet", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("toolbar")).toBeVisible();
  await expectNoCloudUi(page);
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await expectNoCloudUi(page);
  await page.getByTestId("toolbar").screenshot({ path: `${SHOTS.replace(/\/?$/, "/")}cloud-off-toolbar.png` });

  await page.keyboard.press("Control+k");
  const input = page.getByTestId("palette-input");
  for (const word of ["share", "sharing", "team", "invite", "sign in", "library", "outbox", "admin"]) {
    await input.fill(word);
    await expect(page.locator('[data-testid^="palette-item-share."]'), word).toHaveCount(0);
    await expect(page.locator('[data-testid^="palette-item-account."]'), word).toHaveCount(0);
  }
  // The share file is offline, so it stays, described without shares or a cloud.
  await input.fill("share");
  await expect(page.getByTestId("palette-item-project.downloadShareFile")).toBeVisible();
  await shot(page, "palette");
  await page.keyboard.press("Escape");

  await page.keyboard.press("?");
  const sheet = page.getByTestId("shortcuts-overlay");
  await expect(sheet).toBeVisible();
  await expect(sheet).not.toContainText("Share this auto");
  await expect(sheet).not.toContainText("Sharing");
  await expect(sheet).not.toContainText("Team library");
});

/** The 0.1.2 UX sweep (W1-9): with no account to have, the Settings tooltip does not offer one. */
test("the Settings button's tooltip leaves out the account", async ({ page }) => {
  await openExample(page);
  await page.getByTestId("toolbar-settings").hover();
  const tip = page.getByRole("tooltip");
  await expect(tip).toContainText("The features you use, this project's robot, and how the editor looks.");
  await expect(tip).not.toContainText("account");
});

test("#/admin says the admin page is not in this build, also with an auto open", async ({ page }) => {
  await page.goto("/#/admin");
  const notice = page.getByTestId("cloud-off-link");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("The admin page isn't available in this build");
  await expectNoCloudUi(page);
  await expect(page.getByText("Team number review")).toHaveCount(0);
  await shot(page, "admin");
  await notice.getByTestId("cloud-off-link-close").click();
  await expect(notice).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("");

  // Set with an auto open, too.
  await page.getByTestId("canvas-load-example").click();
  await page.evaluate(() => {
    window.location.hash = "#/admin";
  });
  await expect(notice).toContainText("The admin page isn't available in this build");
  await page.keyboard.press("Escape");
  await expect(notice).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("");
  await expect(page.getByTestId("admin-page")).toHaveCount(0);
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
});

test("a share link says sharing is not in this build, and closing it clears the address", async ({ page }) => {
  await page.goto("/#/s/AAAAAAAAAAAAAAAAAAAAAA");
  const notice = page.getByTestId("cloud-off-link");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Sharing isn't available in this build");
  await expect(notice).toContainText("share file");
  await shot(page, "share-link");
  await notice.getByTestId("cloud-off-link-close").click();
  await expect(notice).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("");
  await expect(page.getByTestId("canvas-load-example")).toBeVisible();
  await expectNoCloudUi(page);
});

test("a first visit through a share link still opens the example, the preset card and the tour once the page is closed", async ({
  page,
}) => {
  // A new visitor: nothing in browser storage, so the first visit has not happened yet.
  await page.addInitScript(() => {
    window.localStorage.removeItem("zenith.ui");
  });
  await page.goto("/#/s/AAAAAAAAAAAAAAAAAAAAAA");
  const notice = page.getByTestId("cloud-off-link");
  await expect(notice).toBeVisible();
  await expect(page.getByTestId("tour")).toHaveCount(0);
  await expect(page.getByTestId("preset-card")).toHaveCount(0);
  await notice.getByTestId("cloud-off-link-close").click();
  // Closed, the address is the plain one with nothing open, so the first run goes on as it does
  // there: the example, then the preset card, then the tour on the preset chosen.
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
  await expect(page.getByTestId("tour")).toHaveCount(0);
  await choosePreset(page);
  await expect(page.getByTestId("tour")).toBeVisible();
  await shot(page, "share-link-first-visit");
});

test("an invite link says teams are not in this build, also with an auto open", async ({ page }) => {
  await openExample(page);
  await page.evaluate(() => {
    window.location.hash = "#/join/abcdefgh1234";
  });
  const notice = page.getByTestId("cloud-off-link");
  await expect(notice).toContainText("Teams aren't available in this build");
  await page.keyboard.press("Escape");
  await expect(notice).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("");
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
});

test("envelopes and the alliance view with partner files work, and a proposal is saved as a file", async ({ page }) => {
  await openExample(page);

  // An envelope on shootPreloads: the 24 in square round where it starts.
  await page.getByTestId("step-row-shootPreloads").getByRole("button").first().click();
  await openMore(page);
  await page.getByTestId("inspector-envelope-add").click();
  await expect(page.getByTestId("inspector-envelope-x")).toHaveValue("-25.00");
  await expect(page.getByTestId("inspector-envelope-y")).toHaveValue("-48.00");

  // Two partners from files, one of them at the propose level, with Suggest changes and no Send.
  await page.getByTestId("partners-panel-fold").click();
  await page.getByTestId("partners-file-input").setInputFiles(PARTNER);
  await expect(page.getByTestId("partners-list")).toContainText("Starter partner");
  await expect(page.getByTestId("alliance-findings")).toContainText("predicted");
  await page.getByTestId("partners-file-input").setInputFiles(PROPOSE_PARTNER);
  await expect(page.locator('[data-testid^="partner-suggest-"]')).toHaveCount(1);
  await expect(page.locator('[data-testid^="alliance-lane-"]')).toHaveCount(2);
  await expectNoCloudUi(page);
  await shot(page, "alliance");
  await page.locator('[data-testid^="partner-suggest-"]').click();
  await expect(page.getByTestId("proposal-save")).toBeVisible();
  await expect(page.getByTestId("proposal-send")).toHaveCount(0);
});

test("link shares kept on this computer while the cloud was on are not listed in the Partners panel", async ({ page }) => {
  // As a build with the cloud on leaves them: in localStorage signed in, in sessionStorage signed out.
  await page.addInitScript(() => {
    const kept = JSON.stringify([{ id: "keptLinkShare1", secret: "aAAAAAAAAAAAAAAAAAAAAA", label: "Shared link", via: "link", kept: true }]);
    window.localStorage.setItem("zenith.cloud.keptShares", kept);
    window.sessionStorage.setItem("zenith.cloud.keptShares", kept);
  });
  await openExample(page);
  await page.getByTestId("partners-panel-fold").click();
  await expect(page.getByTestId("partners-file-input")).toBeAttached();
  await expect(page.getByTestId("opened-links")).toHaveCount(0);
  await expect(page.getByText("Links opened here")).toHaveCount(0);
  await expectNoCloudUi(page);
});

test("the page asks no host but its own, at start-up, with an auto open and at every cloud address", async ({ page, baseURL }) => {
  const own = new URL(baseURL ?? "http://localhost").host;
  const elsewhere: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if ((url.protocol === "http:" || url.protocol === "https:") && url.host !== own) elsewhere.push(request.url());
  });
  const webSockets: string[] = [];
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).host !== own) webSockets.push(socket.url());
  });

  await openExample(page);
  for (const hash of ["#/s/AAAAAAAAAAAAAAAAAAAAAA", "#/join/abcdefgh1234", "#/admin"]) {
    await page.evaluate((next) => {
      window.location.hash = next;
    }, hash);
    await expect(page.getByTestId("cloud-off-link")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("");
  }
  await page.goto("/#/s/AAAAAAAAAAAAAAAAAAAAAA");
  await expect(page.getByTestId("cloud-off-link")).toBeVisible();
  await expectNoCloudUi(page);
  await page.waitForLoadState("networkidle");

  expect(elsewhere, "requests to other hosts").toEqual([]);
  expect(webSockets, "web sockets to other hosts").toEqual([]);
});

test("a Pedro Visualizer project imports from the palette", async ({ page }) => {
  await openExample(page);
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Import from another planner");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("palette-item-project.import").click();
  await (await chooser).setFiles(fixture("pedro/score-and-park.pp"));
  await expect(page.getByTestId("toolbar-auto-name")).toContainText("score-and-park.auto.json");
  await expect(page.getByTestId("step-row-gardenPickup")).toBeVisible();
  await expect(page.getByTestId("import-notice")).toBeVisible();
  await expectNoCloudUi(page);
});
