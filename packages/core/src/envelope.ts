import type { Envelope, Step } from "@horizon36596/zenith-schema";
import type { Pose, Vec2 } from "./geometry/vec.js";

/**
 * Envelopes (spec 13 section 10): the planner-only polygon a step that runs declares the robot's
 * bounding box stays inside, for at most `maxDurationS`. This module reads them off a step and
 * builds one; the shape check is `checks/envelope.ts` and the timing is in `estimate.ts`.
 */

/** A step's envelope, or undefined when it has none or is a group, which cannot carry one. */
export function envelopeOf(step: Step): Envelope | undefined {
  if (step.kind !== "path" && step.kind !== "command" && step.kind !== "wait") return undefined;
  return step.envelope;
}

/**
 * An axis-aligned square envelope centred on a pose, corners counter-clockwise from the south-west
 * one, which is what the editor offers as a starting point to edit. The side, the window and the
 * provenance come from the caller: core invents none of them (CLAUDE.md rule 4).
 */
export function squareEnvelopeAround(
  centre: Vec2 | Pose,
  sideIn: number,
  maxDurationS: number,
  provenance: string,
): Envelope {
  const half = sideIn / 2;
  const polygon: Vec2[] = [
    { xIn: centre.xIn - half, yIn: centre.yIn - half },
    { xIn: centre.xIn + half, yIn: centre.yIn - half },
    { xIn: centre.xIn + half, yIn: centre.yIn + half },
    { xIn: centre.xIn - half, yIn: centre.yIn + half },
  ];
  return { polygon, maxDurationS, provenance };
}
