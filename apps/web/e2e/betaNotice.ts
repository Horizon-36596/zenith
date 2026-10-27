/**
 * The beta notice, seen already: every Playwright config here (the editor suite, the QA suite, the
 * pages smoke) starts each browser context with this version's dismissal in localStorage, so the
 * notice never covers a test's first click. `beta-notice.spec.ts` turns the seed off to test the
 * notice itself.
 */
import { readFileSync } from "node:fs";
import { BETA_NOTICE_DISMISSED, betaNoticeKey } from "../src/dialogs/betaNoticeState";

/** The version the dev server and the built app show, read where vite.config.ts reads it. */
export const APP_VERSION = (JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string }).version;

/** This version's dismissal key. */
export const BETA_NOTICE_KEY = betaNoticeKey(APP_VERSION);

/** A `storageState` whose one origin has dismissed this version's notice. */
export function betaNoticeSeen(origin: string): { cookies: []; origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }> } {
  return { cookies: [], origins: [{ origin, localStorage: [{ name: BETA_NOTICE_KEY, value: BETA_NOTICE_DISMISSED }] }] };
}
