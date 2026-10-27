import type {
  ProjectionMarker,
  ProjectionStep,
  ProjectionStructure,
  ProposalChange,
} from "@horizon36596/zenith-schema";
import { sha256Hex, stableJson } from "../hash.js";
import type { ProposalFinding } from "./types.js";

/**
 * The proposal's own view of a projection's structure: its hash, what tokens it holds, and the
 * changes applied to a copy of it. This is all the proposing team can compute, since it only has
 * the projection, and the owning team runs the same code against the structure it rebuilds from the
 * pinned revision, so both sides agree on what a proposal means.
 */

/**
 * The hash of a structure: `sha256:` and the SHA-256 of its stable JSON (`stableJson`), keys in
 * order, so the same structure gives the same hash on every device and after a round trip through
 * a file. A projection with no structure, a view projection, hashes as `null`.
 */
export function structureHashOf(structure: ProjectionStructure | undefined): string {
  return `sha256:${sha256Hex(stableJson(structure ?? null))}`;
}

/** How a step, a finding's step id and a token are named in the sentences one side reads. */
export interface Naming {
  /** A step as a sentence names it: `s3` for the proposer, `"toGarden"` for the owner. */
  step(opaqueId: string): string;
  /** The `stepId` a finding carries: the opaque id for the proposer, the real id for the owner. */
  stepId(opaqueId: string): string;
  /** A token as a sentence names it. */
  token(token: string): string;
}

/** The proposer's naming: everything by its opaque name, the only names it has. */
export const OPAQUE_NAMING: Naming = { step: (id) => id, stepId: (id) => id, token: (token) => token };

type ChildKey = "steps" | "then" | "else";

/** Where a step sits in a structure: the list that holds it, its place there and the group it is in. */
export interface Slot {
  node: ProjectionStep;
  list: ProjectionStep[];
  index: number;
  parent: ProjectionStep | null;
  key: ChildKey;
}

/** The child lists of a structure step, with the key each is under. */
export function childListsOf(node: ProjectionStep): { key: ChildKey; steps: ProjectionStep[] }[] {
  switch (node.kind) {
    case "sequence":
    case "parallel":
      return [{ key: "steps", steps: node.steps }];
    case "branch":
      return node.else === undefined
        ? [{ key: "then", steps: node.then }]
        : [
            { key: "then", steps: node.then },
            { key: "else", steps: node.else },
          ];
    default:
      return [];
  }
}

/** Every step of a structure by its id, depth first; the first when an id repeats. */
export function slotsOf(steps: ProjectionStep[]): Map<string, Slot> {
  const slots = new Map<string, Slot>();
  const visit = (list: ProjectionStep[], parent: ProjectionStep | null, key: ChildKey): void => {
    list.forEach((node, index) => {
      if (!slots.has(node.id)) slots.set(node.id, { node, list, index, parent, key });
      for (const child of childListsOf(node)) visit(child.steps, node, child.key);
    });
  };
  visit(steps, null, "steps");
  return slots;
}

/** Every token a structure holds, each once for every place it is held. */
export function tokensIn(steps: readonly ProjectionStep[]): string[] {
  const tokens: string[] = [];
  const visit = (list: readonly ProjectionStep[]): void => {
    for (const node of list) {
      switch (node.kind) {
        case "path":
          for (const marker of node.markers ?? []) tokens.push(marker.token);
          if (node.endCondition !== undefined) tokens.push(node.endCondition.token);
          break;
        case "command":
          tokens.push(node.token);
          break;
        case "wait":
          if (node.until !== undefined) tokens.push(node.until.token);
          break;
        case "branch":
          tokens.push(node.condition.token);
          break;
        default:
          break;
      }
      for (const child of childListsOf(node)) visit(child.steps);
    }
  };
  visit(steps);
  return tokens;
}

/** The tokens a change puts somewhere, which are the only ones a proposal can hold. */
export function tokensPlacedBy(change: ProposalChange): string[] {
  switch (change.op) {
    case "addPath":
      return [...(change.markers ?? []).map((marker) => marker.token), ...(change.endCondition === undefined ? [] : [change.endCondition.token])];
    case "insertWait":
    case "setWait":
      return change.until === undefined ? [] : [change.until.token];
    default:
      return [];
  }
}

/** The step a change is about, or that a new step goes after; null for a step added at the start. */
export function targetOf(change: ProposalChange): string | null {
  if (change.op === "insertWait" || change.op === "addPath") return change.afterStepId ?? null;
  return change.stepId;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The highest `sN` in a structure, so new steps in a preview are numbered after the share's. */
function highestStepNumber(steps: ProjectionStep[]): number {
  let highest = 0;
  for (const id of slotsOf(steps).keys()) {
    const number = Number(id.slice(1));
    if (Number.isInteger(number) && number > highest) highest = number;
  }
  return highest;
}

const RUNS = new Set(["path", "command", "wait"]);

/** What a preview did: the new structure, the changes it could not make, and what each new step was called. */
export interface Preview {
  structure: ProjectionStructure;
  failures: Map<number, ProposalFinding>;
  addedIds: Map<number, string>;
}

/**
 * Applies the changes at `indexes`, in that order, to a copy of `base`. A change that does not fit
 * is left out, with a finding saying why, and the ones after it are still tried. New steps get the
 * ids after the share's highest (`s13`, `s14`, ...), in the order they are added. An envelope is
 * not part of the structure, so `setEnvelope` is checked here but changes nothing in it. Pure: the
 * base is never changed.
 */
export function previewChanges(
  base: ProjectionStructure,
  changes: readonly ProposalChange[],
  indexes: readonly number[],
  naming: Naming,
): Preview {
  const structure = clone(base);
  const failures = new Map<number, ProposalFinding>();
  const addedIds = new Map<number, string>();
  const removed = new Set<string>();
  let next = highestStepNumber(structure.steps);

  for (const index of indexes) {
    const change = changes[index];
    if (change === undefined) continue;
    const slots = slotsOf(structure.steps);
    const number = `Change ${String(index + 1)}`;
    const fail = (message: string, opaqueId?: string): void => {
      failures.set(index, {
        severity: "error",
        stepId: opaqueId === undefined ? "(proposal)" : naming.stepId(opaqueId),
        code: "PROPOSAL_CHANGE",
        message,
        changeIndex: index,
      });
    };
    const find = (id: string): Slot | null => {
      const slot = slots.get(id);
      if (slot !== undefined) {
        // The owner's side maps only the share's own step ids onto the auto, so a change may not
        // name a step that an earlier change in the proposal adds: it would pass here and then
        // fail on Apply as "no longer in the auto".
        if ([...addedIds.values()].includes(id)) {
          fail(`${number} names ${id}, a step an earlier change in this proposal adds; a change can only name a step the share already has.`);
          return null;
        }
        return slot;
      }
      if (removed.has(id)) fail(`${number} names ${naming.step(id)}, which an earlier change in this proposal removed.`, id);
      else fail(`${number} names ${id}, but the share has no step ${id}.`);
      return null;
    };
    const place = (node: ProjectionStep, afterStepId: string | undefined): boolean => {
      if (afterStepId === undefined) {
        structure.steps.unshift(node);
        return true;
      }
      const anchor = find(afterStepId);
      if (anchor === null) return false;
      anchor.list.splice(anchor.index + 1, 0, node);
      return true;
    };
    const newId = (): string => {
      next += 1;
      return `s${String(next)}`;
    };

    switch (change.op) {
      case "movePose": {
        const slot = find(change.stepId);
        if (slot === null) break;
        const name = naming.step(change.stepId);
        const node = slot.node;
        if (node.kind !== "path") {
          fail(`${number} moves a pose of ${name}, which is a ${node.kind} step, not a path.`, change.stepId);
          break;
        }
        const segment = node.segments[change.segmentIndex];
        if (segment === undefined) {
          fail(`${number} moves a pose of ${name}, but it has no segment at index ${String(change.segmentIndex)}.`, change.stepId);
          break;
        }
        if (typeof change.point === "object") {
          const at = change.point.controlIndex;
          if (segment.kind !== "bezier") {
            fail(
              `${number} moves control point ${String(at)} of segment ${String(change.segmentIndex)} of ${name}, but that segment is a line, which has no control points.`,
              change.stepId,
            );
            break;
          }
          if (segment.control[at] === undefined) {
            fail(`${number} moves control point ${String(at)} of segment ${String(change.segmentIndex)} of ${name}, but that segment has no control point at index ${String(at)}.`, change.stepId);
            break;
          }
          segment.control[at] = { xIn: change.pose.xIn, yIn: change.pose.yIn };
          break;
        }
        const old = segment[change.point];
        segment[change.point] = { xIn: change.pose.xIn, yIn: change.pose.yIn, headingRad: change.pose.headingRad ?? old.headingRad };
        break;
      }
      case "setHeading":
      case "setSpeedFraction":
      case "moveMarker": {
        const slot = find(change.stepId);
        if (slot === null) break;
        const name = naming.step(change.stepId);
        const node = slot.node;
        const what = change.op === "setHeading" ? "sets the heading of" : change.op === "setSpeedFraction" ? "sets the speed of" : "slides a marker of";
        if (node.kind !== "path") {
          fail(`${number} ${what} ${name}, which is a ${node.kind} step, not a path.`, change.stepId);
          break;
        }
        if (change.op === "setHeading") node.heading = clone(change.heading);
        else if (change.op === "setSpeedFraction") node.speedFraction = change.speedFraction;
        else {
          const marker: ProjectionMarker | undefined = node.markers?.[change.markerIndex];
          if (marker === undefined) {
            fail(`${number} slides marker ${String(change.markerIndex)} of ${name}, but it has no marker at index ${String(change.markerIndex)}.`, change.stepId);
            break;
          }
          marker.at = clone(change.at);
        }
        break;
      }
      case "setTimeout": {
        const slot = find(change.stepId);
        if (slot === null) break;
        const node = slot.node;
        if (node.kind !== "path" && node.kind !== "command" && node.kind !== "wait") {
          fail(`${number} sets the timeout of ${naming.step(change.stepId)}, which is a ${node.kind} step; only path, command and wait steps have one.`, change.stepId);
          break;
        }
        if (change.timeoutS === null) delete node.timeoutS;
        else node.timeoutS = change.timeoutS;
        break;
      }
      case "insertWait": {
        const id = newId();
        const node: ProjectionStep =
          change.until === undefined ? { id, kind: "wait", seconds: change.seconds ?? 0 } : { id, kind: "wait", until: clone(change.until) };
        if (place(node, change.afterStepId)) addedIds.set(index, id);
        else next -= 1;
        break;
      }
      case "setWait": {
        const slot = find(change.stepId);
        if (slot === null) break;
        const node = slot.node;
        if (node.kind !== "wait") {
          fail(`${number} sets what ${naming.step(change.stepId)} waits for, but it is a ${node.kind} step, not a wait.`, change.stepId);
          break;
        }
        delete node.seconds;
        delete node.until;
        if (change.until === undefined) node.seconds = change.seconds ?? 0;
        else node.until = clone(change.until);
        break;
      }
      case "removeStep": {
        const slot = find(change.stepId);
        if (slot === null) break;
        const name = naming.step(change.stepId);
        const { node, parent } = slot;
        if (node.kind !== "path" && node.kind !== "wait") {
          fail(`${number} removes ${name}, which is a ${node.kind} step; a proposal may only remove path and wait steps.`, change.stepId);
          break;
        }
        if (parent?.kind === "parallel" && parent.deadline === node.id) {
          fail(`${number} removes ${name}, which is the deadline of its parallel group, and the group would then have nothing to end it.`, change.stepId);
          break;
        }
        if ((parent?.kind === "parallel" || parent?.kind === "sequence") && slot.list.length === 1) {
          fail(`${number} removes ${name}, the only step in its ${parent.kind} group, and a group needs at least one.`, change.stepId);
          break;
        }
        if (parent === null && slot.list.length === 1) {
          fail(`${number} removes ${name}, the only step left in the auto, and an auto needs at least one.`, change.stepId);
          break;
        }
        slot.list.splice(slot.index, 1);
        removed.add(node.id);
        break;
      }
      case "addPath": {
        const id = newId();
        const node: ProjectionStep = {
          id,
          kind: "path",
          ...(change.timeoutS === undefined ? {} : { timeoutS: change.timeoutS }),
          segments: clone(change.segments),
          heading: clone(change.heading),
          ...(change.speedFraction === undefined ? {} : { speedFraction: change.speedFraction }),
          ...(change.markers === undefined ? {} : { markers: clone(change.markers) }),
          ...(change.endCondition === undefined ? {} : { endCondition: clone(change.endCondition) }),
        };
        if (place(node, change.afterStepId)) addedIds.set(index, id);
        else next -= 1;
        break;
      }
      case "reorder": {
        const slot = find(change.stepId);
        if (slot === null) break;
        if (change.newIndex >= slot.list.length) {
          fail(
            `${number} moves ${naming.step(change.stepId)} to index ${String(change.newIndex)}, but its list has only ${slot.list.length === 1 ? "1 step" : `${String(slot.list.length)} steps`}, so the last index is ${String(slot.list.length - 1)}.`,
            change.stepId,
          );
          break;
        }
        const [node] = slot.list.splice(slot.index, 1);
        if (node !== undefined) slot.list.splice(change.newIndex, 0, node);
        break;
      }
      case "setEnvelope": {
        const slot = find(change.stepId);
        if (slot === null) break;
        if (!RUNS.has(slot.node.kind)) {
          fail(
            `${number} gives ${naming.step(change.stepId)} an envelope, but it is a ${slot.node.kind} step; only a path, command or wait step can carry one.`,
            change.stepId,
          );
        }
        break;
      }
    }
  }

  return { structure, failures, addedIds };
}

/**
 * The token findings of a set of changes against the share's structure: a token the share did not
 * hold, and a token that the changes leave held in two places, which is a copy rather than a move.
 * `preview` is the structure after those same changes.
 */
export function tokenFindings(
  base: ProjectionStructure,
  changes: readonly ProposalChange[],
  indexes: readonly number[],
  preview: Preview,
  naming: Naming,
): ProposalFinding[] {
  const held = new Set(tokensIn(base.steps));
  const findings: ProposalFinding[] = [];
  const counts = new Map<string, number>();
  for (const token of tokensIn(preview.structure.steps)) counts.set(token, (counts.get(token) ?? 0) + 1);
  for (const index of indexes) {
    const change = changes[index];
    if (change === undefined) continue;
    const target = targetOf(change);
    const stepId = target === null || change.op === "insertWait" || change.op === "addPath" ? "(proposal)" : naming.stepId(target);
    const number = `Change ${String(index + 1)}`;
    for (const token of tokensPlacedBy(change)) {
      if (!held.has(token)) {
        findings.push({
          severity: "error",
          stepId,
          code: "PROPOSAL_TOKEN",
          message: `${number} holds ${token}, a token the share did not hold; a proposal can only move the share's own tokens.`,
          changeIndex: index,
        });
        continue;
      }
      if (preview.failures.has(index)) continue;
      if ((counts.get(token) ?? 0) > 1) {
        findings.push({
          severity: "error",
          stepId,
          code: "PROPOSAL_TOKEN",
          message: `${number} places ${naming.token(token)}, which is still held where the share had it, so it would run twice; a token can be moved, by removing or changing the step that holds it, but not copied.`,
          changeIndex: index,
        });
      }
    }
  }
  return findings;
}
