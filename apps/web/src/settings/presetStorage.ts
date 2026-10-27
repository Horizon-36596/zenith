/**
 * `zenith.presets`, the person's own presets in localStorage under their own key, so a reset of
 * `zenith.ui` keeps them. It is read one preset at a time (`parseUserPresets`): a preset that fails to
 * parse is dropped and the rest are kept. Nothing here is synced to the cloud in this version.
 */
import { USER_PRESETS_VERSION, parseUserPresets, type UserPreset } from "./presets";

export const USER_PRESETS_KEY = "zenith.presets";

/** The stored presets, and how many could not be read. Blocked storage or junk reads as none. */
export function loadUserPresets(): { presets: UserPreset[]; dropped: number } {
  try {
    const raw = window.localStorage.getItem(USER_PRESETS_KEY);
    return raw === null ? { presets: [], dropped: 0 } : parseUserPresets(JSON.parse(raw));
  } catch {
    return { presets: [], dropped: 0 };
  }
}

/** Writes the presets. A browser with storage blocked keeps them for this visit only. */
export function saveUserPresets(presets: readonly UserPreset[]): void {
  try {
    window.localStorage.setItem(USER_PRESETS_KEY, JSON.stringify({ version: USER_PRESETS_VERSION, presets }));
  } catch {
    // Nothing to do: the list in memory still works until the page closes.
  }
}
