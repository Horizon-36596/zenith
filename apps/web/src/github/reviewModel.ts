/**
 * Review mode's view model (site/docs/github.md): the step-level
 * diff of two versions of a routine, each change carrying what it did to the estimate, plus the
 * base's plan so the canvas can ghost it under the head.
 *
 * Pure: it takes two documents and the three files they are read against and returns numbers. No
 * network, no store, no DOM, which is what lets the whole panel be tested without either GitHub or
 * a browser.
 */
import type { AutoDiffChangeKind, Estimate, Finding, Plan } from "@horizon36596/zenith-core";
import type { Auto, Field, Robot, Waypoints } from "@horizon36596/zenith-schema";
import { safeCheck, safeDiff, safeEstimate, safePlan, safeResolve } from "../lib/coreSafe";

export interface ReviewStepRow {
  kind: AutoDiffChangeKind;
  stepId: string;
  /** `core.diff`'s one sentence naming what happened to this step. */
  summary: string;
  /** The keys that differ, for a changed step. */
  fields: string[];
  /** How far a pose moved, in inches, when the change moved one. */
  movedIn: number | null;
  baseS: number | null;
  headS: number | null;
  /** Seconds this change added (positive) or saved (negative), or null when either side is unknown. */
  deltaS: number | null;
  /** `#diff-<hash>R<line>` into the pull request's file view, filled in by the loader. */
  anchor: string | null;
}

export interface ReviewTotals {
  baseS: number | null;
  headS: number | null;
  deltaS: number | null;
}

export interface ReviewModel {
  rows: ReviewStepRow[];
  /** Keys of the document itself that differ: name, title, description, alliance, start. */
  header: string[];
  identical: boolean;
  totals: ReviewTotals;
  /** The head's findings, which is what a reviewer is being asked to accept. */
  findings: Finding[];
  /** The base's plan, drawn ghosted under the head; null when the PR adds the file. */
  basePlan: Plan | null;
  /** Why a number is missing, when one is. */
  reason: string | null;
}

interface Sides {
  base: Auto | null;
  head: Auto;
  robot: Robot;
  field: Field;
  waypoints?: Waypoints | undefined;
}

interface Analysed {
  plan: Plan | null;
  estimate: Estimate | null;
  findings: Finding[];
  reason: string | null;
}

/** Resolve, plan, estimate and check one side, degrading to nulls rather than throwing. */
function analyse(auto: Auto, robot: Robot, field: Field, waypoints: Waypoints | undefined): Analysed {
  const resolved = safeResolve(auto, waypoints);
  if (!resolved.ok) return { plan: null, estimate: null, findings: [], reason: resolved.reason };
  const planned = safePlan(resolved.value, robot, field);
  if (!planned.ok) return { plan: null, estimate: null, findings: [], reason: planned.reason };
  const estimated = safeEstimate(planned.value, robot);
  const checked = safeCheck(
    planned.value,
    estimated.ok ? estimated.value : null,
    robot,
    field,
  );
  return {
    plan: planned.value,
    estimate: estimated.ok ? estimated.value : null,
    findings: checked.ok ? checked.value : planned.value.findings,
    reason: estimated.ok ? null : estimated.reason,
  };
}

const nominalOf = (estimate: Estimate | null, stepId: string): number | null =>
  estimate?.byStepId[stepId]?.nominalS ?? null;

/** The largest single pose move in a change, which is the number a reviewer reads first. */
const movedInOf = (deltas: { distanceIn: number }[] | undefined): number | null =>
  deltas === undefined || deltas.length === 0
    ? null
    : Math.max(...deltas.map((delta) => delta.distanceIn));

function deltaFor(kind: AutoDiffChangeKind, baseS: number | null, headS: number | null): number | null {
  if (kind === "added") return headS;
  if (kind === "removed") return baseS === null ? null : -baseS;
  if (baseS === null || headS === null) return null;
  return headS - baseS;
}

export function buildReviewModel(sides: Sides): ReviewModel {
  const { base, head, robot, field, waypoints } = sides;
  const headSide = analyse(head, robot, field, waypoints);
  const baseSide = base === null ? null : analyse(base, robot, field, waypoints);

  const totals: ReviewTotals = {
    baseS: baseSide?.estimate?.nominalS ?? null,
    headS: headSide.estimate?.nominalS ?? null,
    deltaS: null,
  };
  if (totals.baseS !== null && totals.headS !== null) totals.deltaS = totals.headS - totals.baseS;

  // A pull request that adds the file has no base to diff against: every step is new.
  if (base === null) {
    const rows: ReviewStepRow[] = head.steps.map((step, index) => {
      const stepId = step.id ?? `step${String(index)}`;
      const headS = nominalOf(headSide.estimate, stepId);
      return {
        kind: "added" as const,
        stepId,
        summary: "Added by this pull request.",
        fields: [],
        movedIn: null,
        baseS: null,
        headS,
        deltaS: headS,
        anchor: null,
      };
    });
    return {
      rows,
      header: [],
      identical: false,
      totals,
      findings: headSide.findings,
      basePlan: null,
      reason: headSide.reason,
    };
  }

  const attempt = safeDiff(base, head);
  if (!attempt.ok) {
    return {
      rows: [],
      header: [],
      identical: false,
      totals,
      findings: headSide.findings,
      basePlan: baseSide?.plan ?? null,
      reason: attempt.reason,
    };
  }

  const rows = attempt.value.changes.map((change): ReviewStepRow => {
    const baseS = nominalOf(baseSide?.estimate ?? null, change.stepId);
    const headS = nominalOf(headSide.estimate, change.stepId);
    return {
      kind: change.kind,
      stepId: change.stepId,
      summary: change.summary,
      fields: change.fields ?? [],
      movedIn: movedInOf(change.poseDeltas),
      baseS: change.kind === "added" ? null : baseS,
      headS: change.kind === "removed" ? null : headS,
      deltaS: deltaFor(change.kind, baseS, headS),
      anchor: null,
    };
  });

  return {
    rows,
    header: attempt.value.header,
    identical: attempt.value.identical,
    totals,
    findings: headSide.findings,
    basePlan: baseSide?.plan ?? null,
    reason: headSide.reason ?? baseSide?.reason ?? null,
  };
}

/** Everything review mode holds while a pull request is open in the editor. */
export interface ReviewState {
  owner: string;
  repo: string;
  number: number;
  /** The pull request on github.com, which every anchor is relative to. */
  htmlUrl: string;
  title: string;
  /** The changed auto file's path, for the diff anchors. */
  path: string;
  baseRef: string;
  headRef: string;
  /** Every path the pull request changes, so an unexpected file is visible rather than silent. */
  files: string[];
  head: Auto;
  base: Auto | null;
  model: ReviewModel;
}
