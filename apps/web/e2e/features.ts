/**
 * The feature switches of Settings, General (issue #101). Commands starts on (issue #112), and
 * partner sharing and the ledger start off. A spec that tests a feature turns it on with
 * `turnOnFeatures` rather than relying on a default; the switches it does not name are stored off,
 * Commands included, so a spec written before Commands started on still sees what it was written for.
 * Full sim (issue #207) is on by default and has no row in Settings, so a stored `false` here does
 * not hide it; `ALL_FEATURES` names it like the rest.
 *
 * It merges the switches into the stored UI preferences before the page loads, and only when the
 * preferences carry no switches yet, so a test that changes a switch and reloads keeps its change.
 * Call it after any init script that writes `zenith.ui` only while it is empty (most specs' tour
 * preference), so that one still sees an empty store.
 */
import type { BrowserContext, Page } from "@playwright/test";

export interface Features {
  partners: boolean;
  ledger: boolean;
  commands: boolean;
  optimizer: boolean;
  fullSim: boolean;
}

export const ALL_FEATURES: Features = { partners: true, ledger: true, commands: true, optimizer: true, fullSim: true };

/** `on` is a page, or a browser context when the test opens more than one page (a host's popup). */
export async function turnOnFeatures(on: Page | BrowserContext, features: Partial<Features> = ALL_FEATURES): Promise<void> {
  await on.addInitScript((wanted: Partial<Features>) => {
    let prefs: Record<string, unknown> = {};
    try {
      prefs = JSON.parse(window.localStorage.getItem("zenith.ui") ?? "{}") as Record<string, unknown>;
    } catch {
      prefs = {};
    }
    if (prefs["features"] !== undefined) return;
    prefs["features"] = { partners: false, ledger: false, commands: false, optimizer: false, fullSim: false, ...wanted };
    // Stored at the current preferences version (`PREFS_VERSION` in src/state/prefs.ts), so the
    // one-time switch-on of Commands for older saves leaves these switches as the spec set them.
    prefs["version"] = 1;
    window.localStorage.setItem("zenith.ui", JSON.stringify(prefs));
  }, features);
}
