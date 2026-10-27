import type {
  Auto,
  Heading,
  Marker,
  MarkerAt,
  PathStep,
  PoseSource,
  Segment,
  Waypoints,
} from "@horizon36596/zenith-schema";
import { CONTINUITY_TOLERANCE_IN } from "../continuity.js";
import { EditError } from "./errors.js";
import { finish } from "./finish.js";
import { updateStep } from "./tree.js";

/** A literal pose to write into a segment endpoint or a Bezier control point. */
export interface PoseInput {
  xIn: number;
  yIn: number;
  headingRad?: number;
  provenance?: string;
}

/** Which point of which segment `setPose` targets. */
export interface PoseTarget {
  segmentIndex: number;
  pointKind: "from" | "to" | "control";
  /** Required, and only meaningful, when `pointKind` is `"control"`. */
  controlIndex?: number;
}

/** What `setPose` does besides writing the one point it targets. */
export interface SetPoseOptions {
  /**
   * Move the joint the target sits on, not only the target: when the target is one end of an
   * interior joint (`jointTwin`), the other end is written the same pose in the same edit, so the
   * path never tears there. The editor writes every move of a path point this way.
   */
  joint?: boolean;
  /** The project's waypoints, so `joint` can measure a waypoint end against a pose of its own. */
  waypoints?: Waypoints;
}

function asPathStep(step: { kind: string }, stepId: string): asserts step is PathStep {
  if (step.kind !== "path") {
    throw new EditError(`Step ${JSON.stringify(stepId)} is a ${step.kind} step, not a path.`);
  }
}

/** Where a pose source sits, or null for `"current"` or a waypoint `waypoints` does not name. */
function spotOf(source: PoseSource, waypoints: Waypoints | undefined): { xIn: number; yIn: number } | null {
  if (source === "current") return null;
  if ("ref" in source) return waypoints?.waypoints[source.ref] ?? null;
  return source;
}

/**
 * The other end of the interior joint `target` sits on, or null when it sits on none.
 *
 * Inside one path step, segment k-1's `to` and segment k's `from` are one point to the editor
 * (issue #146) when they follow the same waypoint, or when they sit within the CONTINUITY
 * tolerance of each other. A waypoint end is measured against a pose of its own only with
 * `waypoints` in hand. A `from` written as `"current"` already starts where the segment before it
 * ends, so it is never a twin that needs writing, and when it is the target, the end before it is
 * its twin. The path's own first and last points, and its control points, are on no joint.
 */
export function jointTwin(step: PathStep, target: PoseTarget, waypoints?: Waypoints): PoseTarget | null {
  let twin: PoseTarget;
  if (target.pointKind === "to") twin = { segmentIndex: target.segmentIndex + 1, pointKind: "from" };
  else if (target.pointKind === "from") twin = { segmentIndex: target.segmentIndex - 1, pointKind: "to" };
  else return null;
  const ownSegment = step.segments[target.segmentIndex];
  const twinSegment = step.segments[twin.segmentIndex];
  if (ownSegment === undefined || twinSegment === undefined) return null;
  const own = target.pointKind === "to" ? ownSegment.to : ownSegment.from;
  const other = twin.pointKind === "to" ? twinSegment.to : twinSegment.from;
  if (other === "current") return null;
  if (own === "current") return target.pointKind === "from" ? twin : null;
  if ("ref" in own && "ref" in other && own.ref === other.ref) return twin;
  const a = spotOf(own, waypoints);
  const b = spotOf(other, waypoints);
  if (a === null || b === null) return null;
  return Math.hypot(a.xIn - b.xIn, a.yIn - b.yIn) <= CONTINUITY_TOLERANCE_IN ? twin : null;
}

/** A segment with one of its ends replaced by a copy of `pose`. */
const withEnd = (segment: Segment, end: "from" | "to", pose: PoseInput): Segment =>
  end === "from" ? { ...segment, from: { ...pose } } : { ...segment, to: { ...pose } };

/**
 * Sets one point of one segment of a path step to a literal pose: a segment endpoint (`from` or
 * `to`, replacing whatever pose source — inline pose, waypoint ref or `"current"` — was there) or
 * one Bezier control point. With `options.joint`, an interior joint moves as one point: the other
 * end of it gets the same pose in this edit (`jointTwin`).
 *
 * A control point is written without a heading, whatever `pose` carries: the runtime and Pedro
 * ignore a control point's heading, so one would only be noise in the file (N82).
 */
export function setPose(
  auto: Auto,
  stepId: string,
  target: PoseTarget,
  pose: PoseInput,
  options: SetPoseOptions = {},
): Auto {
  const result = updateStep(auto.steps, "step", stepId, (step) => {
    asPathStep(step, stepId);
    const segment = step.segments[target.segmentIndex];
    if (segment === undefined) {
      throw new EditError(
        `Step ${JSON.stringify(stepId)} has no segment at index ${String(target.segmentIndex)}.`,
      );
    }
    const segments = [...step.segments];
    if (target.pointKind === "control") {
      if (segment.kind !== "bezier") {
        throw new EditError(
          `Segment ${String(target.segmentIndex)} of step ${JSON.stringify(stepId)} is a line; it has no control points.`,
        );
      }
      if (target.controlIndex === undefined) {
        throw new EditError('A "control" pose target needs controlIndex.');
      }
      const control = [...segment.control];
      if (control[target.controlIndex] === undefined) {
        throw new EditError(
          `Segment ${String(target.segmentIndex)} of step ${JSON.stringify(stepId)} has no control point at index ${String(target.controlIndex)}.`,
        );
      }
      control[target.controlIndex] = {
        xIn: pose.xIn,
        yIn: pose.yIn,
        ...(pose.provenance === undefined ? {} : { provenance: pose.provenance }),
      };
      segments[target.segmentIndex] = { ...segment, control };
    } else {
      const twin = options.joint === true ? jointTwin(step, target, options.waypoints) : null;
      segments[target.segmentIndex] = withEnd(segment, target.pointKind, pose);
      const twinSegment = twin === null ? undefined : segments[twin.segmentIndex];
      if (twin !== null && twinSegment !== undefined && twin.pointKind !== "control") {
        segments[twin.segmentIndex] = withEnd(twinSegment, twin.pointKind, pose);
      }
    }
    return { ...step, segments };
  });
  if (!result.found) throw new EditError(`No step with id ${JSON.stringify(stepId)}.`);
  return finish({ ...auto, steps: result.steps });
}

/** Whether two pose sources are the same one as written: `"current"`, the same waypoint, or the same inline pose. */
function sameSource(a: PoseSource, b: PoseSource): boolean {
  if (a === "current" || b === "current") return a === b;
  if ("ref" in a || "ref" in b) return "ref" in a && "ref" in b && a.ref === b.ref;
  return (
    a.xIn === b.xIn && a.yIn === b.yIn && a.headingRad === b.headingRad && a.provenance === b.provenance
  );
}

const describeSource = (source: PoseSource): string => JSON.stringify(source);

/**
 * Replaces a path step's route: its `segments` and its `heading`, and nothing else. The step's id,
 * markers, `endCondition`, `timeoutS`, `speedFraction`, `envelope`, `expect`, `notes`, `rejoinFrom`
 * and every other step stay exactly as they were.
 *
 * The route may not move an end: the first segment's `from` and the last segment's `to` must be the
 * ones the step has now, as written, so a `"current"` stays `"current"`, a waypoint stays that
 * waypoint, and every step after this one starts where it did. A step that is not a path, an id
 * that is not there, a route with no segments, or one the schema refuses throws `EditError`.
 */
export function setRoute(auto: Auto, stepId: string, segments: readonly Segment[], heading: Heading): Auto {
  const result = updateStep(auto.steps, "step", stepId, (step) => {
    asPathStep(step, stepId);
    const first = segments[0];
    const last = segments[segments.length - 1];
    if (first === undefined || last === undefined) {
      throw new EditError(`A route for step ${JSON.stringify(stepId)} needs at least one segment.`);
    }
    const oldFirst = step.segments[0];
    const oldLast = step.segments[step.segments.length - 1];
    if (oldFirst !== undefined && !sameSource(first.from, oldFirst.from)) {
      throw new EditError(
        `The new route for step ${JSON.stringify(stepId)} starts at ${describeSource(first.from)}, but the step starts at ${describeSource(oldFirst.from)}. A new route keeps both ends.`,
      );
    }
    if (oldLast !== undefined && !sameSource(last.to, oldLast.to)) {
      throw new EditError(
        `The new route for step ${JSON.stringify(stepId)} ends at ${describeSource(last.to)}, but the step ends at ${describeSource(oldLast.to)}. A new route keeps both ends.`,
      );
    }
    return { ...step, segments: [...segments], heading };
  });
  if (!result.found) throw new EditError(`No step with id ${JSON.stringify(stepId)}.`);
  return finish({ ...auto, steps: result.steps });
}

/** Replaces a path step's heading mode outright. */
export function setHeadingMode(auto: Auto, stepId: string, heading: Heading): Auto {
  const result = updateStep(auto.steps, "step", stepId, (step) => {
    asPathStep(step, stepId);
    return { ...step, heading };
  });
  if (!result.found) throw new EditError(`No step with id ${JSON.stringify(stepId)}.`);
  return finish({ ...auto, steps: result.steps });
}

/**
 * Sets a path step's `speedFraction` (0 exclusive, 1 inclusive; the schema enforces the range), or
 * removes it when `fraction` is undefined, so the path drives at the robot's own
 * `defaultPathSpeedFraction` again and follows that setting when it changes.
 */
export function setSpeed(auto: Auto, stepId: string, fraction: number | undefined): Auto {
  const result = updateStep(auto.steps, "step", stepId, (step) => {
    asPathStep(step, stepId);
    if (fraction === undefined) {
      const next = { ...step };
      delete next.speedFraction;
      return next;
    }
    return { ...step, speedFraction: fraction };
  });
  if (!result.found) throw new EditError(`No step with id ${JSON.stringify(stepId)}.`);
  return finish({ ...auto, steps: result.steps });
}

/** Appends a segment to a path step. A path's segments must stay continuous; `validate` checks that. */
export function addSegment(auto: Auto, stepId: string, segment: Segment): Auto {
  const result = updateStep(auto.steps, "step", stepId, (step) => {
    asPathStep(step, stepId);
    return { ...step, segments: [...step.segments, segment] };
  });
  if (!result.found) throw new EditError(`No step with id ${JSON.stringify(stepId)}.`);
  return finish({ ...auto, steps: result.steps });
}

/** Removes the segment at `segmentIndex`. A path step needs at least one segment. */
export function removeSegment(auto: Auto, stepId: string, segmentIndex: number): Auto {
  const result = updateStep(auto.steps, "step", stepId, (step) => {
    asPathStep(step, stepId);
    if (step.segments[segmentIndex] === undefined) {
      throw new EditError(
        `Step ${JSON.stringify(stepId)} has no segment at index ${String(segmentIndex)}.`,
      );
    }
    if (step.segments.length <= 1) {
      throw new EditError(
        `Step ${JSON.stringify(stepId)} has only one segment; a path step needs at least one.`,
      );
    }
    return { ...step, segments: step.segments.filter((_, index) => index !== segmentIndex) };
  });
  if (!result.found) throw new EditError(`No step with id ${JSON.stringify(stepId)}.`);
  return finish({ ...auto, steps: result.steps });
}

/** Adds a marker to a path step. */
export function addMarker(auto: Auto, stepId: string, marker: Marker): Auto {
  const result = updateStep(auto.steps, "step", stepId, (step) => {
    asPathStep(step, stepId);
    return { ...step, markers: [...(step.markers ?? []), marker] };
  });
  if (!result.found) throw new EditError(`No step with id ${JSON.stringify(stepId)}.`);
  return finish({ ...auto, steps: result.steps });
}

/** Removes the marker at `markerIndex` from a path step. */
export function removeMarker(auto: Auto, stepId: string, markerIndex: number): Auto {
  const result = updateStep(auto.steps, "step", stepId, (step) => {
    asPathStep(step, stepId);
    const markers = step.markers ?? [];
    if (markers[markerIndex] === undefined) {
      throw new EditError(
        `Step ${JSON.stringify(stepId)} has no marker at index ${String(markerIndex)}.`,
      );
    }
    return { ...step, markers: markers.filter((_, index) => index !== markerIndex) };
  });
  if (!result.found) throw new EditError(`No step with id ${JSON.stringify(stepId)}.`);
  return finish({ ...auto, steps: result.steps });
}

/** Moves a marker to a new `at` (path parameter, distance, or distance from the end). */
export function setMarkerAt(auto: Auto, stepId: string, markerIndex: number, at: MarkerAt): Auto {
  const result = updateStep(auto.steps, "step", stepId, (step) => {
    asPathStep(step, stepId);
    const markers = step.markers ?? [];
    if (markers[markerIndex] === undefined) {
      throw new EditError(
        `Step ${JSON.stringify(stepId)} has no marker at index ${String(markerIndex)}.`,
      );
    }
    return {
      ...step,
      markers: markers.map((marker, index) => (index === markerIndex ? { ...marker, at } : marker)),
    };
  });
  if (!result.found) throw new EditError(`No step with id ${JSON.stringify(stepId)}.`);
  return finish({ ...auto, steps: result.steps });
}
