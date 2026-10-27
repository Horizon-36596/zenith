/**
 * Preset files, `<name>.zenith-preset.json`: how a preset travels between browsers, the desktop app and
 * teammates. A preset file is keyed by registry ids, not by storage names, and it is not a project
 * file, so it is outside the `02-file-format.md` contract.
 *
 * Reading one is the only check between a file from anywhere and a person's settings, so it keeps
 * only what it can check: a file over 64 KB, or of another kind or version, is refused whole; an
 * unknown id is ignored and counted; a bad value is dropped; a robot's id or a layout one is refused;
 * and each key goes through `validateBinding`. Nothing in the file runs or becomes a URL. An import
 * adds the preset to the list and never applies it. No DOM and no storage here.
 */
import { BINDINGS, assignKey, resolveKeymap, validateBinding, type Binding, type KeyContext } from "../app/keymap";
import { BUILT_IN_PRESET_IDS, SETTINGS, type AnySettingEntry, type BuiltInPresetId, type KeyOverrides } from "./registry";
import { MAX_PRESET_NAME, readPresetValues, uniqueName, type UserPreset } from "./presets";
import { PRESET_FILE_SUFFIX } from "../project/presetPaths";
import { unreadableJsonMessage } from "../project/fileErrors";

export const PRESET_FILE_KIND = "zenith-preset";
export const PRESET_FILE_VERSION = 1;

/** The largest preset file read, in bytes. SET BY HAND (spec 15 section 6.4): many times a full preset with every key bound. */
export const MAX_PRESET_FILE_BYTES = 64 * 1024;

export { PRESET_FILE_SUFFIX };

/** The name an imported preset takes when its file has none it can use. */
const NO_NAME = "Imported preset";

/** A preset as a file holds it: a user preset without its id, which the list gives it on import. */
export type PresetFilePreset = Omit<UserPreset, "id">;

/** What an import kept and what it did not, for the line Settings shows after it. */
export interface PresetImportReport {
  /** How many ids no setting has, which were ignored. */
  unknown: number;
  /** The ids whose value was the wrong type or out of range. */
  dropped: string[];
  /** The ids a preset may not set, with the reason. */
  refused: { id: string; reason: string }[];
  /** The keys that were not kept, with the reason. */
  keysRefused: { id: string; keys: string | null; reason: string }[];
  /** The file's `settings`, `keys` or `basedOn` that were there but could not be read at all, with the reason. */
  ignored: { field: "settings" | "keys" | "basedOn"; reason: string }[];
  /** The file's name was taken, so the preset has the next free one. */
  renamed: boolean;
}

export type PresetFileRead = { ok: true; preset: PresetFilePreset; report: PresetImportReport } | { ok: false; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isBuiltIn = (id: unknown): id is BuiltInPresetId => BUILT_IN_PRESET_IDS.some((builtIn) => builtIn === id);

/** The text Export writes. */
export function presetFileText(preset: UserPreset | PresetFilePreset): string {
  const file = {
    kind: PRESET_FILE_KIND,
    presetVersion: PRESET_FILE_VERSION,
    name: preset.name,
    description: preset.description,
    basedOn: preset.basedOn,
    settings: preset.settings,
    ...(preset.keys === undefined ? {} : { keys: preset.keys }),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** The file name Export gives the preset: its name, with what no file name can hold replaced. */
export function presetFileName(name: string): string {
  // Characters Windows, macOS or Linux refuse in a file name, and control characters.
  const safe = name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "-").trim().replace(/^\.+|\.+$/g, "");
  return `${safe === "" ? "preset" : safe}${PRESET_FILE_SUFFIX}`;
}

/** The size of `text` in bytes, as UTF-8. */
const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/**
 * The file's keys, one at a time, as Settings, Keyboard would take them from the defaults: a key a
 * person may not set is refused with the reason, and so is a key that overlaps one the file gave
 * earlier. A key that overlaps a default moves there, which leaves that action with no key, as
 * "Move it here" does. The result never holds two overlapping keys.
 */
function readFileKeys(
  raw: Record<string, unknown>,
  bindings: readonly Binding[],
  context: KeyContext,
): { keys: KeyOverrides; refused: PresetImportReport["keysRefused"] } {
  let keys: KeyOverrides = {};
  const fromFile = new Set<string>();
  const refused: PresetImportReport["keysRefused"] = [];
  for (const [id, value] of Object.entries(raw)) {
    const binding = bindings.find((one) => one.id === id);
    if (value !== null && typeof value !== "string") {
      refused.push({ id, keys: null, reason: "A key is written as text, such as Ctrl E, or null for no key." });
      continue;
    }
    if (binding === undefined) {
      refused.push({ id, keys: value, reason: "No action in this version of Zenith has that id." });
      continue;
    }
    if (binding.fixed !== undefined) {
      refused.push({ id, keys: value, reason: binding.fixed });
      continue;
    }
    if (value === null) {
      keys = assignKey(bindings, keys, id, null, context);
      fromFile.add(id);
      continue;
    }
    const check = validateBinding(id, value, resolveKeymap(bindings, keys, context), bindings, context);
    if (check.kind === "refused") {
      refused.push({ id, keys: value, reason: check.reason });
      continue;
    }
    if (check.kind === "conflict" && fromFile.has(check.other)) {
      const other = bindings.find((one) => one.id === check.other);
      refused.push({ id, keys: value, reason: `The file gives ${check.keys} to ${other?.label ?? check.other} too.` });
      continue;
    }
    keys = assignKey(bindings, keys, id, check.keys, context);
    fromFile.add(id);
  }
  return { keys, refused };
}

/** What to do after a preset file picked for import is refused. */
export const PRESET_IMPORT_AGAIN = "Pick a .zenith-preset.json file made by Export.";

/**
 * Why a preset file is refused for its size, naming the file as every other file error does
 * (UI_GUIDE section 9.19). `name` is the file's name, or "The file" when there is none to give.
 */
export const presetTooLargeMessage = (name: string, next: string = PRESET_IMPORT_AGAIN): string =>
  `${name} is larger than 64 KB, so it is not a preset file. ${next}`;

/**
 * The preset in a preset file's text, or why the file is refused. `taken` are the names already in
 * the list: a name that clashes with one, or with a built-in, becomes "Name (2)". A refusal names the
 * file, `fileName` (else "The file"), says what is wrong and ends with `next`, the reader's own next
 * step, so a preset file reads like every other file error (`project/fileErrors.ts`). `settings`,
 * `bindings` and `context` are the registry, the key table and where the page runs, passed in only
 * by tests.
 */
export function readPresetFile(
  text: string,
  taken: readonly { name: string }[],
  options: {
    settings?: readonly AnySettingEntry[];
    bindings?: readonly Binding[];
    context?: KeyContext;
    fileName?: string;
    next?: string;
  } = {},
): PresetFileRead {
  const subject = options.fileName ?? "The file";
  const next = options.next ?? PRESET_IMPORT_AGAIN;
  if (byteLength(text) > MAX_PRESET_FILE_BYTES) return { ok: false, reason: presetTooLargeMessage(subject, next) };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: unreadableJsonMessage(subject, text, error, next) };
  }
  if (!isRecord(raw) || raw["kind"] !== PRESET_FILE_KIND) return { ok: false, reason: `${subject} is not a Zenith preset file. ${next}` };
  if (raw["presetVersion"] !== PRESET_FILE_VERSION) {
    return { ok: false, reason: `${subject} is from another version of Zenith, which this one cannot read. ${next}` };
  }

  // A block that is there but is not an object is reported, not dropped without a word.
  const ignored: PresetImportReport["ignored"] = [];
  if (raw["settings"] !== undefined && !isRecord(raw["settings"])) {
    ignored.push({ field: "settings", reason: "Its settings are not a list of setting ids and values, so none was read." });
  }
  if (raw["keys"] !== undefined && !isRecord(raw["keys"])) {
    ignored.push({ field: "keys", reason: "Its keys are not a list of action ids and keys, so none was read." });
  }
  if (raw["basedOn"] !== undefined && !isBuiltIn(raw["basedOn"])) {
    ignored.push({ field: "basedOn", reason: "It is based on a preset that is not Basic, Essential or Full, so it is based on Essential." });
  }
  const values = readPresetValues(raw["settings"], options.settings ?? SETTINGS);
  const fileKeys = isRecord(raw["keys"])
    ? readFileKeys(raw["keys"], options.bindings ?? BINDINGS, options.context ?? { desktop: false })
    : undefined;
  const given = typeof raw["name"] === "string" ? raw["name"].trim().slice(0, MAX_PRESET_NAME).trim() : "";
  const wanted = given === "" ? NO_NAME : given;
  const name = uniqueName(wanted, taken);
  const preset: PresetFilePreset = {
    name,
    description: typeof raw["description"] === "string" ? raw["description"].trim() : "",
    basedOn: isBuiltIn(raw["basedOn"]) ? raw["basedOn"] : "essential",
    settings: values.values,
    ...(fileKeys === undefined ? {} : { keys: fileKeys.keys }),
  };
  return {
    ok: true,
    preset,
    report: {
      unknown: values.unknown.length,
      dropped: values.dropped,
      refused: values.refused,
      keysRefused: fileKeys?.refused ?? [],
      ignored,
      renamed: name !== wanted,
    },
  };
}
