/**
 * The first visit's preset card, and what a choice on it does. Kept apart from `store.ts`, which the
 * action table imports, because applying a preset reaches the keymap and so the action table: this
 * module sits above both.
 */
import { afterBetaNotice } from "../dialogs/betaNoticeState";
import { getState } from "../state/store";
import { applyBuiltInPreset, applyPresetById, importPresetText, type ImportResult } from "../settings/presetStore";
import type { BuiltInPresetId } from "../settings/registry";
import { shouldOfferPreset } from "./model";
import { autoStartTour, getPresetCardOpen, getTour, setPresetCardOpen, startCoreTour } from "./store";

/**
 * The first visit, once its example has loaded: ask which preset the person wants, on the true first
 * run only (nothing seen, nothing chosen, something open), and otherwise do what a first visit
 * always did, start the core tour when it has not been seen. Host mode never comes here; it calls
 * `autoStartTour` once the host's project is open, so a host's tour has no card. The beta notice
 * comes first and alone: while it is open, all of this waits for it to close.
 */
export function startFirstRun(): void {
  afterBetaNotice(startFirstRunNow);
}

function startFirstRunNow(): void {
  const state = getState();
  if (getTour().phase !== "off") return;
  if (shouldOfferPreset(state.prefs.tour, state.prefs.preset, state.auto !== null)) setPresetCardOpen(true);
  else autoStartTour();
}

/** A choice on the card: apply the preset, and start the core tour on it. */
export function choosePresetOnFirstRun(id: BuiltInPresetId): void {
  applyBuiltInPreset(id);
  startCoreTour();
}

/**
 * Import on the card: the file's preset is added to the person's list and, since they picked it
 * here, applied, with its keys, because a first visit has none of their own to replace. A file that
 * does not read leaves the card open and says why. A file that finishes reading after the card has
 * closed, because the person chose on it meanwhile, adds and applies nothing, so it never replaces
 * that choice or starts the tour again.
 */
export function importPresetOnFirstRun(text: string, fileName?: string): ImportResult {
  if (!getPresetCardOpen()) return { ok: false, reason: "The preset card closed before the file was read, so nothing was imported." };
  const result = importPresetText(text, fileName);
  if (!result.ok) return result;
  applyPresetById(result.preset.id, { keys: true });
  startCoreTour();
  return result;
}
