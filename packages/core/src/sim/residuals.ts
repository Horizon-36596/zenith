import type { Trace } from "../trace.js";
import { normalizeSigned } from "./pedroPath.js";
import { simPoseAt } from "./simulate.js";

/**
 * How far the instant sim is from a Gradle run of the same routine (site/docs/simulation.md): the
 * numbers that say whether the preview can replace the slow sim yet, and which part of the model to
 * fix when it cannot. Pure: it compares two traces and reads nothing else.
 */

export interface StepResidual {
  id: string;
  /** Which occurrence of this id, from 0, when a step runs more than once. */
  occurrence: number;
  simS: number;
  gradleS: number;
  /** Sim minus Gradle, in seconds: positive when the preview is slower. */
  residualS: number;
  /** Sim minus Gradle start time, which is how much earlier steps have drifted. */
  startResidualS: number;
}

export interface SimResiduals {
  steps: StepResidual[];
  /** Steps the Gradle trace ran that the sim did not, and the other way round. */
  missingInSim: string[];
  missingInGradle: string[];
  stepDurationRmsS: number | null;
  stepDurationMaxAbsS: number | null;
  /** Sim minus Gradle, for the whole routine. */
  totalResidualS: number;
  /** Poses compared at the Gradle trace's own times, inside both traces' spans. */
  poseSamples: number;
  positionRmsIn: number | null;
  positionMaxIn: number | null;
  headingRmsRad: number | null;
  headingMaxRad: number | null;
}

const occurrenceKey = (id: string, occurrence: number): string => `${id}#${String(occurrence)}`;

function keyed(trace: Trace): Map<string, { id: string; occurrence: number; startS: number; endS: number }> {
  const counts = new Map<string, number>();
  const out = new Map<string, { id: string; occurrence: number; startS: number; endS: number }>();
  for (const step of trace.steps) {
    const occurrence = counts.get(step.id) ?? 0;
    counts.set(step.id, occurrence + 1);
    out.set(occurrenceKey(step.id, occurrence), {
      id: step.id,
      occurrence,
      startS: step.startS,
      endS: step.endS,
    });
  }
  return out;
}

const rms = (values: readonly number[]): number | null =>
  values.length === 0 ? null : Math.sqrt(values.reduce((sum, v) => sum + v * v, 0) / values.length);

const maxAbs = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((max, v) => Math.max(max, Math.abs(v)), 0);

const endOf = (trace: Trace): number => {
  const lastPose = trace.poses[trace.poses.length - 1];
  let end = lastPose?.[0] ?? 0;
  for (const step of trace.steps) end = Math.max(end, step.endS);
  return end;
};

/** Compares a sim trace with a Gradle trace of the same routine, step by step and pose by pose. */
export function simResiduals(trace: Trace, gradleTrace: Trace): SimResiduals {
  const sim = keyed(trace);
  const gradle = keyed(gradleTrace);

  const steps: StepResidual[] = [];
  const missingInSim: string[] = [];
  for (const [key, g] of gradle) {
    const s = sim.get(key);
    if (s === undefined) {
      missingInSim.push(g.id);
      continue;
    }
    const simS = s.endS - s.startS;
    const gradleS = g.endS - g.startS;
    steps.push({
      id: g.id,
      occurrence: g.occurrence,
      simS,
      gradleS,
      residualS: simS - gradleS,
      startResidualS: s.startS - g.startS,
    });
  }
  const missingInGradle: string[] = [];
  for (const [key, s] of sim) if (!gradle.has(key)) missingInGradle.push(s.id);

  const positions: number[] = [];
  const headings: number[] = [];
  const first = trace.poses[0];
  const last = trace.poses[trace.poses.length - 1];
  if (first !== undefined && last !== undefined) {
    for (const row of gradleTrace.poses) {
      const t = row[0];
      if (t < first[0] || t > last[0]) continue;
      const pose = simPoseAt(trace, t);
      if (pose === null) continue;
      positions.push(Math.hypot(pose.xIn - row[1], pose.yIn - row[2]));
      headings.push(normalizeSigned(pose.headingRad - row[3]));
    }
  }

  const residuals = steps.map((step) => step.residualS);
  return {
    steps,
    missingInSim,
    missingInGradle,
    stepDurationRmsS: rms(residuals),
    stepDurationMaxAbsS: maxAbs(residuals),
    totalResidualS: endOf(trace) - endOf(gradleTrace),
    poseSamples: positions.length,
    positionRmsIn: rms(positions),
    positionMaxIn: maxAbs(positions),
    headingRmsRad: rms(headings),
    headingMaxRad: maxAbs(headings),
  };
}
