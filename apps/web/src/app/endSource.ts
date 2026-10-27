/**
 * What a path end is written as, as one choice (issue #241): the previous end (`"current"`, offered
 * only to a From), a pose of its own, or a waypoint it follows. The Inspector's SourceSelect shows
 * these choices and calls `chooseEndSource`, which replaces the old From or To kind select and the
 * Waypoint select under it.
 */
import { setSegmentSource } from "@horizon36596/zenith-core";
import type { PoseSource } from "@horizon36596/zenith-schema";
import { getState } from "../state/store";
import { ownerSource, tryEdit, writeOwner, writeOwnPose } from "./edits";

/** One end's choice: `"current"`, `"pose"`, or `ref:` and the waypoint's name. */
export type EndChoice = "current" | "pose" | `ref:${string}`;

/** One option of the select: its value and the words it shows. */
export interface EndOption {
  value: EndChoice;
  label: string;
}

/** A path end, as `writeOwnPose` and `followNearestWaypoint` name it. */
export interface PathEnd {
  stepId: string;
  point: { segmentIndex: number; pointKind: "from" | "to" };
}

const REF = "ref:";

/** The choice an end shows for what the file has now. */
export const endChoiceOf = (source: PoseSource): EndChoice =>
  source === "current" ? "current" : "ref" in source ? `${REF}${source.ref}` : "pose";

/**
 * The select's options for one end: the previous end for a From (the last step's, or the previous
 * path's in a chain), "This pose", and then, as their own group, every waypoint by name. A waypoint
 * the end follows that waypoints.json no longer has stays in the list, so the select still shows it.
 */
export function endChoices(
  pointKind: "from" | "to",
  segmentIndex: number,
  waypointNames: readonly string[],
  source: PoseSource,
): { ends: EndOption[]; waypoints: EndOption[] } {
  const ends: EndOption[] = [
    ...(pointKind === "from" || source === "current"
      ? [{ value: "current" as const, label: segmentIndex > 0 ? "Previous path's end" : "Last step's end" }]
      : []),
    { value: "pose", label: "This pose" },
  ];
  const followed = source !== "current" && "ref" in source ? source.ref : null;
  const names = followed === null || waypointNames.includes(followed) ? waypointNames : [...waypointNames, followed];
  return { ends, waypoints: names.map((name) => ({ value: `${REF}${name}`, label: name })) };
}

/**
 * Writes the end as the choice says, as one undo step. A waypoint makes it follow that waypoint.
 * "This pose" keeps the end where it stands now (`writeOwnPose`, issue #133). The previous end is
 * only for a From. Choosing what the end already is writes nothing.
 */
export function chooseEndSource(end: PathEnd, choice: EndChoice): void {
  const auto = getState().auto;
  if (auto === null) return;
  const source = ownerSource(auto, end);
  if (source === undefined || endChoiceOf(source) === choice) return;
  if (choice === "current") {
    if (end.point.pointKind !== "from") return;
    tryEdit((current) => setSegmentSource(current, end.stepId, end.point.segmentIndex, "from", "current"));
    return;
  }
  if (choice === "pose") {
    writeOwnPose(end);
    return;
  }
  const ref = choice.slice(REF.length);
  tryEdit((current) => writeOwner(current, end, { ref }));
}
