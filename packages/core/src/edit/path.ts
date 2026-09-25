import type { Auto, Heading, Marker, MarkerAt, PathStep, Segment } from "@horizon36596/zenith-schema";
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

function asPathStep(step: { kind: string }, stepId: string): asserts step is PathStep {
  if (step.kind !== "path") {
    throw new EditError(`Step ${JSON.stringify(stepId)} is a ${step.kind} step, not a path.`);
  }
}

/**
 * Sets one point of one segment of a path step to a literal pose: a segment endpoint (`from` or
 * `to`, replacing whatever pose source — inline pose, waypoint ref or `"current"` — was there) or
 * one Bezier control point.
 */
export function setPose(auto: Auto, stepId: string, target: PoseTarget, pose: PoseInput): Auto {
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
      control[target.controlIndex] = { ...pose };
      segments[target.segmentIndex] = { ...segment, control };
    } else if (target.pointKind === "from") {
      segments[target.segmentIndex] = { ...segment, from: { ...pose } };
    } else {
      segments[target.segmentIndex] = { ...segment, to: { ...pose } };
    }
    return { ...step, segments };
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

/** Sets a path step's `speedFraction` (0 exclusive, 1 inclusive; the schema enforces the range). */
export function setSpeed(auto: Auto, stepId: string, fraction: number): Auto {
  const result = updateStep(auto.steps, "step", stepId, (step) => {
    asPathStep(step, stepId);
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
