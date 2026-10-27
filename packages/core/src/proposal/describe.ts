import type { ProjectionMarkerAt, ProposalChange } from "@horizon36596/zenith-schema";
import type { Naming } from "./structure.js";

/**
 * One sentence for each change, which review mode lists beside it and the CLI prints: what the
 * change does, in the reader's names for steps and tokens. Numbers are shown as the file holds
 * them, in inches, radians and seconds.
 */

const number = (value: number): string => String(Number(value.toFixed(3)));

function markerAt(at: ProjectionMarkerAt): string {
  if ("t" in at) return `t = ${number(at.t)}`;
  if ("distanceIn" in at) return `${number(at.distanceIn)} in from the start`;
  return `${number(at.distanceFromEndIn)} in from the end`;
}

const place = (afterStepId: string | undefined, naming: Naming): string =>
  afterStepId === undefined ? "at the start of the auto" : `after ${naming.step(afterStepId)}`;

const plural = (count: number, one: string): string => `${String(count)} ${one}${count === 1 ? "" : "s"}`;

export function describeChange(change: ProposalChange, naming: Naming): string {
  switch (change.op) {
    case "movePose": {
      // Counted from 1, the way the Inspector names paths and control points ("Path 1",
      // "Control 1 x"); the file's own indices count from 0.
      const segment = `path ${String(change.segmentIndex + 1)}`;
      const where =
        typeof change.point === "object"
          ? `control point ${String(change.point.controlIndex + 1)} of ${segment}`
          : `the ${change.point === "to" ? "end" : "start"} of ${segment}`;
      const heading = change.pose.headingRad === undefined ? "" : `, heading ${number(change.pose.headingRad)} rad`;
      const text = `Move ${where} of ${naming.step(change.stepId)} to (${number(change.pose.xIn)}, ${number(change.pose.yIn)}) in${heading}.`;
      return text.charAt(0).toUpperCase() + text.slice(1);
    }
    case "setHeading":
      return `Set the heading of ${naming.step(change.stepId)} to ${change.heading.mode}.`;
    case "setSpeedFraction":
      return `Drive ${naming.step(change.stepId)} at ${number(change.speedFraction)} of full speed.`;
    case "setTimeout":
      return change.timeoutS === null
        ? `Remove the timeout of ${naming.step(change.stepId)}.`
        : `Give ${naming.step(change.stepId)} a timeout of ${number(change.timeoutS)} s.`;
    case "insertWait":
      return change.until === undefined
        ? `Wait ${number(change.seconds ?? 0)} s ${place(change.afterStepId, naming)}.`
        : `Wait until ${naming.token(change.until.token)} ${place(change.afterStepId, naming)}.`;
    case "setWait":
      return change.until === undefined
        ? `Make ${naming.step(change.stepId)} wait ${number(change.seconds ?? 0)} s.`
        : `Make ${naming.step(change.stepId)} wait until ${naming.token(change.until.token)}.`;
    case "removeStep":
      return `Remove ${naming.step(change.stepId)}.`;
    case "addPath": {
      const carries = [
        ...(change.markers ?? []).map((marker) => `${naming.token(marker.token)} at ${markerAt(marker.at)}`),
        ...(change.endCondition === undefined ? [] : [`ending on ${naming.token(change.endCondition.token)}`]),
      ];
      return `Add a path chain of ${plural(change.segments.length, "path")} ${place(change.afterStepId, naming)}${
        carries.length === 0 ? "" : `, with ${carries.join(" and ")}`
      }.`;
    }
    case "reorder":
      return `Move ${naming.step(change.stepId)} to index ${String(change.newIndex)} of the list that holds it.`;
    case "moveMarker":
      return `Slide marker ${String(change.markerIndex)} of ${naming.step(change.stepId)} to ${markerAt(change.at)}.`;
    case "setEnvelope":
      return change.envelope === null
        ? `Remove the envelope of ${naming.step(change.stepId)}.`
        : `Give ${naming.step(change.stepId)} an envelope of ${plural(change.envelope.polygon.length, "corner")} for up to ${number(change.envelope.maxDurationS)} s${
            change.envelope.actualDurationS === undefined
              ? ""
              : `, previewed as a run of ${number(change.envelope.actualDurationS)} s`
          }.`;
  }
}
