/**
 * UI preferences, and only UI preferences. Nothing about a project is kept here: the files are the
 * state (site/docs/editor.md). The last opened folder is a File System
 * Access handle and lives in IndexedDB instead, because a handle cannot be stringified.
 */
import { parseLedgerHeight } from "../app/ledgerSplit";
import {
  ESSENTIAL_UNCHOSEN,
  builtInBase,
  parsePresetRef,
  presetValue,
  resolveSetting,
  type PresetRef,
  type UserPresetBase,
} from "../settings/presets";
import { loadUserPresets } from "../settings/presetStorage";
import { SETTINGS, TOOLBAR_BUTTONS, readStored, settingEntry, withSetting, type AnySettingEntry, type KeyOverrides, type SettingEntry } from "../settings/registry";
import { parseSection, type SettingsSection } from "../settings/sections";
import { FULL_SIM_DEFAULT } from "./fullSimSwitch";
import type { SimSpeed } from "./simSpeed";
import { parseWaypointPinOverrides, type PinOverrides, type WaypointPinsMode } from "./waypointPins";

export type Theme = "dark" | "light";

/**
 * How far the guided tour has got (site/docs/editor.md). `seen` is what keeps the
 * tour from starting again on the next visit, whichever way the person left it; `coreDone` and
 * `fullDone` record which of the two tours they finished, so the help menu can offer the rest.
 */
export interface TourProgress {
  seen: boolean;
  coreDone: boolean;
  fullDone: boolean;
}

/**
 * How the field is drawn under the routine (site/docs/editor.md). The same union
 * as the canvas's `FieldView`, kept here so preferences do not import the canvas.
 */
export type FieldView = "image" | "image+outlines" | "vector";

/**
 * The field's Grid setting (owner ruling D11): `off` draws the floor only, `tiles` the floor and the 24
 * in tile seams, and `12` and `6` add lines at that many inches between the seams. `12` is how the
 * field was drawn before the setting existed. The same union as the canvas's, kept here so preferences
 * do not import the canvas.
 */
export type FieldGrid = "off" | "tiles" | "12" | "6";

/**
 * The heading mode a new path starts with (owner ruling D6), the registry's `editing.defaultHeading`.
 * `apps/web` builds the heading from it and hands the result to the edit; `packages/core` never reads
 * it.
 */
export type DefaultHeadingMode = "tangent" | "linear" | "constant";

/**
 * Where the robot on the field and the timeline's clock come from (site/docs/simulation.md,
 * "Playback levels"): the planned path exactly, the instant sim, or the robot repository's own sim.
 * The same union as the canvas's `PlaybackLevel`, kept here so preferences do not import the canvas.
 */
export type PlaybackLevel = "ideal" | "instant" | "full";

export const NO_TOUR_PROGRESS: TourProgress = { seen: false, coreDone: false, fullDone: false };

/**
 * How much of a row's description is drawn (issue #238, UI_GUIDE section 9.13): `compact`, "Labels
 * only", draws the label alone, and `full`, "With descriptions", adds the brief on a line under it.
 * The hint, a long hover or Shift F1, is the whole description in both.
 *
 * It is written to become issue #200's registry entry one to one:
 *
 *     id: "display.descriptions"   storage: "descriptions" in zenith.ui   scope: person   kind: display
 *     section: editor  group: Appearance  label: "Descriptions"
 *     control: segmented ["compact" = "Labels only", "full" = "With descriptions"]
 *     defaultValue: "compact"   presets: { basic: "full", essential: "compact", full: "compact" }
 *     hides: none   needs: []   gates: []
 */
export type Descriptions = "compact" | "full";

/** Labels only, by decision desc-default (b): the clutter was Dohun's own complaint. */
export const DEFAULT_DESCRIPTIONS: Descriptions = "compact";

/** The stored option, or the default for anything it does not know. */
export const parseDescriptions = (value: unknown): Descriptions =>
  value === "compact" || value === "full" ? value : DEFAULT_DESCRIPTIONS;

/**
 * The parts of Zenith a person can switch off in Settings, General (issue #101). Pathing is the minimum
 * and has no switch. What each one hides is `state/features.ts`, read from the registry.
 */
export interface FeatureSwitches {
  /** Partners, partner lanes, share files, proposals and sharing outside the team. */
  partners: boolean;
  /** The Ledger panel, game piece counts on the field and the ledger's counting and scoring findings. */
  ledger: boolean;
  /** Command steps, markers and the command registry. */
  commands: boolean;
  /** Inserting sequence, parallel and branch groups, and wrapping steps in one. */
  groups: boolean;
  /** Making, renaming and deleting waypoints, and the waypoint list. */
  waypoints: boolean;
  /** Choosing Piecewise for a path that is not piecewise yet. */
  advancedHeading: boolean;
  /** Optimize path: off in Basic, on in Essential and Full. */
  optimizer: boolean;
  /** The bottom panel's Code tab. */
  codeTab: boolean;
  /**
   * Full sim (issue #207): the desktop app's high-fidelity sim, the Full sim playback level and
   * loading a trace file. On, and not shown in Settings (`FULL_SIM_DEFAULT`).
   */
  fullSim: boolean;
}

export { FULL_SIM_DEFAULT };

/** Pathing only: every switch off. */
export const NO_FEATURES: FeatureSwitches = {
  partners: false,
  ledger: false,
  commands: false,
  groups: false,
  waypoints: false,
  advancedHeading: false,
  optimizer: false,
  codeTab: false,
  fullSim: false,
};

/**
 * Where a switch nobody has set starts: Essential's value (spec 15 section 4.1). Commands is on,
 * because the example uses it (owner ruling, issue #112); partner sharing and the ledger are off
 * (issue #101); the switches added with the presets are on, so Essential is today's editor; Full sim
 * follows `FULL_SIM_DEFAULT` (issue #207).
 */
export const DEFAULT_FEATURES: FeatureSwitches = {
  partners: false,
  ledger: false,
  commands: true,
  groups: true,
  waypoints: true,
  advancedHeading: true,
  optimizer: true,
  codeTab: true,
  fullSim: FULL_SIM_DEFAULT,
};

/**
 * The stored switches. Partner sharing and the ledger are on only when stored as `true`. The others
 * keep a stored `true` or `false`, so a person who chose keeps their choice, and anything else
 * (never stored, or not a boolean) is its default, on. Full sim is whatever `FULL_SIM_DEFAULT` says,
 * whatever is stored: nobody can switch it in the app, so nothing stored was a choice, and turning the
 * constant off must hide it again for people whose saved preferences say `true`.
 */
export function parseFeatures(value: unknown): FeatureSwitches {
  if (!isRecord(value)) return DEFAULT_FEATURES;
  const kept = (key: keyof FeatureSwitches): boolean => {
    const stored = value[key];
    return typeof stored === "boolean" ? stored : DEFAULT_FEATURES[key];
  };
  return {
    partners: value["partners"] === true,
    ledger: value["ledger"] === true,
    commands: kept("commands"),
    groups: kept("groups"),
    waypoints: kept("waypoints"),
    advancedHeading: kept("advancedHeading"),
    optimizer: kept("optimizer"),
    codeTab: kept("codeTab"),
    fullSim: FULL_SIM_DEFAULT,
  };
}

/**
 * Whether each toolbar button shows, nested by the dot in its action id, as
 * `{ tool: { select: true } }` (`display.toolbar.<actionId>` in the registry).
 */
export type ToolbarShown = Readonly<Record<string, Readonly<Record<string, boolean>>>>;

/** Every toolbar button shown. */
const EVERY_BUTTON: ToolbarShown = TOOLBAR_BUTTONS.reduce<Record<string, Record<string, boolean>>>((shown, { id }) => {
  const [group = "", name = ""] = id.split(".");
  shown[group] = { ...shown[group], [name]: true };
  return shown;
}, {});

/**
 * Which time the optimizer card lowers: the instant sim, or the estimate. The same pair as core's
 * optimizer option `scorer`, kept here so preferences do not import the optimizer. The default is the
 * instant sim, SET BY HAND (spec 16 section 5.2).
 */
export type OptimizeScorer = "sim" | "estimate";

export const DEFAULT_OPTIMIZE_SCORER: OptimizeScorer = "sim";

export interface Prefs {
  /**
   * Which one-time migrations the stored preferences have had (`PREFS_VERSION`). Missing in
   * preferences saved before the first one, which reads as 0.
   */
  version: number;
  theme: Theme;
  snap: boolean;
  /**
   * The heading mode a new path gets (`DefaultHeadingMode`), the registry's `editing.defaultHeading`.
   * Linear unless the person chose another (owner ruling D6), whatever they stored before it existed.
   */
  defaultHeading: DefaultHeadingMode;
  /**
   * Extend this chain (issue #204, decision D5): with a path step selected, an Add path click,
   * Add a path to here and Insert a path add a path to that step's chain instead of a new step.
   * Off unless the person turned it on. The registry's `editing.addPathExtends`.
   */
  addPathExtends: boolean;
  /**
   * Start a new path with the previous path's end heading (issue #435): a new path starts at the
   * heading the robot has where the step before it ends, and in Linear mode ends at that heading
   * too. On unless the person turned it off. The registry's `editing.newPathKeepsHeading`.
   */
  newPathKeepsHeading: boolean;
  /**
   * Protect measured waypoints (spec 15 section 13, decision D12): a pin labelled MEASURED or
   * CALIBRATED FROM ROBOT takes its first press as a select, and the second press-drag moves it. On
   * unless the person turned it off. The registry's `editing.protectMeasuredPins`.
   */
  protectMeasuredPins: boolean;
  /**
   * How far an arrow key moves a selected point or waypoint pin, in inches: the registry's
   * `editing.nudgeIn` (spec 15 section 4.3). 0.5 unless the person set another.
   */
  nudgeIn: number;
  /** How far Shift and an arrow key moves it, in inches: `editing.nudgeFarIn`. 2 unless set. */
  nudgeFarIn: number;
  /** How far `R` and Shift `R` turn a heading, in degrees (the UI's unit): `editing.rotateDeg`. 5 unless set. */
  rotateDeg: number;
  /** How far `,` and `.` move the playhead, in seconds: `editing.scrubStepS`. 0.1 unless set. */
  scrubStepS: number;
  panelLeftW: number;
  panelRightW: number;
  findingsH: number;
  findingsCollapsed: boolean;
  /** The ledger is folded to its title and a one-line summary until opened (UI_GUIDE 9.8). */
  ledgerOpen: boolean;
  /**
   * The open Ledger's height in the left column, set by the divider above it (`app/ledgerSplit.ts`),
   * or null for the default split with the step list.
   */
  ledgerH: number | null;
  tour: TourProgress;
  fieldView: FieldView;
  /** How much of the field's grid is drawn (`FieldGrid`), the registry's `display.fieldGrid`. */
  fieldGrid: FieldGrid;
  /** The field picture's named look (`field.image.variants`), or null for the field's default. */
  fieldStyle: string | null;
  /** Group rows folded shut in the step list, each as `fileName#stepId` (`foldKey`). */
  foldedGroups: string[];
  /**
   * The playback level last chosen. `full` is remembered but only used while a full sim trace is
   * loaded; without one the editor plays the ideal level, and while Full sim is switched off it plays
   * the instant sim, or Ideal when that has no run (`state/playback.ts`, issue #207).
   */
  playbackLevel: PlaybackLevel;
  /**
   * Whether the canvas draws a red ghost of the robot where a path clips the wall, a structure or a
   * keep-out zone (`canvas/clipGhosts.ts`). On unless the person hid them.
   */
  clipGhosts: boolean;
  /**
   * Whether the field draws the dashed outlines of structure the robot passes under at its height:
   * each whole hive frame leg, the crossbar and an overhead hive envelope (`canvas/structureLayer.ts`).
   * On unless the person turned them off. The band of a leg the robot runs into is drawn either way.
   * Planned as issue #200 registry entry `field.overheadOutlines` (Basic off, Essential and Full on).
   */
  overheadOutlines: boolean;
  /**
   * Whether the field shows the ledger's counts, split into pollen and nectar, beside each place that
   * holds pieces and riding with the robot (`canvas/fieldCounts.ts`). On unless the person hid them.
   */
  ledgerCounts: boolean;
  /**
   * Whether the robot outline at the playhead also draws a faint outline of its footprint grown by
   * the robot's clearance from field elements (owner ruling D8, `canvas/clearanceOutline.ts`). Off
   * unless the person or the Full preset turned it on. It only draws: no person's setting changes
   * the clearance or the CLEARANCE findings, which come from robot.json.
   */
  clearanceOutline: boolean;
  /**
   * Which waypoint pins the field shows (`state/waypointPins.ts`): all, the ones the open auto
   * follows (the default, issues #211 and #217), or none. A view choice only, so it never changes
   * waypoints.json. The registry's `display.waypointPins`.
   */
  waypointPins: WaypointPinsMode;
  /**
   * One pin shown or hidden whatever `waypointPins` says, keyed `<project key>#<name>`
   * (`pinKey`), stored only where it differs from the mode, oldest first and at most
   * `MAX_WAYPOINT_PIN_OVERRIDES` of them.
   */
  waypointPinOverrides: PinOverrides;
  /** The Settings window's section last shown (`settings/sections.ts`), or null before it was ever opened. */
  settingsSection: SettingsSection | null;
  /**
   * The person's feature switches in Settings, General (`state/features.ts`): partner sharing, the
   * ledger and commands. Commands starts on and the other two off (`DEFAULT_FEATURES`). Also Full
   * sim, which Settings does not show (`FULL_SIM_DEFAULT`). Never written into a project's files.
   */
  features: FeatureSwitches;
  /** Whether a finding in Problems shows its code chip (`display.findingCodes`). */
  findingCodes: boolean;
  /** Which toolbar buttons show (`display.toolbar.<actionId>`); a hidden one keeps its key and palette row. */
  toolbar: ToolbarShown;
  /**
   * The optimizer card's options as last chosen (registry ids `optimizer.scorer`,
   * `optimizer.allowSplit` and `optimizer.allowRanges`). There is no margin here: it is the robot's
   * `footprint.clearanceIn` (owner ruling D8), and the card may override it for one run without saving
   * it.
   */
  optimizeScorer: OptimizeScorer;
  optimizeAllowSplit: boolean;
  optimizeAllowRanges: boolean;
  /** The heading holds as last chosen, in inches, 0 off (registry ids `optimizer.holdStartHeadingIn` and `optimizer.holdEndHeadingIn`, issue #448). */
  optimizeHoldStartHeadingIn: number;
  optimizeHoldEndHeadingIn: number;
  /** How the desktop app runs the full sim (registry id `sim.speed`, `state/simSpeed.ts`). */
  fullSimSpeed: SimSpeed;
  /** Whether rows draw their brief inline (`Descriptions`): Settings, Editor, Appearance, Descriptions. */
  descriptions: Descriptions;
  /**
   * Whether the one-time hint, "Hover anything for a second, or press Shift F1, to see what it
   * does.", has been shown (issue #238). Set the first time it shows, so a reload never shows it again.
   */
  descriptionsHintSeen: boolean;
  /**
   * The Inspector sections the person folded or opened, by kind-level id such as `path.heading` or
   * `step.more` (issue #239, UI_GUIDE section 9.3). A section with no entry takes its own default.
   * It is layout, so it is outside every preset: a preset never writes it.
   */
  inspectorFolds: Readonly<Record<string, boolean>>;
  /**
   * The person's own keys, by binding id (`app/keymap.ts`): Settings, Keyboard. A binding with no entry
   * has its default key; null means no key.
   */
  keys: KeyOverrides;
  /**
   * The bindings whose new default key was already one of the person's keys, so they were left
   * without one, that the Keyboard section has said so for (spec 15 section 8.3). It says so once.
   * Layout, outside every preset.
   */
  keysDisplacedSeen: string[];
  /**
   * The preset the settings came from, and whether the person chose it. A setting with nothing stored
   * takes this preset's value. Preferences saved before presets existed have none, which reads as
   * Essential, not chosen.
   */
  preset: PresetRef;
}

/** The most folded groups remembered; the oldest are forgotten first. */
export const MAX_FOLDED_GROUPS = 200;

/** A group's key in `foldedGroups`: the auto's file name and the group's id, so two autos never share one. */
export const foldKey = (fileName: string | null, stepId: string): string => `${fileName ?? ""}#${stepId}`;

/**
 * The preferences' version. Loading anything older runs the migrations after it once
 * (`migrateFeatures`) and saves the result at this version, so they never run again.
 *
 * - 1 (issue #112): Commands switched on once for everyone. Before it, every save wrote
 *   `commands: false` whether or not the person had touched the switch, so a stored false from then
 *   is not a choice. A false saved at version 1 or later is, and is kept.
 */
export const PREFS_VERSION = 1;

/** The switches as a version-`from` save left them, brought up to `PREFS_VERSION`. */
export function migrateFeatures(features: FeatureSwitches, from: number): FeatureSwitches {
  if (from < 1 && !features.commands) return { ...features, commands: true };
  return features;
}

export const DEFAULT_PREFS: Prefs = {
  version: PREFS_VERSION,
  theme: "dark",
  snap: true,
  defaultHeading: "linear",
  addPathExtends: false,
  newPathKeepsHeading: settingEntry("editing.newPathKeepsHeading").defaultValue,
  protectMeasuredPins: settingEntry("editing.protectMeasuredPins").defaultValue,
  nudgeIn: settingEntry("editing.nudgeIn").defaultValue,
  nudgeFarIn: settingEntry("editing.nudgeFarIn").defaultValue,
  rotateDeg: settingEntry("editing.rotateDeg").defaultValue,
  scrubStepS: settingEntry("editing.scrubStepS").defaultValue,
  panelLeftW: 300,
  panelRightW: 320,
  findingsH: 180,
  findingsCollapsed: false,
  ledgerOpen: false,
  ledgerH: null,
  tour: NO_TOUR_PROGRESS,
  fieldView: "image+outlines",
  fieldGrid: "tiles",
  fieldStyle: null,
  foldedGroups: [],
  playbackLevel: "ideal",
  clipGhosts: true,
  overheadOutlines: true,
  ledgerCounts: true,
  clearanceOutline: false,
  waypointPins: settingEntry("display.waypointPins").defaultValue,
  waypointPinOverrides: {},
  settingsSection: null,
  features: DEFAULT_FEATURES,
  findingCodes: true,
  toolbar: EVERY_BUTTON,
  optimizeScorer: DEFAULT_OPTIMIZE_SCORER,
  optimizeAllowSplit: true,
  optimizeAllowRanges: true,
  optimizeHoldStartHeadingIn: 0,
  optimizeHoldEndHeadingIn: 0,
  fullSimSpeed: settingEntry("sim.speed").defaultValue,
  descriptions: DEFAULT_DESCRIPTIONS,
  descriptionsHintSeen: false,
  inspectorFolds: {},
  keys: {},
  keysDisplacedSeen: [],
  preset: ESSENTIAL_UNCHOSEN,
};

const KEY = "zenith.ui";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export function loadPrefs(): Prefs {
  let parsed: unknown;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return DEFAULT_PREFS;
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_PREFS;
  }
  if (!isRecord(parsed)) return DEFAULT_PREFS;
  const prefs = readPrefs(parsed, SETTINGS, loadUserPresets().presets);
  // Saved at once, so the migration runs only on this load, whatever the person sets next.
  if (storedVersion(parsed) < PREFS_VERSION) savePrefs(prefs);
  return prefs;
}

const storedVersion = (parsed: Record<string, unknown>): number =>
  typeof parsed["version"] === "number" ? parsed["version"] : 0;

/** `read()`, or `fallback` when reading throws, so one damaged key never costs the others. */
function guarded<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/**
 * The preferences from a stored `zenith.ui` blob, key by key. Each key is read on its own, so one bad
 * value falls back alone and never resets the rest. A registered setting is the first of its stored
 * value, the recorded preset's value and its default (`resolveSetting`); the other keys are layout,
 * which no preset sets. A recorded user preset fills in through the built-in it is based on, so
 * `userPresets` are the stored ones (`zenith.presets`). `settings` is the registry, passed in only by
 * tests.
 */
export function readPrefs(
  parsed: Record<string, unknown>,
  settings: readonly AnySettingEntry[] = SETTINGS,
  userPresets: readonly UserPresetBase[] = [],
): Prefs {
  const version = guarded(() => storedVersion(parsed), 0);
  const preset = guarded(() => parsePresetRef(parsed["preset"]), ESSENTIAL_UNCHOSEN);
  const base = builtInBase(preset, userPresets);
  const at = <K extends keyof Prefs>(key: K, read: (value: unknown) => Prefs[K]): Prefs[K] =>
    guarded(() => read(parsed[key]), DEFAULT_PREFS[key]);
  const number = (fallback: number) => (value: unknown): number => (typeof value === "number" ? value : fallback);
  let prefs: Prefs = {
    ...DEFAULT_PREFS,
    version: PREFS_VERSION,
    panelLeftW: at("panelLeftW", number(DEFAULT_PREFS.panelLeftW)),
    panelRightW: at("panelRightW", number(DEFAULT_PREFS.panelRightW)),
    findingsH: at("findingsH", number(DEFAULT_PREFS.findingsH)),
    findingsCollapsed: at("findingsCollapsed", (value) => value === true),
    ledgerOpen: at("ledgerOpen", (value) => value === true),
    ledgerH: at("ledgerH", parseLedgerHeight),
    tour: at("tour", parseTour),
    foldedGroups: at("foldedGroups", (value) =>
      Array.isArray(value) ? value.filter((key): key is string => typeof key === "string").slice(-MAX_FOLDED_GROUPS) : [],
    ),
    playbackLevel: at("playbackLevel", (value) => (value === "instant" || value === "full" ? value : "ideal")),
    overheadOutlines: at("overheadOutlines", (value) => value !== false),
    waypointPinOverrides: at("waypointPinOverrides", parseWaypointPinOverrides),
    settingsSection: at("settingsSection", parseSection),
    descriptions: at("descriptions", parseDescriptions),
    descriptionsHintSeen: at("descriptionsHintSeen", (value) => value === true),
    inspectorFolds: at("inspectorFolds", parseInspectorFolds),
    keysDisplacedSeen: at("keysDisplacedSeen", (value) =>
      Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string"))] : [],
    ),
    preset,
  };
  for (const entry of settings) {
    const one = entry as SettingEntry;
    const fallback = presetValue(one, base) ?? one.defaultValue;
    prefs = withSetting(prefs, one.id, guarded(() => resolveSetting(one, readStored(parsed, one.storage), base), fallback));
  }
  return { ...prefs, features: migrateFeatures(prefs.features, version) };
}

/** The stored folds, entry by entry: an entry whose value is not a boolean is dropped, the rest kept. */
export function parseInspectorFolds(value: unknown): Record<string, boolean> {
  if (!isRecord(value) || Array.isArray(value)) return {};
  const folds: Record<string, boolean> = {};
  for (const [id, open] of Object.entries(value)) {
    if (typeof open === "boolean") folds[id] = open;
  }
  return folds;
}

function parseTour(value: unknown): TourProgress {
  if (!isRecord(value)) return NO_TOUR_PROGRESS;
  return {
    seen: value["seen"] === true,
    coreDone: value["coreDone"] === true,
    fullDone: value["fullDone"] === true,
  };
}

export function savePrefs(prefs: Prefs): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // A browser with storage blocked still runs the editor; it just forgets the panel widths.
  }
}

/** Applies the theme to the document element, which is where tokens.css reads it. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset["theme"] = theme;
}
