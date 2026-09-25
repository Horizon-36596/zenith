import { childLists, type Auto, type Pose, type PoseSource, type Step } from "@horizon36596/zenith-schema";
import { childPrefix, effectiveId } from "./edit/ids.js";
import type { AutoDiff, AutoDiffChange, Estimate, PoseDelta } from "./types.js";

/**
 * The step-level structural diff two versions of a routine are reviewed through
 * (site/docs/github.md).
 *
 * It is keyed on step id, not on position, because a review wants to say "the second volley moved
 * two inches" rather than "eleven lines changed". A step without an id in the file is keyed on its
 * position in the list it sits in, exactly as `resolve` names it, so the two views agree.
 *
 * Both functions are pure and deterministic: the same pair of documents always gives the same
 * changes in the same order, which is what lets a bot rewrite one comment in place.
 */

/** A step, and where it sits in the document. */
interface Entry {
  id: string;
  step: Step;
  /** The list the step is a member of: `steps`, or `<owner id>.steps`, `.then`, `.else`. */
  list: string;
  /** Its position in that list. */
  index: number;
  /** Its position in a walk of the whole document, which is the order changes are reported in. */
  order: number;
}

const CHILD_LISTS = ["steps", "then", "else"] as const;

/**
 * The child lists of a step, each with the id prefix `resolve` gives its members.
 *
 * The prefix comes from `childPrefix`, the one definition of it: a branch with both arms numbers
 * them (`b.1.`, `b.2.`) and one with only a `then` does not. Naming the two arms alike gave two
 * different steps the id `b.1`, and review mode then anchored both changes to the same step, so one
 * change hid the other.
 */
const childrenOf = (step: Step, id: string): { list: string; prefix: string; steps: readonly Step[] }[] => {
  const lists = childLists(step);
  return lists.map((list, index) => ({
    list: step.kind === "branch" ? (index === 0 ? "then" : "else") : "steps",
    prefix: childPrefix(id, lists.length, index),
    steps: list,
  }));
};

/** Walks the whole step tree in document order, naming every step the way `resolve` names it. */
export function walkSteps(steps: readonly Step[]): Entry[] {
  const entries: Entry[] = [];
  const visit = (list: readonly Step[], listName: string, prefix: string): void => {
    list.forEach((step, index) => {
      const id = effectiveId(step, index, prefix);
      entries.push({ id, step, list: listName, index, order: entries.length });
      for (const child of childrenOf(step, id)) {
        visit(child.steps, `${id}.${child.list}`, child.prefix);
      }
    });
  };
  visit(steps, "steps", "step");
  return entries;
}

/** The keys of a step that are its own content, rather than the steps nested inside it. */
const contentKeys = (step: Step): string[] =>
  Object.keys(step).filter(
    (key) => key !== "id" && !(CHILD_LISTS as readonly string[]).includes(key),
  );

/** Deep equality over the plain JSON a step is made of. Key order does not count as a difference. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) if (!sameValue(left[key], right[key])) return false;
  return true;
}

const isPose = (source: PoseSource | undefined): source is Pose =>
  typeof source === "object" && source !== null && "xIn" in source;

/** The short way round, so a heading that crossed pi does not read as a six-radian turn. */
const wrapRad = (radians: number): number => {
  const wrapped = ((radians + Math.PI) % (2 * Math.PI)) - Math.PI;
  return wrapped <= -Math.PI ? wrapped + 2 * Math.PI : wrapped;
};

function poseDelta(
  where: string,
  before: PoseSource | undefined,
  after: PoseSource | undefined,
): PoseDelta | null {
  if (!isPose(before) || !isPose(after)) return null;
  const dxIn = after.xIn - before.xIn;
  const dyIn = after.yIn - before.yIn;
  const dHeadingRad =
    before.headingRad === undefined || after.headingRad === undefined
      ? null
      : wrapRad(after.headingRad - before.headingRad);
  if (dxIn === 0 && dyIn === 0 && (dHeadingRad === null || dHeadingRad === 0)) return null;
  return { where, dxIn, dyIn, dHeadingRad, distanceIn: Math.hypot(dxIn, dyIn) };
}

/** Every pose that moved between two versions of a path step, named by where it sits. */
export function poseDeltas(before: Step, after: Step): PoseDelta[] {
  if (before.kind !== "path" || after.kind !== "path") return [];
  const deltas: PoseDelta[] = [];
  const count = Math.min(before.segments.length, after.segments.length);
  for (let index = 0; index < count; index += 1) {
    const from = before.segments[index];
    const to = after.segments[index];
    if (from === undefined || to === undefined) continue;
    const at = `segments[${String(index)}]`;
    for (const end of ["from", "to"] as const) {
      const delta = poseDelta(`${at}.${end}`, from[end], to[end]);
      if (delta !== null) deltas.push(delta);
    }
    if (from.kind === "bezier" && to.kind === "bezier") {
      const controls = Math.min(from.control.length, to.control.length);
      for (let point = 0; point < controls; point += 1) {
        const delta = poseDelta(
          `${at}.control[${String(point)}]`,
          from.control[point],
          to.control[point],
        );
        if (delta !== null) deltas.push(delta);
      }
    }
  }
  return deltas;
}

/** Inches to two places, without the trailing zeroes that make a table hard to read. */
const inches = (value: number): string => {
  const fixed = value.toFixed(2);
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
};

/** One sentence saying what happened to a step, which is what a reviewer reads first. */
function summarise(
  change: Omit<AutoDiffChange, "summary">,
  before: Step | null,
  after: Step | null,
): string {
  const kindOf = (step: Step | null): string => step?.kind ?? "step";
  switch (change.kind) {
    case "added":
      return `A ${kindOf(after)} step was added at position ${String((change.toIndex ?? 0) + 1)}.`;
    case "removed":
      return `The ${kindOf(before)} step at position ${String((change.fromIndex ?? 0) + 1)} was removed.`;
    case "moved":
      return `The ${kindOf(after)} step moved from position ${String((change.fromIndex ?? 0) + 1)} to position ${String((change.toIndex ?? 0) + 1)}.`;
    default: {
      const fields = change.fields ?? [];
      const moved = change.poseDeltas ?? [];
      const furthest = moved.reduce<PoseDelta | null>(
        (best, delta) => (best === null || delta.distanceIn > best.distanceIn ? delta : best),
        null,
      );
      const named =
        fields.length <= 1
          ? `Its ${fields[0] ?? "content"} changed`
          : `Its ${fields.slice(0, -1).join(", ")} and ${String(fields[fields.length - 1])} changed`;
      const tail =
        furthest === null
          ? "."
          : `, and ${moved.length === 1 ? "one pose" : `${String(moved.length)} poses`} moved, the furthest by ${inches(furthest.distanceIn)} in.`;
      return `${named}${tail}`;
    }
  }
}

/** The document's own fields, in the order the schema declares them. */
const HEADER_KEYS = [
  "name",
  "title",
  "description",
  "robot",
  "field",
  "alliance",
  "authors",
  "created",
  "start",
] as const;

/** The step-level structural diff between two routines. */
export function diff(a: Auto, b: Auto): AutoDiff {
  const before = walkSteps(a.steps);
  const after = walkSteps(b.steps);
  const beforeById = new Map(before.map((entry) => [entry.id, entry]));
  const afterById = new Map(after.map((entry) => [entry.id, entry]));
  const changes: AutoDiffChange[] = [];

  for (const entry of before) {
    if (afterById.has(entry.id)) continue;
    changes.push({
      kind: "removed",
      stepId: entry.id,
      fromIndex: entry.index,
      summary: summarise(
        { kind: "removed", stepId: entry.id, fromIndex: entry.index },
        entry.step,
        null,
      ),
    });
  }

  for (const entry of after) {
    const old = beforeById.get(entry.id);
    if (old === undefined) {
      changes.push({
        kind: "added",
        stepId: entry.id,
        toIndex: entry.index,
        summary: summarise(
          { kind: "added", stepId: entry.id, toIndex: entry.index },
          null,
          entry.step,
        ),
      });
      continue;
    }

    const fields = [...new Set([...contentKeys(old.step), ...contentKeys(entry.step)])].filter(
      (key) =>
        !sameValue(
          (old.step as unknown as Record<string, unknown>)[key],
          (entry.step as unknown as Record<string, unknown>)[key],
        ),
    );
    if (fields.length > 0) {
      const deltas = poseDeltas(old.step, entry.step);
      const change: AutoDiffChange = {
        kind: "changed",
        stepId: entry.id,
        summary: "",
        fields,
        ...(deltas.length > 0 ? { poseDeltas: deltas } : {}),
        fromIndex: old.index,
        toIndex: entry.index,
      };
      change.summary = summarise(change, old.step, entry.step);
      changes.push(change);
    }
    if (old.list !== entry.list || old.index !== entry.index) {
      const change: AutoDiffChange = {
        kind: "moved",
        stepId: entry.id,
        summary: "",
        fromIndex: old.index,
        toIndex: entry.index,
      };
      change.summary =
        old.list === entry.list
          ? summarise(change, old.step, entry.step)
          : `The ${entry.step.kind} step moved out of ${old.list} and into ${entry.list}.`;
      changes.push(change);
    }
  }

  // Document order in the new file, so a review reads top to bottom. A removed step keeps the place
  // it held in the old one, just ahead of whatever now stands there.
  const orderOf = (change: AutoDiffChange): number => {
    const now = afterById.get(change.stepId);
    if (now !== undefined) return now.order;
    return (beforeById.get(change.stepId)?.order ?? 0) - 0.5;
  };
  changes.sort((left, right) => orderOf(left) - orderOf(right));

  const header = HEADER_KEYS.filter(
    (key) =>
      !sameValue(
        (a as unknown as Record<string, unknown>)[key],
        (b as unknown as Record<string, unknown>)[key],
      ),
  ).map((key) => String(key));

  return { changes, header, identical: changes.length === 0 && header.length === 0 };
}

const seconds = (value: number | null | undefined): string =>
  value === null || value === undefined ? "unknown" : value.toFixed(2);

const signed = (value: number, places = 2): string =>
  `${value >= 0 ? "+" : "-"}${Math.abs(value).toFixed(places)}`;

/** The estimate change for one step, or null when neither side has one to compare. */
function deltaS(stepId: string, a: Estimate | undefined, b: Estimate | undefined): string | null {
  const before = a?.byStepId[stepId]?.nominalS;
  const after = b?.byStepId[stepId]?.nominalS;
  if (before === undefined && after === undefined) return null;
  if (before === undefined || before === null || after === undefined || after === null) {
    return `${seconds(before)} s to ${seconds(after)} s`;
  }
  return `${before.toFixed(2)} s to ${after.toFixed(2)} s (${signed(after - before)} s)`;
}

/**
 * The diff as markdown, for a pull request comment or the CLI. Passing the two estimates adds what
 * the change costs in seconds, which is usually the question being asked.
 */
export function diffToMarkdown(
  autoDiff: AutoDiff,
  estimateA?: Estimate,
  estimateB?: Estimate,
): string {
  const lines: string[] = [];

  if (autoDiff.identical) {
    lines.push("No structural changes.");
  } else {
    if (autoDiff.header.length > 0) {
      lines.push(`Header: ${autoDiff.header.join(", ")} changed.`, "");
    }
    for (const change of autoDiff.changes) {
      const cost = deltaS(change.stepId, estimateA, estimateB);
      lines.push(
        `- \`${change.stepId}\` ${change.kind}. ${change.summary}${cost === null ? "" : ` Estimate ${cost}.`}`,
      );
      for (const delta of change.poseDeltas ?? []) {
        const heading =
          delta.dHeadingRad === null || delta.dHeadingRad === 0
            ? ""
            : `, heading ${signed((delta.dHeadingRad * 180) / Math.PI, 1)} degrees`;
        lines.push(
          `  - \`${delta.where}\` moved ${inches(delta.distanceIn)} in (x ${signed(delta.dxIn)}, y ${signed(delta.dyIn)}${heading}).`,
        );
      }
    }
  }

  if (estimateA !== undefined && estimateB !== undefined) {
    const before = estimateA.nominalS;
    const after = estimateB.nominalS;
    const change = before === null || after === null ? null : after - before;
    lines.push(
      "",
      `Total: ${seconds(before)} s to ${seconds(after)} s${change === null ? "" : ` (${signed(change)} s)`}.`,
    );
  }

  return lines.join("\n").trim();
}
