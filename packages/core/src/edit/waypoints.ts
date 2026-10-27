/**
 * Edits to `waypoints.json`, and to the places an auto follows one of its waypoints (issue #134):
 * add, move, rename and remove a named pose, and find or replace every `{ "ref": name }` in an
 * auto. Pure, like every primitive in this directory: each takes a document and returns a new one,
 * validated through `@horizon36596/zenith-schema`, and never mutates its input. The file format does
 * not change; these only write what `waypoints.json` and `*.auto.json` already hold.
 */
import {
  childLists,
  parseWaypoints,
  SchemaError,
  withChildLists,
  type Auto,
  type Pose,
  type PoseSource,
  type Step,
  type Waypoint,
  type Waypoints,
} from "@horizon36596/zenith-schema";
import { EditError } from "./errors.js";
import { finish } from "./finish.js";
import { childPrefix, effectiveId, STEP_ID_MAX, STEP_ID_NAME_PATTERN } from "./ids.js";

/**
 * The names the editor gives a new waypoint: a letter, then letters, digits, `_` or `-`. The
 * format itself accepts any name that is not empty; this narrower rule keeps a name readable in a
 * file, a commit message and a generated Java comment alike. A hand-written name outside it still
 * loads, moves and can be renamed to one inside it. A step's explicit id follows the same rule; it is
 * one constant, `STEP_ID_NAME_PATTERN` in ids.ts.
 */
export const WAYPOINT_NAME_PATTERN = STEP_ID_NAME_PATTERN;

/** The longest name the editor gives a waypoint, the same limit a step's id has. */
export const WAYPOINT_NAME_MAX = STEP_ID_MAX;

const has = (waypoints: Waypoints, name: string): boolean =>
  Object.prototype.hasOwnProperty.call(waypoints.waypoints, name);

/**
 * Why `name` cannot be a new waypoint's name in `waypoints`, as a sentence, or null when it can.
 * `renaming` is the waypoint being renamed, whose own name does not count as taken.
 */
export function waypointNameProblem(name: string, waypoints: Waypoints | undefined, renaming?: string): string | null {
  if (name.length === 0) return "A waypoint needs a name.";
  if (name.length > WAYPOINT_NAME_MAX) return `A waypoint's name is at most ${String(WAYPOINT_NAME_MAX)} characters.`;
  if (!WAYPOINT_NAME_PATTERN.test(name)) {
    return "A waypoint's name starts with a letter and holds only letters, digits, _ and -.";
  }
  if (name !== renaming && waypoints !== undefined && has(waypoints, name)) return `There is already a waypoint named ${name}.`;
  return null;
}

/** Parses the candidate file, so an edit can never leave `waypoints.json` invalid. */
function finishWaypoints(candidate: Waypoints): Waypoints {
  try {
    return parseWaypoints(candidate);
  } catch (error) {
    if (error instanceof SchemaError) {
      throw new EditError(
        `This edit would leave waypoints.json invalid:\n  ${error.issues
          .map((issue) => `${issue.path.length === 0 ? "(root)" : issue.path.join(".")}: ${issue.message}`)
          .join("\n  ")}`,
      );
    }
    throw error;
  }
}

function requireWaypoint(waypoints: Waypoints, name: string): void {
  if (!has(waypoints, name)) throw new EditError(`waypoints.json has no waypoint named ${name}.`);
}

/** A new waypoint, after the others. Its name must pass `waypointNameProblem`. */
export function addWaypoint(waypoints: Waypoints, name: string, waypoint: Waypoint): Waypoints {
  const problem = waypointNameProblem(name, waypoints);
  if (problem !== null) throw new EditError(problem);
  return finishWaypoints({ ...waypoints, waypoints: { ...waypoints.waypoints, [name]: waypoint } });
}

/** A waypoint that exists given new numbers or provenance, in the place it already has. */
export function setWaypoint(waypoints: Waypoints, name: string, waypoint: Waypoint): Waypoints {
  requireWaypoint(waypoints, name);
  return finishWaypoints({ ...waypoints, waypoints: { ...waypoints.waypoints, [name]: waypoint } });
}

/** A waypoint renamed in place, so the file keeps its order. Renaming to its own name changes nothing. */
export function renameWaypoint(waypoints: Waypoints, from: string, to: string): Waypoints {
  requireWaypoint(waypoints, from);
  if (to === from) return waypoints;
  const problem = waypointNameProblem(to, waypoints, from);
  if (problem !== null) throw new EditError(problem);
  const renamed: Record<string, Waypoint> = {};
  for (const [name, waypoint] of Object.entries(waypoints.waypoints)) renamed[name === from ? to : name] = waypoint;
  return finishWaypoints({ ...waypoints, waypoints: renamed });
}

/** The file without one waypoint. */
export function removeWaypoint(waypoints: Waypoints, name: string): Waypoints {
  requireWaypoint(waypoints, name);
  const rest: Record<string, Waypoint> = {};
  for (const [other, waypoint] of Object.entries(waypoints.waypoints)) if (other !== name) rest[other] = waypoint;
  return finishWaypoints({ ...waypoints, waypoints: rest });
}

/** One place an auto follows a waypoint: its start, or one end of a segment of a path step. */
export type WaypointUse =
  | { ref: string; at: "start" }
  | { ref: string; at: "point"; stepId: string; segmentIndex: number; pointKind: "from" | "to" };

const refOf = (source: PoseSource | { ref: string } | Pose): string | null =>
  typeof source === "object" && "ref" in source ? source.ref : null;

/** Visits every step in document order, depth first, with its effective id. */
function eachStep(steps: readonly Step[], prefix: string, visit: (step: Step, id: string) => void): void {
  steps.forEach((step, index) => {
    const id = effectiveId(step, index, prefix);
    visit(step, id);
    const lists = childLists(step);
    lists.forEach((list, listIndex) => {
      eachStep(list, childPrefix(id, lists.length, listIndex), visit);
    });
  });
}

/** The forest with `visit` applied to every step, children first; a step `visit` returns as it is stays the same object. */
function mapSteps(steps: readonly Step[], prefix: string, visit: (step: Step, id: string) => Step): Step[] {
  return steps.map((step, index) => {
    const id = effectiveId(step, index, prefix);
    const lists = childLists(step);
    const inner =
      lists.length === 0
        ? step
        : withChildLists(
            step,
            lists.map((list, listIndex) => mapSteps(list, childPrefix(id, lists.length, listIndex), visit)),
          );
    return visit(inner, id);
  });
}

/**
 * Every place `auto` follows a waypoint, the start first and then the paths in document order, or
 * only the places that follow `name` when it is given. Bezier control points are poses of their own
 * in the format, so they never follow a waypoint.
 */
export function waypointUses(auto: Auto, name?: string): WaypointUse[] {
  const uses: WaypointUse[] = [];
  const wanted = (ref: string | null): ref is string => ref !== null && (name === undefined || ref === name);
  const start = refOf(auto.start.pose);
  if (wanted(start)) uses.push({ ref: start, at: "start" });
  eachStep(auto.steps, "step", (step, stepId) => {
    if (step.kind !== "path") return;
    step.segments.forEach((segment, segmentIndex) => {
      for (const pointKind of ["from", "to"] as const) {
        const ref = refOf(segment[pointKind]);
        if (wanted(ref)) uses.push({ ref, at: "point", stepId, segmentIndex, pointKind });
      }
    });
  });
  return uses;
}

/** The names of the waypoints `auto` follows anywhere, each once, in the order they are first used. */
export function waypointsUsed(auto: Auto): string[] {
  return [...new Set(waypointUses(auto).map((use) => use.ref))];
}

/**
 * The auto with every place that follows waypoint `name` written as `replacement` instead: another
 * waypoint to follow (a rename), or a pose of its own (a delete that unlinks). An auto that never
 * follows `name` comes back as it was.
 */
export function replaceWaypointRefs(auto: Auto, name: string, replacement: Pose | { ref: string }): Auto {
  if (waypointUses(auto, name).length === 0) return auto;
  const swap = <T extends PoseSource>(source: T): T | Pose | { ref: string } =>
    refOf(source) === name ? { ...replacement } : source;
  const steps = mapSteps(auto.steps, "step", (step) => {
    if (step.kind !== "path") return step;
    const touched = step.segments.some((segment) => refOf(segment.from) === name || refOf(segment.to) === name);
    if (!touched) return step;
    return { ...step, segments: step.segments.map((segment) => ({ ...segment, from: swap(segment.from), to: swap(segment.to) })) };
  });
  const startPose = refOf(auto.start.pose) === name ? { ...replacement } : auto.start.pose;
  return finish({ ...auto, start: { ...auto.start, pose: startPose }, steps });
}
