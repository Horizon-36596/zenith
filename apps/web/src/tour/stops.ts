/**
 * The tour's content. Each stop names a `data-tour` anchor in the shell, a title, one or two plain
 * sentences, and optionally a thing to try that moves the tour on by itself. The core tour covers
 * what someone needs to make their first edit; the full tour covers every feature.
 */
import { modifierSentence } from "../help/canvasHelp";
import { keyLabel, type ShortcutId } from "../app/shortcuts";
import { getState } from "../state/store";
import type { TourStop, TourStops } from "./model";
import { hostById, hostIdFromSearch } from "../project/hostOrigins";
import { isDesktop } from "../project/desktop";
import { actionShown, tourStopShown, type FeatureSwitches } from "../state/features";
import { RUN_GROUP } from "../app/toolbarRun";
import type { Prefs } from "../state/prefs";
import { toolbarButtonShown } from "../settings/registry";

/**
 * A key in a stop's text. The tour shows the person's key there when it runs (`withKeys`), or
 * `without` while they have left that action with no key, so a stop never names a key that does
 * nothing.
 */
const key = (id: ShortcutId, without: string): string => `{key:${id}|${without}}`;

export const CORE_STOPS: readonly TourStop[] = [
  {
    id: "field",
    anchor: "field",
    title: "This is the field",
    body: "The FTC field from above, with an example auto on it. The dots are where the robot drives to, and the outline is the robot itself.",
    task: { label: "Try it (optional): drag one of the dots on the path.", signal: "pointDragged" },
    side: "right",
  },
  {
    id: "steps",
    anchor: "steps",
    title: "The steps",
    body: "The robot runs these top to bottom. A step drives a path, runs a command, waits, or groups other steps.",
    task: { label: "Try it (optional): click a step to select it.", signal: "stepSelected" },
    side: "right",
  },
  {
    id: "insert",
    anchor: "insert",
    title: "Add a step",
    body: "Insert puts a new step straight after the selected one. A new path starts where that step ends, so you can add to the middle of an auto.",
    task: { label: "Try it (optional): open Insert and add a Path.", signal: "stepInserted" },
    // The sentence is about the steps list, so the card keeps off all of it, not only the button.
    keepClear: ["steps"],
    side: "right",
  },
  {
    id: "inspector",
    anchor: "inspector",
    title: "The inspector",
    body: "Every setting of the selected step: where it goes, which way the robot faces, how fast. With nothing selected it shows the auto's start and its waypoints. Hover a ? for what a section means.",
    prepare: "selectFirstPath",
    side: "left",
  },
  {
    // Waypoints are where Zenith differs most from other FTC path tools (issue #217).
    id: "waypoints",
    anchor: "section.waypoints",
    title: "Waypoints",
    body: "A waypoint is a named spot measured once on the real field and saved in waypoints.json. Any number of autos can follow it, so moving it once moves every auto that uses it.",
    // The Waypoints list shows in the Routine view, with nothing selected (issue #244).
    prepare: "selectNothing",
    side: "left",
  },
  {
    id: "findings",
    anchor: "findings",
    title: "Problems",
    body: "Zenith checks the auto as you edit: hitting a wall, running out of time, shooting with nothing loaded. Click a problem to jump to its step.",
    side: "top",
  },
  {
    id: "run",
    anchor: "run",
    title: "Play and save",
    body: `Play shows the robot running the auto. Save writes the file back to your robot's repository; the example is read only, so there Save asks whether to save the full project or just the auto.`,
    task: { label: `Try it (optional): press ${keyLabel("playPause")} to play.`, signal: "playToggled" },
    side: "bottom",
  },
];

export const FULL_STOPS: readonly TourStop[] = [
  {
    id: "tool.select",
    anchor: "tool.select",
    title: "Select",
    body: `Click things on the field to select them and drag them to move them. ${key("select", "The Select button")} switches back to it from any tool.`,
    side: "bottom",
  },
  {
    id: "tool.addPath",
    anchor: "tool.addPath",
    title: "Add path",
    body: `Click the field to add a drive to that point. It continues from the selected step, so select a step first to add in the middle. ${key("addCommand", "Add command")} does the same for a command.`,
    task: { label: `Try it (optional): press ${key("addPath", "the Add path button")}.`, signal: "toolChanged" },
    side: "bottom",
  },
  {
    id: "tool.marker",
    anchor: "tool.marker",
    title: "Marker",
    body: "Click a path to fire a command partway along it without stopping, such as starting the intake as the robot arrives. The marker then opens in the inspector, where you set its command, its settings and where it fires; click it again any time to edit it.",
    side: "bottom",
  },
  {
    id: "tool.heading",
    anchor: "tool.heading",
    title: "Heading arrows",
    body: "The arrows at a path's ends show which way the robot faces; drag one to turn it. Right-click a path for Split heading here.",
    task: { label: "Try it (optional): drag one of the heading arrows on the selected path.", signal: "headingTurned" },
    prepare: "selectPathWithHeadingArrows",
    // The drag happens on the field, and the inspector's Heading section shows what it changed.
    keepClear: ["field", "inspector"],
    side: "bottom",
  },
  {
    id: "tool.measure",
    anchor: "tool.measure",
    title: "Measure",
    body: `Drag between two points on the field to read the distance and the angle between them. ${key("measure", "The Measure button")} picks it.`,
    side: "bottom",
  },
  {
    id: "view.snap",
    anchor: "view.snap",
    title: "Snap",
    body: `Points stop at waypoints, walls and a grid, and headings at 15°. ${modifierSentence()}`.trim(),
    task: { label: `Try it (optional): press ${key("snap", "the Snap button")} to turn snap off and on.`, signal: "snapToggled" },
    side: "bottom",
  },
  {
    id: "section.heading",
    anchor: "section.heading",
    title: "Heading modes",
    body: "Tangent faces the way the robot drives, Constant holds one angle, Linear turns between two and Facing point keeps looking at a spot. Piecewise gives each stretch of the path its own mode.",
    prepare: "selectFirstPath",
    side: "left",
  },
  {
    id: "section.markers",
    anchor: "section.markers",
    title: "Markers",
    body: "Each marker is a command fired at a point along this path. Click one here or on the field to change its command, its settings or where it fires.",
    prepare: "selectPathWithMarker",
    side: "left",
  },
  {
    id: "groups",
    // The first group row in the steps list (`StepsPanel.tsx`), so the card sits beside the group
    // rows rather than over them (0.1.2 UX sweep, W1-5).
    anchor: "groups",
    title: "Groups",
    body: "Parallel runs steps at the same time, Sequence chains them into one block, and Branch picks between two sets on a condition. Right-click steps to wrap them in a group.",
    side: "right",
  },
  {
    id: "timeline",
    anchor: "timeline",
    title: "Timeline",
    body: "Each bar is one step's time, against the autonomous period. A striped bar has no estimate yet. Drag the scrubber to move the robot through the auto.",
    side: "right",
  },
  {
    id: "ledger",
    anchor: "ledger",
    title: "Ledger",
    body: "What the robot is holding after each step. It is how Zenith catches a shot with nothing loaded or a robot carrying too much.",
    side: "right",
  },
  {
    id: "provenance",
    anchor: "provenance",
    title: "Where a number came from",
    body: "Each position carries a label: Measured on the real field, Set from editor when dragged here, Placeholder until someone checks it on the robot.",
    prepare: "selectPathWithPose",
    // The chip sits among the inspector's pose rows the sentence is about.
    keepClear: ["inspector"],
    side: "left",
  },
  {
    id: "findings.fixes",
    anchor: "findings",
    title: "Fixing problems",
    // The example has no problems, so the stop says what happens once the list has a row (0.1.2 UX
    // sweep, W1-7).
    body: "When the Problems list has a row, hover its code for what it means and how to fix it. When Zenith knows the fix, a button on the row applies it.",
    side: "top",
  },
  {
    id: "view.alliance",
    anchor: "view.alliance",
    title: "The other alliance",
    body: "Shows the auto mirrored for the other alliance. You always edit one side; the robot mirrors it at match time.",
    task: { label: `Try it (optional): press ${key("alliance", "the alliance button")}.`, signal: "allianceToggled" },
    side: "bottom",
  },
  {
    id: "run.simulate",
    anchor: "run.simulate",
    title: "Simulate",
    body: "Runs the high-fidelity sim, the robot repository's own code, on the auto and lays the recorded drive over the plan, so you can compare them.",
    side: "bottom",
  },
  {
    id: "run.propose",
    anchor: "run.propose",
    title: "Share with GitHub",
    body: "When the project comes from GitHub, Propose commits the auto and a picture of it, and opens a pull request for the team to review.",
    side: "bottom",
  },
  {
    id: "context",
    anchor: "field",
    title: "Right-click menus",
    body: "Right-click a point, a path, a step or empty field for the actions that apply there, each with its shortcut.",
    side: "right",
  },
  {
    id: "palette",
    anchor: "palette",
    title: "Find any action",
    body: `${key("palette", "Search")} opens a search over every action, command, waypoint and auto in the project.`,
    task: { label: `Try it (optional): press ${key("palette", "Search")}.`, signal: "paletteOpened" },
    side: "bottom",
  },
  {
    id: "settings",
    anchor: "settings",
    title: "Settings",
    body: `${key("settings", "The Settings button")} opens Settings: the features you use, this project's robot, and how the editor looks.`,
    prepare: "closeMenus",
    side: "bottom",
  },
  {
    id: "help",
    anchor: "help",
    title: "Shortcuts and help",
    body: `${key("help", "Keyboard shortcuts, in the help menu,")} lists every shortcut and gesture. The help menu replays this tour whenever you want it.`,
    prepare: "closeMenus",
    side: "bottom",
  },
];

/**
 * The stops for a page opened by a host (site/docs/host-protocol.md), named by `hostName`
 * ("DSIM"), or the plain stops for null. In host mode there is no example and no repository: the
 * field holds the auto the host sent, Save sends it back to the host, and there is no GitHub, so the
 * Propose stop, whose button is not on the toolbar there, is left out rather than pointing at nothing.
 */
export function tourStopsFor(hostName: string | null): TourStops {
  if (hostName === null) return { core: CORE_STOPS, full: FULL_STOPS };
  const core = CORE_STOPS.map((stop): TourStop => {
    if (stop.id === "field") {
      return {
        ...stop,
        body: `The FTC field from above, with the auto you opened from ${hostName} on it. The dots are where the robot drives to, and the outline is the robot itself.`,
      };
    }
    if (stop.id === "run") {
      // Save to the host is on the host bar at the right, not in the toolbar's run group, so the
      // stop points at it: the spotlight is on the button the sentence names.
      return {
        ...stop,
        anchor: "host.save",
        body: `Save to ${hostName} sends the auto back to ${hostName}. Play shows the robot running the auto first.`,
      };
    }
    return stop;
  });
  return { core, full: FULL_STOPS.filter((stop) => stop.id !== "run.propose") };
}

/** The host this page was opened for, by the name its copy uses, or null outside host mode. */
const HOST_ID = typeof window === "undefined" ? null : hostIdFromSearch(window.location.search);
const HOST_NAME = HOST_ID === null ? null : (hostById(HOST_ID)?.displayName ?? HOST_ID);

/**
 * The words of the Simulate stop in a browser, which cannot run the robot repository's sim: Simulate
 * there loads the trace that sim records (0.1.2 UX sweep, W1-4).
 */
export const SIMULATE_IN_BROWSER =
  "Loads a trace recorded by the high-fidelity sim in your robot repository and lays that drive over the plan, so you can compare them.";

/** `stops` as a browser shows them: the Simulate stop says Simulate loads a trace there. */
export function browserStops(stops: TourStops): TourStops {
  const reword = (stop: TourStop): TourStop => (stop.id === "run.simulate" ? { ...stop, body: SIMULATE_IN_BROWSER } : stop);
  return { core: stops.core.map(reword), full: stops.full.map(reword) };
}

export const TOUR_STOPS: TourStops =
  HOST_NAME === null && !isDesktop() ? browserStops(tourStopsFor(HOST_NAME)) : tourStopsFor(HOST_NAME);

/** What else the tour follows besides the switches: two display settings of Settings, Editor. */
export interface TourDisplay {
  /** Whether Problems shows each finding's code chip (`display.findingCodes`). Absent means shown. */
  findingCodes?: boolean;
  /** Whether the toolbar shows the button of action `id` (`display.toolbar.<id>`). Absent means every one. */
  buttonShown?: (id: string) => boolean;
}

/** "a, b, or c", or "a or b", for the steps stop's list of what a step does. */
const orList = (items: readonly string[]): string =>
  items.length <= 2 ? items.join(" or ") : `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1] ?? ""}`;

/**
 * The sentences that name a feature, in the words they take while it is off: a stop never points
 * at something the switches in Settings, General, or the display settings, have hidden.
 */
const WITHOUT: Readonly<Record<string, (stop: TourStop, features: FeatureSwitches, display: TourDisplay) => string>> = {
  steps: (stop, features) =>
    features.commands && features.groups
      ? stop.body
      : `The robot runs these top to bottom. A step ${orList([
          "drives a path",
          ...(features.commands ? ["runs a command"] : []),
          "waits",
          ...(features.groups ? ["groups other steps"] : []),
        ])}.`,
  findings: (stop, features) =>
    features.ledger
      ? stop.body
      : "Zenith checks the auto as you edit: hitting a wall or running out of time. Click a problem to jump to its step.",
  "tool.addPath": (stop, features) => (features.commands ? stop.body : stop.body.replace(` ${key("addCommand", "Add command")} does the same for a command.`, "")),
  inspector: (stop, features) =>
    features.waypoints ? stop.body : stop.body.replace("the auto's start and its waypoints", "the auto's start"),
  "tool.heading": (stop, features) =>
    features.advancedHeading
      ? stop.body
      : stop.body.replace(" Right-click a path for Split heading here.", ""),
  "section.heading": (stop, features) =>
    features.advancedHeading ? stop.body : stop.body.replace(" Piecewise gives each stretch of the path its own mode.", ""),
  "findings.fixes": (stop, _features, display) =>
    display.findingCodes !== false
      ? stop.body
      : stop.body.replace(
          "When the Problems list has a row, hover its code for what it means and how to fix it.",
          "When the Problems list has a row, click it to see how to fix it.",
        ),
};

/** `text` with each key in it (`key`) as the person has it now. */
export function withKeys(text: string): string {
  return text.replace(/\{key:(\w+)\|([^}]*)\}/g, (_, id: string, without: string) => keyLabel(id as ShortcutId) ?? without);
}

/**
 * `stops` with the stops the switches hide left out, and the stops on a toolbar button the person
 * took off the toolbar, the rest worded for what is on, and every key the person's own.
 */
export function stopsShown(stops: TourStops, features: FeatureSwitches, display: TourDisplay = {}): TourStops {
  const onToolbar = display.buttonShown ?? (() => true);
  // The "run" anchor is the toolbar's run group, which is not drawn once none of its buttons is
  // (`panels/Toolbar.tsx`), so its stop goes with the last of them. Host mode points that stop at
  // its host bar instead (`tourStopsFor`).
  const anchorShown = (anchor: string): boolean =>
    anchor === "run" ? RUN_GROUP.some((id) => actionShown(id, features) && onToolbar(id)) : onToolbar(anchor);
  const shown = (list: readonly TourStop[]): TourStop[] =>
    list
      .filter((stop) => tourStopShown(stop.id, features) && (stop.anchor === null || anchorShown(stop.anchor)))
      .map((stop) => {
        const reword = WITHOUT[stop.id];
        const body = withKeys(reword === undefined ? stop.body : reword(stop, features, display));
        return { ...stop, body, ...(stop.task === undefined ? {} : { task: { ...stop.task, label: withKeys(stop.task.label) } }) };
      });
  return { core: shown(stops.core), full: shown(stops.full) };
}

let shownCache: { features: FeatureSwitches; findingCodes: boolean; toolbar: Prefs["toolbar"]; keys: unknown; github: boolean; stops: TourStops } | null = null;

/** The tour as it runs now, for the switches, the display settings and the keys as they are set. */
export function currentTourStops(): TourStops {
  const { prefs, backend } = getState();
  const { features, findingCodes, toolbar, keys } = prefs;
  // The toolbar draws Propose only for a project opened from GitHub (issue #412), so its stop goes too.
  const github = backend?.kind === "github";
  if (
    shownCache?.features !== features ||
    shownCache.findingCodes !== findingCodes ||
    shownCache.toolbar !== toolbar ||
    shownCache.keys !== keys ||
    shownCache.github !== github
  ) {
    const buttonShown = (id: string): boolean => toolbarButtonShown(prefs, id) && (id !== "run.propose" || github);
    const stops = stopsShown(TOUR_STOPS, features, { findingCodes, buttonShown });
    shownCache = { features, findingCodes, toolbar, keys, github, stops };
  }
  return shownCache.stops;
}
