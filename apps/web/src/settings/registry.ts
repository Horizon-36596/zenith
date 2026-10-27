/**
 * The settings registry. Every switch, display option and editing setting is one entry here, and
 * loading and saving the preferences (`state/prefs.ts`) and the presets (`presets.ts`) read the entries
 * rather than keeping lists of their own. A new switch, option or key goes into the registry first
 * (UI_GUIDE, "Customization").
 *
 * A feature switch's `gates` list what turning it off hides, and `state/features.ts` derives every
 * gate it applies from them, so no other module keeps a list of what a switch hides. A switch that
 * hides file data also carries its `hiddenData` hooks (`hiddenData.ts`).
 *
 * The module is pure: no DOM and no storage. It is tested in `registry.test.ts`.
 */
import { NUDGE_FAR_IN, NUDGE_IN, ROTATE_DEG, SCRUB_STEP_S } from "../app/shortcuts";
import type { DefaultHeadingMode, FieldGrid, FieldView, OptimizeScorer, Prefs, Theme } from "../state/prefs";
import { FULL_SIM_DEFAULT } from "../state/fullSimSwitch";
import { DEFAULT_SIM_SPEED, SIM_SPEEDS, SIM_SPEED_LABEL, type SimSpeed } from "../state/simSpeed";
import { WAYPOINT_PINS_LABEL, WAYPOINT_PINS_MODES, type WaypointPinsMode } from "../state/waypointPins";
import { COMMANDS_HIDDEN_DATA, type HiddenDataHooks } from "./hiddenData";
import type { SettingsSection } from "./sections";

/** The built-in presets, in the order the cards show them (`presets.ts`). */
export const BUILT_IN_PRESET_IDS = ["basic", "essential", "full"] as const;
export type BuiltInPresetId = (typeof BUILT_IN_PRESET_IDS)[number];

/**
 * The buttons of the toolbar's groups, each its action's id and label (`app/actions.ts`
 * `TOOLBAR_GROUPS`, and the Documentation button), in the order the toolbar draws them. Each has a
 * `display.toolbar.<id>` setting that takes the button off the toolbar and nothing else: its key,
 * its menu items and its palette row still work. Search, Settings and Help are not here, because they
 * are the way back to everything else. `registry.test.ts` fails when the toolbar gains a button this
 * list does not name.
 */
export const TOOLBAR_BUTTONS = [
  { id: "tool.select", label: "Select" },
  { id: "tool.addPath", label: "Add path" },
  { id: "tool.extendChain", label: "Extend this chain" },
  { id: "tool.marker", label: "Marker" },
  { id: "tool.heading", label: "Heading" },
  { id: "tool.measure", label: "Measure" },
  { id: "view.snap", label: "Snap" },
  { id: "edit.undo", label: "Undo" },
  { id: "edit.redo", label: "Redo" },
  { id: "path.optimize", label: "Optimize path" },
  { id: "run.validate", label: "Validate" },
  { id: "view.play", label: "Play" },
  { id: "run.simulate", label: "Simulate" },
  { id: "run.save", label: "Save" },
  { id: "run.propose", label: "Propose" },
  { id: "desktop.sim", label: "Run high-fidelity sim" },
  { id: "desktop.deploy", label: "Deploy autos into the robot repo" },
  { id: "desktop.git", label: "Commit, push and open a pull request" },
  { id: "share.open", label: "Share this auto" },
  { id: "share.page", label: "Sharing" },
  { id: "view.alliance", label: "Mirror to the other alliance" },
  { id: "help.docs", label: "Documentation" },
] as const;

export type ToolbarButtonId = (typeof TOOLBAR_BUTTONS)[number]["id"];

/** A toolbar button's registry id. */
export type ToolbarSettingId = `display.toolbar.${ToolbarButtonId}`;

export const toolbarSettingId = (id: ToolbarButtonId): ToolbarSettingId => `display.toolbar.${id}`;

/** Whether `id` names a button `TOOLBAR_BUTTONS` lists. */
export const isToolbarButton = (id: string): id is ToolbarButtonId => TOOLBAR_BUTTONS.some((button) => button.id === id);

/** The feature switches, by their registry ids. */
export type FeatureSettingId =
  | "features.partners"
  | "features.ledger"
  | "features.commands"
  | "features.groups"
  | "features.waypoints"
  | "features.advancedHeading"
  | "features.optimizer"
  | "features.codeTab"
  | "features.fullSim";

/** The value each registered setting holds, by its registry id. */
export type SettingValues = Record<FeatureSettingId, boolean> & Record<ToolbarSettingId, boolean> & OtherSettingValues;

interface OtherSettingValues {
  "optimizer.scorer": OptimizeScorer;
  "optimizer.allowSplit": boolean;
  "optimizer.allowRanges": boolean;
  /** Hold the start heading over the first this many inches of the route; 0 is off (issue #448). */
  "optimizer.holdStartHeadingIn": number;
  /** Hold the end heading over the last this many inches of the route; 0 is off (issue #448). */
  "optimizer.holdEndHeadingIn": number;
  /** How the desktop app runs the full sim: Basic, Fast or Ultrafast (`state/simSpeed.ts`). */
  "sim.speed": SimSpeed;
  "editing.snap": boolean;
  "editing.defaultHeading": DefaultHeadingMode;
  "editing.addPathExtends": boolean;
  /** A new path starts at the heading the robot has where the step before it ends, and keeps it. */
  "editing.newPathKeepsHeading": boolean;
  /** A pin labelled MEASURED or CALIBRATED FROM ROBOT only selects on its first press (section 13). */
  "editing.protectMeasuredPins": boolean;
  /** How far an arrow key moves a point or a waypoint pin, in inches. */
  "editing.nudgeIn": number;
  /** How far Shift and an arrow key moves it, in inches. */
  "editing.nudgeFarIn": number;
  /** How far `R` and Shift `R` turn a heading, in degrees (degrees are for the UI only). */
  "editing.rotateDeg": number;
  /** How far `,` and `.` and the timeline's step buttons move the playhead, in seconds. */
  "editing.scrubStepS": number;
  "display.clipGhosts": boolean;
  "display.ledgerCounts": boolean;
  "display.clearanceOutline": boolean;
  /** Which waypoint pins the field shows: all, the ones the open auto follows, or none (issue #236). */
  "display.waypointPins": WaypointPinsMode;
  "display.theme": Theme;
  "display.fieldView": FieldView;
  "display.fieldGrid": FieldGrid;
  /** The field picture's named look, or null for the field's own default. */
  "display.fieldStyle": string | null;
  /** Whether a finding in Problems shows its code chip. */
  "display.findingCodes": boolean;
  /** The person's own keys (`app/keymap.ts`), by binding id; null means the action has no key. */
  "keys.bindings": KeyOverrides;
}

/**
 * The keys a person set, by binding id (an action id), in the written form (`Ctrl Shift E`), or
 * null for no key. A binding with no entry has its default. Only the shape is checked here;
 * `resolveKeymap` drops an entry whose key is not one a person may use, so a damaged entry falls back
 * alone.
 */
export type KeyOverrides = Readonly<Record<string, string | null>>;

export type SettingId = keyof SettingValues;

export interface SettingOption<T> {
  value: T;
  label: string;
}

/** How Settings shows the setting. A number has its unit, its range and the step of its arrow keys. */
export type SettingControl<T> =
  | { type: "switch" }
  /** The Keyboard section's own table of bindings (`settings/KeyboardPane.tsx`). */
  | { type: "keymap" }
  | {
      type: "number";
      /** The unit the number is written in: `in`, `°` or `s`. */
      unit: string;
      min: number;
      max: number;
      step: number;
    }
  | {
      type: "segmented" | "dropdown";
      /** The choices, or `fieldStyles` for the open field file's picture looks (`field.image.variants`). */
      options: readonly SettingOption<T>[] | "fieldStyles";
    };

/**
 * What each built-in preset sets the setting to; `leave`, built-ins do not set it, though a user
 * preset may; or `never`, it is outside every preset, user presets included: layout (spec 15
 * section 2), or a switch nobody chooses in this version (`unlisted`).
 */
export type SettingPresets<T> = Readonly<Record<BuiltInPresetId, T>> | "leave" | "never";

/**
 * What a feature switch hides while it is off, by id. An action that more than one switch gates
 * needs all of them on. A toolbar button, a key and a menu item are their action, so gating the
 * action takes them all out.
 */
export interface SettingGates {
  /** Ids in `ACTIONS` (`app/actions.ts`). */
  actions?: readonly string[];
  /** Step kinds in the Insert menu (`panels/InsertMenu.tsx`). */
  insertKinds?: readonly string[];
  /** Stop ids in the tour (`tour/stops.ts`). */
  tourStops?: readonly string[];
  /** Finding codes (core's `FINDING_HELP`), left out of Problems, the step list and the field. */
  findings?: readonly string[];
  /** Settings sections. */
  sections?: readonly SettingsSection[];
  /**
   * Fix kinds (core's `Fix["kind"]`) whose button a finding leaves out, such as `optimizeRoute`,
   * which opens the Optimize card. The finding itself still shows.
   */
  fixes?: readonly string[];
}

export interface SettingEntry<Id extends SettingId = SettingId> {
  /** A stable dotted id, used in preset files. */
  id: Id;
  /** The key in `zenith.ui`, dotted for a nested one. Existing names stay. */
  storage: string;
  scope: "person" | "robot";
  kind: "feature" | "display" | "editing" | "keys";
  section: SettingsSection;
  group: string;
  label: string;
  description: string;
  control: SettingControl<SettingValues[Id]>;
  /** The value, or undefined when the stored value is absent or wrong. Never throws on junk. */
  parse: (raw: unknown) => SettingValues[Id] | undefined;
  defaultValue: SettingValues[Id];
  presets: SettingPresets<SettingValues[Id]>;
  /** The settings this one depends on: while one is off this one keeps its value and shows disabled. */
  needs: readonly SettingId[];
  /**
   * What turning it off hides: file data (so it needs hidden-data hooks), only the ways to author
   * something, or nothing.
   */
  hides: "data" | "authoring" | "none";
  /** What the switch hides while it is off; only feature switches have gates. */
  gates?: SettingGates;
  /** The hidden-data hooks, which every entry that `hides` data has (spec 15 section 7). */
  hiddenData?: HiddenDataHooks;
  /**
   * What must exist before Settings lists the switch, for a switch registered ahead of the feature
   * it turns on. Its value is stored and the presets set it, but it gates nothing and no Settings row
   * shows it until the unit that builds the feature gives it its gates and drops this.
   */
  awaiting?: string;
  /**
   * Why Settings lists no row for the switch, for one nobody chooses in this version: Full sim, which
   * the owner sets for everyone (issue #207; on since 2026-10-14). It still hides what its gates name
   * when its default is off, no preset carries it, and only a stored `true` or its default turns it on.
   */
  unlisted?: string;
  /**
   * Set on a setting that only the desktop app acts on, such as Full sim speed: a browser has no
   * robot repository sim to run, so there Settings draws no row for it and search does not find it.
   */
  desktopOnly?: true;
}

/** Any entry, whatever its id. */
export type AnySettingEntry = { [Id in SettingId]: SettingEntry<Id> }[SettingId];

/** A presettable entry: one each built-in preset sets. */
export type PresettableEntry = AnySettingEntry & { presets: Readonly<Record<BuiltInPresetId, unknown>> };

const bool = (raw: unknown): boolean | undefined => (typeof raw === "boolean" ? raw : undefined);

/** The longest heading hold the card and Settings take, in inches (SPEC: the FTC field's 144 in side, `field.json` `sizeIn`). */
export const OPTIMIZE_HOLD_MAX_IN = 144;

/** The step a heading hold moves in, in inches (SET BY HAND: a length along the route to the inch). */
export const OPTIMIZE_HOLD_STEP_IN = 1;

/** A finite number from `min` to `max` inclusive. Anything else, a numeric string included, is no value. */
const numberIn =
  (min: number, max: number) =>
  (raw: unknown): number | undefined =>
    typeof raw === "number" && Number.isFinite(raw) && raw >= min && raw <= max ? raw : undefined;

const oneOf =
  <T extends string>(values: readonly T[]) =>
  (raw: unknown): T | undefined =>
    values.find((value) => value === raw);

/** The longest key text kept, with room to spare: the longest a person can set is 16 characters. */
const MAX_KEY_TEXT = 40;

/** A stored `keys` object, entry by entry: an entry that is not a key text or null is dropped alone. */
function parseKeys(raw: unknown): KeyOverrides | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  return Object.fromEntries(
    Object.entries(raw).filter(
      ([id, value]) =>
        id !== "" && (value === null || (typeof value === "string" && value.trim() !== "" && value.length <= MAX_KEY_TEXT)),
    ),
  ) as KeyOverrides;
}

const same = <T>(value: T): Readonly<Record<BuiltInPresetId, T>> => ({ basic: value, essential: value, full: value });

const THEMES: readonly SettingOption<Theme>[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

const FIELD_VIEW_OPTIONS: readonly SettingOption<FieldView>[] = [
  { value: "image+outlines", label: "Picture with outlines" },
  { value: "image", label: "Picture only" },
  { value: "vector", label: "Outlines only" },
];

const WAYPOINT_PINS_OPTIONS: readonly SettingOption<WaypointPinsMode>[] = WAYPOINT_PINS_MODES.map((mode) => ({
  value: mode,
  label: WAYPOINT_PINS_LABEL[mode],
}));

const OPTIMIZE_SCORERS: readonly SettingOption<OptimizeScorer>[] = [
  { value: "sim", label: "Instant sim" },
  { value: "estimate", label: "Estimate" },
];

/** The heading a new path starts with, in the order the dropdown lists them (spec 15 section 11). */
export const DEFAULT_HEADING_OPTIONS: readonly SettingOption<DefaultHeadingMode>[] = [
  { value: "tangent", label: "Tangent" },
  { value: "linear", label: "Linear" },
  { value: "constant", label: "Constant" },
];

/** The Grid choices in the order the dropdown and the palette action step through them (spec 15 section 10). */
export const FIELD_GRID_OPTIONS: readonly SettingOption<FieldGrid>[] = [
  { value: "off", label: "Off" },
  { value: "tiles", label: "Tiles (24 in)" },
  { value: "12", label: "12 in" },
  { value: "6", label: "6 in" },
];

const SIM_SPEED_OPTIONS: readonly SettingOption<SimSpeed>[] = SIM_SPEEDS.map((speed) => ({ value: speed, label: SIM_SPEED_LABEL[speed] }));

/** Off in Basic, on in Essential and Full: for a returning student (spec 15 sections 1 and 4). */
const RETURNING: Readonly<Record<BuiltInPresetId, boolean>> = { basic: false, essential: true, full: true };

const feature = (
  id: FeatureSettingId,
  label: string,
  description: string,
  presets: Readonly<Record<BuiltInPresetId, boolean>>,
  hides: SettingEntry["hides"],
  gates: SettingGates,
  hiddenData?: HiddenDataHooks,
): SettingEntry<typeof id> => ({
  id,
  storage: id,
  scope: "person",
  kind: "feature",
  section: "general",
  group: "Features",
  label,
  description,
  control: { type: "switch" },
  parse: bool,
  defaultValue: presets.essential,
  presets,
  needs: [],
  hides,
  gates,
  ...(hiddenData === undefined ? {} : { hiddenData }),
});

type EditingNumberId = "editing.nudgeIn" | "editing.nudgeFarIn" | "editing.rotateDeg" | "editing.scrubStepS";

const numberSetting = <Id extends EditingNumberId>(entry: {
  id: Id;
  storage: string;
  label: string;
  description: string;
  unit: string;
  defaultValue: number;
  min: number;
  max: number;
  step: number;
}): SettingEntry<Id> => ({
  id: entry.id,
  storage: entry.storage,
  scope: "person",
  kind: "editing",
  section: "editor",
  group: "Editing",
  label: entry.label,
  description: entry.description,
  control: { type: "number", unit: entry.unit, min: entry.min, max: entry.max, step: entry.step },
  parse: numberIn(entry.min, entry.max),
  defaultValue: entry.defaultValue,
  presets: "leave",
  needs: [],
  hides: "none",
});

/**
 * Every registered setting. The order of the feature switches is the order General lists them.
 * Today's values are spec 15 section 4: Essential is today's Zenith, Basic takes things away for a
 * new student, and Full turns on the two switches that are off today.
 */
export const SETTINGS: readonly AnySettingEntry[] = [
  feature(
    "features.partners",
    "Partner sharing",
    "Partners' autos on your field and timeline, share files, proposals and sharing with other teams.",
    { basic: false, essential: false, full: true },
    "authoring",
    { actions: ["share.open", "share.page", "project.downloadShareFile", "project.downloadProposeShareFile", "proposal.open"] },
  ),
  feature(
    "features.ledger",
    "Ledger and ball counting",
    "What the robot holds after each step, the counts on the field, and the counting problems they find, such as a shot with nothing loaded. Problems with where the robot shoots from always show.",
    { basic: false, essential: false, full: true },
    "authoring",
    {
      actions: ["view.ledgerCounts"],
      insertKinds: ["transfer"],
      tourStops: ["ledger"],
      // Only the ledger's counting and scoring findings: what the robot holds, what a transfer
      // moves and where launched pieces land (`packages/core/src/checks/season.ts`). The ledger's
      // findings about where the robot shoots from, LEGAL_APPROACH (a shot the rules penalise) and
      // TURRET_RANGE (a shot the turret cannot aim), are not here: they show, are drawn and are
      // counted whatever the switch says, since a new student fixes them by moving the robot and
      // never needs the Ledger panel to read them (owner ruling, issue #493).
      findings: ["CAPACITY", "EMPTY_SHOT", "TRANSFER", "LAUNCH_TARGET"],
    },
  ),
  // On in every built-in, because the example uses it (owner ruling, issue #112).
  feature(
    "features.commands",
    "Commands",
    "Command steps and markers from your robot code, adding an envelope to a step, and the command registry.",
    same(true),
    "data",
    {
      actions: [
        "tool.addCommand",
        "tool.marker",
        "insert.command",
        // A new parallel group starts with a command beside the path, so without commands there is none to add.
        "insert.parallel",
        "insert.race",
        "insert.deadline",
        "project.importCommands",
        "project.commands",
        "marker.delete",
      ],
      insertKinds: ["command", "parallel"],
      tourStops: ["tool.marker", "section.markers"],
      // About commands and markers (`packages/core/src/checks/schedule.ts`, `check.ts`).
      findings: ["STATIONARY_MARKER", "MOVES_ROBOT"],
      sections: ["commands"],
    },
    COMMANDS_HIDDEN_DATA,
  ),
  // The switches below take away only the ways to make something (spec 15 section 7): what a file
  // already has shows and edits as usual, with a quiet "Made with" chip in the Inspector.
  feature(
    "features.groups",
    "Step groups",
    "Sequence, parallel and branch groups in Insert, and wrapping steps in one. Groups a file has always show.",
    RETURNING,
    "authoring",
    {
      // Unwrap stays: it acts on a group you can see.
      actions: [
        "insert.sequence",
        "insert.parallel",
        "insert.race",
        "insert.deadline",
        "insert.branch",
        "edit.wrapSequence",
        "edit.wrapParallel",
        "edit.wrapBranch",
      ],
      insertKinds: ["sequence", "parallel", "branch"],
      tourStops: ["groups"],
    },
  ),
  feature(
    "features.waypoints",
    "Waypoints",
    "Making, renaming and deleting waypoints, and the waypoint list. Pins your autos follow still draw and move.",
    RETURNING,
    "authoring",
    {
      actions: ["waypoint.add", "field.addWaypointHere", "waypoint.saveAs", "waypoint.rename", "waypoint.followRename", "waypoint.delete"],
      // The core tour's stop on the Waypoints list (issue #217), which goes with the list.
      tourStops: ["waypoints"],
    },
  ),
  // The heading menu's Piecewise and the field's "Split heading here" are not actions, so
  // `piecewiseOffered` (`state/features.ts`) reads this switch for them.
  feature(
    "features.advancedHeading",
    "Advanced heading",
    "Piecewise headings, a different mode on each stretch of a path. A path that is piecewise already keeps its full editor.",
    RETURNING,
    "authoring",
    {},
  ),
  // Owner ruling D9 (2026-10-08): Optimize path is available to everyone, off in Basic and on in
  // Essential and Full, and anyone can turn it on by hand. Off, it hides every entry point: the two
  // palette commands, and with them the Inspector's Optimize button, which runs `path.optimize`, and
  // any key bound to them; and a finding's Route around action, the `optimizeRoute` fix; and the
  // field's Add a clear path here.
  feature(
    "features.optimizer",
    "Optimize path",
    "Finds a faster route for a path step between its two ends, and shows it before anything changes.",
    { basic: false, essential: true, full: true },
    "authoring",
    { actions: ["path.optimize", "path.optimizeWithOptions", "path.optimizeAll", "field.addClearPathHere"], fixes: ["optimizeRoute"] },
  ),
  // The bottom panel reads this switch for its tabs (`panels/bottomTab.ts`); it hides no action.
  feature(
    "features.codeTab",
    "Code tab",
    "The Code tab beside Problems, with the Java Zenith writes for the open auto.",
    RETURNING,
    "none",
    {},
  ),
  // Owner rulings (00-decisions.md): the robot repository's own sim was hidden from the beta on
  // 2026-10-08 (issue #207) and is back on for everyone since 2026-10-14. Settings has no row for it
  // and `FULL_SIM_DEFAULT` is the switch. Every save writes the switches, so nothing stored was a
  // choice: nothing stored is read, and the default decides for everyone, so turning the constant
  // off hides it again even where a save says `true`.
  // Simulate outside host mode offers only the full sim, so it follows the switch too; in host mode
  // it is the host's own simulator, which `state/features.ts` (`forHostMode`) leaves out of the gate.
  {
    id: "features.fullSim",
    storage: "features.fullSim",
    scope: "person",
    kind: "feature",
    section: "general",
    group: "Features",
    label: "Full sim",
    description: "The robot repository's own sim: the desktop app's high-fidelity sim, the Full sim playback level and loading a trace file.",
    control: { type: "switch" },
    parse: () => undefined,
    defaultValue: FULL_SIM_DEFAULT,
    presets: "never",
    needs: [],
    hides: "authoring",
    gates: { actions: ["desktop.sim", "run.simulate"], tourStops: ["run.simulate"] },
    unlisted: "The owner sets the full sim for everyone with FULL_SIM_DEFAULT (issue #207); it is on.",
  },
  // How the desktop app runs the full sim (site/docs/full-sim-simloop.md, "Full sim speed"). It is
  // about this computer, not about how anyone edits, so no preset sets it. Fast is the default: it
  // costs nothing until the first run. A project without sim.server runs Basic whatever this says.
  {
    id: "sim.speed",
    storage: "fullSimSpeed",
    scope: "person",
    kind: "editing",
    section: "general",
    group: "Full sim",
    label: "Full sim speed",
    description: "How the desktop app runs the robot repository's own sim. A faster speed keeps more of the computer busy.",
    control: { type: "segmented", options: SIM_SPEED_OPTIONS },
    parse: oneOf(SIM_SPEEDS),
    defaultValue: DEFAULT_SIM_SPEED,
    presets: "leave",
    needs: ["features.fullSim"],
    hides: "none",
    desktopOnly: true,
  },
  // The optimizer card's options, kept as the person's last choice. The margin is not here: it is the
  // robot's `footprint.clearanceIn` (owner ruling D8), and the card may override it for one run without
  // saving it. Built-ins leave these alone. Each default is SET BY HAND: the instant sim is the
  // objective (spec 16 section 5.2), and splitting a chain and using heading ranges are how a route
  // gets faster (spec 16 section 3).
  {
    id: "optimizer.scorer",
    storage: "optimizeScorer",
    scope: "person",
    kind: "editing",
    section: "editor",
    group: "Optimize path",
    label: "Score with",
    description: "Which time Optimize path tries to lower: the instant sim's, or the estimate.",
    control: { type: "segmented", options: OPTIMIZE_SCORERS },
    parse: oneOf(OPTIMIZE_SCORERS.map((option) => option.value)),
    defaultValue: "sim",
    presets: "leave",
    needs: ["features.optimizer"],
    hides: "none",
  },
  {
    id: "optimizer.allowSplit",
    storage: "optimizeAllowSplit",
    scope: "person",
    kind: "editing",
    section: "editor",
    group: "Optimize path",
    label: "Allow several paths",
    description: "Lets Optimize path split a chain into up to four paths.",
    control: { type: "switch" },
    parse: bool,
    defaultValue: true,
    presets: "leave",
    needs: ["features.optimizer"],
    hides: "none",
  },
  {
    id: "optimizer.allowRanges",
    storage: "optimizeAllowRanges",
    scope: "person",
    kind: "editing",
    section: "editor",
    group: "Optimize path",
    label: "Allow heading ranges",
    description: "Lets Optimize path change the heading mode part of the way along a path.",
    control: { type: "switch" },
    parse: bool,
    defaultValue: true,
    presets: "leave",
    needs: ["features.optimizer"],
    hides: "none",
  },
  // The heading holds (issue #448), kept as the person's last choice like the options above. Each
  // default is 0, off (SET BY HAND: a hold is a constraint the person asks for, so none is on until
  // they do). The range runs to the field's 144 in side (SPEC: the FTC field, `field.json`
  // `sizeIn`), in steps of 1 in (SET BY HAND: a hold is a length along the route to the inch).
  {
    id: "optimizer.holdStartHeadingIn",
    storage: "optimizeHoldStartHeadingIn",
    scope: "person",
    kind: "editing",
    section: "editor",
    group: "Optimize path",
    label: "Hold start heading for",
    description: "Keeps the heading the robot starts with over the first this many inches of the route. 0 is off.",
    control: { type: "number", unit: "in", min: 0, max: OPTIMIZE_HOLD_MAX_IN, step: OPTIMIZE_HOLD_STEP_IN },
    parse: numberIn(0, OPTIMIZE_HOLD_MAX_IN),
    defaultValue: 0,
    presets: "leave",
    needs: ["features.optimizer"],
    hides: "none",
  },
  {
    id: "optimizer.holdEndHeadingIn",
    storage: "optimizeHoldEndHeadingIn",
    scope: "person",
    kind: "editing",
    section: "editor",
    group: "Optimize path",
    label: "Hold end heading for",
    description: "Reaches the heading the path ends with this many inches before its end, and keeps it. 0 is off.",
    control: { type: "number", unit: "in", min: 0, max: OPTIMIZE_HOLD_MAX_IN, step: OPTIMIZE_HOLD_STEP_IN },
    parse: numberIn(0, OPTIMIZE_HOLD_MAX_IN),
    defaultValue: 0,
    presets: "leave",
    needs: ["features.optimizer"],
    hides: "none",
  },
  {
    id: "editing.snap",
    storage: "snap",
    scope: "person",
    kind: "editing",
    section: "editor",
    group: "Editing",
    label: "Snap",
    description: "Points stop at waypoints, walls and the grid, and headings at 15°. Ctrl flips it for one drag.",
    control: { type: "switch" },
    parse: bool,
    defaultValue: true,
    presets: same(true),
    needs: [],
    hides: "none",
  },
  {
    // Owner ruling D6 (spec 15 section 11): the heading of a new path is a per-person setting, Linear
    // until chosen, so a person who never opens Settings gets Linear from the next new path. Every
    // built-in sets Linear. SET BY HAND: owner ruling 2026-10-08 (D6).
    id: "editing.defaultHeading",
    storage: "defaultHeading",
    scope: "person",
    kind: "editing",
    section: "editor",
    group: "Editing",
    label: "Heading for new paths",
    description: "How a new path turns the robot: Tangent faces the way it drives, Linear turns from the heading it arrives with to the end's, Constant holds the heading it arrives with.",
    control: { type: "dropdown", options: DEFAULT_HEADING_OPTIONS },
    parse: oneOf(DEFAULT_HEADING_OPTIONS.map((option) => option.value)),
    defaultValue: "linear",
    presets: same("linear"),
    needs: [],
    hides: "none",
  },
  {
    // Decision D5 (spec 15 section 4.3): off in every built-in. SET BY HAND: Dohun ruling 2026-10-08 (D5).
    // The add-path tool reads it; the control that turns it on is the tool's own (issue #204).
    id: "editing.addPathExtends",
    storage: "addPathExtends",
    scope: "person",
    kind: "editing",
    section: "editor",
    group: "Editing",
    label: "Extend this chain",
    description: "With a path step selected, adding a path adds to that step's chain instead of making a new step.",
    control: { type: "switch" },
    parse: bool,
    defaultValue: false,
    presets: same(false),
    needs: [],
    hides: "none",
  },
  {
    // Issue #435 (spec 15 section 11): on in every built-in, so a new Linear path starts at the heading the
    // robot already has and keeps it until the person changes it. SET BY HAND: Dohun report 2026-10-12 (#435).
    id: "editing.newPathKeepsHeading",
    storage: "newPathKeepsHeading",
    scope: "person",
    kind: "editing",
    section: "editor",
    group: "Editing",
    label: "Start a new path with the previous path's end heading",
    description: "A new path starts at the heading the robot has where the step before it ends, and a Linear one ends at that heading too until you change it. Tangent is unaffected.",
    control: { type: "switch" },
    parse: bool,
    defaultValue: true,
    presets: same(true),
    needs: [],
    hides: "none",
  },
  {
    // Decision D12 (spec 15 sections 4.3 and 13): on in every built-in, so a pose the team measured on
    // the field is not replaced by one stray drag. SET BY HAND: Dohun ruling 2026-10-08 (D12).
    id: "editing.protectMeasuredPins",
    storage: "protectMeasuredPins",
    scope: "person",
    kind: "editing",
    section: "editor",
    group: "Editing",
    label: "Protect measured waypoints",
    description: "A waypoint labelled MEASURED or CALIBRATED FROM ROBOT only selects on its first press; the next press-drag moves it.",
    control: { type: "switch" },
    parse: bool,
    defaultValue: true,
    presets: same(true),
    needs: [],
    hides: "none",
  },
  // The four editing numbers (spec 15 section 4.3). Each default is CARRIED OVER from the constant of
  // the same name in `app/shortcuts.ts`, so a person who never opens Settings sees every nudge, turn
  // and scrub move as it always has. Each range is SET BY HAND: from a tenth of the default or less,
  // so a key still does something, up to a distance that is still an edit and not a jump across the
  // field. The built-ins leave them: a preset does not change how far a key moves.
  numberSetting({
    id: "editing.nudgeIn",
    storage: "nudgeIn",
    label: "Nudge",
    description: "How far an arrow key moves the selected point or waypoint.",
    unit: "in",
    defaultValue: NUDGE_IN,
    min: 0.05,
    max: 12,
    step: 0.05,
  }),
  numberSetting({
    id: "editing.nudgeFarIn",
    storage: "nudgeFarIn",
    label: "Far nudge",
    description: "How far Shift and an arrow key moves it.",
    unit: "in",
    defaultValue: NUDGE_FAR_IN,
    min: 0.1,
    max: 24,
    step: 0.1,
  }),
  numberSetting({
    id: "editing.rotateDeg",
    storage: "rotateDeg",
    label: "Rotate",
    description: "How far R and Shift R turn a heading.",
    unit: "°",
    defaultValue: ROTATE_DEG,
    min: 0.5,
    max: 90,
    step: 0.5,
  }),
  numberSetting({
    id: "editing.scrubStepS",
    storage: "scrubStepS",
    label: "Playhead step",
    description: "How far the comma and full stop keys move the playhead.",
    unit: "s",
    defaultValue: SCRUB_STEP_S,
    min: 0.01,
    max: 1,
    step: 0.01,
  }),
  {
    id: "display.clipGhosts",
    storage: "clipGhosts",
    scope: "person",
    kind: "display",
    section: "editor",
    group: "Field",
    label: "Clip ghosts",
    description: "The robot drawn in red where a path clips the wall, a structure or a keep-out zone.",
    control: { type: "switch" },
    parse: bool,
    defaultValue: true,
    presets: same(true),
    needs: [],
    hides: "none",
  },
  {
    id: "display.ledgerCounts",
    storage: "ledgerCounts",
    scope: "person",
    kind: "display",
    section: "editor",
    group: "Field",
    label: "Ledger counts",
    description: "The ledger's counts beside each place that holds pieces, and riding with the robot.",
    control: { type: "switch" },
    parse: bool,
    defaultValue: true,
    presets: same(true),
    needs: ["features.ledger"],
    hides: "none",
  },
  // Owner ruling D8: a view of the robot's clearance only. The margin and the CLEARANCE findings
  // come from robot.json, never from a person's setting.
  {
    id: "display.clearanceOutline",
    storage: "clearanceOutline",
    scope: "person",
    kind: "display",
    section: "editor",
    group: "Field",
    label: "Clearance outline",
    description: "A faint outline around the robot at the playhead, its footprint grown by the robot's clearance from field elements.",
    control: { type: "switch" },
    parse: bool,
    defaultValue: false,
    presets: { basic: false, essential: false, full: true },
    needs: [],
    hides: "none",
  },
  // Decision wp-hide-model (00-decisions.md "Waypoint pins") with issues #211 and #217: the field
  // shows the open auto's waypoints, so Essential, which is Zenith as the registry ships (owner ruling
  // essential-invariant), and Basic show `used`, and Full shows every pin, as the ruling planned for
  // Full. The per-pin overrides beside it are layout, which no preset sets.
  {
    id: "display.waypointPins",
    storage: "waypointPins",
    scope: "person",
    kind: "display",
    section: "editor",
    group: "Field",
    label: "Waypoint pins",
    description: "Which pins the field shows. Hidden pins do not snap. Only you see this.",
    control: { type: "segmented", options: WAYPOINT_PINS_OPTIONS },
    parse: oneOf(WAYPOINT_PINS_MODES),
    defaultValue: "used",
    presets: { basic: "used", essential: "used", full: "all" },
    needs: [],
    hides: "none",
  },
  {
    id: "display.theme",
    storage: "theme",
    scope: "person",
    kind: "display",
    section: "editor",
    group: "Appearance",
    label: "Theme",
    description: "Dark or light. The field stays dark in both themes.",
    control: { type: "segmented", options: THEMES },
    parse: oneOf(THEMES.map((option) => option.value)),
    defaultValue: "dark",
    presets: "never",
    needs: [],
    hides: "none",
  },
  {
    id: "display.fieldView",
    storage: "fieldView",
    scope: "person",
    kind: "display",
    section: "editor",
    group: "Field",
    label: "Field view",
    description: "What is drawn under your routine.",
    control: { type: "segmented", options: FIELD_VIEW_OPTIONS },
    parse: oneOf(FIELD_VIEW_OPTIONS.map((option) => option.value)),
    defaultValue: "image+outlines",
    presets: "never",
    needs: [],
    hides: "none",
  },
  {
    // Owner ruling D11 (spec 15 section 10): one Grid setting, Tiles by default, so the 12 in grid is
    // off unless chosen. Every built-in preset sets Tiles: Basic shows tiles only, and Essential is
    // today's Zenith without the 12 in lines.
    id: "display.fieldGrid",
    storage: "fieldGrid",
    scope: "person",
    kind: "display",
    section: "editor",
    group: "Field",
    label: "Grid",
    description: "How much of the field's grid is drawn: none, the 24 in tile seams, or lines every 12 or 6 in.",
    control: { type: "dropdown", options: FIELD_GRID_OPTIONS },
    parse: oneOf(FIELD_GRID_OPTIONS.map((option) => option.value)),
    defaultValue: "tiles",
    presets: same("tiles"),
    needs: [],
    hides: "none",
  },
  {
    id: "display.fieldStyle",
    storage: "fieldStyle",
    scope: "person",
    kind: "display",
    section: "editor",
    group: "Field",
    label: "Field style",
    description: "Which of the field picture's looks is drawn, when the field file has more than one.",
    control: { type: "dropdown", options: "fieldStyles" },
    parse: (raw) => (typeof raw === "string" || raw === null ? raw : undefined),
    defaultValue: null,
    presets: "never",
    needs: [],
    hides: "none",
  },
  {
    id: "display.findingCodes",
    storage: "findingCodes",
    scope: "person",
    kind: "display",
    section: "editor",
    group: "Appearance",
    label: "Finding codes",
    description: "The code beside each problem, such as COLLISION, whose hover says how to fix it. The sentence always shows.",
    control: { type: "switch" },
    parse: bool,
    defaultValue: true,
    presets: RETURNING,
    needs: [],
    hides: "none",
  },
  ...TOOLBAR_BUTTONS.map(
    ({ id, label }) =>
      ({
        id: toolbarSettingId(id),
        // Nested by the action id's own dot, as `toolbar: { tool: { select: true } }`.
        storage: `toolbar.${id}`,
        scope: "person",
        kind: "display",
        section: "editor",
        group: "Toolbar",
        label,
        description: "Its button on the toolbar. Hidden, its key, its menu items and its palette row still work.",
        control: { type: "switch" },
        parse: bool,
        defaultValue: true,
        presets: "leave",
        needs: [],
        hides: "none",
      }) satisfies SettingEntry<ToolbarSettingId> as AnySettingEntry,
  ),
  // Built-in presets never change keys; a user preset carries them only when saved with "Include my
  // keys" (spec 15 sections 2 and 6.1).
  {
    id: "keys.bindings",
    storage: "keys",
    scope: "person",
    kind: "keys",
    section: "keyboard",
    group: "Keys",
    label: "Keys",
    description: "Your own keys for the editor's actions.",
    control: { type: "keymap" },
    parse: parseKeys,
    defaultValue: {},
    presets: "leave",
    needs: [],
    hides: "none",
  },
];

const BY_ID: ReadonlyMap<SettingId, AnySettingEntry> = new Map(SETTINGS.map((entry) => [entry.id, entry]));

/** The entry registered under `id`. */
export function settingEntry<Id extends SettingId>(id: Id): SettingEntry<Id> {
  const entry = BY_ID.get(id);
  if (entry === undefined) throw new Error(`No setting is registered as ${id}.`);
  return entry as unknown as SettingEntry<Id>;
}

/** Whether every built-in preset sets the entry. */
export const isPresettable = (entry: AnySettingEntry): entry is PresettableEntry => typeof entry.presets === "object";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** The raw value at a dotted storage key of a stored blob, or undefined when any part is missing. */
export function readStored(blob: unknown, storage: string): unknown {
  let at: unknown = blob;
  for (const part of storage.split(".")) {
    if (!isRecord(at) || Array.isArray(at)) return undefined;
    at = at[part];
  }
  return at;
}

/** A copy of `blob` with `value` at the dotted storage key, every object on the way copied, not changed. */
function writeStored<T extends object>(blob: T, storage: string, value: unknown): T {
  const [head, ...rest] = storage.split(".");
  if (head === undefined) return blob;
  const record = blob as Record<string, unknown>;
  const inner = record[head];
  const next = rest.length === 0 ? value : writeStored(isRecord(inner) ? inner : {}, rest.join("."), value);
  return { ...blob, [head]: next };
}

/** The setting's value in `prefs`, read at its storage key. */
export function getSetting<Id extends SettingId>(prefs: Prefs, id: Id): SettingValues[Id] {
  return readStored(prefs, settingEntry(id).storage) as SettingValues[Id];
}

/**
 * Whether the toolbar draws the button of action `id` (`display.toolbar.<id>`). A hidden button's
 * key, menu items and palette row still work; an id no setting covers always shows.
 */
export const toolbarButtonShown = (prefs: Prefs, id: string): boolean =>
  !isToolbarButton(id) || getSetting(prefs, toolbarSettingId(id)) !== false;

/** A copy of `prefs` with the setting at `value`; everything else is the same object as before. */
export function withSetting<Id extends SettingId>(prefs: Prefs, id: Id, value: SettingValues[Id]): Prefs {
  return writeStored(prefs, settingEntry(id).storage, value);
}

/**
 * The part of `prefs` that writing the settings in `values` changes, keyed by top-level preference,
 * for `setPrefs`. A nested setting such as `features.commands` brings its whole parent object.
 */
export function settingsPatch(prefs: Prefs, values: Partial<SettingValues>): Partial<Prefs> {
  let next = prefs;
  const touched = new Set<keyof Prefs>();
  for (const [id, value] of Object.entries(values) as [SettingId, SettingValues[SettingId]][]) {
    const entry = settingEntry(id);
    next = writeStored(next, entry.storage, value);
    touched.add(entry.storage.split(".")[0] as keyof Prefs);
  }
  const patch: Partial<Record<keyof Prefs, unknown>> = {};
  for (const key of touched) patch[key] = next[key];
  return patch as Partial<Prefs>;
}
