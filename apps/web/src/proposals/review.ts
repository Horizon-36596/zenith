/**
 * The owner's review of a proposal (spec 13 section 14, in the review mode
 * of spec 06 section 4): the auto as it is now ghosted, the
 * proposal over it, every change with core's one sentence for it, the proposer's comment, what
 * became of it and what it does to the estimate, and the findings of the result.
 *
 * Everything here is core's: `diffProposal` maps the opaque ids and tokens back through the pinned
 * revision, finds the conflicts and makes the accepted changes through the edit primitives, and the
 * estimate deltas come from the same review model the pull-request review uses. This file only
 * arranges the answer for the panel, and says which changes can be accepted at all.
 *
 * Pure: no DOM, no clock, no store.
 */
import {
  diffProposal,
  plan,
  resolve,
  simulate,
  type ApplyProposalOptions,
  type ProjectShareInput,
  type ProposalChangeStatus,
  type ProposalFinding,
  type ShareStatus,
} from "@horizon36596/zenith-core";
import type { Auto, Field, ProposalChange, ProposalChangeOp, Robot, ShareRef, Waypoints } from "@horizon36596/zenith-schema";
import { buildReviewModel, type ReviewModel } from "../github/reviewModel";

/** The share options every owner-side call passes: a proposal is only ever against a propose share. */
export const PROPOSE_LEVEL = { level: "propose" } as const;

/** What the owner's side reads a proposal against. */
export interface ReviewFiles {
  robot: Robot;
  field: Field;
  waypoints?: Waypoints | undefined;
}

/**
 * The pinned revision a proposal is read against, planned and simulated the way the sharer's device
 * did before it built the projection, so the opaque ids and tokens map back the same way.
 */
export function pinnedInputFor(auto: Auto, files: ReviewFiles): ProjectShareInput {
  const planned = plan(resolve(auto, files.waypoints, files.robot), files.robot, files.field);
  const trace = simulate(planned, files.robot, files.field);
  return { plan: planned, trace, robot: files.robot, field: files.field };
}

/** What one change can be: taken, or only rejected, and why. */
export type ChangeValidity = "valid" | "conflict" | "invalid" | "refused";

/** One change as the review lists it. */
export interface ReviewChangeRow {
  /** Its place in the proposal, from 0. */
  index: number;
  /** The same place from 1, as the sentences name it. */
  number: number;
  op: ProposalChangeOp;
  /** The owner's own id of the step it is about, or goes after; null for the start of the auto. */
  stepId: string | null;
  /** Core's one sentence, in the owner's own step and command names. */
  summary: string;
  comment: string | null;
  validity: ChangeValidity;
  /** Why it can only be rejected, when it can only be rejected. */
  reason: string | null;
  /** True while the owner has it accepted (only a valid change can be). */
  accepted: boolean;
  /** True once an Apply made it and the auto still has it. */
  applied: boolean;
  /**
   * Seconds it adds to its step (positive) or saves (negative), with every valid change made; null
   * when the estimate cannot say.
   */
  deltaS: number | null;
}

export interface OwnerReviewInput {
  /** The auto as it is now. */
  current: Auto;
  /** The pinned revision, planned (`pinnedInputFor`). */
  pinned: ProjectShareInput;
  files: ReviewFiles;
  proposal: unknown;
  /** The changes the owner has accepted, from 0. */
  accepted: ReadonlySet<number>;
  /** The changes an Apply already made, which the auto still has. */
  applied: ReadonlySet<number>;
  share?: ShareStatus;
  shareRef?: ShareRef;
}

export interface OwnerReview {
  /** Why the whole proposal is refused, when it is: then no change can be accepted. */
  refusals: ProposalFinding[];
  rows: ReviewChangeRow[];
  /** Every change that can be accepted and has not been applied yet: what "Accept all valid" takes. */
  validIndexes: number[];
  /** The changes an Apply would make now: accepted, valid and not applied yet. */
  toApply: number[];
  /** The auto with the accepted changes made, drawn over the auto as it is now. */
  proposed: Auto;
  /** The pull-request review model of now against the proposed auto: deltas, totals, findings. */
  model: ReviewModel;
}

const VALIDITY: Record<ProposalChangeStatus, ChangeValidity> = {
  applied: "valid",
  notAccepted: "valid",
  conflict: "conflict",
  invalid: "invalid",
  refused: "refused",
};

function optionsOf(input: OwnerReviewInput, accepted: readonly number[]): ApplyProposalOptions & { accepted: readonly number[] } {
  return {
    accepted,
    ...(input.files.waypoints === undefined ? {} : { waypoints: input.files.waypoints }),
    ...(input.share === undefined ? {} : { share: input.share }),
    ...(input.shareRef === undefined ? {} : { shareRef: input.shareRef }),
  };
}

const changesOf = (proposal: unknown): ProposalChange[] => {
  if (typeof proposal !== "object" || proposal === null) return [];
  const changes = (proposal as { changes?: unknown }).changes;
  return Array.isArray(changes) ? (changes as ProposalChange[]) : [];
};

/** The review for the owner's current choices. */
export function buildOwnerReview(input: OwnerReviewInput): OwnerReview {
  const count = changesOf(input.proposal).length;
  const every = Array.from({ length: count }, (_, index) => index).filter((index) => !input.applied.has(index));

  // Every change not applied yet, all accepted: which of them can be taken at all, and why not.
  const all = diffProposal(input.current, input.pinned, PROPOSE_LEVEL, input.proposal, optionsOf(input, every));
  const refusals = all.findings.filter((finding) => finding.changeIndex === undefined && finding.code !== "PROPOSAL_CHANGE");
  const reasonOf = new Map<number, string>();
  for (const finding of all.findings) {
    if (finding.changeIndex !== undefined && !reasonOf.has(finding.changeIndex)) reasonOf.set(finding.changeIndex, finding.message);
  }
  const statusOf = new Map(all.changes.map((report) => [report.index, report]));
  const validIndexes = every.filter((index) => statusOf.get(index)?.status === "applied");
  const toApply = validIndexes.filter((index) => input.accepted.has(index));

  const chosen = toApply.length === validIndexes.length ? all : diffProposal(input.current, input.pinned, PROPOSE_LEVEL, input.proposal, optionsOf(input, toApply));
  const model = buildReviewModel({ base: input.current, head: chosen.proposed, ...input.files });
  const withAll = toApply.length === validIndexes.length ? model : buildReviewModel({ base: input.current, head: all.proposed, ...input.files });
  const deltaOf = new Map(withAll.rows.map((row) => [row.stepId, row.deltaS]));

  const source = changesOf(input.proposal);
  const rows: ReviewChangeRow[] = all.changes.map((report) => {
    const change = source[report.index];
    const applied = input.applied.has(report.index);
    const validity = applied ? "valid" : VALIDITY[report.status];
    const waitS = change?.op === "insertWait" && change.seconds !== undefined ? change.seconds : null;
    return {
      index: report.index,
      number: report.number,
      op: report.op,
      stepId: report.stepId,
      summary: report.summary,
      comment: report.comment ?? null,
      validity,
      reason: applied || validity === "valid" ? null : (reasonOf.get(report.index) ?? refusals[0]?.message ?? null),
      accepted: !applied && validity === "valid" && input.accepted.has(report.index),
      applied,
      deltaS: waitS ?? (report.stepId === null || change?.op === "insertWait" || change?.op === "addPath" ? null : (deltaOf.get(report.stepId) ?? null)),
    };
  });

  return { refusals, rows, validIndexes, toApply, proposed: chosen.proposed, model };
}

/** The accepted set after "Accept all valid": every valid change not applied yet. */
export const acceptAllValid = (review: Pick<OwnerReview, "validIndexes">): Set<number> => new Set(review.validIndexes);

/** The accepted set with one change accepted or rejected. A change that cannot be taken stays out. */
export function toggleAccepted(accepted: ReadonlySet<number>, review: Pick<OwnerReview, "validIndexes">, index: number, accept: boolean): Set<number> {
  const next = new Set(accepted);
  if (accept && review.validIndexes.includes(index)) next.add(index);
  else next.delete(index);
  return next;
}
