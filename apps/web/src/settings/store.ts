/**
 * Whether the Settings window is open, and at which section (issue #97). The section last shown is
 * remembered with the other UI preferences (`state/prefs.ts`), so the window opens where the person
 * left it unless an entry point asks for a section, as the toolbar's account button asks for Account.
 *
 * The window is modal, so it never sits beside a docked sheet: opening it closes the account and
 * sharing sheets, and opening one of those from inside it closes the window first.
 */
import { useSyncExternalStore } from "react";
import { cloudEnabled } from "../account/config";
import { account } from "../account/store";
import { closeSharingSheet, getCloud } from "../cloud/store";
import { clearStaleStatus, getState as getEditor, setPrefs } from "../state/store";
import { sectionShown } from "../state/features";
import { settingEntry, type SettingId } from "./registry";
import { resolveSection, visibleSections, type SettingsSection } from "./sections";

export interface SettingsState {
  open: boolean;
  /** The section showing, or last shown. */
  section: SettingsSection;
  /**
   * A row the window brings into view and focuses once, then clears: a setting's registry id
   * (`openSettingsAt`), `ROBOT_CLEARANCE`, or the test id of a row a section draws by hand (the search,
   * `openSettingsRow`). The window finds it by `data-setting` and then by `data-testid`.
   */
  focus?: string;
}

/** The row `openRobotClearance` brings into view: Robot's Clearance from field elements. */
export const ROBOT_CLEARANCE = "robot.clearance";

let settings: SettingsState = { open: false, section: "account" };
const listeners = new Set<() => void>();

const set = (next: SettingsState): void => {
  settings = next;
  for (const listener of listeners) listener();
};

/** Calls `listener` after every change, outside React. Returns the unsubscribe. */
export const subscribeSettings = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getSettings = (): SettingsState => settings;
export const useSettings = (): SettingsState => useSyncExternalStore(subscribeSettings, getSettings, getSettings);

/**
 * The section `wanted` lands on for this person now. Whether they are a Horizon admin is only known
 * once the cloud answers, so Admin is let through here; the window shows the first section instead
 * if the answer is no.
 */
function landing(wanted: SettingsSection | null): SettingsSection {
  const cloud = cloudEnabled();
  const state = account.getState();
  const visible = visibleSections({
    cloud,
    signedIn: cloud && state.user !== null && state.profile !== null,
    admin: true,
    fake: cloud && account.isFake(),
    dev: import.meta.env.DEV,
    commands: sectionShown("commands", getEditor().prefs.features),
  });
  return resolveSection(wanted, visible);
}

/** Opens the window at `section`, or at the section last shown. */
export function openSettings(section?: SettingsSection): void {
  if (account.getState().panel !== null) account.close();
  if (getCloud().sheet !== null) closeSharingSheet();
  const shown = landing(section ?? getEditor().prefs.settingsSection);
  if (shown !== getEditor().prefs.settingsSection) setPrefs({ settingsSection: shown });
  set({ open: true, section: shown });
  clearStaleStatus();
}

/**
 * Opens the window at the setting's own section with its row in view and its control focused: the
 * palette's row for an action a switch hides lands here, on that switch (spec 15 section 7).
 */
export function openSettingsAt(id: SettingId): void {
  openSettings(settingEntry(id).section);
  set({ ...settings, focus: id });
}

/** Opens `section` with the row whose `data-setting` or test id is `target` in view and its control focused (the search's results). */
export function openSettingsRow(section: SettingsSection, target: string): void {
  openSettings(section);
  set({ ...settings, focus: target });
}

/** Opens Robot with its Clearance from field elements row in view and its control focused. */
export function openRobotClearance(): void {
  openSettings("robot");
  set({ ...settings, focus: ROBOT_CLEARANCE });
}

/** Forgets the setting to focus, once the window has focused it. */
export function clearSettingsFocus(): void {
  if (settings.focus === undefined) return;
  set({ open: settings.open, section: settings.section });
}

/** Shows another section and remembers it for next time. */
export function showSettingsSection(section: SettingsSection): void {
  if (settings.open && settings.section === section) return;
  setPrefs({ settingsSection: section });
  set({ open: true, section });
}

export function closeSettings(): void {
  if (settings.open) set({ open: false, section: settings.section });
}
