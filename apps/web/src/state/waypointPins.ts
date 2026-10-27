/**
 * Which waypoint pins the field shows (issue #236; decision wp-hide-model A). Hiding a pin is a view
 * choice of one person: it changes what the field draws, what the pointer can reach and what a point
 * snaps onto, and never `waypoints.json`, the undo history or whether anything is unsaved.
 *
 * Two levels decide it. The show mode (`waypointPins`) covers every pin: all of them, only the ones
 * the open auto follows, or none. A per-pin override (`waypointPinOverrides`) then shows or hides one
 * pin in one project whatever the mode says, and is stored only where it differs from the mode, so
 * the map holds exceptions and nothing else.
 *
 * The mode is the registry's `display.waypointPins` (`settings/registry.ts`): `used` by default and
 * in Basic and Essential (issues #211 and #217), and `all` in Full.
 */
import { waypointsUsed } from "@horizon36596/zenith-core";
import type { Auto, Waypoints } from "@horizon36596/zenith-schema";

/** All pins, only the pins the open auto follows, or none. */
export type WaypointPinsMode = "all" | "used" | "none";

export const WAYPOINT_PINS_MODES: readonly WaypointPinsMode[] = ["all", "used", "none"];

/** What every surface calls each mode: the Settings row, the Pins row, the field menu, the palette and the status line. */
export const WAYPOINT_PINS_LABEL: Record<WaypointPinsMode, string> = {
  all: "All",
  used: "This auto's",
  none: "None",
};

/** One pin's override: shown or hidden whatever the mode says. */
export type PinOverride = "show" | "hide";

/** The overrides by `pinKey`, oldest first, which is the order JSON keeps them in. */
export type PinOverrides = Readonly<Record<string, PinOverride>>;

/** The most overrides remembered; the oldest are forgotten first, as `foldedGroups` does. */
export const MAX_WAYPOINT_PIN_OVERRIDES = 500;

/**
 * A stored mode, or `used` for anything that is not one: the field shows the open auto's waypoints
 * until the person asks for more (issues #211 and #217).
 */
export function parseWaypointPins(value: unknown): WaypointPinsMode {
  return value === "all" || value === "none" ? value : "used";
}

/** The stored overrides, keeping only well-formed entries and the newest `MAX_WAYPOINT_PIN_OVERRIDES`. */
export function parseWaypointPinOverrides(value: unknown): PinOverrides {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, PinOverride] => entry[1] === "show" || entry[1] === "hide",
  );
  return Object.fromEntries(entries.slice(-MAX_WAYPOINT_PIN_OVERRIDES));
}

/**
 * One pin's key in the overrides: the project's key and the waypoint's name, split by the first `#`.
 * The project's key has its `%` and `#` escaped, so a project key with a `#` in it never reads as
 * another project's key followed by a name: `a` and `a#b` keep apart.
 */
export const pinKey = (projectKey: string, name: string): string =>
  `${projectKey.replaceAll("%", "%25").replaceAll("#", "%23")}#${name}`;

/** Whether the mode alone shows the pin called `name`, given the names the open auto follows. */
export function shownByMode(mode: WaypointPinsMode, name: string, used: ReadonlySet<string>): boolean {
  if (mode === "all") return true;
  if (mode === "none") return false;
  return used.has(name);
}

export interface PinVisibilityInput {
  waypoints: Waypoints | null | undefined;
  auto: Auto | null;
  mode: WaypointPinsMode;
  overrides: PinOverrides;
  /** The open project's key (`projectKey`), or null with no project, where only the mode counts. */
  projectKey: string | null;
}

/** The names of the waypoints whose pins are hidden. */
export function hiddenWaypointNames(input: PinVisibilityInput): Set<string> {
  const hidden = new Set<string>();
  const names = Object.keys(input.waypoints?.waypoints ?? {});
  if (names.length === 0) return hidden;
  const used = new Set(input.auto === null ? [] : waypointsUsed(input.auto));
  for (const name of names) {
    const override = input.projectKey === null ? undefined : input.overrides[pinKey(input.projectKey, name)];
    const shown = override === undefined ? shownByMode(input.mode, name, used) : override === "show";
    if (!shown) hidden.add(name);
  }
  return hidden;
}

/** The overrides without `key`, then with it added last when given, capped oldest first. */
function withEntry(overrides: PinOverrides, key: string, value: PinOverride | undefined): PinOverrides {
  const next: Record<string, PinOverride> = {};
  for (const [other, entry] of Object.entries(overrides)) if (other !== key) next[other] = entry;
  if (value !== undefined) next[key] = value;
  const entries = Object.entries(next);
  return entries.length > MAX_WAYPOINT_PIN_OVERRIDES ? Object.fromEntries(entries.slice(-MAX_WAYPOINT_PIN_OVERRIDES)) : next;
}

/**
 * The overrides once pin `key` is shown or hidden. Where that is what the mode gives anyway the
 * override goes; otherwise it is stored as the newest entry.
 */
export function withPinShown(overrides: PinOverrides, key: string, shown: boolean, byMode: boolean): PinOverrides {
  return withEntry(overrides, key, shown === byMode ? undefined : shown ? "show" : "hide");
}

/** The overrides once waypoint `from` in project `projectKey` is renamed `to`: its override moves with it. */
export function withPinRenamed(overrides: PinOverrides, projectKey: string, from: string, to: string): PinOverrides {
  const value = overrides[pinKey(projectKey, from)];
  if (value === undefined || from === to) return overrides;
  return withEntry(withEntry(overrides, pinKey(projectKey, from), undefined), pinKey(projectKey, to), value);
}

/**
 * The overrides with pin `key` set to `value`, or without it when `value` is undefined. A deleted
 * waypoint's override goes this way, so a new waypoint given its name later starts from the mode;
 * the undo of the delete puts it back.
 */
export function withPinOverride(overrides: PinOverrides, key: string, value: PinOverride | undefined): PinOverrides {
  if (overrides[key] === value) return overrides;
  return withEntry(overrides, key, value);
}

/**
 * The overrides that still differ from a new mode. `all` makes every `show` say nothing and `none`
 * every `hide`, in every project; `used` depends on the auto, so it keeps them all.
 */
export function prunedForMode(overrides: PinOverrides, mode: WaypointPinsMode): PinOverrides {
  if (mode === "used") return overrides;
  const same: PinOverride = mode === "all" ? "show" : "hide";
  return Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== same));
}

/** Whether override `key` is one of project `projectKey`'s (`pinKey`). */
const inProject = (key: string, projectKey: string): boolean => key.startsWith(pinKey(projectKey, ""));

/**
 * The overrides without any of project `projectKey`'s: what the list's Show all leaves, so every pin
 * of that project follows the show mode again. Other projects keep theirs.
 */
export function withoutProjectPins(overrides: PinOverrides, projectKey: string): PinOverrides {
  const kept = Object.entries(overrides).filter(([key]) => !inProject(key, projectKey));
  return kept.length === Object.keys(overrides).length ? overrides : Object.fromEntries(kept);
}

/** How many pins of project `projectKey` are shown or hidden on their own, whatever the mode says. */
export function projectPinOverrideCount(overrides: PinOverrides, projectKey: string | null): number {
  if (projectKey === null) return 0;
  return Object.keys(overrides).filter((key) => inProject(key, projectKey)).length;
}
