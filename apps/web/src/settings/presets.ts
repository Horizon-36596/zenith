/**
 * The built-in presets, Basic, Essential and Full, as pure logic over the registry: their value tables,
 * applying one, the changes from one, and how a stored value resolves through the recorded preset
 * (section 5). No DOM and no storage; the store writes what these return through `setSetting`.
 *
 * User presets (section 6.3) are pure logic here too: parsing `zenith.presets` one preset at a
 * time, their names, saving the current settings as one, applying one, and the changes from the
 * recorded preset. `presetStorage.ts` reads and writes `zenith.presets`, and `presetStore.ts`
 * applies a preset through `setSettings`.
 */
import type { Prefs } from "../state/prefs";
import {
  BUILT_IN_PRESET_IDS,
  SETTINGS,
  getSetting,
  isPresettable,
  settingEntry,
  withSetting,
  type KeyOverrides,
  type AnySettingEntry,
  type BuiltInPresetId,
  type SettingEntry,
  type SettingId,
  type SettingValues,
} from "./registry";

/** A built-in preset's id, or a user preset's, `user:<uuid>`. */
export type PresetId = BuiltInPresetId | `user:${string}`;

/**
 * The preset the person's settings came from, kept in `zenith.ui` as `preset`. `chosen` records
 * that the person picked one, on the first-run card or in Settings, so the card never asks again.
 */
export interface PresetRef {
  id: PresetId;
  chosen: boolean;
  /**
   * For a user preset, the built-in it is based on, recorded when it is applied. Its values fill
   * what the preset leaves out, and they still do once the preset is deleted, when the header reads
   * "Custom (based on Full)".
   */
  basedOn?: BuiltInPresetId;
  /**
   * Set when a user preset with keys of its own was applied with "Keep my keys". Its keys are then
   * not part of what it sets, so the person's keys are not a change from it and a revert leaves them.
   */
  keptKeys?: true;
}

/** What a blob with no `preset` resolves to: every existing user, and every e2e spec that writes `zenith.ui`. */
export const ESSENTIAL_UNCHOSEN: PresetRef = { id: "essential", chosen: false };

export interface BuiltInPreset {
  id: BuiltInPresetId;
  name: string;
  /** Who it is for, one sentence (spec 15 section 1). */
  description: string;
}

export const BUILT_IN_PRESETS: readonly BuiltInPreset[] = [
  { id: "basic", name: "Basic", description: "Draw paths, add commands, play and save, with few buttons." },
  { id: "essential", name: "Essential", description: "The editor as it ships, with everything you need to plan an auto. Recommended." },
  { id: "full", name: "Full", description: "Everything, Ledger and Partners included." },
];

const isBuiltIn = (id: unknown): id is BuiltInPresetId => BUILT_IN_PRESET_IDS.some((builtIn) => builtIn === id);

const isPresetId = (id: unknown): id is PresetId =>
  isBuiltIn(id) || (typeof id === "string" && id.startsWith("user:") && id.length > "user:".length);

/**
 * The stored `preset`. An unknown id reads as Essential; `chosen` is kept whenever it is a boolean,
 * so a person who chose is never asked again.
 */
export function parsePresetRef(raw: unknown): PresetRef {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return ESSENTIAL_UNCHOSEN;
  const { id, chosen, basedOn, keptKeys } = raw as Record<string, unknown>;
  const ref: PresetRef = { id: isPresetId(id) ? id : "essential", chosen: chosen === true };
  if (isBuiltIn(ref.id)) return ref;
  const based = isBuiltIn(basedOn) ? { ...ref, basedOn } : ref;
  return keptKeys === true ? { ...based, keptKeys: true } : based;
}

/** The part of a user preset that resolving needs. */
export interface UserPresetBase {
  id: `user:${string}`;
  basedOn: BuiltInPresetId;
}

/**
 * The built-in whose values fill what the recorded preset leaves out: itself, a user preset's
 * `basedOn`, the base recorded with it once it is gone, or Essential.
 */
export function builtInBase(ref: PresetRef, userPresets: readonly UserPresetBase[] = []): BuiltInPresetId {
  if (isBuiltIn(ref.id)) return ref.id;
  return userPresets.find((preset) => preset.id === ref.id)?.basedOn ?? ref.basedOn ?? "essential";
}

/** The built-in's value for the entry, or undefined when built-ins do not set it. */
export function presetValue<Id extends SettingId>(entry: SettingEntry<Id>, preset: BuiltInPresetId): SettingValues[Id] | undefined {
  return typeof entry.presets === "object" ? entry.presets[preset] : undefined;
}

/**
 * A setting's value from what is stored (spec 15 section 5): the stored value, then the recorded
 * built-in's, then the default. So a setting added in a later version arrives at the value of the
 * preset the person chose.
 */
export function resolveSetting<Id extends SettingId>(entry: SettingEntry<Id>, raw: unknown, preset: BuiltInPresetId): SettingValues[Id] {
  return entry.parse(raw) ?? presetValue(entry, preset) ?? entry.defaultValue;
}

/** Every value the built-in sets, by registry id. */
export function presetSettings(preset: BuiltInPresetId): Partial<SettingValues> {
  const values: Partial<Record<SettingId, unknown>> = {};
  for (const entry of SETTINGS) if (isPresettable(entry)) values[entry.id] = entry.presets[preset];
  return values as Partial<SettingValues>;
}

/**
 * `prefs` with every value the built-in sets, not the ones it leaves, and the preset recorded as
 * chosen. Layout is untouched, and a built-in never changes keys (spec 15 section 6.1).
 */
export function applyPreset(prefs: Prefs, preset: BuiltInPresetId): Prefs {
  let next = prefs;
  for (const [id, value] of Object.entries(presetSettings(preset)) as [SettingId, SettingValues[SettingId]][]) {
    next = withSetting(next, id, value as never);
  }
  return { ...next, preset: { id: preset, chosen: true } };
}

/**
 * The settings whose values differ from what the built-in sets, in registry order. Derived every
 * time and never stored (spec 15 section 6.2).
 */
export function presetChanges(prefs: Prefs, preset: BuiltInPresetId): SettingId[] {
  return SETTINGS.filter(isPresettable)
    .filter((entry: AnySettingEntry) => getSetting(prefs, entry.id) !== presetValue(entry as SettingEntry, preset))
    .map((entry) => entry.id);
}

/**
 * The feature switches a built-in turns off, by label, in the order General lists them: the "what
 * you get" line of its card, generated from the registry so it cannot drift (spec 15 section 6.1).
 * A switch registered ahead of its feature (`awaiting`) is left out, because nothing in the editor
 * shows it yet.
 */
export function presetSwitchedOff(preset: BuiltInPresetId): string[] {
  return SETTINGS.filter((entry) => entry.kind === "feature" && entry.awaiting === undefined && presetValue(entry as SettingEntry, preset) === false).map(
    (entry) => entry.label,
  );
}

/* ---- User presets (spec 15 section 6.3) ------------------------------------------------- */

/**
 * The most user presets kept. SET BY HAND (spec 15 section 6.3): enough for a team's roles, and a
 * list that still reads at a glance.
 */
export const MAX_USER_PRESETS = 20;

/** The longest name a preset may have, in characters. SET BY HAND (spec 15 section 6.3): it fits one row of Settings. */
export const MAX_PRESET_NAME = 40;

/** The version of `zenith.presets`, apart from `zenith.ui`'s (spec 15 section 5). */
export const USER_PRESETS_VERSION = 1;

/** The values a preset sets, by registry id. */
export type PresetValues = Partial<SettingValues>;

/** A person's own preset, kept in `zenith.presets`. */
export interface UserPreset extends UserPresetBase {
  name: string;
  description: string;
  /** What it sets, by registry id. A setting it does not name takes its `basedOn` built-in's value. */
  settings: PresetValues;
  /** The person's keys, only when it was saved with "Include my keys". Applying it can replace theirs. */
  keys?: KeyOverrides;
  /**
   * The project preset file this is the person's copy of (spec 15 section 6.5): set when they applied
   * a project's preset, or added theirs to a project. Applying that project preset again updates this
   * copy instead of adding another. `project` is the project's key (`projectKey`), `file` the bare
   * file name in its presets folder.
   */
  fromProject?: ProjectPresetLink;
}

/** Where a user preset's project copy is: the project's key and the file's name in its presets folder. */
export interface ProjectPresetLink {
  project: string;
  file: string;
}

/**
 * Whether a user preset may carry the entry: a person's setting that is not layout. Keys travel
 * apart, in `keys`, and a robot's values live in `robot.json` (spec 15 section 2).
 */
export const inUserPresets = (entry: AnySettingEntry): boolean =>
  entry.scope === "person" && entry.presets !== "never" && entry.kind !== "keys";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What reading the values of a stored preset, or of a preset file, kept and what it did not. */
export interface ReadValues {
  values: PresetValues;
  /** Ids no setting has. */
  unknown: string[];
  /** Ids whose value was the wrong type or out of range. */
  dropped: string[];
  /** Ids a preset may not set, with the reason. */
  refused: { id: string; reason: string }[];
}

/**
 * The values in `raw`, id by id: an unknown id is skipped, a bad value is dropped alone, and an id a
 * preset may not set is refused. `settings` is the registry, passed in only by tests.
 */
export function readPresetValues(raw: unknown, settings: readonly AnySettingEntry[] = SETTINGS): ReadValues {
  const read: ReadValues = { values: {}, unknown: [], dropped: [], refused: [] };
  if (!isRecord(raw)) return read;
  const values: Partial<Record<SettingId, unknown>> = {};
  for (const [id, value] of Object.entries(raw)) {
    const entry = settings.find((one) => one.id === id);
    if (entry === undefined) {
      read.unknown.push(id);
    } else if (entry.scope === "robot") {
      read.refused.push({ id, reason: "It belongs to the robot, in robot.json, so a preset never sets it." });
    } else if (!inUserPresets(entry)) {
      read.refused.push({
        id,
        reason:
          entry.kind === "keys"
            ? "Keys go in the file's keys, not its settings."
            : entry.unlisted !== undefined
              ? "Nobody chooses it in this version, so a preset never carries it."
              : "It is layout, which a preset never carries.",
      });
    } else {
      const parsed = (entry as SettingEntry).parse(value);
      if (parsed === undefined) read.dropped.push(id);
      else values[entry.id] = parsed;
    }
  }
  read.values = values as PresetValues;
  return read;
}

const isBuiltInName = (name: string): boolean =>
  BUILT_IN_PRESETS.some((preset) => preset.name.toLowerCase() === name.trim().toLowerCase());

/**
 * Why `name` cannot name a preset, or undefined when it can: 1 to 40 characters, not a built-in's
 * name, and unique ignoring case. `exceptId` is the preset being renamed, which may keep its name.
 */
export function nameProblem(name: string, presets: readonly { id?: string; name: string }[], exceptId?: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed === "") return "A preset needs a name.";
  if (trimmed.length > MAX_PRESET_NAME) return `A name has at most ${String(MAX_PRESET_NAME)} characters.`;
  if (isBuiltInName(trimmed)) return `${trimmed} is a built-in preset. Choose another name.`;
  const taken = presets.find(
    (preset) => (exceptId === undefined || preset.id !== exceptId) && preset.name.toLowerCase() === trimmed.toLowerCase(),
  );
  return taken === undefined ? undefined : `You already have a preset called ${taken.name}.`;
}

/** `name`, or "Name (2)", "Name (3)" and so on when it is taken, still within 40 characters. */
export function uniqueName(name: string, presets: readonly { name: string }[]): string {
  const trimmed = name.trim().slice(0, MAX_PRESET_NAME).trimEnd();
  if (nameProblem(trimmed, presets) === undefined) return trimmed;
  for (let n = 2; ; n += 1) {
    const suffix = ` (${String(n)})`;
    const candidate = `${trimmed.slice(0, MAX_PRESET_NAME - suffix.length).trimEnd()}${suffix}`;
    if (nameProblem(candidate, presets) === undefined) return candidate;
  }
}

const isUserId = (id: unknown): id is `user:${string}` => typeof id === "string" && id.startsWith("user:") && id.length > "user:".length;

/** One stored user preset, or undefined when it is not one. A bad value inside it is dropped alone. */
export function parseUserPreset(raw: unknown): UserPreset | undefined {
  if (!isRecord(raw)) return undefined;
  const { id, name, description, basedOn, settings, keys, fromProject } = raw;
  if (!isUserId(id) || typeof name !== "string" || name !== name.trim() || !isBuiltIn(basedOn)) return undefined;
  if (nameProblem(name, []) !== undefined) return undefined;
  const preset: UserPreset = {
    id,
    name,
    description: typeof description === "string" ? description : "",
    basedOn,
    settings: readPresetValues(settings).values,
  };
  const ownKeys = isRecord(keys) ? settingEntry("keys.bindings").parse(keys) : undefined;
  const withKeys = ownKeys === undefined ? preset : { ...preset, keys: ownKeys };
  const link = parseProjectLink(fromProject);
  return link === undefined ? withKeys : { ...withKeys, fromProject: link };
}

/** A stored `fromProject`, or undefined when it is not one; a bad link is dropped alone, never the preset. */
function parseProjectLink(raw: unknown): ProjectPresetLink | undefined {
  if (!isRecord(raw)) return undefined;
  const { project, file } = raw;
  if (typeof project !== "string" || project === "" || typeof file !== "string" || file === "") return undefined;
  return { project, file };
}

/**
 * `zenith.presets`, one preset at a time (spec 15 section 5): a preset that fails to parse is dropped
 * and counted, and the rest are kept. Of two with the same id or name the first stays, and at most
 * 20 are kept.
 */
export function parseUserPresets(raw: unknown): { presets: UserPreset[]; dropped: number } {
  if (!isRecord(raw) || raw["version"] !== USER_PRESETS_VERSION || !Array.isArray(raw["presets"])) return { presets: [], dropped: 0 };
  const presets: UserPreset[] = [];
  let dropped = 0;
  for (const item of raw["presets"] as unknown[]) {
    let preset: UserPreset | undefined;
    try {
      preset = parseUserPreset(item);
    } catch {
      preset = undefined;
    }
    const twin = preset !== undefined && presets.some((kept) => kept.id === preset.id || nameProblem(preset.name, [kept]) !== undefined);
    if (preset === undefined || twin || presets.length >= MAX_USER_PRESETS) dropped += 1;
    else presets.push(preset);
  }
  return { presets, dropped };
}

/** The values the person's settings have now that a user preset carries. */
export function currentValues(prefs: Prefs): PresetValues {
  const values: Partial<Record<SettingId, unknown>> = {};
  for (const entry of SETTINGS) if (inUserPresets(entry)) values[entry.id] = getSetting(prefs, entry.id);
  return values as PresetValues;
}

/** A user preset of the current settings: "Save current settings as a preset…". */
export function userPresetFrom(
  prefs: Prefs,
  given: { id: `user:${string}`; name: string; description: string; basedOn: BuiltInPresetId; includeKeys: boolean },
): UserPreset {
  const preset: UserPreset = {
    id: given.id,
    name: given.name.trim(),
    description: given.description.trim(),
    basedOn: given.basedOn,
    settings: currentValues(prefs),
  };
  return given.includeKeys ? { ...preset, keys: prefs.keys } : preset;
}

/** `preset` with the current settings, and the current keys when it carries keys: "Update from current settings". */
export const updatedFrom = (preset: UserPreset, prefs: Prefs): UserPreset => ({
  ...preset,
  settings: currentValues(prefs),
  ...(preset.keys === undefined ? {} : { keys: prefs.keys }),
});

/** Every value applying the user preset writes: its base's, then its own over them, then its keys when asked. */
export function userPresetWrites(preset: UserPreset, options: { keys: boolean }): PresetValues {
  return {
    ...presetSettings(preset.basedOn),
    ...preset.settings,
    ...(options.keys && preset.keys !== undefined ? { "keys.bindings": preset.keys } : {}),
  };
}

/**
 * The reference recorded once the user preset is applied, with `keptKeys` when it has keys of its
 * own and they were not taken.
 */
export const userPresetRef = (preset: UserPreset, options: { keys: boolean } = { keys: true }): PresetRef => ({
  id: preset.id,
  chosen: true,
  basedOn: preset.basedOn,
  ...(preset.keys !== undefined && !options.keys ? { keptKeys: true as const } : {}),
});

/**
 * `prefs` with the user preset applied: its values written, layout untouched, and it recorded. Its
 * keys replace the person's only with `keys`, which Settings asks about first.
 */
export function applyUserPreset(prefs: Prefs, preset: UserPreset, options: { keys: boolean }): Prefs {
  let next = prefs;
  for (const [id, value] of Object.entries(userPresetWrites(preset, options)) as [SettingId, SettingValues[SettingId]][]) {
    next = withSetting(next, id, value as never);
  }
  return { ...next, preset: userPresetRef(preset, options) };
}

/** The recorded user preset, while it is still in the list. */
export const recordedUserPreset = (ref: PresetRef, userPresets: readonly UserPreset[]): UserPreset | undefined =>
  isBuiltIn(ref.id) ? undefined : userPresets.find((preset) => preset.id === ref.id);

/**
 * What the recorded preset sets: a built-in's values, or a user preset's over its base's, with its
 * keys when it has them and the person did not keep their own.
 */
function recordedValues(ref: PresetRef, userPresets: readonly UserPreset[]): PresetValues {
  const user = recordedUserPreset(ref, userPresets);
  return user === undefined ? presetSettings(builtInBase(ref, userPresets)) : userPresetWrites(user, { keys: ref.keptKeys !== true });
}

/** The recorded preset's value for the setting, or undefined when it does not set it. A revert writes it back. */
export function presetValueOf<Id extends SettingId>(prefs: Prefs, userPresets: readonly UserPreset[], id: Id): SettingValues[Id] | undefined {
  return recordedValues(prefs.preset, userPresets)[id];
}

/** Whether two setting values are the same, a keys object included. */
export const sameValue = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * The settings whose values differ from what the recorded preset sets, in registry order, the keys
 * included for a user preset that carries them (spec 15 section 6.2). Derived every time, never stored.
 */
export const changesFrom = (prefs: Prefs, userPresets: readonly UserPreset[]): SettingId[] =>
  differences(prefs, recordedValues(prefs.preset, userPresets));

/** The settings that applying the user preset, keys included, would change: what an import shows, since it applies nothing. */
export const wouldChange = (prefs: Prefs, preset: UserPreset): SettingId[] => differences(prefs, userPresetWrites(preset, { keys: true }));

/** The settings, in registry order, whose values in `prefs` differ from the ones `values` sets. */
const differences = (prefs: Prefs, values: PresetValues): SettingId[] =>
  SETTINGS.filter((entry) => Object.hasOwn(values, entry.id) && !sameValue(getSetting(prefs, entry.id), values[entry.id])).map(
    (entry) => entry.id,
  );

/** The recorded preset's name: a built-in's, a user preset's, or "Custom (based on Full)" once it is deleted. */
export function presetLabel(ref: PresetRef, userPresets: readonly UserPreset[]): string {
  const builtIn = BUILT_IN_PRESETS.find((preset) => preset.id === ref.id);
  if (builtIn !== undefined) return builtIn.name;
  const user = recordedUserPreset(ref, userPresets);
  if (user !== undefined) return user.name;
  const base = BUILT_IN_PRESETS.find((preset) => preset.id === builtInBase(ref, userPresets));
  return `Custom (based on ${base?.name ?? "Essential"})`;
}

/**
 * The chosen preset's own name, for the tour's "You chose …" line (spec 15 section 9): a built-in's
 * or a user preset's still in the list. Null when nothing was chosen, or when the preset is gone and
 * Settings calls it Custom; decided by what is recorded, never by how the name reads.
 */
export function chosenPresetName(ref: PresetRef, userPresets: readonly UserPreset[]): string | null {
  if (!ref.chosen) return null;
  const builtIn = BUILT_IN_PRESETS.find((preset) => preset.id === ref.id);
  if (builtIn !== undefined) return builtIn.name;
  return recordedUserPreset(ref, userPresets)?.name ?? null;
}

/** "Basic", "Basic, 1 change" or "Basic, 2 changes": the head of Settings, Presets. */
export function changeSummary(prefs: Prefs, userPresets: readonly UserPreset[]): string {
  const label = presetLabel(prefs.preset, userPresets);
  const count = changesFrom(prefs, userPresets).length;
  return count === 0 ? label : `${label}, ${String(count)} ${count === 1 ? "change" : "changes"}`;
}
