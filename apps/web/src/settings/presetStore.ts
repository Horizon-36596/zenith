/**
 * The person's own presets in this page, and applying any preset. The list is `zenith.presets`
 * (`presetStorage.ts`), written after every change. Applying a preset writes its values through
 * `setSettings`, the one way any setting is written, and records it in `zenith.ui` as `preset`; it never
 * touches layout, and only a user preset applied with its keys changes keys. The rules themselves are
 * pure, in `presets.ts` and `presetFile.ts`.
 */
import { useSyncExternalStore } from "react";
import { getState, setPrefs, setSettings } from "../state/store";
import { keyContext } from "../app/keymap";
import { readPresetFile, type PresetImportReport } from "./presetFile";
import { linkedCopy, type ProjectPreset } from "./projectPresets";
import { USER_PRESETS_KEY, loadUserPresets, saveUserPresets } from "./presetStorage";
import {
  BUILT_IN_PRESETS,
  MAX_USER_PRESETS,
  builtInBase,
  nameProblem,
  presetSettings,
  uniqueName,
  updatedFrom,
  userPresetFrom,
  userPresetRef,
  userPresetWrites,
  sameValue,
  type PresetId,
  type PresetRef,
  type ProjectPresetLink,
  type UserPreset,
} from "./presets";
import { SETTINGS, getSetting, type BuiltInPresetId, type SettingId, type SettingValues } from "./registry";
import type { Prefs } from "../state/prefs";

let presets: UserPreset[] | null = null;
const listeners = new Set<() => void>();

/** The person's presets, read from storage the first time they are asked for. */
export const getUserPresets = (): readonly UserPreset[] => (presets ??= loadUserPresets().presets);

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useUserPresets = (): readonly UserPreset[] => useSyncExternalStore(subscribe, getUserPresets, getUserPresets);

function notify(): void {
  for (const listener of listeners) listener();
}

function write(next: UserPreset[]): void {
  presets = next;
  saveUserPresets(next);
  notify();
}

// Another tab that changes the list (or clears storage) makes this one read it again, so its next
// change starts from that tab's list and never writes over it.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== USER_PRESETS_KEY) return;
    presets = null;
    notify();
  });
}

export type PresetResult = { ok: true; preset: UserPreset } | { ok: false; reason: string };

/** Why no preset can be added now, or undefined while one can. */
export const fullReason = (list: readonly UserPreset[] = getUserPresets()): string | undefined =>
  list.length >= MAX_USER_PRESETS ? `You have ${String(MAX_USER_PRESETS)} presets, the most Zenith keeps. Delete one first.` : undefined;

const newId = (): `user:${string}` => `user:${crypto.randomUUID()}`;

const isBuiltIn = (id: PresetId): id is BuiltInPresetId => BUILT_IN_PRESETS.some((preset) => preset.id === id);

/** Applies a built-in: its values, never the keys (spec 15 section 6.1). */
export function applyBuiltInPreset(id: BuiltInPresetId): void {
  setSettings(presetSettings(id));
  setPrefs({ preset: { id, chosen: true } });
}

/** Applies a user preset. Its keys replace the person's only with `keys`, which Settings asks about first. */
export function applyUserPresetNow(preset: UserPreset, options: { keys: boolean }): void {
  setSettings(userPresetWrites(preset, options));
  setPrefs({ preset: userPresetRef(preset, options) });
}

/**
 * What applying a preset changed: the settings it gave new values, and what puts them back in one
 * step, so Presets can say "Applied Basic: 6 settings changed." and offer Undo (UI_GUIDE 9.15).
 */
export interface PresetUndo {
  changed: SettingId[];
  values: Partial<SettingValues>;
  preset: PresetRef;
}

/** The change from `before` to `after`, the settings as they were before and after an apply. */
export function presetUndoFrom(before: Prefs, after: Prefs): PresetUndo {
  const changed = SETTINGS.filter((entry) => !sameValue(getSetting(before, entry.id), getSetting(after, entry.id))).map((entry) => entry.id);
  const values = Object.fromEntries(changed.map((id) => [id, getSetting(before, id)])) as Partial<SettingValues>;
  return { changed, values, preset: before.preset };
}

/** Puts back what an apply changed, and the preset the settings came from before it. */
export function undoPresetApply(undo: PresetUndo): void {
  setSettings(undo.values);
  setPrefs({ preset: undo.preset });
}

/** Applies the preset `id`, a built-in or one of the person's. */
export function applyPresetById(id: PresetId, options: { keys: boolean }): void {
  if (isBuiltIn(id)) {
    applyBuiltInPreset(id);
    return;
  }
  const preset = getUserPresets().find((one) => one.id === id);
  if (preset !== undefined) applyUserPresetNow(preset, options);
}

/**
 * Saves the current settings as a new preset, and records it as the one the settings came from,
 * since they are now exactly it. The keys go in only with `includeKeys`.
 */
export function saveCurrentAsPreset(given: { name: string; description: string; includeKeys: boolean }): PresetResult {
  const list = getUserPresets();
  const why = fullReason(list) ?? nameProblem(given.name, list);
  if (why !== undefined) return { ok: false, reason: why };
  const { prefs } = getState();
  const preset = userPresetFrom(prefs, { ...given, id: newId(), basedOn: builtInBase(prefs.preset, list) });
  write([...list, preset]);
  setPrefs({ preset: userPresetRef(preset) });
  return { ok: true, preset };
}

/** Renames one of the person's presets. */
export function renamePreset(id: string, name: string): PresetResult {
  const list = getUserPresets();
  const preset = list.find((one) => one.id === id);
  if (preset === undefined) return { ok: false, reason: "That preset is gone." };
  const why = nameProblem(name, list, id);
  if (why !== undefined) return { ok: false, reason: why };
  const renamed = { ...preset, name: name.trim() };
  write(list.map((one) => (one.id === id ? renamed : one)));
  return { ok: true, preset: renamed };
}

/** An editable copy of a preset, built-in or the person's, named "Name (2)" (spec 15 section 6.1). */
export function duplicatePreset(id: PresetId): PresetResult {
  const list = getUserPresets();
  const why = fullReason(list);
  if (why !== undefined) return { ok: false, reason: why };
  let copy: UserPreset;
  if (isBuiltIn(id)) {
    const builtIn = BUILT_IN_PRESETS.find((preset) => preset.id === id);
    copy = { id: newId(), name: uniqueName(builtIn?.name ?? "Preset", list), description: builtIn?.description ?? "", basedOn: id, settings: presetSettings(id) };
  } else {
    const source = list.find((one) => one.id === id);
    if (source === undefined) return { ok: false, reason: "That preset is gone." };
    // A copy is the person's own: it is not linked to the project file its source came from.
    const { fromProject: _link, ...rest } = source;
    copy = { ...rest, id: newId(), name: uniqueName(source.name, list) };
  }
  write([...list, copy]);
  return { ok: true, preset: copy };
}

/** Replaces a preset's settings, and its keys when it carries keys, with the current ones. */
export function updatePresetFromCurrent(id: string): PresetResult {
  const list = getUserPresets();
  const preset = list.find((one) => one.id === id);
  if (preset === undefined) return { ok: false, reason: "That preset is gone." };
  const updated = updatedFrom(preset, getState().prefs);
  write(list.map((one) => (one.id === id ? updated : one)));
  return { ok: true, preset: updated };
}

/**
 * Deletes one of the person's presets. Deleting the recorded one keeps the person's values, and the
 * header then reads "Custom (based on Essential)": the base stays recorded for that.
 */
export function deletePreset(id: string): void {
  const list = getUserPresets();
  const preset = list.find((one) => one.id === id);
  if (preset === undefined) return;
  const { prefs } = getState();
  if (prefs.preset.id === id) setPrefs({ preset: { ...prefs.preset, basedOn: preset.basedOn } });
  write(list.filter((one) => one.id !== id));
}

export type ImportResult = { ok: true; preset: UserPreset; report: PresetImportReport } | { ok: false; reason: string };

/** Adds the preset in a preset file's text to the list. It applies nothing (spec 15 section 6.4). */
export function importPresetText(text: string, fileName?: string): ImportResult {
  const list = getUserPresets();
  const full = fullReason(list);
  if (full !== undefined) return { ok: false, reason: full };
  const read = readPresetFile(text, list, { context: keyContext(), ...(fileName === undefined ? {} : { fileName }) });
  if (!read.ok) return read;
  const preset: UserPreset = { ...read.preset, id: newId() };
  write([...list, preset]);
  return { ok: true, preset, report: read.report };
}

/**
 * Applies one of the open project's presets (spec 15 section 6.5): the person's copy linked to its
 * file is brought up to date with the file, or, the first time, a linked copy is added under the
 * file's name ("Name (2)" when they have one of that name), and that copy is applied. A copy keeps
 * the name the person gave it. With 20 presets and no linked copy, nothing changes.
 */
export function applyProjectPreset(project: string, item: ProjectPreset, options: { keys: boolean }): PresetResult {
  const list = getUserPresets();
  const linked = linkedCopy(list, project, item.file);
  const fromFile = {
    description: item.preset.description,
    basedOn: item.preset.basedOn,
    settings: item.preset.settings,
    ...(item.preset.keys === undefined ? {} : { keys: item.preset.keys }),
    fromProject: { project, file: item.file },
  };
  let copy: UserPreset;
  if (linked !== undefined) {
    copy = { id: linked.id, name: linked.name, ...fromFile };
    write(list.map((one) => (one.id === linked.id ? copy : one)));
  } else {
    const why = fullReason(list);
    if (why !== undefined) return { ok: false, reason: why };
    copy = { id: newId(), name: uniqueName(item.preset.name, list), ...fromFile };
    write([...list, copy]);
  }
  applyUserPresetNow(copy, options);
  return { ok: true, preset: copy };
}

/**
 * Links one of the person's presets to the project file Add to project just wrote, so the project's
 * row reads In use and a later Update in project knows its file. Another of their presets linked to
 * that same file lets it go: one file has one copy.
 */
export function linkPresetToProject(id: string, link: ProjectPresetLink): void {
  const list = getUserPresets();
  if (!list.some((one) => one.id === id)) return;
  write(
    list.map((one) => {
      if (one.id === id) return { ...one, fromProject: link };
      if (one.fromProject?.project !== link.project || one.fromProject.file !== link.file) return one;
      const { fromProject: _link, ...rest } = one;
      return rest;
    }),
  );
}
