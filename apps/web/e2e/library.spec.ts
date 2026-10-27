/**
 * The team library (spec 13 sections 5, 6 and 8.4) against the fake cloud (`?cloud=fake`): two
 * revisions published from one base shown side by side in the review view, with Keep and Open in
 * project, and nothing changed until one is chosen; the revision each row was published from; the
 * sharing chip on every library auto; and Keep for offline on a received share and on a link share
 * opened here.
 *
 * Screenshots go to test-results/library/, which git ignores, or to ZENITH_E2E_SHOTS when set.
 */
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { turnOnFeatures } from "./features";

const SHOTS = process.env["ZENITH_E2E_SHOTS"] ?? fileURLToPath(new URL("../test-results/library/", import.meta.url));
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS.replace(/\/?$/, "/")}library-${name}.png` });

const GRACE = "memory-google-user";
const SLUG = "collect-and-score";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("zenith.ui") === null) {
      window.localStorage.setItem(
        "zenith.ui",
        JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }),
      );
    }
    window.localStorage.removeItem("zenith.cloud.keptShares");
  });
  await turnOnFeatures(page);
});

async function openExample(page: Page): Promise<void> {
  await page.goto("/?cloud=fake");
  await page.getByTestId("canvas-load-example").click();
  await expect(page.getByTestId("step-row-driveOut")).toBeVisible();
}

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

async function switchTo(page: Page, uid: string, name: string): Promise<void> {
  await page.getByTestId("toolbar-account").click();
  await page.getByTestId("settings-nav-developer").click();
  await page.getByTestId("settings").getByTestId(`fake-switch-${uid}`).click();
  await expect(page.getByTestId("toolbar-account")).toContainText(name);
  await page.getByTestId("settings-close").click();
}

/** The fake cloud's connection switch. The dev server serves the account store module itself. */
async function setOnline(page: Page, online: boolean): Promise<void> {
  await page.evaluate(async (on) => {
    const path = "/src/account/store.ts";
    const store = (await import(/* @vite-ignore */ path)) as { account: { setFakeOnline(online: boolean): Promise<void> } };
    await store.account.setFakeOnline(on);
  }, online);
}

/**
 * Two more publishes of the library's one auto, both from revision 1, as two members editing the
 * same revision would make: the first leg's end placed 12 in either side of where it was. They go
 * through the page's own account model, the one Publish uses, so the second is marked diverged.
 */
async function publishDivergedPair(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const path = "/src/account/store.ts";
    const { account } = (await import(/* @vite-ignore */ path)) as {
      account: {
        getState(): { library: { autos: Array<{ id: string; title: string }>; revisions: Record<string, Array<{ id: string; content: string }>> } };
        markOpened(autoId: string, revisionId: string): void;
        publish(file: { fileName: string; canonical: string; project: null }): Promise<unknown>;
      };
    };
    const library = account.getState().library;
    const auto = library.autos[0];
    const first = auto === undefined ? undefined : library.revisions[auto.id]?.[0];
    if (auto === undefined || first === undefined) throw new Error("the library has no revision 1");
    const version = (yIn: number): string => {
      const doc = JSON.parse(first.content) as { steps: Array<{ segments: Array<{ to: unknown }> }> };
      const segment = doc.steps[0]?.segments[0];
      if (segment === undefined) throw new Error("the example has no first leg");
      segment.to = { xIn: -12, yIn, headingRad: 1.5708, provenance: "SET FROM EDITOR: e2e" };
      return `${JSON.stringify(doc, null, 2)}\n`;
    };
    account.markOpened(auto.id, first.id);
    await account.publish({ fileName: auto.title, canonical: version(-24), project: null });
    account.markOpened(auto.id, first.id);
    await account.publish({ fileName: auto.title, canonical: version(-48), project: null });
  });
}

test("two revisions from one base open side by side, and Keep publishes the chosen one without overwriting either", async ({ page }) => {
  await openExample(page);
  await signIn(page, "github", "Ada");
  await createTeam(page, 36596, "Horizon");
  await page.getByTestId("teams-sheet-close").click();

  await page.getByTestId("toolbar-account.library").click();
  const library = page.getByTestId("library-sheet");
  await library.getByTestId("library-publish").click();
  await expect(library.getByTestId(`revision-${SLUG}-1`)).toContainText("first revision");
  // The sharing chip on the library auto: nothing is shared yet.
  await expect(library.getByTestId(`library-auto-${SLUG}-sharing`)).toHaveText("Team only");

  await publishDivergedPair(page);
  const plain = library.getByTestId(`revision-${SLUG}-2`);
  const diverged = library.getByTestId(`revision-${SLUG}-2-diverged`);
  await expect(plain.getByTestId("revision-base")).toHaveText("from revision 1");
  await expect(diverged.getByTestId("revision-base")).toHaveText("from revision 1");
  await expect(diverged.getByTestId("revision-diverged")).toBeVisible();
  await expect(library.getByTestId(`library-auto-${SLUG}-diverged`)).toBeVisible();
  await shot(page, "1-diverged-rows");

  // Compare opens the review view; the library closes to give it the room.
  await diverged.getByTestId(`revision-${SLUG}-2-compare`).click();
  const review = page.getByTestId("library-review");
  await expect(review).toBeVisible();
  await expect(page.getByTestId("library-sheet")).toHaveCount(0);
  await expect(review.getByTestId("library-review-meta")).toContainText("both published from revision 1");
  await expect(review.getByTestId("library-review-change-driveOut")).toBeVisible();
  await expect(review.getByTestId("library-review-change-driveOut")).toContainText("Moved 24.0 in.");
  const mine = review.getByTestId("library-review-side-first");
  const other = review.getByTestId("library-review-side-second");
  await expect(mine).toHaveAttribute("data-owner", "mine");
  await expect(mine.getByRole("heading")).toHaveText("Mine");
  await expect(other.getByRole("heading")).toHaveText("The other one");
  await expect(review.getByTestId("library-review-keep-first")).toHaveText("Keep mine");
  await expect(review.getByTestId("library-review-lead")).toContainText("Both were published from the same revision.");
  await shot(page, "2-review-view");

  // Swap draws the other side solid.
  const canvas = review.getByTestId("library-review-canvas");
  const solidBefore = await canvas.getAttribute("data-solid");
  await review.getByTestId("library-review-swap").click();
  await expect(canvas).not.toHaveAttribute("data-solid", solidBefore ?? "");

  // Leaving changes nothing: the editor still has its own auto, with no unsaved edits.
  await review.getByTestId("library-review-leave").click();
  await expect(review).toHaveCount(0);
  await expect(page.getByTestId("toolbar-auto-name")).toContainText(`${SLUG}.auto.json`);
  await expect(page.getByTestId("toolbar-auto-name").getByLabel("Unsaved changes")).toHaveCount(0);

  // From the auto's own Review button this time, then Keep the other one.
  await page.getByTestId("toolbar-account.library").click();
  await page.getByTestId("library-sheet").getByTestId(`library-auto-${SLUG}-review`).click();
  await expect(review).toBeVisible();
  await review.getByTestId("library-review-keep-second").click();
  await expect(review).toHaveCount(0);
  await expect(page.getByTestId("status")).toContainText("as revision 3");

  await page.getByTestId("toolbar-account.library").click();
  const after = page.getByTestId("library-sheet");
  await expect(after.getByTestId(`revision-${SLUG}-3`)).toContainText("from revision 2");
  await expect(after.getByTestId(`revision-${SLUG}-3`)).toContainText("(newest)");
  // Both revision 2s are still there, and the divergence is settled.
  await expect(after.getByTestId(`revision-${SLUG}-2`)).toBeVisible();
  await expect(after.getByTestId(`revision-${SLUG}-2-diverged`)).toBeVisible();
  await expect(after.getByTestId(`library-auto-${SLUG}-diverged`)).toHaveCount(0);
  await shot(page, "3-kept");
});

test("the library shows how each auto is shared, and a received share and an opened link can be kept for offline", async ({ page }) => {
  await openExample(page);
  await signIn(page, "google", "Grace");
  await createTeam(page, 12345, "Partner team");
  await signOut(page);
  await signIn(page, "github", "Ada");
  await createTeam(page, 36596, "Horizon");
  await page.getByTestId("teams-sheet-close").click();

  // Ada shares the example with team 12345, then by link.
  await page.getByTestId("toolbar-share.open").click();
  const sheet = page.getByTestId("share-sheet");
  await sheet.getByTestId("share-publish").click();
  await expect(sheet.getByTestId("share-publish-first")).toHaveCount(0);
  await sheet.getByTestId("share-team-input").fill("12345");
  await sheet.getByTestId("share-team-input").press("Enter");
  await sheet.getByTestId("share-submit").click();
  // The first share with a team shows its safety code, and one click shares.
  await sheet.getByTestId("first-share-code").getByTestId("first-share-code-share").click();
  await expect(sheet.getByTestId("share-done")).toBeVisible();
  await sheet.getByTestId("share-done").click();

  await page.getByTestId("toolbar-account.library").click();
  const chip = page.getByTestId("library-sheet").getByTestId(`library-auto-${SLUG}-sharing`);
  await expect(chip).toHaveText("Shared with 1 team");
  await chip.hover();
  await expect(page.getByRole("tooltip")).toContainText("Team 12345");
  await shot(page, "4-library-chip");
  // Clicking it opens the Sharing page on that auto's shares, with Show all for the rest.
  await chip.click();
  const sharingPage = page.getByTestId("sharing-page");
  await expect(sharingPage).toBeVisible();
  await expect(page.getByTestId("library-sheet")).toHaveCount(0);
  await expect(sharingPage.getByTestId("sharing-filter")).toContainText("Showing shares of");
  await expect(sharingPage.getByTestId("sharing-filter-auto")).toHaveText("collect-and-score.auto.json");
  await expect(sharingPage.getByTestId("sharing-shares").locator('[data-testid^="share-row-"][data-state="active"]')).toHaveCount(1);
  await expect(sharingPage.getByRole("region", { name: "Invites" })).toHaveCount(0);
  await sharingPage.getByTestId("sharing-filter-show-all").click();
  await expect(sharingPage.getByTestId("sharing-filter")).toHaveCount(0);
  await expect(sharingPage.getByRole("region", { name: "Invites" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByTestId("toolbar-share.open").click();
  await sheet.getByTestId("share-audience-link").click();
  await sheet.getByTestId("share-submit").click();
  await sheet.getByTestId("share-confirm-link").click();
  const link = await sheet.getByTestId("share-link").textContent();
  await sheet.getByTestId("share-done").click();

  // Grace keeps the share her team received for offline, and it loads with the connection off.
  await switchTo(page, GRACE, "Grace");
  await page.getByTestId("partners-panel-fold").click();
  const received = page.getByTestId("received-list");
  await received.locator('[data-testid$="-details"]').click();
  const keep = received.locator('[data-testid$="-keep"]');
  await expect(keep).not.toBeChecked();
  // The box ticks once the share has been read and opened, which takes the key work a moment.
  await keep.click();
  await expect(page.getByTestId("status")).toContainText("Kept the auto from Team 36596 (unverified) for offline use");
  await expect(keep).toBeChecked();
  await received.evaluate((element) => {
    element.scrollIntoView({ block: "center" });
  });
  await shot(page, "5-received-kept");
  await setOnline(page, false);
  await expect(page.getByTestId("offline-badge")).toBeVisible();
  await received.locator('[data-testid$="-load"]').click();
  await expect(page.getByTestId("partners-list")).toContainText("Team 36596");
  await setOnline(page, true);

  // Signed out, the link opens, and is listed to open again; kept, it opens with no connection.
  await signOut(page);
  await expect(page.getByTestId("opened-links")).toHaveCount(0);
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, new URL(link ?? "").hash);
  await expect(page.getByTestId("partners-list")).toContainText("Shared link");
  const opened = page.getByTestId("opened-links-list");
  await expect(opened).toContainText("Shared link");
  await expect(opened.locator('[data-testid$="-state"]')).toHaveText("Opened on this computer");
  await opened.locator('[data-testid$="-keep"]').click();
  await expect(opened.locator('[data-testid$="-state"]')).toHaveText("Kept for offline on this computer");
  await shot(page, "6-opened-link-kept");

  await page.getByTestId("partners-list").locator('[data-testid^="partner-remove-"]').first().click();
  await setOnline(page, false);
  await opened.locator('[data-testid$="-open"]').click();
  await expect(page.getByTestId("partners-list")).toContainText("Shared link");
  await setOnline(page, true);
});
