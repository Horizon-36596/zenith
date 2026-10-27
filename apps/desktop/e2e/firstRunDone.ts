/**
 * What every desktop spec writes into a new profile's localStorage before it reloads the window: the
 * first-run tour as seen, and this version's beta notice as dismissed, so neither sits over the
 * buttons a spec drives. Both have their own web tests (apps/web/e2e/tour.spec.ts and
 * beta-notice.spec.ts). The notice's key names the version the way
 * apps/web/src/dialogs/betaNoticeState.ts does, read from the root package.json that the renderer's
 * build reads.
 */
import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";

const version = (JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string }).version;

/** The beta notice's dismissal key for this version (`betaNoticeKey` in the web app). */
export const BETA_NOTICE_KEY = `zenith.betaNotice.${version}`;

/** Marks the tour seen and the beta notice dismissed. The caller reloads for them to take effect. */
export async function seedFirstRunDone(page: Page): Promise<void> {
  await page.evaluate((noticeKey) => {
    localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
    localStorage.setItem(noticeKey, "dismissed");
  }, BETA_NOTICE_KEY);
}

/**
 * For a spec that cannot reload, because the window takes a launch's request only on its first load:
 * the notice that first load showed is closed with Got it, as a person would.
 */
export async function closeFirstLoadNotice(page: Page): Promise<void> {
  await page.getByTestId("beta-notice-ok").click();
  await expect(page.getByTestId("beta-notice")).toHaveCount(0);
}
