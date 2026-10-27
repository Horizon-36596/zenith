import type { Field, Robot, Step } from "@horizon36596/zenith-schema";
import { membersThatCount, stepTimeoutS, worstS } from "../estimate.js";
import { startFromCurrentFix } from "../fix.js";
import { raisedTimeoutS, TIMEOUT_TIGHT_MULTIPLE } from "../kinematics.js";
import type { Estimate, Finding, Fix, PlanStep, StepEstimate } from "../types.js";

/**
 * The checks about the shape of the routine rather than its geometry: TIME_BUDGET, TIMEOUT_TIGHT,
 * WAIT_NO_TIMEOUT, STATIONARY_MARKER, MOVES_ROBOT and PROVENANCE
 * (site/docs/checks-and-findings.md).
 */

/** The label an inline pose is taken to carry when it has none (`03` section 4, PROVENANCE). */
export const INHERITED_PROVENANCE = "SET FROM EDITOR";

/**
 * TIME_BUDGET: the routine over the period. Nominal over is a warning, optimistic over an error.
 * When some step has no fixed time, an info note says which steps make the total a bound
 * (`boundNote`); `steps` is the flattened plan, which says how each group combines its members.
 *
 * The optimistic end is the band's low end, less any path that ends on a condition (`optimisticS`):
 * that path's seconds are an upper bound, since its sensor can stop it at once.
 */
export function checkTimeBudget(estimate: Estimate | null, field: Field, steps: readonly PlanStep[] = []): Finding[] {
  const periodS = field.periods?.autoS;
  if (estimate === null || periodS === undefined || estimate.nominalS === null) return [];
  const findings: Finding[] = [];
  const lowS = optimisticS(estimate, new Map(steps.map((step) => [step.id, step])));

  if (lowS > periodS) {
    findings.push({
      severity: "error",
      stepId: "total",
      code: "TIME_BUDGET",
      message: `Even the optimistic end of the estimate, ${lowS.toFixed(1)} s, is over the ${periodS.toFixed(0)} s autonomous period.`,
    });
  } else if (estimate.nominalS > periodS) {
    findings.push({
      severity: "warning",
      stepId: "total",
      code: "TIME_BUDGET",
      message: `The routine is estimated at ${estimate.nominalS.toFixed(1)} s against a ${periodS.toFixed(0)} s autonomous period; only the optimistic end of the band fits.`,
    });
  }

  const note = estimate.hasUnknown ? boundNote(estimate, periodS, steps) : null;
  if (note !== null) findings.push(note);
  return findings;
}

/** The steps that make the routine's total a bound rather than a firm number, in document order. */
interface BoundSteps {
  /** Steps with no estimate and no timeout. Each counts as zero, so the total is a lower bound. */
  open: string[];
  /** Steps with no estimate that a timeout bounds, with that timeout (their `highS`). */
  capped: { stepId: string; timeoutS: number }[];
  /** Paths that end on a condition, timed as if they drove the whole path. */
  onCondition: string[];
}

/**
 * Collects the `BoundSteps` under these rows. It looks inside a group only when the group's own
 * seconds are a bound, and there only at the members that decide them (`membersThatCount`): the
 * others are stopped when the group ends and add nothing to the total.
 */
function boundSteps(
  rows: readonly StepEstimate[],
  planned: ReadonlyMap<string, PlanStep>,
  out: BoundSteps = { open: [], capped: [], onCondition: [] },
): BoundSteps {
  for (const row of rows) {
    if (row.children !== undefined) {
      if (!row.unknown) continue;
      boundSteps(membersThatCount(row, row.children, planned), planned, out);
    } else if (row.unknown && row.nominalS === null) {
      if (row.highS === null) out.open.push(row.stepId);
      else out.capped.push({ stepId: row.stepId, timeoutS: row.highS });
    } else if (row.unknown && row.kind === "path") {
      out.onCondition.push(row.stepId);
    }
  }
  return out;
}

/** True for a path that ends on a condition: the estimate times it as if it drove the whole path. */
const endsOnCondition = (row: StepEstimate): boolean =>
  row.children === undefined && row.kind === "path" && row.unknown && row.nominalS !== null;

/**
 * The seconds a step takes when every path that ends on a condition stops the moment it starts,
 * combined the way the estimate combines a group (`estimate.ts`): a sequence and a branch side add
 * their known members, `all` takes the longest, `race` the shortest that ends (a member with no
 * estimate by its timeout), `deadline` its deadline member, and a branch its longer side. A group
 * with no such path inside, or one the flattened plan does not describe, keeps its own seconds.
 */
function soonestS(row: StepEstimate, planned: ReadonlyMap<string, PlanStep>): number | null {
  const children = row.children;
  if (children === undefined) return endsOnCondition(row) ? 0 : row.nominalS;
  const step = planned.get(row.stepId)?.step;
  if (!row.unknown || step === undefined) return row.nominalS;
  const each = children.map((child) => soonestS(child, planned));
  const known = (values: readonly (number | null)[]): number[] =>
    values.filter((value): value is number => value !== null);
  const sum = (values: readonly (number | null)[]): number | null =>
    values.length > 0 && known(values).length === 0 ? null : known(values).reduce((total, value) => total + value, 0);
  const extreme = (values: readonly number[], pick: (...numbers: number[]) => number): number | null =>
    values.length === 0 ? null : pick(...values);
  if (step.kind === "parallel") {
    if (step.mode === "race") {
      return extreme(known(each.map((value, index) => value ?? (children[index] as StepEstimate).highS)), Math.min);
    }
    const deadline = step.mode === "deadline" ? children.findIndex((child) => child.stepId === step.deadline) : -1;
    return deadline >= 0 ? (each[deadline] ?? null) : extreme(known(each), Math.max);
  }
  if (step.kind === "branch") {
    const thenCount = step.then.length;
    return extreme(known([sum(each.slice(0, thenCount)), sum(each.slice(thenCount))]), Math.max);
  }
  return sum(each);
}

/**
 * The optimistic end of the total: the low end of its band, except that a path that ends on a
 * condition may stop at once, so its seconds are left out rather than read as a lower bound.
 */
function optimisticS(estimate: Estimate, planned: ReadonlyMap<string, PlanStep>): number {
  const nominalS = estimate.nominalS ?? 0;
  if (!Object.values(estimate.byStepId).some(endsOnCondition)) return estimate.lowS ?? nominalS;
  const soonest = estimate.steps.reduce((total, row) => total + (soonestS(row, planned) ?? 0), 0);
  return soonest * (1 - estimate.bandFraction);
}

/** Step ids for a sentence: "a", "a and b", "a, b and c", and past three, "and N more". */
function named(ids: readonly string[]): string {
  const shown = ids.length > 3 ? [...ids.slice(0, 3), `${String(ids.length - 3)} more`] : [...ids];
  return shown.length <= 1 ? (shown[0] ?? "") : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1] ?? ""}`;
}

/** A timeout for a sentence, with no trailing zeros: 1 s, 0.5 s, 2.25 s. */
const seconds = (value: number): string => String(Number(value.toFixed(2)));

/**
 * TIME_BUDGET's info note: why the total is a bound, naming the steps that make it one, so opening
 * the note selects the first of them (`stepIds`). It keeps `stepId` "total", which is what it is
 * about.
 *
 * Three kinds of step make a total a bound. One with no estimate and no timeout counts as zero, so
 * the total is a lower bound and the routine may not fit; that note is given even when the total is
 * already over the period, since the routine is then further over than it says. One with no
 * estimate but a timeout takes at most its timeout, so the note says what the routine takes when
 * each runs its timeout in full. A path that ends on a condition is timed as if it drove its whole
 * path, so the routine may come in under the total; that note is also given over the period.
 */
function boundNote(estimate: Estimate, periodS: number, steps: readonly PlanStep[]): Finding | null {
  const nominalS = estimate.nominalS ?? 0;
  const period = `${periodS.toFixed(0)} s period`;
  const planned = new Map(steps.map((step) => [step.id, step]));
  const { open, capped, onCondition } = boundSteps(estimate.steps, planned);
  const note = (stepIds: string[], message: string): Finding => ({
    severity: "info",
    stepId: "total",
    stepIds,
    code: "TIME_BUDGET",
    message,
  });

  if (open.length > 0) {
    const has = open.length === 1 ? "has" : "have";
    const consequence = nominalS <= periodS ? `may not fit the ${period}` : `may run even further over the ${period}`;
    return note(
      open,
      `The total of ${nominalS.toFixed(1)} s is a lower bound: ${named(open)} ${has} no estimate and no timeout, so the routine ${consequence}.`,
    );
  }
  // Over the period, "the routine fits only if" no longer applies, but a path that ends on a
  // condition still makes the total an upper bound, and the routine may yet come in under it.
  if (nominalS > periodS && onCondition.length === 0) return null;

  const conditionNote =
    onCondition.length === 0
      ? ""
      : ` ${named(onCondition)} ${onCondition.length === 1 ? "ends" : "end"} on a condition, so it may come in under that.`;

  if (capped.length > 0 && nominalS <= periodS) {
    const rows = estimate.steps.map((row) => worstS(row, planned));
    const fullS = rows.every((value) => value !== null) ? rows.reduce<number>((total, value) => total + (value as number), 0) : nominalS;
    const ids = capped.map((entry) => entry.stepId);
    const one = capped.length === 1 ? capped[0] : undefined;
    const message =
      fullS <= periodS
        ? one === undefined
          ? `The routine fits the ${period} even if ${named(ids)} run their full timeouts (${fullS.toFixed(1)} s).`
          : `The routine fits the ${period} even if ${one.stepId} runs its full ${seconds(one.timeoutS)} s timeout (${fullS.toFixed(1)} s).`
        : one === undefined
          ? `The routine fits the ${period} only if ${named(ids)} end before their timeouts: run in full, they take it to ${fullS.toFixed(1)} s.`
          : `The routine fits the ${period} only if ${one.stepId} ends before its ${seconds(one.timeoutS)} s timeout: run in full, it takes the routine to ${fullS.toFixed(1)} s.`;
    return note([...ids, ...onCondition], `${message}${conditionNote}`);
  }

  if (onCondition.length > 0) {
    const ends =
      onCondition.length === 1
        ? "ends on a condition rather than at the end of its path"
        : "end on a condition rather than at the end of their paths";
    return note(
      onCondition,
      `The total of ${nominalS.toFixed(1)} s is an upper bound: ${named(onCondition)} ${ends}, so the routine may come in under it.`,
    );
  }
  return null;
}

/** Where a timeout stops a path step, from the estimate's clock along it. */
type Stop = { at: "turn" } | { at: "settle" } | { at: "along"; t: number; shortIn: number };

function stopAlong(step: PlanStep, row: StepEstimate, timeoutS: number): Stop | null {
  const times = row.timeAtSampleS;
  if (step.kind !== "path" || times === undefined || times.length < 2 || times.length !== step.samples.length) return null;
  const driveS = timeoutS - (row.turnS ?? 0);
  if (driveS <= 0) return { at: "turn" };
  if (driveS >= (times[times.length - 1] as number)) return { at: "settle" };
  for (let index = 1; index < times.length; index += 1) {
    const afterS = times[index] as number;
    if (afterS < driveS) continue;
    const beforeS = times[index - 1] as number;
    const before = step.samples[index - 1] as PlanStep["samples"][number];
    const after = step.samples[index] as PlanStep["samples"][number];
    const u = afterS - beforeS <= 1e-12 ? 1 : (driveS - beforeS) / (afterS - beforeS);
    const sIn = before.sIn + (after.sIn - before.sIn) * u;
    return { at: "along", t: before.t + (after.t - before.t) * u, shortIn: Math.max(0, step.lengthIn - sIn) };
  }
  return { at: "settle" };
}

/**
 * TIMEOUT_TIGHT: a step whose timeout leaves it no room over its own estimate.
 *
 * A timeout under the estimate stops the step before it is done, so it is a warning: it says where
 * along the path the robot is stopped, which the estimate counts the step up to. One between the
 * estimate and `TIMEOUT_TIGHT_MULTIPLE` times it only cuts a slow run short, so it stays info. Both
 * offer to raise the timeout to that multiple of the estimate, rounded up (`raisedTimeoutS`).
 */
export function checkTimeouts(steps: readonly PlanStep[], estimate: Estimate | null): Finding[] {
  if (estimate === null) return [];
  const findings: Finding[] = [];
  for (const step of steps) {
    const timeoutS = stepTimeoutS(step.step);
    const row = estimate.byStepId[step.id];
    const estimateS = row?.uncappedS ?? row?.nominalS ?? null;
    if (timeoutS === undefined || row === undefined || estimateS === null) continue;
    if (timeoutS >= estimateS * TIMEOUT_TIGHT_MULTIPLE) continue;
    const raisedS = raisedTimeoutS(estimateS);
    const fixes: Fix[] = [
      { kind: "raiseTimeout", stepId: step.id, label: `Raise the timeout to ${seconds(raisedS)} s`, params: { timeoutS: raisedS } },
    ];
    if (timeoutS >= estimateS) {
      findings.push({
        severity: "info",
        stepId: step.id,
        code: "TIMEOUT_TIGHT",
        message: `The timeout of ${timeoutS.toFixed(1)} s is under ${String(TIMEOUT_TIGHT_MULTIPLE)} times this step's estimate of ${estimateS.toFixed(2)} s, so a slow run will be cut short.`,
        fixes,
      });
      continue;
    }

    const base = `The timeout of ${timeoutS.toFixed(1)} s is under this step's estimate of ${estimateS.toFixed(2)} s`;
    const condition = step.step.kind === "path" ? step.step.endCondition?.condition : undefined;
    const unless = condition === undefined ? "" : `, unless ${condition} ends it first`;
    const stop = stopAlong(step, row, timeoutS);
    let t: number | undefined;
    let message: string;
    if (stop === null) {
      message = `${base}, so the robot stops it ${(estimateS - timeoutS).toFixed(2)} s before it would finish.`;
    } else if (stop.at === "turn") {
      t = 0;
      message = `${base}, so the robot is stopped while it still turns in place, before it drives${unless}.`;
    } else if (stop.at === "settle") {
      t = 1;
      message = `${base}, so the robot is stopped as it settles at the end of the path${unless}.`;
    } else {
      t = stop.t;
      message = `${base}, so the robot is stopped at t ${stop.t.toFixed(2)}, ${String(Math.round(stop.shortIn))} in short of the end of the path${unless}.`;
    }
    findings.push({
      severity: "warning",
      stepId: step.id,
      ...(t === undefined ? {} : { t }),
      code: "TIMEOUT_TIGHT",
      message: `${message} The estimate counts the step up to its timeout.`,
      fixes,
    });
  }
  return findings;
}

/**
 * Whether a step is sure to end on its own: its worst case is bounded (`worstS`). Without an
 * estimate there is no worst case to read, so only a wait until a condition with no timeout, or a
 * group that one can hold open, is taken to be able to wait forever.
 */
function endsOnItsOwn(step: PlanStep, estimate: Estimate | null, planned: ReadonlyMap<string, PlanStep>): boolean {
  const row = estimate?.byStepId[step.id];
  if (row !== undefined) return worstS(row, planned) !== null;
  const authored = step.step;
  if (authored.kind === "wait") return authored.seconds !== undefined || authored.timeoutS !== undefined;
  const children = step.children ?? [];
  const ends = (child: PlanStep): boolean => endsOnItsOwn(child, estimate, planned);
  if (authored.kind === "parallel" && authored.mode === "race") return children.some(ends);
  const deadline =
    authored.kind === "parallel" && authored.mode === "deadline"
      ? children.find((child) => child.id === authored.deadline)
      : undefined;
  return deadline === undefined ? children.every(ends) : ends(deadline);
}

/**
 * The ids of the steps a parallel group ends early, with everything nested inside them: every
 * member of a `deadline` group but the deadline, and a member of a `race`, which stops when the
 * first one does, when another member is sure to end (`endsOnItsOwn`). A wait there is ended by the
 * group, so it cannot wait for the rest of the period. A race whose members can all wait forever
 * ends none of them, so each wait in it still warns.
 */
function endedByGroup(steps: readonly PlanStep[], estimate: Estimate | null): Set<string> {
  const planned = new Map(steps.map((step) => [step.id, step]));
  const ended = new Set<string>();
  const mark = (step: PlanStep): void => {
    ended.add(step.id);
    for (const child of step.children ?? []) mark(child);
  };
  for (const step of steps) {
    if (step.step.kind !== "parallel" || step.step.mode === "all") continue;
    const children = step.children ?? [];
    if (step.step.mode === "race") {
      const ends = children.map((child) => endsOnItsOwn(child, estimate, planned));
      children.forEach((child, index) => {
        if (ends.some((end, other) => end && other !== index)) mark(child);
      });
    } else {
      for (const child of children) if (child.id !== step.step.deadline) mark(child);
    }
  }
  return ended;
}

/**
 * WAIT_NO_TIMEOUT: a wait until a condition with no timeout, which waits for the rest of the period
 * when the condition never reads true. Its fix points the editor at the Timeout field and writes no
 * number, since only the person knows how long the robot may wait. A path's `endCondition` does not
 * raise it: the generated code races the condition against the path, so the path's end bounds it.
 * Nor does a wait that a `race` or a `deadline` group ends early (`endedByGroup`).
 */
export function checkWaitTimeouts(steps: readonly PlanStep[], estimate: Estimate | null = null): Finding[] {
  const findings: Finding[] = [];
  const ended = endedByGroup(steps, estimate);
  for (const step of steps) {
    if (step.step.kind !== "wait" || step.step.until === undefined || step.step.timeoutS !== undefined) continue;
    if (ended.has(step.id)) continue;
    findings.push({
      severity: "warning",
      stepId: step.id,
      code: "WAIT_NO_TIMEOUT",
      message: `This step waits until ${step.step.until} with no timeout, so if it never reads true the robot waits here for the rest of the period.`,
      fixes: [{ kind: "focusTimeout", stepId: step.id, label: "Set a timeout", params: {} }],
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
 * so whatever follows has to start from wherever it actually ended. The finding offers "Start from
 * where the robot is", which sets that start to `"current"` (issue #186). Steps that hold the robot
 * still in between (a wait, a command that does not drive, a transfer) do not change that: the first
 * path after the command is the one that must start from `"current"` (issue #375).
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
          fixes: [startFromCurrentFix(step.id)],
        });
      }
    }
    // Only a path says where the robot is again. A wait, a command that does not drive or a
    // transfer holds the robot wherever the moving command left it, which is still unknown.
    if (step.step.kind === "command" && movesRobot.has(step.step.name)) {
      after = step.step.name;
    } else if (step.step.kind === "path") {
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
    ...checkTimeBudget(estimate, field, steps),
    ...checkTimeouts(steps, estimate),
    ...checkWaitTimeouts(steps, estimate),
    ...checkStationaryMarkers(steps, robot),
    ...checkMovesRobot(steps, robot),
    ...checkProvenance(steps),
  ];
}
