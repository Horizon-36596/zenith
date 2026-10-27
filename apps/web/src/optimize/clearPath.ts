/**
 * Add a clear path here (issue #310): the draft a right-click on an empty field point opens the
 * Optimize card on.
 *
 * The draft is a path step from where the robot is to the point, `from: "current"`, inserted after
 * the anchor as Add a path to here would insert it. With Extend this chain on and a path step
 * selected (decision D5), it goes straight after that chain instead and carries the chain's speed,
 * end condition and timeout, so Apply can join it onto the chain as more of its paths. The draft
 * lives only in the card: the open auto is not touched until Apply.
 *
 * The end heading is the person's default heading mode's (owner ruling D6), facing the way the
 * path drives as Add a path to here does, or, when the point is a legal approach to the season's
 * current target, Linear to the heading that approach gives (`legalApproachEnd`), since Linear is
 * the one default mode that can end on a heading it is given.
 */
import { EDITOR_PROVENANCE, joinStepsProblem, ledgerStateAfter, legalApproachEnd, stepEndOverlap, type LegalApproachEnd } from "@horizon36596/zenith-core";
import type { Auto, PathStep, PoseSource } from "@horizon36596/zenith-schema";
import { anchorEndPose, chainToExtend, insertAnchorId } from "../app/edits";
import { defaultPathHeading } from "../lib/headingModes";
import { newPathHeading } from "../app/newPathHeading";
import { findEntry, freshPathId, indexSteps, newPathStep } from "../lib/stepOps";
import { insertStepAfter } from "../lib/structure";
import { currentDerived, getState } from "../state/store";
import { overlapWords } from "./thingWords";

/** The words of the right-click item (issue #413); the card it opens is titled "Add a clear path". */
export const CLEAR_PATH_LABEL = "Add a clear path here";

/** What the right-click item does, for its tooltip (0.1.2 UX review). */
export const CLEAR_PATH_HINT = "Find a path to this spot that goes round the structures. Nothing changes until you apply it.";

export interface ClearPathDraft {
  /** The open auto the draft was built from: Apply writes only while it is still the open one. */
  base: Auto;
  /** `base` with the draft step inserted, which the run optimizes. */
  auto: Auto;
  /** The draft step's id in `auto`. */
  stepId: string;
  /** The chain Apply appends the route to (Extend this chain), or null for a new step. */
  chainId: string | null;
  /** The point the path goes to, so Run again can build the draft afresh after an edit. */
  target: ClearPathTarget;
  /** The season target the path ends facing, or null when the default heading mode decided. */
  approach: LegalApproachEnd | null;
}

/** Where a right-click asks for a clear path to, and the waypoint it snapped onto, if any. */
export interface ClearPathTarget {
  xIn: number;
  yIn: number;
  waypoint?: string | undefined;
}

/** The chain settings a path must share with the chain it joins (core's `joinSteps`). */
const SHARED_KEYS = ["speedFraction", "endCondition", "timeoutS"] as const;

/**
 * The ledger state once the anchor step and everything inside it has run, which is the state the
 * new path starts in; the end of the routine when there is no anchor.
 */
function stateAtAnchor(auto: Auto, anchorId: string | undefined) {
  const run = currentDerived().ledgerRun;
  if (run === null) return null;
  if (anchorId === undefined) return run.finalState;
  const entries = indexSteps(auto);
  const at = entries.findIndex((entry) => entry.id === anchorId);
  if (at < 0) return run.finalState;
  const depth = entries[at]?.depth ?? 0;
  let end = at;
  while (end + 1 < entries.length && (entries[end + 1]?.depth ?? 0) > depth) end += 1;
  const done = new Set(entries.slice(0, end + 1).map((entry) => entry.id));
  return ledgerStateAfter(run, (stepId) => done.has(stepId));
}

/** The draft for a clear path to `target`, or the reason there can be none. */
export function clearPathDraft(target: ClearPathTarget): ClearPathDraft | string {
  const state = getState();
  const base = state.auto;
  if (base === null) return "Open an auto first.";
  if (state.review !== null) return "Review mode is read only.";
  const robot = state.autoRobot ?? state.project?.robot ?? null;
  if (robot === null) return "Open a project with a robot first.";

  const chainId = chainToExtend();
  // Apply joins the route onto the chain, and a path in a parallel group runs side by side with its
  // neighbours, so it has no next path to join: say so now, before a run, not after Apply.
  const chainEntry = chainId === null ? undefined : findEntry(base, chainId);
  const holder = chainEntry?.parentId === undefined ? undefined : findEntry(base, chainEntry.parentId);
  if (chainId !== null && holder?.step.kind === "parallel") {
    return `${chainId} runs in the parallel group ${holder.id}, so Extend this chain cannot add a clear path after it. Select a step outside the group, or turn Extend this chain off.`;
  }
  const anchorId = chainId ?? insertAnchorId();
  const from = anchorEndPose();
  const waypoints = state.project?.waypoints;
  const named = waypoints?.waypoints;
  const follows = target.waypoint !== undefined && named !== undefined && Object.prototype.hasOwnProperty.call(named, target.waypoint) ? target.waypoint : null;
  const to: PoseSource = follows === null ? { xIn: target.xIn, yIn: target.yIn, provenance: EDITOR_PROVENANCE } : { ref: follows };

  // Facing the way it drives there, as Add a path to here does, unless the point is a season target.
  const bearing = Math.atan2(target.yIn - from.yIn, target.xIn - from.xIn);
  const seasonState = stateAtAnchor(base, anchorId);
  const approach =
    seasonState === null ? null : legalApproachEnd(currentDerived().season, seasonState, base.alliance, target, bearing, robot);
  const heading =
    approach === null
      ? newPathHeading(from.headingRad, bearing)
      : defaultPathHeading("linear", from.headingRad, approach.headingRad);

  const chain = chainId === null ? undefined : findEntry(base, chainId)?.step;
  const shared: Partial<PathStep> = {};
  if (chain?.kind === "path") for (const key of SHARED_KEYS) if (chain[key] !== undefined) Object.assign(shared, { [key]: chain[key] });
  const step: PathStep = { ...newPathStep(freshPathId(base), "current", to, heading), ...shared };
  try {
    const inserted = insertStepAfter(base, step, anchorId, waypoints);
    // Any other reason Apply could not join the route onto the chain is given now, in core's words.
    const problem = chainId === null ? null : joinStepsProblem(inserted.auto, chainId, inserted.id, waypoints === undefined ? {} : { waypoints });
    if (problem !== null) return problem;
    return { base, auto: inserted.auto, stepId: inserted.id, chainId, target, approach };
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Why no clear path can reach `draft`'s spot, or null when one may: an end of the draft that is
 * inside a structure or a keep-out, or over the centre line or the wall, which no route between its
 * ends can change. It is the optimizer's own first test, made here at once so a blocked spot is
 * refused before any search (0.1.2 UX review).
 */
export function clearPathBlocked(draft: ClearPathDraft): string | null {
  const state = getState();
  const robot = state.autoRobot ?? state.project?.robot ?? null;
  const field = state.autoField ?? state.project?.field ?? null;
  if (robot === null || field === null) return null;
  const waypoints = state.project?.waypoints;
  const overlap = stepEndOverlap({
    auto: draft.auto,
    robot,
    field,
    ...(waypoints === undefined ? {} : { waypoints }),
    season: currentDerived().season,
    stepId: draft.stepId,
  });
  if (overlap === null) return null;
  const where = overlapWords(overlap.kind, overlap.id);
  return overlap.end === "end"
    ? `That spot is ${where}. Right-click somewhere clear of it.`
    : `The robot would start this path ${where}. Move the step before it clear first.`;
}
