/**
 * What the Inspector's compact Waypoints list shows and writes (issue #245), apart from its React
 * parts in `WaypointSection.tsx`. Degrees here, radians in the file (CLAUDE.md rule 3).
 */
import { degToRad, radToDeg } from "@horizon36596/zenith-core";
import { listed } from "../app/edits";
import { writeWaypointNumbers } from "../app/waypointEdits";
import type { ReadOffLabel } from "../lib/provenance";
import { otherAutosRow, type Impact } from "../app/waypointImpact";

/** A row's three numbers: x and y in inches, and the heading in degrees. */
export type RowAxis = "x" | "y" | "h";

/** A waypoint's numbers as its row shows them. */
export function rowValues(pose: { xIn: number; yIn: number; headingRad: number }): Record<RowAxis, number> {
  return { x: pose.xIn, y: pose.yIn, h: radToDeg(pose.headingRad) };
}

/**
 * One number typed, stepped or scrubbed in a row: written through `writeWaypointNumbers`, so it is
 * one undo step and keeps the label the waypoint had, except that MEASURED and CALIBRATED FROM ROBOT
 * become SET FROM EDITOR with a warning (decision measured-typed, option b, issue #273). Returns the
 * label it replaced, or null when the label stayed.
 */
export function writeRowNumber(name: string, axis: RowAxis, value: number): ReadOffLabel | null {
  if (axis === "x") return writeWaypointNumbers(name, { xIn: value });
  if (axis === "y") return writeWaypointNumbers(name, { yIn: value });
  return writeWaypointNumbers(name, { headingRad: degToRad(value) });
}

/** The section's title, one count: "Waypoints (11)". How many pins are hidden is the Pins row's tooltip. */
export function waypointsTitle(count: number): string {
  return `Waypoints (${String(count)})`;
}

/** The Pins row's hint: what each choice shows, and how many pins this person has hidden now. */
export function pinsHint(hidden: number, total: number): string {
  const now =
    hidden === 0
      ? "No pins are hidden now."
      : `${String(hidden)} of ${String(total)} ${total === 1 ? "pin is" : "pins are"} hidden now.`;
  return `Which pins your field shows: all, the ones this auto follows, or none. Only you see it. ${now}`;
}

/**
 * A name as two pieces for a row that has to cut it short: the head, which an ellipsis may shorten,
 * and the tail, which always shows. The tail is the name's last word (`Approach` of `flowerNorthApproach`)
 * or, with no word boundary, its last six characters, so two long names that start alike still differ.
 * A short name is all head.
 */
export function splitName(name: string): { head: string; tail: string } {
  if (name.length <= 14) return { head: name, tail: "" };
  let cut = -1;
  for (let at = name.length - 4; at >= name.length - 10 && at > 4; at -= 1) {
    const here = name.charAt(at);
    const before = name.charAt(at - 1);
    const word = (here >= "A" && here <= "Z" && !(before >= "A" && before <= "Z")) || (/[_\-\s]/.test(before) && !/[_\-\s]/.test(here));
    if (word) {
      cut = at;
      break;
    }
  }
  if (cut === -1) cut = name.length - 6;
  return { head: name.slice(0, cut), tail: name.slice(cut) };
}

const many = (count: number, one: string, more: string): string => `${String(count)} ${count === 1 ? one : more}`;

/**
 * The selected row's one "Used by" line, short enough for one line, and its hint with the full lists:
 * which points of the open auto follow the waypoint, and which other autos do, with the new errors an
 * unsaved move gives them. `impact` is null while the other autos are still being read.
 */
export function usedByLine(here: readonly string[], impact: Impact | null): { here: string; others: string; hint: string } {
  const herePart = here.length === 0 ? "nothing here" : here.length === 1 ? (here[0] ?? "") : `${String(here.length)} points here`;
  let others = "checking…";
  if (impact !== null) {
    const count = impact.followers.length;
    const errors = impact.followers.reduce((sum, row) => sum + (row.newErrors ?? 0), 0);
    const missed = impact.unreadable.length + impact.unchecked.length;
    const parts = [count === 0 ? "no other auto" : many(count, "other auto", "other autos")];
    if (errors > 0) parts.push(many(errors, "new error", "new errors"));
    if (missed > 0) parts.push(`${String(missed)} not checked`);
    others = parts.join(", ");
  }
  const hereFull = here.length === 0 ? "nothing follows it" : listed(here);
  const othersFull = impact === null ? "checking…" : otherAutosRow(impact);
  const end = othersFull.endsWith("…") ? "" : ".";
  return { here: herePart, others, hint: `In this auto: ${hereFull}. In other autos: ${othersFull}${end}` };
}
