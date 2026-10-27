/**
 * The feature switches in Settings, General (issue #101): what each one hides, as pure helpers,
 * plus the hook every surface reads them through, so no panel reads the preference on its own.
 *
 * Pathing is the minimum and has no switch. The others are per person, kept with the UI
 * preferences (`prefs.ts`) and never written into a project's files. Commands starts on, because
 * the example uses it (issue #112); partner sharing and the ledger start off:
 *
 * - Partner sharing: the Partners panel and the partner lanes, partners on the field, the alliance
 *   findings, share files, proposals, and sharing outside the team.
 * - Ledger and ball counting: the Ledger panel and its divider, the counts on the field, the
 *   Transfer step in Insert, the holds at the start, and the ledger's counting and scoring findings.
 *   Its findings about where the robot shoots from (LEGAL_APPROACH, TURRET_RANGE) always show.
 * - Commands: command steps, markers, the command registry, adding an envelope and the findings
 *   about commands. The command library choice stays, since the generated code needs its runtime
 *   even for an auto of paths alone.
 *
 * The presets added five more, on in Essential and Full
 * and off in Basic. Each takes away only the ways to make something; what a file already has shows
 * and edits as usual, under a quiet "Made with" chip in the Inspector (`madeWithOff`):
 *
 * - Step groups: inserting sequence, parallel and branch groups, and Wrap. Unwrap stays.
 * - Waypoints: making, renaming and deleting a waypoint, and the waypoint list. The pins the autos
 *   follow still draw and drag, and a selected pin keeps its own row in the Inspector.
 * - Advanced heading: Piecewise, and "Split heading here", for a path that is not piecewise yet
 *   (`piecewiseOffered`). A piecewise path keeps its full editor.
 * - Optimize path: registered ahead of the action (spec 16), so it is stored and preset but gates
 *   nothing and is not listed in General yet.
 * - Code tab: the bottom panel's Code tab, which falls back to Problems while it is off.
 *
 * - Full sim (issue #207): the desktop app's high-fidelity sim, the Full sim playback level, loading
 *   a trace file, and Simulate outside host mode, which offers nothing else. It is on (hidden from
 *   the beta on 2026-10-08, back on 2026-10-14) and has no row in Settings (`unlisted` in the registry; `FULL_SIM_DEFAULT` is the switch). A
 *   host's own simulator (site/docs/host-protocol.md) is not the robot repository's sim, so it stays.
 *
 * Which actions, insert kinds, tour stops, findings and Settings sections each switch hides is not
 * listed here: it is derived from each registry entry's `gates` (`settings/registry.ts`),
 * and a switch that hides file data supplies its
 * hidden-data hooks there (`settings/hiddenData.ts`).
 *
 * Hiding never changes a file. An auto that already has command steps or markers keeps them, saves
 * them unchanged and still times them; the step list says how many are hidden instead of drawing
 * them, and a hidden step can never be selected.
 */
import type { Finding } from "@horizon36596/zenith-core";
import type { Auto, Heading, Step } from "@horizon36596/zenith-schema";
import type { Tool } from "../canvas/types";
import { COMMANDS_HIDDEN_DATA, type HiddenDataHooks, type HideableSelection } from "../settings/hiddenData";
import { SETTINGS, settingEntry, type AnySettingEntry, type SettingGates } from "../settings/registry";
import type { SettingsSection } from "../settings/sections";
import type { FeatureSwitches } from "./prefs";
import { indexSteps } from "../lib/stepOps";
import { hostIdFromSearch } from "../project/hostOrigins";
import { getState, setSetting, setSettings, useSelector, type State } from "./store";

export type { FeatureSwitches } from "./prefs";
export { DEFAULT_FEATURES, FULL_SIM_DEFAULT, NO_FEATURES } from "./prefs";
export { markerCount } from "../settings/hiddenData";

export type Feature = keyof FeatureSwitches;

/** Every switch on, for tests and for the e2e helper that turns them all on. */
export const ALL_FEATURES: FeatureSwitches = {
  partners: true,
  ledger: true,
  commands: true,
  groups: true,
  waypoints: true,
  advancedHeading: true,
  optimizer: true,
  codeTab: true,
  fullSim: true,
};

export interface FeatureInfo {
  id: Feature;
  /** The switch's name in Settings. */
  label: string;
  /** One sentence under it: what turning it on adds. */
  description: string;
}

/** A switch's registry id (`settings/registry.ts`). */
export const settingId = (feature: Feature) => `features.${feature}` as const;

/** The switch a feature entry of the registry stores. */
const featureOf = (entry: AnySettingEntry): Feature => entry.storage.slice("features.".length) as Feature;

/**
 * The switches in the order General lists them, read from the registry. A switch registered ahead
 * of its feature (`awaiting`; none since Optimize path gained its action) is stored but not listed,
 * since it would turn nothing on yet, and neither is a switch nobody chooses in this version
 * (`unlisted`: Full sim, issue #207), which still hides what it gates.
 */
export const FEATURES: readonly FeatureInfo[] = SETTINGS.filter(
  (entry) => entry.kind === "feature" && entry.awaiting === undefined && entry.unlisted === undefined,
).map((entry) => ({
  id: featureOf(entry),
  label: entry.label,
  description: entry.description,
}));

const FEATURE_ORDER: readonly Feature[] = FEATURES.map((feature) => feature.id);

/**
 * Whether Settings, General lists the switch, so a way to turn it on can point there. Full sim is
 * not listed (issue #207), so what it hides is left out of the palette rather than greyed.
 */
export const featureListed = (feature: Feature): boolean => FEATURE_ORDER.includes(feature);

/** A switch's name in Settings. */
export const featureLabel = (feature: Feature): string => settingEntry(settingId(feature)).label;

/* ---- Gates, derived from the registry --------------------------------------------------------- */

/** For each gated id, the switches it needs on, in registry order. */
export type GateMap = ReadonlyMap<string, readonly Feature[]>;

export type Gates = Readonly<Record<keyof SettingGates, GateMap>>;

const GATE_KINDS: readonly (keyof SettingGates)[] = ["actions", "insertKinds", "tourStops", "findings", "sections", "fixes"];

/**
 * The gate maps of the feature switches in `entries`, read from each entry's `gates`. An id that
 * more than one switch gates needs them all on: `insert.parallel` will need Commands and Step
 * groups once that switch exists.
 */
export function deriveGates(entries: readonly AnySettingEntry[]): Gates {
  const maps = Object.fromEntries(GATE_KINDS.map((kind) => [kind, new Map<string, Feature[]>()])) as Record<keyof SettingGates, Map<string, Feature[]>>;
  for (const entry of entries) {
    if (entry.kind !== "feature" || entry.gates === undefined) continue;
    const feature = featureOf(entry);
    for (const kind of GATE_KINDS) {
      for (const id of entry.gates[kind] ?? []) maps[kind].set(id, [...(maps[kind].get(id) ?? []), feature]);
    }
  }
  return maps;
}

/**
 * Whether this page was opened by a host (site/docs/host-protocol.md). There Simulate is the host's
 * own simulator, which the Full sim switch does not cover. Read once, like `isHostMode`.
 */
const HOST_MODE = typeof window !== "undefined" && hostIdFromSearch(window.location.search) !== null;

/**
 * The ids the Full sim switch gates only outside host mode: outside it, Simulate and its tour stop
 * offer only the full sim, and in host mode they are the host's own simulator (issue #207).
 */
const FULL_SIM_OUTSIDE_HOST: readonly string[] = ["run.simulate"];

/** `gates` with Full sim taken off the ids it gates only outside host mode. */
export function forHostMode(gates: Gates): Gates {
  const strip = (map: GateMap): GateMap =>
    new Map(
      [...map].flatMap(([id, needs]): [string, readonly Feature[]][] => {
        if (!FULL_SIM_OUTSIDE_HOST.includes(id)) return [[id, needs]];
        const rest = needs.filter((feature) => feature !== "fullSim");
        return rest.length === 0 ? [] : [[id, rest]];
      }),
    );
  return { ...gates, actions: strip(gates.actions), tourStops: strip(gates.tourStops) };
}

const GATES = HOST_MODE ? forHostMode(deriveGates(SETTINGS)) : deriveGates(SETTINGS);

/** Whether every switch in `needs` is on. An id no switch gates has nothing to need. */
const allOn = (needs: readonly Feature[] | undefined, features: FeatureSwitches): boolean =>
  needs === undefined || needs.every((feature) => features[feature]);

/* ---- Actions --------------------------------------------------------------------------------- */

/** The switches the action `id` needs on, in registry order; empty when no switch covers it. */
export const actionNeeds = (id: string): readonly Feature[] => GATES.actions.get(id) ?? [];

/** Whether the action `id` is on show. An action no switch covers always is; one that several cover needs them all. */
export const actionShown = (id: string, features: FeatureSwitches): boolean => allOn(GATES.actions.get(id), features);

/** The first switch, in registry order, that keeps the action `id` hidden now; undefined while it shows. */
export const actionOffBy = (id: string, features: FeatureSwitches): Feature | undefined =>
  actionNeeds(id).find((feature) => !features[feature]);

/**
 * Whether More offers to add an envelope to a step that has none (`panels/Inspector.tsx`). Adding
 * one comes with Commands, which every built-in preset turns on, not with Partners (owner ruling
 * 2026-10-10, issue #273). An envelope the step already has always shows, whatever the switch says,
 * as hiding never changes a file.
 */
export const envelopeEntryShown = (features: FeatureSwitches): boolean => features.commands;

/** Whether the Insert menu offers the step kind (`panels/InsertMenu.tsx`). */
export const insertKindShown = (kind: string, features: FeatureSwitches): boolean => allOn(GATES.insertKinds.get(kind), features);

/**
 * Whether the heading menu offers Piecewise, and the field "Split heading here", for a path whose
 * heading is `heading`: always with Advanced heading on, and with it off only for a path that is
 * piecewise already, which keeps its full editor. A D5
 * Join writes piecewise ranges whatever the switch says, since joining is pathing.
 */
export const piecewiseOffered = (heading: Heading | undefined, features: FeatureSwitches): boolean =>
  features.advancedHeading || heading?.mode === "piecewise";

/** The switches whose tools made `step`, in registry order: a group needs Step groups, a piecewise heading Advanced heading. */
export function madeWith(step: Step): Feature[] {
  if (step.kind === "sequence" || step.kind === "parallel" || step.kind === "branch") return ["groups"];
  if (step.kind === "path" && step.heading?.mode === "piecewise") return ["advancedHeading"];
  return [];
}

/**
 * The first switch that made `step` and is off now, for the Inspector's quiet chip, "Made with Step
 * groups, which your settings turn off" (spec 15 section 7). Undefined while every one is on. The
 * step itself shows and edits as usual either way.
 */
export const madeWithOff = (step: Step, features: FeatureSwitches): Feature | undefined =>
  madeWith(step).find((feature) => !features[feature]);

/** The chip's words for a thing made with `feature` while it is off. */
export const madeWithLine = (feature: Feature): string => `Made with ${featureLabel(feature)}, which your settings turn off`;


/**
 * Whether a finding offers a fix of this kind (core's `Fix["kind"]`): Route around (`optimizeRoute`)
 * goes with Optimize path. The finding itself still shows.
 */
export const fixShown = (kind: string, features: FeatureSwitches): boolean => allOn(GATES.fixes.get(kind), features);

/** Whether a Settings section shows for these switches (`settings/sections.ts`): Commands goes with its switch. */
export const sectionShown = (section: SettingsSection, features: FeatureSwitches): boolean =>
  allOn(GATES.sections.get(section), features);

/* ---- Tour ------------------------------------------------------------------------------------ */

/** Whether the tour stop shows (`tour/stops.ts`). */
export const tourStopShown = (id: string, features: FeatureSwitches): boolean => allOn(GATES.tourStops.get(id), features);

/* ---- Hidden data ----------------------------------------------------------------------------- */

interface DataSwitch {
  feature: Feature;
  hooks: HiddenDataHooks;
}

/** The switches that hide file data, each with its hooks. */
const DATA_SWITCHES: readonly DataSwitch[] = SETTINGS.flatMap((entry) =>
  entry.kind === "feature" && entry.hiddenData !== undefined ? [{ feature: featureOf(entry), hooks: entry.hiddenData }] : [],
);

const dataSwitchesOff = (features: FeatureSwitches): DataSwitch[] => DATA_SWITCHES.filter((entry) => !features[entry.feature]);

/* ---- Findings -------------------------------------------------------------------------------- */

type FindingFacts = Pick<Finding, "code" | "message" | "stepId">;

/** The switches that keep a finding out on its own facts: its code, or what its message is about. */
function switchesHiding(finding: Pick<Finding, "code" | "message">, features: FeatureSwitches): Feature[] {
  const off = (GATES.findings.get(finding.code) ?? []).filter((feature) => !features[feature]);
  for (const { feature, hooks } of dataSwitchesOff(features)) {
    if (!off.includes(feature) && hooks.hidesFinding(finding)) off.push(feature);
  }
  return off;
}

/**
 * Whether a finding shows in Problems, on the step list and on the field. `hidden` is the set of
 * steps the switches hide (`hiddenStepIds`): a finding about one of them has nothing to point at.
 */
export function findingShown(finding: FindingFacts, features: FeatureSwitches, hidden: ReadonlySet<string>): boolean {
  return switchesHiding(finding, features).length === 0 && !hidden.has(finding.stepId);
}

/** `findings` without the ones the switches hide. */
export const shownFindings = <T extends FindingFacts>(findings: readonly T[], features: FeatureSwitches, hidden: ReadonlySet<string>): T[] =>
  findings.filter((finding) => findingShown(finding, features, hidden));

/** What the Problems panel's last line says about the problems the switches hide. */
export interface HiddenProblems {
  /** The errors and warnings hidden. Info notes are not counted. */
  count: number;
  /** How many of `count` are errors, so the line can name them: an error is never hidden silently. */
  errors: number;
  /** The switches that hide them, in the order General lists them: Show turns these on. */
  features: Feature[];
}

/**
 * The errors and warnings among `findings`, every finding the check returned, that the switches
 * hide, and which switches hide them. The check itself
 * always runs whole; this only counts what Problems leaves out.
 */
export function hiddenProblems(
  findings: readonly (FindingFacts & Pick<Finding, "severity">)[],
  auto: Auto | null,
  features: FeatureSwitches,
): HiddenProblems {
  const stepsOff = auto === null ? [] : dataSwitchesOff(features).map(({ feature, hooks }) => ({ feature, steps: hooks.hiddenSteps(auto) }));
  const by = new Set<Feature>();
  let count = 0;
  let errors = 0;
  for (const finding of findings) {
    if (finding.severity === "info") continue;
    const hiding = switchesHiding(finding, features);
    for (const { feature, steps } of stepsOff) if (steps.has(finding.stepId)) hiding.push(feature);
    if (hiding.length === 0) continue;
    count += 1;
    if (finding.severity === "error") errors += 1;
    for (const feature of hiding) by.add(feature);
  }
  return { count, errors, features: FEATURE_ORDER.filter((feature) => by.has(feature)) };
}

/**
 * The Problems panel's last line for `count` hidden problems, `errors` of them errors, without its
 * Show button. It names the errors, because the header counts only what the list shows and a deploy
 * still skips an auto for an error nobody can see.
 */
export function hiddenProblemsLine(count: number, errors = 0): string {
  const head = `${String(count)} more ${count === 1 ? "problem" : "problems"} in hidden features`;
  if (errors === 0) return `${head}.`;
  if (count === 1) return `${head}, and it is an error.`;
  if (errors === count) return `${head}, all of them errors.`;
  return `${head}, ${String(errors)} of them ${errors === 1 ? "an error" : "errors"}.`;
}

/** The header's error count's hint when the switches hide errors, or undefined when they hide none. */
export const hiddenErrorsHint = (errors: number): string | undefined =>
  errors === 0
    ? undefined
    : `Not counted: ${String(errors)} ${errors === 1 ? "error" : "errors"} in hidden features, named in the last line of the list. Deploy skips an auto with any error.`;

/** The errors among every finding of an auto, and how many of them the switches hide. */
export interface ErrorsHidden {
  /** Every error the check found, shown or hidden. */
  errors: number;
  /** How many of `errors` the switches hide. */
  hidden: number;
  /** The switches that hide them, in the order General lists them. */
  features: Feature[];
}

/**
 * The errors among `findings`, every finding the check returned, and which of them the switches
 * hide. Propose, Save and the share file count every error, as the CLI does, and say when one they
 * count is in a hidden feature, since the Problems list does not show it.
 */
export function errorsHidden(
  findings: readonly (FindingFacts & Pick<Finding, "severity">)[],
  auto: Auto | null,
  features: FeatureSwitches,
): ErrorsHidden {
  const errors = findings.filter((finding) => finding.severity === "error");
  const hidden = hiddenProblems(errors, auto, features);
  return { errors: errors.length, hidden: hidden.count, features: hidden.features };
}

/**
 * Where the hidden errors are, to follow an error count: ", in a feature your settings hide (Ledger
 * and ball counting)" when every error is hidden, ", 1 of them in ..." when some are, and nothing
 * when none is.
 */
export function hiddenErrorsWhere({ errors, hidden, features }: ErrorsHidden): string {
  if (hidden === 0) return "";
  const where = `${features.length === 1 ? "a feature" : "features"} your settings hide (${features.map(featureLabel).join(", ")})`;
  return hidden === errors ? `, in ${where}` : `, ${String(hidden)} of them in ${where}`;
}

/** "turn the feature on", or "turn the features on" when several switches hide the errors. */
export const turnOnWords = (features: readonly Feature[]): string =>
  `turn the ${features.length === 1 ? "feature" : "features"} on`;

/**
 * What an empty Problems list says, given how many findings the switches left in (`listed`, before
 * the severity filter) and how many errors and warnings they hide. With every finding hidden it
 * must not say "No problems found." above a line that counts the hidden ones.
 */
export function emptyProblemsLine(listed: number, hidden: number): string {
  if (listed > 0) return "No problems at that severity.";
  return hidden > 0 ? "No problems in the features you have on." : "No problems found.";
}

/* ---- Steps ----------------------------------------------------------------------------------- */

const NONE: ReadonlySet<string> = new Set();

/**
 * The ids of the steps the switches hide in `auto`, from the hooks of each data switch that is off:
 * today its command steps, at any depth, while Commands is off. They stay in the file, keep their
 * time and are saved unchanged.
 */
export function hiddenStepIds(auto: Auto | null, features: FeatureSwitches): ReadonlySet<string> {
  if (auto === null) return NONE;
  const off = dataSwitchesOff(features);
  const [only] = off;
  if (only === undefined) return NONE;
  if (off.length === 1) return only.hooks.hiddenSteps(auto);
  const hidden = new Set<string>();
  for (const { hooks } of off) for (const id of hooks.hiddenSteps(auto)) hidden.add(id);
  return hidden.size === 0 ? NONE : hidden;
}

/**
 * Where a step moving one place up (`delta` -1) or down (+1) lands, as an index into its siblings,
 * while some of them are hidden. The rule: a step moves past the next visible sibling in that
 * direction and lands right beside it, on its far side. Hidden siblings never move; the ones the step
 * passes on its way end up on its other side. So the visible order changes exactly as the person
 * sees it, and no hidden step changes its place among the visible ones. Null when no visible sibling
 * lies that way, so there is nothing to move past.
 */
export function visibleMoveIndex(
  siblingIds: readonly string[],
  index: number,
  delta: -1 | 1,
  hidden: ReadonlySet<string>,
): number | null {
  for (let at = index + delta; at >= 0 && at < siblingIds.length; at += delta) {
    const id = siblingIds[at];
    if (id !== undefined && !hidden.has(id)) return at;
  }
  return null;
}

/**
 * How many hidden steps sit inside the steps in `roots`, at any depth. Deleting a group deletes
 * everything in it, so the step list asks first when some of that cannot be seen.
 */
export function hiddenInside(auto: Auto | null, roots: readonly string[], features: FeatureSwitches): number {
  const hidden = hiddenStepIds(auto, features);
  if (auto === null || hidden.size === 0 || roots.length === 0) return 0;
  const entries = indexSteps(auto);
  const parentOf = new Map(entries.map((entry) => [entry.id, entry.parentId]));
  let count = 0;
  for (const id of hidden) {
    for (let at = parentOf.get(id); at !== undefined; at = parentOf.get(at)) {
      if (roots.includes(at)) {
        count += 1;
        break;
      }
    }
  }
  return count;
}

/**
 * What a hidden step is called in the question before a delete: the data switch's own word while
 * one is off, and plain "step" if several ever are.
 */
export function hiddenStepNoun(features: FeatureSwitches): { one: string; many: string } {
  const off = dataSwitchesOff(features);
  return off.length === 1 && off[0] !== undefined ? off[0].hooks.stepNoun : { one: "step", many: "steps" };
}

/** One line per data switch that is off and hides something in `auto`, for the step list. */
export function hiddenDataNotes(auto: Auto | null, features: FeatureSwitches): { feature: Feature; note: string }[] {
  if (auto === null) return [];
  return dataSwitchesOff(features).flatMap(({ feature, hooks }) => {
    const note = hooks.note(auto);
    return note === null ? [] : [{ feature, note }];
  });
}

/**
 * The one line the step list shows while Commands is off and the auto has command steps or markers,
 * or null when there is nothing hidden. They are kept in the file; this says where they went.
 */
export function hiddenCommandsNote(auto: Auto | null, features: FeatureSwitches): string | null {
  if (auto === null || features.commands) return null;
  return COMMANDS_HIDDEN_DATA.note(auto);
}

/**
 * The selection with anything hidden taken out: a hidden step becomes no selection, and each data
 * switch that is off takes out the parts of a step it hides (Commands turns a marker into its path).
 * `store.setSelection` runs every selection through this.
 */
export function shownSelection<T extends HideableSelection>(selection: T, auto: Auto | null, features: FeatureSwitches): T {
  const off = dataSwitchesOff(features);
  if (off.length === 0) return selection;
  if (selection.stepId !== undefined && hiddenStepIds(auto, features).has(selection.stepId)) return {} as T;
  return off.reduce((shown, { hooks }) => hooks.shownSelection(shown), selection);
}

/* ---- Reading and writing the switches -------------------------------------------------------- */

const selectFeatures = (state: State): FeatureSwitches => state.prefs.features;

/** The switches now, outside React. */
export const getFeatures = (): FeatureSwitches => getState().prefs.features;

/** The switches, for a component; it draws again when one changes. */
export const useFeatures = (): FeatureSwitches => useSelector(selectFeatures);

/** One switch, for a component that only cares about it. */
export const useFeature = (feature: Feature): boolean => useFeatures()[feature];

/** Whether the tool can stay picked: a tool goes with its `tool.` action, so marker and Add command go with Commands. */
export const toolShown = (tool: Tool, features: FeatureSwitches): boolean => actionShown(`tool.${tool}`, features);

/**
 * Turns one switch on or off, through `setSetting`. Everything it covers comes back or goes at once,
 * with no reload; a selection that the switch now hides is cleared.
 */
export function setFeature(feature: Feature, on: boolean): void {
  if (getFeatures()[feature] === on) return;
  setSetting(settingId(feature), on);
}

/** The switches named in `features` at once, in one write, for tests and the e2e helper; the rest stay as they are. */
export function setFeatures(features: Partial<FeatureSwitches>): void {
  setSettings(
    Object.fromEntries(
      (Object.entries(features) as [Feature, boolean | undefined][]).flatMap(([feature, on]) =>
        on === undefined ? [] : [[settingId(feature), on]],
      ),
    ),
  );
}

/** Turns on each switch in `features` at once, in one write: Problems' Show for hidden problems. */
export function turnOnFeatures(features: readonly Feature[]): void {
  const off = features.filter((feature) => !getFeatures()[feature]);
  if (off.length === 0) return;
  setSettings(Object.fromEntries(off.map((feature) => [settingId(feature), true])));
}
