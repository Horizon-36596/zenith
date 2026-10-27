import {
  childLists,
  type Auto,
  type Envelope,
  type Heading,
  type Marker,
  type MarkerAt,
  type PathStep,
  type Pose,
  type ProjectionSegment,
  type ProjectionStep,
  type Proposal,
  type ProposalChange,
  type Segment,
  type Step,
  type WaitStep,
  type Waypoints,
} from "@horizon36596/zenith-schema";
import { diff } from "../diff.js";
import { EditError } from "../edit/errors.js";
import { effectiveId } from "../edit/ids.js";
import { setPose, setHeadingMode, setMarkerAt, setSpeed } from "../edit/path.js";
import { setEnvelope, setWait } from "../edit/fields.js";
import { addStep, moveStep, removeStep, type IntoGroup } from "../edit/steps.js";
import { setTimeout as setStepTimeout } from "../edit/timing.js";
import { stableJson } from "../hash.js";
import { plan as planAuto } from "../plan.js";
import { projectStructure, type ProjectedStructure, type ProjectShareInput, type ProjectShareOptions, type ProjectionTokenSource } from "../projection.js";
import { resolve } from "../resolve.js";
import type { AutoDiff, Plan } from "../types.js";
import { describeChange } from "./describe.js";
import { locatorsOf, stepAt, Tracker, type Locator } from "./locate.js";
import { slotsOf, targetOf, type Naming } from "./structure.js";
import type { ProposalChangeReport, ProposalChangeStatus, ProposalFinding } from "./types.js";
import { checkChanges, readProposal, refusalsOf, type ValidateProposalOptions } from "./validate.js";

/**
 * `applyProposalToAuto`: the owning team's side of a proposal (spec 13
 * section 14). The owner has the real auto and the revision the share is pinned to; the proposal
 * names steps by opaque ids and commands and conditions by opaque tokens. This rebuilds the
 * mapping from the pinned revision with the same walk `projectShare` used (so nothing about it was
 * ever shared), re-checks the proposal as the proposer's app did, finds every change whose step has
 * changed since the share, and makes only the changes the owner accepted, one at a time, through
 * the ordinary edit primitives, so the result is canonical and is exactly what making the same
 * edits by hand gives.
 */

export interface ApplyProposalOptions extends ValidateProposalOptions {
  /**
   * The project's waypoints, to plan the auto as it is now for the conflict check. A step whose
   * waypoint has moved has changed even when its own text has not, so pass them whenever the auto
   * uses any.
   */
  waypoints?: Waypoints;
  /** The auto as it is now, already planned, in place of planning it here with `waypoints`. */
  currentPlan?: Plan;
}

export interface ApplyProposalResult {
  /** The auto with the accepted changes made; the input itself when none could be. */
  auto: Auto;
  findings: ProposalFinding[];
  /** Every change of the proposal, in order, with what became of it. */
  changes: ProposalChangeReport[];
}

/** How the owner reads a proposal: its own step ids, and a token with the name it stands for. */
function ownerNaming(pinned: ProjectedStructure): Naming {
  const realId = (opaque: string): string => pinned.steps.get(opaque)?.id ?? opaque;
  return {
    step: (opaque) => JSON.stringify(realId(opaque)),
    stepId: realId,
    token: (token) => {
      const source = pinned.tokens.get(token);
      if (source === undefined) return token;
      return `${token} (${"command" in source ? source.command.name : source.condition})`;
    },
  };
}

/**
 * A structure step as it can be compared across two versions of the auto: its own fields, with
 * every opaque name replaced by what it stands for (a token by its command or condition, a
 * deadline by the member's real id), its envelope, which the structure does not carry, and not its
 * members, which are compared on their own.
 */
function comparable(node: ProjectionStep, projected: ProjectedStructure): string {
  const tokenValue = (token: string): unknown => {
    const source: ProjectionTokenSource | undefined = projected.tokens.get(token);
    if (source === undefined) return token;
    return "command" in source ? source.command : { condition: source.condition };
  };
  const own: Record<string, unknown> = { ...node };
  delete own["id"];
  delete own["steps"];
  delete own["then"];
  delete own["else"];
  if (node.kind === "command") own["token"] = tokenValue(node.token);
  if (node.kind === "path") {
    if (node.markers !== undefined) own["markers"] = node.markers.map((marker) => ({ at: marker.at, command: tokenValue(marker.token) }));
    if (node.endCondition !== undefined) own["endCondition"] = tokenValue(node.endCondition.token);
  }
  if (node.kind === "wait" && node.until !== undefined) own["until"] = tokenValue(node.until.token);
  if (node.kind === "branch") own["condition"] = tokenValue(node.condition.token);
  if (node.kind === "parallel" && node.deadline !== undefined) own["deadline"] = projected.steps.get(node.deadline)?.id ?? null;
  const authored = projected.steps.get(node.id)?.step;
  own["envelope"] = authored !== undefined && "envelope" in authored ? (authored.envelope ?? null) : null;
  return stableJson(own);
}

/** The real ids of the members of the list that holds a step, in order. */
function siblingIds(projected: ProjectedStructure, opaque: string): string[] | null {
  const slot = slotsOf(projected.structure.steps).get(opaque);
  if (slot === undefined) return null;
  return slot.list.map((node) => projected.steps.get(node.id)?.id ?? node.id);
}

/** Why a change cannot be applied to the auto as it is now, or null when its step is unchanged. */
function conflictOf(change: ProposalChange, index: number, pinned: ProjectedStructure, current: ProjectedStructure, naming: Naming): string | null {
  const target = targetOf(change);
  if (target === null) return null;
  const number = `Change ${String(index + 1)}`;
  const realId = pinned.steps.get(target)?.id;
  if (realId === undefined) return null;
  const name = naming.step(target);
  const verb = change.op === "insertWait" || change.op === "addPath" ? "inserts a step after" : change.op === "reorder" ? "moves" : "changes";

  const pinnedNamesake = [...pinned.steps.values()].filter((step) => step.id === realId).length;
  const currentOpaque = [...current.steps].filter(([, step]) => step.id === realId).map(([opaque]) => opaque);
  if (pinnedNamesake > 1 || currentOpaque.length > 1) {
    return `${number} ${verb} ${name}, but more than one step in the auto has that id, so it can only be rejected.`;
  }
  const now = currentOpaque[0];
  if (now === undefined) return `${number} ${verb} ${name}, which is no longer in the auto, so it can only be rejected.`;
  if (change.op === "insertWait" || change.op === "addPath") return null;

  const before = slotsOf(pinned.structure.steps).get(target)?.node;
  const after = slotsOf(current.structure.steps).get(now)?.node;
  if (before === undefined || after === undefined || comparable(before, pinned) !== comparable(after, current)) {
    return `${number} ${verb} ${name}, which has changed since the share, so it can only be rejected.`;
  }
  if (change.op === "reorder" && stableJson(siblingIds(pinned, target)) !== stableJson(siblingIds(current, now))) {
    return `${number} moves ${name} among steps that have changed since the share, so it can only be rejected.`;
  }
  return null;
}

const poseOf = (pose: { xIn: number; yIn: number; headingRad?: number | undefined }): Pose =>
  pose.headingRad === undefined ? { xIn: pose.xIn, yIn: pose.yIn } : { xIn: pose.xIn, yIn: pose.yIn, headingRad: pose.headingRad };

function segmentOf(segment: ProjectionSegment): Segment {
  if (segment.kind === "line") return { kind: "line", from: poseOf(segment.from), to: poseOf(segment.to) };
  return {
    kind: "bezier",
    from: poseOf(segment.from),
    control: segment.control.map((point) => ({ xIn: point.xIn, yIn: point.yIn })),
    to: poseOf(segment.to),
  };
}

/** Makes the accepted changes on the auto, one at a time, and says what happened to each. */
class OwnerEdits {
  auto: Auto;
  private readonly tracker = new Tracker();

  constructor(
    auto: Auto,
    private readonly pinned: ProjectedStructure,
  ) {
    this.auto = auto;
    const located = locatorsOf(auto.steps);
    for (const step of pinned.steps.values()) this.tracker.track(step.id, located.get(step.id) ?? null);
  }

  private commandOf(token: string): Marker["command"] {
    const source = this.pinned.tokens.get(token);
    if (source === undefined || !("command" in source)) throw new EditError(`The share holds no command for ${token}.`);
    return source.command;
  }

  private conditionOf(token: string): string {
    const source = this.pinned.tokens.get(token);
    if (source === undefined || "command" in source) throw new EditError(`The share holds no condition for ${token}.`);
    return source.condition;
  }

  private locate(opaque: string): { id: string; locator: Locator } {
    const realId = this.pinned.steps.get(opaque)?.id;
    const locator = realId === undefined ? null : this.tracker.get(realId);
    const found = locator === null ? null : stepAt(this.auto.steps, locator);
    if (locator === null || found === null) throw new EditError(`The step the share calls ${opaque} is no longer in the auto.`);
    return { id: found.id, locator };
  }

  /** Adds a step after another, or at the start, and moves the tracked steps along with it. */
  private insert(step: Step, afterStepId: string | undefined): void {
    if (afterStepId === undefined) {
      const appended = addStep(this.auto, step);
      const index = appended.steps.length - 1;
      const added = appended.steps[index];
      if (added === undefined) throw new EditError("The new step was not added.");
      this.auto = moveStep(appended, effectiveId(added, index, "step"), 0);
      this.tracker.inserted([], "steps", 0);
      return;
    }
    const anchor = this.locate(afterStepId);
    this.auto = addStep(this.auto, step, anchor.id);
    const last = anchor.locator[anchor.locator.length - 1];
    if (last !== undefined) this.tracker.inserted(anchor.locator.slice(0, -1), last.key, last.index + 1);
  }

  apply(change: ProposalChange): void {
    switch (change.op) {
      case "movePose": {
        const { id } = this.locate(change.stepId);
        const target =
          typeof change.point === "object"
            ? { segmentIndex: change.segmentIndex, pointKind: "control" as const, controlIndex: change.point.controlIndex }
            : { segmentIndex: change.segmentIndex, pointKind: change.point };
        this.auto = setPose(this.auto, id, target, poseOf(change.pose));
        return;
      }
      case "setHeading":
        this.auto = setHeadingMode(this.auto, this.locate(change.stepId).id, change.heading as Heading);
        return;
      case "setSpeedFraction":
        this.auto = setSpeed(this.auto, this.locate(change.stepId).id, change.speedFraction);
        return;
      case "setTimeout":
        this.auto = setStepTimeout(this.auto, this.locate(change.stepId).id, change.timeoutS ?? undefined);
        return;
      case "insertWait": {
        const wait: WaitStep =
          change.until === undefined ? { kind: "wait", seconds: change.seconds ?? 0 } : { kind: "wait", until: this.conditionOf(change.until.token) };
        this.insert(wait, change.afterStepId);
        return;
      }
      case "setWait": {
        const { id } = this.locate(change.stepId);
        this.auto = setWait(
          this.auto,
          id,
          change.until === undefined ? { seconds: change.seconds ?? 0 } : { until: this.conditionOf(change.until.token) },
        );
        return;
      }
      case "removeStep": {
        const { id, locator } = this.locate(change.stepId);
        this.auto = removeStep(this.auto, id);
        const last = locator[locator.length - 1];
        if (last !== undefined) this.tracker.removed(locator.slice(0, -1), last.key, last.index);
        return;
      }
      case "addPath": {
        const path: PathStep = {
          kind: "path",
          ...(change.timeoutS === undefined ? {} : { timeoutS: change.timeoutS }),
          segments: change.segments.map(segmentOf),
          heading: change.heading as Heading,
          ...(change.speedFraction === undefined ? {} : { speedFraction: change.speedFraction }),
          ...(change.markers === undefined
            ? {}
            : { markers: change.markers.map((marker) => ({ at: marker.at as MarkerAt, command: this.commandOf(marker.token) })) }),
          ...(change.endCondition === undefined ? {} : { endCondition: { condition: this.conditionOf(change.endCondition.token) } }),
        };
        this.insert(path, change.afterStepId);
        return;
      }
      case "reorder": {
        const { id, locator } = this.locate(change.stepId);
        const parent = locator.slice(0, -1);
        const last = locator[locator.length - 1];
        if (last === undefined) return;
        if (parent.length === 0) {
          const to = Math.min(change.newIndex, this.auto.steps.length - 1);
          this.auto = moveStep(this.auto, id, to);
          this.tracker.moved([], "steps", last.index, to);
          return;
        }
        const group = stepAt(this.auto.steps, parent);
        if (group === null) throw new EditError(`The group that holds ${change.stepId} is no longer in the auto.`);
        const into: IntoGroup =
          group.step.kind === "branch"
            ? { into: group.id, index: change.newIndex, arm: last.key === "else" ? "else" : "then" }
            : { into: group.id, index: change.newIndex };
        const lists = childLists(group.step);
        const members = lists[group.step.kind === "branch" && last.key === "else" ? 1 : 0] ?? [];
        this.auto = moveStep(this.auto, id, into);
        this.tracker.moved(parent, last.key, last.index, Math.min(change.newIndex, members.length - 1));
        return;
      }
      case "moveMarker":
        this.auto = setMarkerAt(this.auto, this.locate(change.stepId).id, change.markerIndex, change.at as MarkerAt);
        return;
      case "setEnvelope":
        this.auto = setEnvelope(this.auto, this.locate(change.stepId).id, change.envelope as Envelope | null);
        return;
    }
  }
}

/** The owner's projection of the auto as it is now, for the conflict check. */
function currentStructure(auto: Auto, input: ProjectShareInput, options: ApplyProposalOptions): ProjectedStructure {
  const current = options.currentPlan ?? planAuto(resolve(auto, options.waypoints, input.robot), input.robot, input.field);
  return projectStructure(current, input.robot);
}

function report(proposal: Proposal, statuses: readonly ProposalChangeStatus[], pinned: ProjectedStructure, naming: Naming): ProposalChangeReport[] {
  return proposal.changes.map((change, index) => {
    const target = targetOf(change);
    return {
      index,
      number: index + 1,
      op: change.op,
      stepId: target === null ? null : (pinned.steps.get(target)?.id ?? null),
      status: statuses[index] ?? "notAccepted",
      summary: describeChange(change, naming),
      ...(change.comment === undefined ? {} : { comment: change.comment }),
    };
  });
}

/**
 * Applies the accepted changes of a proposal to the owner's auto.
 *
 * - `auto` is the auto as it is now.
 * - `projectionInput` and `projectionOptions` are what the share was built from: the pinned
 *   revision's plan and robot and the share's level. The opaque ids and tokens are mapped back
 *   through them (`projectionStepIdMap`, `projectionTokenMap`), and the proposal's structure hash
 *   must match theirs.
 * - `acceptedChangeIndexes` are the changes the owner accepted, from 0; the others are rejected.
 *
 * A refused proposal (a view share, a share said to be revoked or expired, a stale hash, a file
 * that is not a proposal) changes nothing. Otherwise every change is checked as `validateProposal`
 * checks it, and against the auto as it is now: a change whose step has changed since the share,
 * is gone, or now shares its id, is a conflict and can only be rejected. The accepted changes that
 * are neither are made in proposal order through the edit primitives. One that only fits with a
 * change the owner did not accept (a token the rejected change would have freed, say) is left out
 * with a finding. Findings about changes the owner accepted are errors; the same findings about
 * changes the owner rejected are warnings, since rejecting them is the remedy. Pure.
 */
export function applyProposalToAuto(
  auto: Auto,
  projectionInput: ProjectShareInput,
  projectionOptions: ProjectShareOptions,
  proposal: unknown,
  acceptedChangeIndexes: readonly number[],
  options: ApplyProposalOptions = {},
): ApplyProposalResult {
  const read = readProposal(proposal);
  if (read.proposal === null) return { auto, findings: read.findings, changes: [] };
  const parsed = read.proposal;
  const pinned = projectStructure(projectionInput.plan, projectionInput.robot);
  const naming = ownerNaming(pinned);
  const level = projectionOptions.level;
  const refusals = refusalsOf(parsed, level, level === "propose" ? pinned.structure : undefined, options);
  if (refusals.length > 0) {
    return { auto, findings: refusals, changes: report(parsed, parsed.changes.map(() => "refused"), pinned, naming) };
  }

  const count = parsed.changes.length;
  const every = parsed.changes.map((_, index) => index);
  const accepted = new Set<number>();
  const findings: ProposalFinding[] = [];
  for (const index of acceptedChangeIndexes) {
    if (Number.isInteger(index) && index >= 0 && index < count) accepted.add(index);
    else {
      findings.push({
        severity: "error",
        stepId: "(proposal)",
        code: "PROPOSAL_CHANGE",
        message: `There is no change ${String(index + 1)} to accept; this proposal has ${String(count)}.`,
      });
    }
  }
  const severityOf = (index: number): "error" | "warning" => (accepted.has(index) ? "error" : "warning");
  const statuses: ProposalChangeStatus[] = parsed.changes.map((_, index) => (accepted.has(index) ? "applied" : "notAccepted"));
  const perChange: ProposalFinding[] = [];
  const mark = (finding: ProposalFinding, status: ProposalChangeStatus): void => {
    const index = finding.changeIndex;
    if (index === undefined) return;
    perChange.push({ ...finding, severity: severityOf(index) });
    statuses[index] = status;
  };

  // The proposal as it was sent: the proposer's app should already have refused these.
  for (const finding of checkChanges(pinned.structure, parsed, every, naming).findings) mark(finding, "invalid");

  // What has changed in the auto since the share.
  const current = currentStructure(auto, projectionInput, options);
  parsed.changes.forEach((change, index) => {
    if (statuses[index] === "invalid") return;
    const conflict = conflictOf(change, index, pinned, current, naming);
    if (conflict === null) return;
    const target = targetOf(change);
    mark({ severity: "error", stepId: target === null ? "(proposal)" : naming.stepId(target), code: "PROPOSAL_CONFLICT", message: conflict, changeIndex: index }, "conflict");
  });

  // The accepted changes that are left must fit the share without the ones that are not: a
  // reorder counted with an insertion the owner rejected, or a token only a rejected change frees.
  let chosen = every.filter((index) => statuses[index] === "applied");
  for (;;) {
    const { findings: subset } = checkChanges(pinned.structure, parsed, chosen, naming);
    for (const finding of subset) mark(finding, "invalid");
    const left = chosen.filter((index) => statuses[index] === "applied");
    if (left.length === chosen.length) break;
    chosen = left;
  }

  const edits = new OwnerEdits(auto, pinned);
  for (const index of chosen) {
    const change = parsed.changes[index];
    if (change === undefined) continue;
    try {
      edits.apply(change);
    } catch (error) {
      if (!(error instanceof EditError)) throw error;
      const target = targetOf(change);
      mark(
        {
          severity: "error",
          stepId: target === null ? "(proposal)" : naming.stepId(target),
          code: "PROPOSAL_CHANGE",
          message: `Change ${String(index + 1)} could not be made: ${error.message}`,
          changeIndex: index,
        },
        "invalid",
      );
    }
  }

  // One finding per change, the first reason, in change order.
  const seen = new Set<number>();
  const ordered = perChange
    .filter((finding) => {
      const index = finding.changeIndex ?? -1;
      if (seen.has(index)) return false;
      seen.add(index);
      return true;
    })
    .sort((a, b) => (a.changeIndex ?? -1) - (b.changeIndex ?? -1));
  return { auto: edits.auto, findings: [...findings, ...ordered], changes: report(parsed, statuses, pinned, naming) };
}

/** What review mode draws: the auto as it is (ghosted), the auto with the changes, and the diff. */
export interface ProposalDiff extends ApplyProposalResult {
  base: Auto;
  proposed: Auto;
  diff: AutoDiff;
}

/**
 * The review of a proposal (spec 06 section 4, as spec 13
 * section 14 uses it): the auto as it is now, the auto with the accepted changes (every change,
 * unless `accepted` names some), the step-level diff between the two from `core.diff`, and each
 * change with its status, summary and comment. Conflicting changes are never in `proposed`. Pure.
 */
export function diffProposal(
  auto: Auto,
  projectionInput: ProjectShareInput,
  projectionOptions: ProjectShareOptions,
  proposal: unknown,
  options: ApplyProposalOptions & { accepted?: readonly number[] } = {},
): ProposalDiff {
  const read = readProposal(proposal);
  const accepted = options.accepted ?? (read.proposal === null ? [] : read.proposal.changes.map((_, index) => index));
  const result = applyProposalToAuto(auto, projectionInput, projectionOptions, proposal, accepted, options);
  return { ...result, base: auto, proposed: result.auto, diff: diff(auto, result.auto) };
}
