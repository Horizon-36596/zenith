import { childLists, type Auto, type Field, type Step, type Waypoints } from "@horizon36596/zenith-schema";
import {
  ALLIANCE_MAX_CLEARING_OFFSET_S,
  ALLIANCE_TICK_S,
  allianceFixCleared,
  checkAlliance,
  isClearableAllianceCode,
  ownAllianceRobot,
  smallestClearingOffset,
  type AllianceOptions,
  type AllianceRobot,
  type ClearableAllianceCode,
  type ClearingOffset,
} from "./alliance.js";
import { EditError } from "./edit/errors.js";
import { addStep, moveStep } from "./edit/steps.js";
import { childPrefix, collectIds, effectiveId, uniqueId } from "./edit/ids.js";
import { plan as planAuto } from "./plan.js";
import { resolve } from "./resolve.js";
import { noSeasonRules, type SeasonRules } from "./season.js";
import type { Finding, Plan } from "./types.js";

/**
 * The second one-click fix of spec 13 section 9, "wait before this step": the smallest `wait`
 * step, in 0.1 s steps up to 10 s, that clears a predicted ALLIANCE_COLLISION, ALLIANCE_NEAR_MISS
 * or ALLIANCE_ENVELOPE when it is inserted before the step the user's robot is running as the
 * finding begins. Also the one-click "make it a wait step" of the start offset, which turns the
 * offset into a real wait at the start of the auto.
 *
 * Unlike "delay my start", which only moves the user's robot in time, this changes the auto, so
 * every candidate is checked by planning, simulating and comparing the edited auto from scratch:
 * the answer is the same one the user sees after the edit, whatever the follower does around the
 * new wait. Pure, like the rest of core.
 */

/** Where a wait goes and how long it is. */
export interface ClearingWait {
  /** The effective id of the step the wait goes before, in the auto as it stands now. */
  stepId: string;
  /** How long the wait is, in seconds, on the 0.1 s grid. */
  seconds: number;
}

/** Where a step sits in the tree: the group that holds it (null for the top level), and where. */
interface StepPlace {
  id: string;
  step: Step;
  /** The effective id of the group holding the step, or null at the top level. */
  parentId: string | null;
  parentKind: Step["kind"] | null;
  /** Which of the parent's child lists: 0, or 1 for a branch's `else` arm. */
  listIndex: number;
  index: number;
  /** The effective id of the sibling just before it in the same list, if there is one. */
  previousId: string | null;
  /** The places of the groups around it, outermost first. */
  ancestors: StepPlace[];
}

function findPlace(
  steps: readonly Step[],
  targetId: string,
  prefix = "step",
  parent: StepPlace | null = null,
  listIndex = 0,
  ancestors: StepPlace[] = [],
): StepPlace | null {
  let previousId: string | null = null;
  for (const [index, step] of steps.entries()) {
    const id = effectiveId(step, index, prefix);
    const place: StepPlace = {
      id,
      step,
      parentId: parent?.id ?? null,
      parentKind: parent?.step.kind ?? null,
      listIndex,
      index,
      previousId,
      ancestors,
    };
    if (id === targetId) return place;
    const lists = childLists(step);
    for (const [childListIndex, list] of lists.entries()) {
      const found = findPlace(list, targetId, childPrefix(id, lists.length, childListIndex), place, childListIndex, [
        ...ancestors,
        place,
      ]);
      if (found !== null) return found;
    }
    previousId = id;
  }
  return null;
}

/**
 * The step a wait goes before, for a step the robot is running: the step itself when the list
 * holding it runs one step after another (the top level, a sequence, a branch arm), or else the
 * nearest group around it that sits in such a list. A member of a parallel group is not delayed on
 * its own, because a wait beside it in the group would run alongside it rather than before it.
 * Null when there is no step by that id.
 */
export function waitTargetStepId(auto: Auto, stepId: string): string | null {
  const place = findPlace(auto.steps, stepId);
  if (place === null) return null;
  const chain = [...place.ancestors, place];
  for (let at = chain.length - 1; at >= 0; at -= 1) {
    const candidate = chain[at] as StepPlace;
    if (candidate.parentKind !== "parallel") return candidate.id;
  }
  return null;
}

/**
 * The auto with a `wait` of `seconds` inserted straight before the step `beforeId`, in the same
 * list, through the ordinary edit primitives (`addStep` and `moveStep`), so the editor's undo path
 * and an agent's edit give the same file. The new step's id is `wait`, or `wait-2` and on when that
 * is taken. Throws `EditError` when there is no such step.
 */
export function insertWaitBefore(auto: Auto, beforeId: string, seconds: number): { auto: Auto; waitId: string } {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new RangeError("A wait must be a finite number of seconds, zero or more.");
  }
  const place = findPlace(auto.steps, beforeId);
  if (place === null) throw new EditError(`No step with id ${JSON.stringify(beforeId)} to insert a wait before.`);
  // An explicit id cannot collide with a positional one, which always begins with "step".
  const waitId = uniqueId("wait", collectIds(auto.steps));
  const wait: Step = { id: waitId, kind: "wait", seconds };
  if (place.previousId !== null) return { auto: addStep(auto, wait, place.previousId), waitId };
  if (place.parentId !== null) {
    const arm = place.parentKind === "branch" ? (place.listIndex === 1 ? "else" : "then") : undefined;
    return {
      auto: addStep(auto, wait, { into: place.parentId, index: 0, ...(arm === undefined ? {} : { arm }) }),
      waitId,
    };
  }
  return { auto: moveStep(addStep(auto, wait), waitId, 0), waitId };
}

/** What the fix needs to plan the user's auto again: the files the plan was made from. */
export interface ClearingWaitInput {
  /** The user's plan as it stands; its auto, robot and field are the ones edited and replanned. */
  plan: Plan;
  /** The waypoints the auto was resolved against, when it names any. */
  waypoints?: Waypoints;
  /** The field to simulate on. Default the plan's own. */
  field?: Field;
  /** The season's rules, for the ledger and the sim. Default none. */
  season?: SeasonRules;
  /** How findings name the user's robot. Default "your robot". */
  label?: string;
}

/** The user's robot for an edited auto, planned and simulated the way `ownAllianceRobot` does it. */
function ownRobotFor(auto: Auto, input: ClearingWaitInput): AllianceRobot {
  const field = input.field ?? input.plan.field;
  const resolved = resolve(auto, input.waypoints, input.plan.robot);
  const planned = planAuto(resolved, input.plan.robot, field);
  return ownAllianceRobot(planned, field, input.season ?? noSeasonRules, input.label);
}

/**
 * The "wait before this step" fix for one ALLIANCE_COLLISION, ALLIANCE_NEAR_MISS or
 * ALLIANCE_ENVELOPE finding: the smallest wait, in 0.1 s steps from 0.1 s up to 10 s, that leaves
 * no finding of the same code, and no ALLIANCE_COLLISION, with any partner when it is inserted
 * before the step the user's robot is running as the finding begins (`waitTargetStepId` lifts it
 * out of a parallel group). A near miss names the step at its closest approach, and the wait goes
 * before that one. `options` are the ones the finding was raised with, the user's own start offset
 * included, and stay as they are.
 *
 * Null when the finding is ALLIANCE_START_OVERLAP or ALLIANCE_ELEMENT_CONFLICT, which no wait can
 * clear (see `ClearableAllianceCode`), when it names no step of the auto (the robot was waiting out
 * its start offset or had already parked, where "delay my start" is the fix), or when no wait up
 * to 10 s clears it.
 */
export function smallestClearingWait(
  input: ClearingWaitInput,
  partners: readonly AllianceRobot[],
  finding: Finding,
  options: AllianceOptions = {},
): ClearingWait | null {
  const code = finding.code;
  if (!isClearableAllianceCode(code)) return null;
  const auto = input.plan.auto;
  const stepId = waitTargetStepId(auto, finding.stepId);
  if (stepId === null) return null;
  const ticksPerS = Math.round(1 / ALLIANCE_TICK_S);
  const maxTicks = Math.round(ALLIANCE_MAX_CLEARING_OFFSET_S * ticksPerS);
  for (let tick = 1; tick <= maxTicks; tick += 1) {
    const seconds = tick / ticksPerS;
    const own = ownRobotFor(insertWaitBefore(auto, stepId, seconds).auto, input);
    if (allianceFixCleared(checkAlliance(own, partners, options), code)) return { stepId, seconds };
  }
  return null;
}

/**
 * The start offset turned into a real wait (spec 13 section 9, "turning it into a real wait step
 * is one click"): the auto with a `wait` of `seconds` as its very first step, through the same
 * edit primitives as `insertWaitBefore`, so the editor's undo path and an agent's edit give the
 * same file. A robot waiting out a start offset holds its start pose, and so does a robot running
 * a first wait, so the user's robot moves exactly as it did with the offset once the offset is set
 * back to 0 s.
 *
 * Only the user's own offset can become a wait here. A partner's offset, the partner waiting for
 * the user's robot, belongs in the partner's auto, which this cannot edit.
 *
 * The new step's id is `wait`, or `wait-2` and on. Throws a RangeError unless `seconds` is a
 * finite number greater than 0, since a zero offset has no wait to make, and an EditError for an
 * auto with no steps.
 */
export function insertStartWait(auto: Auto, seconds: number): { auto: Auto; waitId: string } {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new RangeError("A start offset becomes a wait only when it is a finite number of seconds greater than 0.");
  }
  const first = auto.steps[0];
  // The schema gives every auto at least one step, so this is only a hand-built object.
  if (first === undefined) throw new EditError("This auto has no steps to put a wait in front of.");
  return insertWaitBefore(auto, effectiveId(first, 0, "step"), seconds);
}

/** The "wait before this step" fix for one finding of a list, as `allianceFixes` reports it. */
export interface FindingClearingWait {
  /** Where the finding sits in the list the fixes were found for, counting from 0. */
  findingIndex: number;
  /** The finding's code, one a wait can clear. */
  code: ClearableAllianceCode;
  /** The wait to insert, or null when none up to 10 s clears it or the finding names no step. */
  wait: ClearingWait | null;
}

/** Both one-click fixes of spec 13 section 9, for every finding in a list that has them. */
export interface AllianceFixes {
  /**
   * "Delay my start": for each of ALLIANCE_COLLISION, ALLIANCE_NEAR_MISS and ALLIANCE_ENVELOPE
   * that is in the list, the smallest start offset for the user's robot that clears every finding
   * of that code without leaving a collision (`smallestClearingOffset`), or null when none up to
   * 10 s does. A code that is not in the list has no entry.
   */
  clearingOffsets: Partial<Record<ClearableAllianceCode, ClearingOffset | null>>;
  /**
   * "Wait before this step": one entry for each finding with one of those codes, in the list's
   * order (`smallestClearingWait`). Findings of the other two codes have no entry.
   */
  clearingWaits: FindingClearingWait[];
}

/**
 * Every fix the alliance view offers for a list of findings, so the CLI and the MCP server report
 * what the editor's buttons would do: the start offset for each clearable code, and the wait for
 * each clearable finding. `own` is the user's robot the findings were raised for, built from
 * `input.plan` the way `ownAllianceRobot` builds it, and `partners` and `options` are the ones the
 * findings were raised with. Two findings of the same code that put the wait before the same step
 * share one search, since the answer depends only on the code and that step.
 */
export function allianceFixes(
  input: ClearingWaitInput,
  own: AllianceRobot,
  partners: readonly AllianceRobot[],
  findings: readonly Finding[],
  options: AllianceOptions = {},
): AllianceFixes {
  const clearingOffsets: Partial<Record<ClearableAllianceCode, ClearingOffset | null>> = {};
  const clearingWaits: FindingClearingWait[] = [];
  const waits = new Map<string, ClearingWait | null>();
  for (const [findingIndex, finding] of findings.entries()) {
    const code = finding.code;
    if (!isClearableAllianceCode(code)) continue;
    if (!(code in clearingOffsets)) clearingOffsets[code] = smallestClearingOffset(own, partners, options, code);
    const key = `${code}\u0000${waitTargetStepId(input.plan.auto, finding.stepId) ?? ""}`;
    let wait = waits.get(key);
    if (wait === undefined) {
      wait = smallestClearingWait(input, partners, finding, options);
      waits.set(key, wait);
    }
    clearingWaits.push({ findingIndex, code, wait });
  }
  return { clearingOffsets, clearingWaits };
}
