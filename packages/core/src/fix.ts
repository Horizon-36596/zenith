import {
  childLists,
  withChildLists,
  type Auto,
  type Heading,
  type Pose,
  type Segment,
  type Step,
} from "@horizon36596/zenith-schema";
import { childPrefix, effectiveId } from "./edit/ids.js";
import type { Fix } from "./types.js";

/**
 * The one-click fixes of site/docs/editor.md, as a pure function over the
 * document: `applyFix(auto, fix)` returns a new `Auto` and leaves the one it was given alone, so
 * the editor's undo stack stays a stack of canonical strings and an agent can apply a fix through
 * the MCP server without hand-editing JSON.
 *
 * A fix that cannot be carried out (a step id that is not there, a segment index past the end)
 * returns the document unchanged rather than throwing: a finding can go stale while its button is
 * still on screen.
 */

type PathStep = Extract<Step, { kind: "path" }>;

const isPath = (step: Step): step is PathStep => step.kind === "path";

/**
 * Rewrites one step wherever it sits, including inside a parallel group or a branch.
 *
 * Steps are addressed by their effective id (`edit/ids.ts`), the same positional name a finding
 * carries: matching on the raw `id` field made every fix on a step without an explicit id a silent
 * no-op, because the finding said `step1` and the field said nothing.
 */
function mapStep(
  steps: readonly Step[],
  stepId: string,
  rewrite: (step: Step) => Step,
  prefix = "step",
): Step[] {
  return steps.map((step, index) => {
    const id = effectiveId(step, index, prefix);
    if (id === stepId) return rewrite(step);
    const lists = childLists(step);
    if (lists.length === 0) return step;
    return withChildLists(
      step,
      lists.map((list, listIndex) =>
        mapStep(list, stepId, rewrite, childPrefix(id, lists.length, listIndex)),
      ),
    );
  });
}

/** The path step immediately before this one in the list that holds it, if there is one. */
function previousPathId(steps: readonly Step[], stepId: string, prefix = "step"): string | null {
  for (const [index, step] of steps.entries()) {
    const id = effectiveId(step, index, prefix);
    if (id === stepId) {
      for (let before = index - 1; before >= 0; before -= 1) {
        const candidate = steps[before];
        if (candidate !== undefined && isPath(candidate)) {
          return effectiveId(candidate, before, prefix);
        }
      }
      return null;
    }
    const branches = childLists(step);
    for (const [branchIndex, branch] of branches.entries()) {
      const nested = previousPathId(
        branch,
        stepId,
        childPrefix(id, branches.length, branchIndex),
      );
      if (nested !== null) return nested;
    }
  }
  return null;
}

/** The heading a step holds as it begins, when the mode says so without needing the geometry. */
function startHeadingOf(heading: Heading | undefined): number | null {
  if (heading === undefined) return null;
  if (heading.mode === "constant") return heading.headingRad;
  if (heading.mode === "linear") return heading.fromRad;
  if (heading.mode === "piecewise") {
    const first = heading.ranges[0];
    return first === undefined ? null : startHeadingOf(first.heading);
  }
  return null;
}

/** de Casteljau subdivision: the control polygons of the two halves of a Bezier split at `u`. */
export function splitControlPolygon(
  points: readonly { xIn: number; yIn: number }[],
  u: number,
): { left: { xIn: number; yIn: number }[]; right: { xIn: number; yIn: number }[] } {
  const left: { xIn: number; yIn: number }[] = [];
  const right: { xIn: number; yIn: number }[] = [];
  let level = points.map((point) => ({ xIn: point.xIn, yIn: point.yIn }));
  while (level.length > 0) {
    left.push(level[0] as { xIn: number; yIn: number });
    right.unshift(level[level.length - 1] as { xIn: number; yIn: number });
    const next: { xIn: number; yIn: number }[] = [];
    for (let i = 0; i + 1 < level.length; i += 1) {
      const a = level[i] as { xIn: number; yIn: number };
      const b = level[i + 1] as { xIn: number; yIn: number };
      next.push({ xIn: a.xIn + (b.xIn - a.xIn) * u, yIn: a.yIn + (b.yIn - a.yIn) * u });
    }
    level = next;
  }
  return { left, right };
}

/** The control polygon a segment draws, which needs the poses its ends resolved to. */
function segmentPoints(
  segment: Segment,
  fromIn: { xIn: number; yIn: number },
  toIn: { xIn: number; yIn: number },
): { xIn: number; yIn: number }[] {
  const controls = segment.kind === "bezier" ? segment.control : [];
  return [fromIn, ...controls.map((point) => ({ xIn: point.xIn, yIn: point.yIn })), toIn];
}

/** The inline pose a `from`/`to` already names, or null when it is a reference or `"current"`. */
function inlinePoint(source: Segment["from"]): { xIn: number; yIn: number } | null {
  if (source === "current" || "ref" in source) return null;
  return { xIn: source.xIn, yIn: source.yIn };
}

function splitSegment(step: PathStep, segmentIndex: number, u: number): PathStep {
  const segment = step.segments[segmentIndex];
  if (segment === undefined || u <= 0 || u >= 1) return step;
  const fromIn = inlinePoint(segment.from);
  const toIn = inlinePoint(segment.to);
  if (fromIn === null || toIn === null) {
    // Splitting needs both ends as numbers. A `"current"` or a waypoint reference has to be
    // resolved first, which is the caller's job, not a guess made here.
    return step;
  }
  const { left, right } = splitControlPolygon(segmentPoints(segment, fromIn, toIn), u);
  const middle = left[left.length - 1] as { xIn: number; yIn: number };
  const middlePose: Pose = { xIn: middle.xIn, yIn: middle.yIn };

  const half = (
    polygon: readonly { xIn: number; yIn: number }[],
    from: Segment["from"],
    to: Segment["to"],
  ): Segment => {
    const controls = polygon.slice(1, -1);
    if (controls.length === 0) return { kind: "line", from, to };
    return { kind: "bezier", from, control: controls.map((point) => ({ ...point })), to };
  };

  const segments = [
    ...step.segments.slice(0, segmentIndex),
    half(left, segment.from, middlePose),
    half(right, middlePose, segment.to),
    ...step.segments.slice(segmentIndex + 1),
  ];
  return { ...step, segments };
}

/** Applies one structured fix to a document and hands back a new one. Pure. */
export function applyFix(auto: Auto, fix: Fix): Auto {
  switch (fix.kind) {
    case "makeTangent": {
      const mode: Heading = {
        mode: fix.params.reversed === true ? "tangentReversed" : "tangent",
      };
      return {
        ...auto,
        steps: mapStep(auto.steps, fix.stepId, (step) =>
          isPath(step) ? { ...step, heading: mode } : step,
        ),
      };
    }

    case "turnAtPreviousStop": {
      // The turn is cheapest where the robot is already standing still, so it moves into the leg
      // before this one and this leg goes back to driving nose-first (`03` section 5).
      const turnIn = fix.params.turnInStepId ?? previousPathId(auto.steps, fix.stepId);
      let steps = mapStep(auto.steps, fix.stepId, (step) =>
        isPath(step) ? { ...step, heading: { mode: "tangent" } } : step,
      );
      if (turnIn !== null) {
        steps = mapStep(steps, turnIn, (step) => {
          if (!isPath(step)) return step;
          const fromRad = fix.params.fromRad ?? startHeadingOf(step.heading) ?? fix.params.headingRad;
          return { ...step, heading: { mode: "linear", fromRad, toRad: fix.params.headingRad } };
        });
      }
      return { ...auto, steps };
    }

    case "slowSweep":
      return {
        ...auto,
        steps: mapStep(auto.steps, fix.stepId, (step) =>
          isPath(step) ? { ...step, speedFraction: fix.params.speedFraction } : step,
        ),
      };

    case "moveToLegalApproach":
      return {
        ...auto,
        steps: mapStep(auto.steps, fix.stepId, (step) => {
          if (!isPath(step)) return step;
          const last = step.segments[step.segments.length - 1];
          if (last === undefined) return step;
          const existing = inlinePoint(last.to);
          const headingRad =
            fix.params.headingRad ??
            (last.to === "current" || "ref" in last.to ? undefined : last.to.headingRad);
          void existing;
          const to: Pose = {
            xIn: fix.params.xIn,
            yIn: fix.params.yIn,
            ...(headingRad === undefined ? {} : { headingRad }),
          };
          return {
            ...step,
            segments: [...step.segments.slice(0, -1), { ...last, to }],
          };
        }),
      };

    case "splitSegment":
      return {
        ...auto,
        steps: mapStep(auto.steps, fix.stepId, (step) =>
          isPath(step) ? splitSegment(step, fix.params.segmentIndex, fix.params.u ?? 0.5) : step,
        ),
      };
  }
}

/** Applies several fixes in order. Each one sees the document the one before it produced. */
export const applyFixes = (auto: Auto, fixes: readonly Fix[]): Auto =>
  fixes.reduce((current, fix) => applyFix(current, fix), auto);
