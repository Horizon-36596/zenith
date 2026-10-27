/**
 * Decision D12, "select first". With the setting Protect measured waypoints on
 * (`editing.protectMeasuredPins`), a waypoint whose provenance starts with MEASURED or CALIBRATED FROM
 * ROBOT does not move on the first press: that press only selects the pin, and the next press-drag
 * moves it. There is no lock and nothing to unlock.
 *
 * Every change to a pin goes through `moveWaypoint` (`waypointEdits.ts`) with the origin it came
 * from. This module is the rule, pure and without the store, so the canvas and the Inspector can ask
 * it too:
 *
 * - `drag` (a press-drag on the field) and `key` (an arrow key or `R`) on a protected pin that is not
 *   selected are held back; the pin is selected instead.
 * - `typed` (a number in the Inspector, typed, stepped or scrubbed) is deliberate, so it goes through,
 *   and the Inspector says what it relabels before the number is committed.
 * - `proposal` (a partner's proposal accepted for a pin) goes through with the same line. No proposal
 *   changes `waypoints.json` today, because the proposal changes in `packages/schema` act on an auto's
 *   steps only, so nothing passes this origin yet; it is here so the rule is whole when one does.
 */
import { EDITOR_PROVENANCE } from "@horizon36596/zenith-core";
import type { Waypoint, Waypoints } from "@horizon36596/zenith-schema";
import { READ_OFF_LABELS, splitProvenance, type ReadOffLabel } from "../lib/provenance";

/** Where a change to a waypoint pin came from. */
export type MoveOrigin = "drag" | "key" | "typed" | "proposal";

/** The label that makes a pin protected, or null when its label is any other or none. */
export function protectedLabel(waypoint: Pick<Waypoint, "provenance"> | undefined): ReadOffLabel | null {
  const { label } = splitProvenance(waypoint?.provenance);
  return READ_OFF_LABELS.find((candidate) => candidate === label) ?? null;
}

/** The names of the pins that take their first press as a select: none while the setting is off. */
export function protectedPinNames(waypoints: Waypoints | undefined, protect: boolean): ReadonlySet<string> {
  const names = new Set<string>();
  if (!protect || waypoints === undefined) return names;
  for (const [name, waypoint] of Object.entries(waypoints.waypoints)) {
    if (protectedLabel(waypoint) !== null) names.add(name);
  }
  return names;
}

export type MoveVerdict = { kind: "move" } | { kind: "selectFirst"; label: ReadOffLabel };

/** Whether a change from `origin` moves the pin, or only selects it first. */
export function moveVerdict(input: { origin: MoveOrigin; waypoint: Waypoint; selected: boolean; protect: boolean }): MoveVerdict {
  const label = input.protect ? protectedLabel(input.waypoint) : null;
  if (label === null) return { kind: "move" };
  if ((input.origin === "drag" || input.origin === "key") && !input.selected) return { kind: "selectFirst", label };
  return { kind: "move" };
}

/** The status line for a first press that only selected a protected pin. */
export const selectFirstLine = (name: string, label: ReadOffLabel): string =>
  `Waypoint ${name} is ${label}, so the first press only selected it. Press and drag it again to move it.`;

/** What a key on a protected pin that is not selected says: it was not moved. */
export const selectFirstKeyLine = (name: string, label: ReadOffLabel): string =>
  `Waypoint ${name} is ${label}, so it only moves once it is selected. Select it first.`;

/** The notice the Inspector shows before a number is committed, and an accepted proposal shows. */
export const measuredNotice = (label: ReadOffLabel, when: string): string => `This changes ${label} to ${EDITOR_PROVENANCE} if ${when}.`;
