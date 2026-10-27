/**
 * How edits on the partner's structure become `ProposalChange` records
 * (spec 13 section 14). Every edit the proposer makes in the editor, a
 * drag, a heading, a speed, an inserted wait, goes through one of these functions, which return a
 * new list of changes and never touch anything else: not the proposer's own auto, and not the
 * projection.
 *
 * Three rules keep a proposal small and readable for the owner:
 *
 * - **One change per thing.** A drag produces a pose every frame; the change for that point is
 *   replaced each time, so a drag is one change however long it runs. The same holds for a step's
 *   heading, speed, timeout, wait, marker and envelope.
 * - **Back to the share is no change.** Setting a value back to what the share has removes the
 *   change, keeping its comment would be a comment about nothing.
 * - **Added steps are edited through the change that added them.** The owner maps a proposal's
 *   step ids back through the pinned revision, where a step the proposal added does not exist, so a
 *   change may only ever name the share's own steps. Editing a wait the proposal inserted changes
 *   that `insertWait`; removing it deletes that `insertWait`.
 *
 * Pure: no DOM, no clock, no store.
 */
import type {
  Envelope,
  ProjectionHeading,
  ProjectionMarkerAt,
  ProjectionStep,
  ProjectionStructure,
  ProposalChange,
  ProposalPoint,
  ProposalPose,
} from "@horizon36596/zenith-schema";
import { MAX_PROPOSAL_COMMENT_LENGTH } from "@horizon36596/zenith-schema";
import { slotsOfStructure } from "./synthetic";

/** What the helpers need to know besides the changes: the share's structure and the added steps. */
export interface DraftContext {
  /** The share's own structure. */
  base: ProjectionStructure;
  /** The preview id of each step a change added, by the change's index (`applyProposalToStructure`). */
  addedIds: ReadonlyMap<number, string>;
}

/** Which point of a segment a drag moved, as the canvas names it. */
export interface DraftPoint {
  segmentIndex: number;
  pointKind: "from" | "to" | "control";
  controlIndex?: number;
}

const TOLERANCE = 1e-6;
const near = (a: number, b: number): boolean => Math.abs(a - b) < TOLERANCE;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The index of the change that added a step, or null when the step is the share's own. */
export function addedBy(context: DraftContext, stepId: string): number | null {
  for (const [index, id] of context.addedIds) if (id === stepId) return index;
  return null;
}

/** The share's own step with this id, or null. */
function baseStep(context: DraftContext, stepId: string): ProjectionStep | null {
  return slotsOfStructure(context.base).get(stepId)?.node ?? null;
}

const pointOf = (target: DraftPoint): ProposalPoint =>
  target.pointKind === "control" ? { controlIndex: target.controlIndex ?? 0 } : target.pointKind;

/** Replaces the first change that `matches`, or appends `next`; removes it when `next` is null. */
function upsert(changes: readonly ProposalChange[], matches: (change: ProposalChange) => boolean, next: ProposalChange | null): ProposalChange[] {
  const at = changes.findIndex(matches);
  if (at < 0) return next === null ? [...changes] : [...changes, next];
  const kept = changes[at];
  const copy = [...changes];
  if (next === null) {
    copy.splice(at, 1);
    return copy;
  }
  // The proposer's comment stays with the thing it is about.
  copy[at] = kept?.comment === undefined || next.comment !== undefined ? next : { ...next, comment: kept.comment };
  return copy;
}

/** A pose moved on the canvas: one `movePose` per point, gone again when the point is back. */
export function recordMovePose(
  changes: readonly ProposalChange[],
  context: DraftContext,
  stepId: string,
  target: DraftPoint,
  pose: { xIn: number; yIn: number; headingRad?: number },
): ProposalChange[] {
  if (addedBy(context, stepId) !== null) return [...changes];
  const node = baseStep(context, stepId);
  if (node === null || node.kind !== "path") return [...changes];
  const segment = node.segments[target.segmentIndex];
  if (segment === undefined) return [...changes];
  const point = pointOf(target);
  const original =
    typeof point === "object"
      ? segment.kind === "bezier"
        ? segment.control[point.controlIndex]
        : undefined
      : segment[point];
  if (original === undefined) return [...changes];
  const originalHeading = (original as { headingRad?: number }).headingRad;
  const turns = pose.headingRad !== undefined && originalHeading !== undefined && !near(pose.headingRad, originalHeading);
  const moved: ProposalPose =
    typeof point === "object" || !turns ? { xIn: pose.xIn, yIn: pose.yIn } : { xIn: pose.xIn, yIn: pose.yIn, headingRad: pose.headingRad };
  const back = near(original.xIn, pose.xIn) && near(original.yIn, pose.yIn) && !turns;
  const matches = (change: ProposalChange): boolean =>
    change.op === "movePose" && change.stepId === stepId && change.segmentIndex === target.segmentIndex && same(change.point, point);
  return upsert(changes, matches, back ? null : { op: "movePose", stepId, segmentIndex: target.segmentIndex, point, pose: moved });
}

/** A path's heading mode changed. */
export function recordHeading(changes: readonly ProposalChange[], context: DraftContext, stepId: string, heading: ProjectionHeading): ProposalChange[] {
  const node = baseStep(context, stepId);
  if (node === null || node.kind !== "path") return [...changes];
  const back = node.heading !== undefined && same(node.heading, heading);
  const matches = (change: ProposalChange): boolean => change.op === "setHeading" && change.stepId === stepId;
  return upsert(changes, matches, back ? null : { op: "setHeading", stepId, heading });
}

/** A path's speed fraction changed. */
export function recordSpeed(changes: readonly ProposalChange[], context: DraftContext, stepId: string, speedFraction: number): ProposalChange[] {
  const node = baseStep(context, stepId);
  if (node === null || node.kind !== "path") return [...changes];
  const back = node.speedFraction !== undefined && near(node.speedFraction, speedFraction);
  const matches = (change: ProposalChange): boolean => change.op === "setSpeedFraction" && change.stepId === stepId;
  return upsert(changes, matches, back ? null : { op: "setSpeedFraction", stepId, speedFraction });
}

/** A step's timeout changed; null removes it. */
export function recordTimeout(changes: readonly ProposalChange[], context: DraftContext, stepId: string, timeoutS: number | null): ProposalChange[] {
  const node = baseStep(context, stepId);
  if (node === null || (node.kind !== "path" && node.kind !== "command" && node.kind !== "wait")) return [...changes];
  const now = node.timeoutS ?? null;
  const back = now === null ? timeoutS === null : timeoutS !== null && near(now, timeoutS);
  const matches = (change: ProposalChange): boolean => change.op === "setTimeout" && change.stepId === stepId;
  return upsert(changes, matches, back ? null : { op: "setTimeout", stepId, timeoutS });
}

/**
 * What a wait waits for, in seconds. On one of the share's waits that is a `setWait`; on a wait the
 * proposal inserted it changes that `insertWait` instead.
 */
export function recordWaitSeconds(changes: readonly ProposalChange[], context: DraftContext, stepId: string, seconds: number): ProposalChange[] {
  const added = addedBy(context, stepId);
  if (added !== null) {
    const change = changes[added];
    if (change?.op !== "insertWait") return [...changes];
    const copy = [...changes];
    const { until: _until, ...rest } = change;
    copy[added] = { ...rest, seconds };
    return copy;
  }
  const node = baseStep(context, stepId);
  if (node === null || node.kind !== "wait") return [...changes];
  const back = node.until === undefined && node.seconds !== undefined && near(node.seconds, seconds);
  const matches = (change: ProposalChange): boolean => change.op === "setWait" && change.stepId === stepId;
  return upsert(changes, matches, back ? null : { op: "setWait", stepId, seconds });
}

/** A marker slid along its path. */
export function recordMarker(
  changes: readonly ProposalChange[],
  context: DraftContext,
  stepId: string,
  markerIndex: number,
  at: ProjectionMarkerAt,
): ProposalChange[] {
  const node = baseStep(context, stepId);
  if (node === null || node.kind !== "path") return [...changes];
  const marker = node.markers?.[markerIndex];
  if (marker === undefined) return [...changes];
  const back = same(marker.at, at);
  const matches = (change: ProposalChange): boolean => change.op === "moveMarker" && change.stepId === stepId && change.markerIndex === markerIndex;
  return upsert(changes, matches, back ? null : { op: "moveMarker", stepId, markerIndex, at });
}

/** A step's envelope set, or, with null, the proposed envelope taken back. */
export function recordEnvelope(changes: readonly ProposalChange[], context: DraftContext, stepId: string, envelope: Envelope | null): ProposalChange[] {
  if (addedBy(context, stepId) !== null) return [...changes];
  const node = baseStep(context, stepId);
  if (node === null) return [...changes];
  const matches = (change: ProposalChange): boolean => change.op === "setEnvelope" && change.stepId === stepId;
  return upsert(changes, matches, envelope === null ? null : { op: "setEnvelope", stepId, envelope });
}

/** The envelope the proposal gives a step, or null when it gives none. */
export function proposedEnvelope(changes: readonly ProposalChange[], stepId: string): Envelope | null {
  for (let index = changes.length - 1; index >= 0; index -= 1) {
    const change = changes[index];
    if (change?.op === "setEnvelope" && change.stepId === stepId) return change.envelope;
  }
  return null;
}

/** Every envelope the proposal sets, by step id, for the synthetic auto. */
export function proposedEnvelopes(changes: readonly ProposalChange[]): Map<string, Envelope | null> {
  const map = new Map<string, Envelope | null>();
  for (const change of changes) if (change.op === "setEnvelope") map.set(change.stepId, change.envelope);
  return map;
}

/**
 * A new wait straight after a step, or at the start of the auto with `afterStepId` null. The anchor
 * must be one of the share's own steps (see the file comment).
 */
export function recordInsertWait(
  changes: readonly ProposalChange[],
  context: DraftContext,
  afterStepId: string | null,
  seconds: number,
): ProposalChange[] {
  if (afterStepId === null) return [...changes, { op: "insertWait", atStart: true, seconds }];
  if (addedBy(context, afterStepId) !== null || baseStep(context, afterStepId) === null) return [...changes];
  return [...changes, { op: "insertWait", afterStepId, seconds }];
}

/**
 * A step removed. A step the proposal added is removed by deleting the change that added it. One of
 * the share's own steps gets a `removeStep`, and the changes that only edited it are dropped, since
 * they would edit nothing.
 */
export function recordRemove(changes: readonly ProposalChange[], context: DraftContext, stepId: string): ProposalChange[] {
  const added = addedBy(context, stepId);
  if (added !== null) return changes.filter((_, index) => index !== added);
  if (baseStep(context, stepId) === null) return [...changes];
  if (changes.some((change) => change.op === "removeStep" && change.stepId === stepId)) return [...changes];
  const edits = new Set(["movePose", "setHeading", "setSpeedFraction", "setTimeout", "setWait", "moveMarker", "setEnvelope", "reorder"]);
  const kept = changes.filter((change) => !(edits.has(change.op) && "stepId" in change && change.stepId === stepId));
  return [...kept, { op: "removeStep", stepId }];
}

/**
 * A step moved to `newIndex` in the list that holds it, counted with the step taken out, in the
 * list as the changes so far leave it (`fromIndex` is its place there now). Consecutive moves of one
 * step are one change: moving a step up three times is one reorder to where it ended.
 */
export function recordReorder(
  changes: readonly ProposalChange[],
  context: DraftContext,
  stepId: string,
  fromIndex: number,
  newIndex: number,
): ProposalChange[] {
  if (addedBy(context, stepId) !== null || baseStep(context, stepId) === null) return [...changes];
  if (fromIndex === newIndex) return [...changes];
  const last = changes[changes.length - 1];
  if (last?.op === "reorder" && last.stepId === stepId) return [...changes.slice(0, -1), { ...last, newIndex }];
  return [...changes, { op: "reorder", stepId, newIndex }];
}

/** Sets or clears a change's one-line comment: line breaks become spaces, and it is capped. */
export function setComment(changes: readonly ProposalChange[], index: number, text: string): ProposalChange[] {
  const change = changes[index];
  if (change === undefined) return [...changes];
  const line = text.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_PROPOSAL_COMMENT_LENGTH);
  const copy = [...changes];
  const { comment: _comment, ...rest } = change;
  copy[index] = (line.length === 0 ? rest : { ...rest, comment: line }) as ProposalChange;
  return copy;
}

/** Takes one change out of the proposal. */
export const removeChange = (changes: readonly ProposalChange[], index: number): ProposalChange[] =>
  changes.filter((_, at) => at !== index);

/** The ids of the share's own steps that a change is about, for the step list's marks. */
export function changedStepIds(changes: readonly ProposalChange[]): Set<string> {
  const ids = new Set<string>();
  for (const change of changes) {
    if ("stepId" in change && typeof change.stepId === "string" && change.op !== "removeStep") ids.add(change.stepId);
  }
  return ids;
}

/** The ids of the share's own steps the proposal removes. */
export function removedStepIds(changes: readonly ProposalChange[]): Set<string> {
  return new Set(changes.flatMap((change) => (change.op === "removeStep" ? [change.stepId] : [])));
}
