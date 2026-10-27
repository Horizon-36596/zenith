/**
 * How the Optimize card and Add a clear path here name what a route keeps clear of: a structure by
 * its field label, the centre line, a keep-out by its name, or the wall. Never a bare id where the
 * season has a label for it.
 */
import { CENTRE_LINE_KEEPOUT_ID } from "@horizon36596/zenith-core";
import { currentDerived, getState } from "../state/store";

export type ThingKind = "structure" | "keepOut" | "wall";

/** "the hive frame, east bar", "the centre line", `the keep-out "x"` or "the field wall". */
export function thingLabel(kind: ThingKind, id: string | null): string {
  if (kind === "wall" || id === null) return "the field wall";
  if (id === CENTRE_LINE_KEEPOUT_ID) return "the centre line";
  if (kind === "keepOut") return `the keep-out "${id}"`;
  const state = getState();
  const field = state.autoField ?? state.project?.field ?? undefined;
  const label = currentDerived().season.obstacleLabel?.(id, field) ?? null;
  return label === null || label === "" ? `the structure "${id}"` : label;
}

/**
 * Where a footprint is, in words: "over the centre line" and "over the field wall", since a robot
 * cannot be inside a line, and "inside" anything with an area.
 */
export function overlapWords(kind: ThingKind, id: string | null): string {
  const what = thingLabel(kind, id);
  return kind === "wall" || id === null || id === CENTRE_LINE_KEEPOUT_ID ? `over ${what}` : `inside ${what}`;
}
