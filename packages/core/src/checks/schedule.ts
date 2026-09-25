import type { Field, Robot, Step } from "@horizon36596/zenith-schema";
import { TIMEOUT_TIGHT_MULTIPLE } from "../kinematics.js";
import type { Estimate, Finding, PlanStep } from "../types.js";

/**
 * The checks about the shape of the routine rather than its geometry: TIME_BUDGET, TIMEOUT_TIGHT,
 * STATIONARY_MARKER, MOVES_ROBOT and PROVENANCE
 * (site/docs/checks-and-findings.md).
 */

/** The label an inline pose is taken to carry when it has none (`03` section 4, PROVENANCE). */
export const INHERITED_PROVENANCE = "SET FROM EDITOR";

/** TIME_BUDGET: the routine over the period. Nominal over is a warning, optimistic over an error. */
export function checkTimeBudget(estimate: Estimate | null, field: Field): Finding[] {
  const periodS = field.periods?.autoS;
  if (estimate === null || periodS === undefined || estimate.nominalS === null) return [];
  const findings: Finding[] = [];

  if ((estimate.lowS ?? estimate.nominalS) > periodS) {
    findings.push({
      severity: "error",
      stepId: "total",
      code: "TIME_BUDGET",
      message: `Even the optimistic end of the estimate, ${(estimate.lowS ?? estimate.nominalS).toFixed(1)} s, is over the ${periodS.toFixed(0)} s autonomous period.`,
    });
  } else if (estimate.nominalS > periodS) {
    findings.push({
      severity: "warning",
      stepId: "total",
      code: "TIME_BUDGET",
      message: `The routine is estimated at ${estimate.nominalS.toFixed(1)} s against a ${periodS.toFixed(0)} s autonomous period; only the optimistic end of the band fits.`,
    });
  }

  if (estimate.hasUnknown && estimate.nominalS <= periodS) {
    // Two different kinds of "unknown" reach here. A step with no estimate at all counts as zero
    // seconds, so the total understates the routine; a step that ends on a sensor contributes the
    // seconds it would take to drive the whole path, which it can only beat. Saying "lower bound"
    // about the second kind would be wrong, so they are reported apart.
    const rows = Object.values(estimate.byStepId);
    const unpriced = rows.some((row) => row.unknown && row.nominalS === null);
    findings.push({
      severity: "info",
      stepId: "total",
      code: "TIME_BUDGET",
      message: unpriced
        ? `The total of ${estimate.nominalS.toFixed(1)} s is a lower bound: at least one step has no estimate, so the routine may not fit the ${periodS.toFixed(0)} s period.`
        : `The total of ${estimate.nominalS.toFixed(1)} s is an upper bound: at least one step ends on a condition rather than at the end of its path, so the routine may come in under it.`,
    });
  }
  return findings;
}

/** TIMEOUT_TIGHT: a step whose timeout leaves it almost no room over its own estimate. */
export function checkTimeouts(steps: readonly PlanStep[], estimate: Estimate | null): Finding[] {
  if (estimate === null) return [];
  const findings: Finding[] = [];
  for (const step of steps) {
    const timeoutS = "timeoutS" in step.step ? step.step.timeoutS : undefined;
    const nominalS = estimate.byStepId[step.id]?.nominalS;
    if (timeoutS === undefined || nominalS === null || nominalS === undefined) continue;
    if (timeoutS >= nominalS * TIMEOUT_TIGHT_MULTIPLE) continue;
    findings.push({
      severity: "info",
      stepId: step.id,
      code: "TIMEOUT_TIGHT",
      message: `The timeout of ${timeoutS.toFixed(1)} s is under ${String(TIMEOUT_TIGHT_MULTIPLE)} times this step's estimate of ${nominalS.toFixed(2)} s, so a slow run will be cut short.`,
    });
  }
  return findings;
}

/** STATIONARY_MARKER: a marker that fires a command the robot is meant to be standing still for. */
export function checkStationaryMarkers(steps: readonly PlanStep[], robot: Robot): Finding[] {
  const findings: Finding[] = [];
  for (const step of steps) {
    if (step.step.kind !== "path") continue;
    for (const marker of (step.step as Extract<Step, { kind: "path" }>).markers ?? []) {
      const spec = robot.commands.find((command) => command.name === marker.command.name);
      if (spec?.stationary !== true) continue;
      findings.push({
        severity: "warning",
        stepId: step.id,
        ...("t" in marker.at ? { t: marker.at.t } : {}),
        code: "STATIONARY_MARKER",
        message: `The marker runs ${marker.command.name}, which robot.json marks as stationary, while this path is still moving.`,
      });
    }
  }
  return findings;
}

/**
 * MOVES_ROBOT: a command whose registry entry says it drives the robot leaves the end pose unknown,
 * so whatever follows has to start from wherever it actually ended.
 *
 * It takes the flattened list: a command that drives the robot does so inside a parallel group or a
 * branch arm too, and the step after it is no better placed to name a fixed pose for having been
 * nested.
 */
export function checkMovesRobot(steps: readonly PlanStep[], robot: Robot): Finding[] {
  const findings: Finding[] = [];
  const movesRobot = new Set(
    robot.commands.filter((command) => command.movesRobot === true).map((command) => command.name),
  );
  let after: string | null = null;

  for (const step of steps) {
    if (after !== null && step.step.kind === "path") {
      const first = (step.step as Extract<Step, { kind: "path" }>).segments[0];
      if (first !== undefined && first.from !== "current") {
        findings.push({
          severity: "error",
          stepId: step.id,
          code: "MOVES_ROBOT",
          message: `${after} moves the robot, so nobody knows where it ended; this step must start from "current" rather than a fixed pose.`,
        });
      }
    }
    if (step.step.kind === "command") {
      after = movesRobot.has(step.step.name) ? step.step.name : null;
    } else if (step.step.kind === "path" || step.step.kind === "wait") {
      after = null;
    }
  }
  return findings;
}

/** PROVENANCE: an inline pose with no label, which is taken to be the editor's own. */
export function checkProvenance(steps: readonly PlanStep[]): Finding[] {
  const findings: Finding[] = [];
  for (const step of steps) {
    if (step.step.kind !== "path") continue;
    let unlabelled = 0;
    for (const segment of (step.step as Extract<Step, { kind: "path" }>).segments) {
      const ends = [segment.from, segment.to];
      for (const end of ends) {
        if (end === "current" || "ref" in end) continue;
        if (end.provenance === undefined) unlabelled += 1;
      }
      if (segment.kind === "bezier") {
        unlabelled += segment.control.filter((point) => point.provenance === undefined).length;
      }
    }
    if (unlabelled === 0) continue;
    findings.push({
      severity: "info",
      stepId: step.id,
      code: "PROVENANCE",
      message:
        unlabelled === 1
          ? `One pose on this step carries no provenance, so it is taken as ${INHERITED_PROVENANCE}.`
          : `${String(unlabelled)} poses on this step carry no provenance, so they are taken as ${INHERITED_PROVENANCE}.`,
    });
  }
  return findings;
}

/** Runs every scheduling check over a plan. */
export function checkSchedule(
  estimate: Estimate | null,
  robot: Robot,
  field: Field,
  steps: readonly PlanStep[],
): Finding[] {
  return [
    ...checkTimeBudget(estimate, field),
    ...checkTimeouts(steps, estimate),
    ...checkStationaryMarkers(steps, robot),
    ...checkMovesRobot(steps, robot),
    ...checkProvenance(steps),
  ];
}
