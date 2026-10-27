import {
  childLists,
  withChildLists,
  type Auto,
  type Heading,
  type Pose,
  type Segment,
  type Step,
} from "@horizon36596/zenith-schema";
import { EditError } from "./edit/errors.js";
import { repairContinuity } from "./edit/groups.js";
import { childPrefix, effectiveId } from "./edit/ids.js";
import { setRoute } from "./edit/path.js";
import { renameStep } from "./edit/steps.js";
import { wrapAngle } from "./geometry/angle.js";
import { makeCurve } from "./geometry/curve.js";
import { splitRange } from "./headingRanges.js";
import { EDITOR_PROVENANCE } from "./provenance.js";
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

/**
 * Starts segment `segmentIndex` exactly where the segment before it ends: its `from` becomes a copy
 * of that segment's `to`, a waypoint reference staying a reference, so the two meet and the joint
 * moves as one point from then on (issue #146).
 */
function joinSegment(step: PathStep, segmentIndex: number): PathStep {
  const before = step.segments[segmentIndex - 1];
  const segment = step.segments[segmentIndex];
  if (before === undefined || segment === undefined) return step;
  const from = typeof before.to === "string" ? before.to : { ...before.to };
  return {
    ...step,
    segments: step.segments.map((candidate, index) => (index === segmentIndex ? { ...candidate, from } : candidate)),
  };
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

type SplitParams = Extract<Fix, { kind: "splitSegment" }>["params"];

/**
 * Where to cut a segment, as its own curve parameters, ascending and strictly inside (0, 1): the
 * one `u` (0.5 when left out), or each of `atFractions`, a fraction of the segment's arc length.
 */
function cutParameters(points: readonly { xIn: number; yIn: number }[], params: SplitParams): number[] {
  let cuts: number[];
  if (params.atFractions === undefined) {
    cuts = [params.u ?? 0.5];
  } else {
    const curve = makeCurve(points);
    cuts = params.atFractions.map((fraction) => curve.uAtLength(fraction * curve.lengthIn));
  }
  const inside = cuts.filter((u) => u > 0 && u < 1).sort((a, b) => a - b);
  return inside.filter((u, index) => index === 0 || u - (inside[index - 1] as number) > 1e-9);
}

/**
 * Cuts one segment into pieces that draw exactly the curve it drew (QA-10, issue #186).
 *
 * Splitting needs both ends as numbers. An inline end is its own numbers; a `"current"` or a
 * waypoint end takes the pose it resolved to from `fromIn`/`toIn`, which the caller (the HEADING
 * check, or the editor from the same resolve the canvas draws) fills in, and without them the
 * segment is left alone rather than guessed. Only the cut is made on those numbers: the first piece
 * still starts at the original `from` and the last still ends at the original `to`, so a
 * `"current"` start or a waypoint end survives. Each new point is written as the first piece's `to`
 * and the next one's `from`, so the editor moves it as one joint (issue #146), and carries SET FROM
 * EDITOR, as do the handles a curve's pieces get. The point has no heading of its own: the step's
 * heading mode decides the heading there, so the robot faces where it did before the cut.
 */
function splitSegment(step: PathStep, params: SplitParams): PathStep {
  const segmentIndex = params.segmentIndex;
  const segment = step.segments[segmentIndex];
  if (segment === undefined) return step;
  const fromIn = inlinePoint(segment.from) ?? params.fromIn ?? null;
  const toIn = inlinePoint(segment.to) ?? params.toIn ?? null;
  if (fromIn === null || toIn === null) return step;
  const points = segmentPoints(segment, { xIn: fromIn.xIn, yIn: fromIn.yIn }, { xIn: toIn.xIn, yIn: toIn.yIn });
  const cuts = cutParameters(points, params);
  if (cuts.length === 0) return step;

  // Cut the rest of the curve each time; de Casteljau keeps the parameter affine on each piece.
  const polygons: { xIn: number; yIn: number }[][] = [];
  let rest = points;
  let done = 0;
  for (const u of cuts) {
    const { left, right } = splitControlPolygon(rest, (u - done) / (1 - done));
    polygons.push(left);
    rest = right;
    done = u;
  }
  polygons.push(rest);

  const joints: Pose[] = polygons.slice(0, -1).map((polygon) => {
    const end = polygon[polygon.length - 1] as { xIn: number; yIn: number };
    return { xIn: end.xIn, yIn: end.yIn, provenance: EDITOR_PROVENANCE };
  });
  const pieces: Segment[] = polygons.map((polygon, index) => {
    const from = index === 0 ? segment.from : (joints[index - 1] as Pose);
    const to = index === polygons.length - 1 ? segment.to : (joints[index] as Pose);
    const controls = polygon.slice(1, -1);
    if (controls.length === 0) return { kind: "line", from, to };
    return {
      kind: "bezier",
      from,
      control: controls.map((point) => ({ xIn: point.xIn, yIn: point.yIn, provenance: EDITOR_PROVENANCE })),
      to,
    };
  });

  const segments = [...step.segments.slice(0, segmentIndex), ...pieces, ...step.segments.slice(segmentIndex + 1)];
  return { ...step, segments };
}

/**
 * Cuts range `rangeIndex` of a piecewise heading into `parts` ranges of equal width, through
 * `splitRange` along the written sweep, so a `linear` range is cut at the headings its sweep passes
 * through and each piece turns its share the long way, as the HEADING warning promises (issue #186).
 */
function splitHeadingRange(step: PathStep, rangeIndex: number, parts: number): PathStep {
  const heading = step.heading;
  if (heading?.mode !== "piecewise" || !Number.isInteger(parts) || parts < 2) return step;
  const range = heading.ranges[rangeIndex];
  if (range === undefined) return step;
  let split = heading;
  for (let part = 1; part < parts; part += 1) {
    split = splitRange(split, range.startT + ((range.endT - range.startT) * part) / parts, "sweep");
  }
  // A cut too close to the range's ends for `MIN_RANGE_T` would leave the range as it was.
  if (split.ranges.length !== heading.ranges.length + parts - 1) return step;
  return { ...step, heading: split };
}

/**
 * Moves the end of a step's last segment to (`xIn`, `yIn`) and keeps its heading, when that end is
 * an inline pose (issue #186). A waypoint end is left alone, since moving it would move every path
 * that names it, and so is `"current"`.
 */
function pushEndBack(step: PathStep, xIn: number, yIn: number): PathStep {
  const last = step.segments[step.segments.length - 1];
  if (last === undefined || last.to === "current" || "ref" in last.to) return step;
  const { headingRad } = last.to;
  const to: Pose = { xIn, yIn, ...(headingRad === undefined ? {} : { headingRad }), provenance: EDITOR_PROVENANCE };
  return { ...step, segments: [...step.segments.slice(0, -1), { ...last, to }] };
}

/** Applies one structured fix to a document and hands back a new one. Pure. */
export function applyFix(auto: Auto, fix: Fix): Auto {
  switch (fix.kind) {
    case "joinSegments":
      return {
        ...auto,
        steps: mapStep(auto.steps, fix.stepId, (step) =>
          isPath(step) ? joinSegment(step, fix.params.segmentIndex) : step,
        ),
      };

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

    case "raiseTimeout":
      return {
        ...auto,
        steps: mapStep(auto.steps, fix.stepId, (step) =>
          step.kind === "path" || step.kind === "command" || step.kind === "wait"
            ? { ...step, timeoutS: fix.params.timeoutS }
            : step,
        ),
      };

    case "focusTimeout":
      // The editor puts the cursor in the step's Timeout field; the number is the person's to type.
      return auto;

    case "optimizeRoute":
      // The editor opens Optimize path, aimed at the step; the route is the person's to preview.
      return auto;

    case "replaceRoute":
      // The same edit as `setRoute`. A fix goes stale like any other, so a step that is gone, is
      // not a path, or a route that would move an end leaves the document as it is.
      try {
        return setRoute(auto, fix.stepId, fix.params.segments, fix.params.heading);
      } catch (error) {
        if (error instanceof EditError) return auto;
        throw error;
      }

    case "moveToLegalApproach":
      return {
        ...auto,
        steps: mapStep(auto.steps, fix.stepId, (step) => {
          if (!isPath(step)) return step;
          const last = step.segments[step.segments.length - 1];
          if (last === undefined) return step;
          const headingRad =
            fix.params.headingRad ??
            (last.to === "current" || "ref" in last.to ? undefined : last.to.headingRad);
          // The spot is the editor's, as every pose a one-click fix writes is.
          const to: Pose = {
            xIn: fix.params.xIn,
            yIn: fix.params.yIn,
            ...(headingRad === undefined ? {} : { headingRad }),
            provenance: EDITOR_PROVENANCE,
          };
          return {
            ...step,
            segments: [...step.segments.slice(0, -1), { ...last, to }],
            ...(fix.params.heading === undefined ? {} : { heading: fix.params.heading }),
          };
        }),
      };

    case "splitSegment":
      return {
        ...auto,
        steps: mapStep(auto.steps, fix.stepId, (step) => (isPath(step) ? splitSegment(step, fix.params) : step)),
      };

    case "splitHeadingRange":
      return {
        ...auto,
        steps: mapStep(auto.steps, fix.stepId, (step) =>
          isPath(step) ? splitHeadingRange(step, fix.params.rangeIndex, fix.params.parts) : step,
        ),
      };

    case "startFromCurrent":
      // The same edit as the Steps panel's "Connect the next step" and the MCP server's
      // `zenith.edit.repairContinuity`. A step that is gone, or is not a path, stays as it is.
      try {
        return repairContinuity(auto, fix.stepId);
      } catch (error) {
        if (error instanceof EditError) return auto;
        throw error;
      }

    case "pushBack":
      return {
        ...auto,
        steps: mapStep(auto.steps, fix.stepId, (step) =>
          isPath(step) ? pushEndBack(step, fix.params.xIn, fix.params.yIn) : step,
        ),
      };

    case "linearHeading":
      return {
        ...auto,
        steps: mapStep(auto.steps, fix.stepId, (step) =>
          isPath(step)
            ? { ...step, heading: { mode: "linear", fromRad: fix.params.fromRad, toRad: fix.params.toRad } }
            : step,
        ),
      };

    case "renameStep":
      // The same edit as the Steps panel's rename and `zenith.edit.renameStep`. A step that is gone,
      // or a new id that another step has taken since, leaves the document as it is.
      try {
        return renameStep(auto, fix.stepId, fix.params.newId);
      } catch (error) {
        if (error instanceof EditError) return auto;
        throw error;
      }
  }
}

/** Radians as canonical form writes them, to four decimals, so the fix writes what the file keeps. */
const fourDecimals = (rad: number): number => Math.round(rad * 10_000) / 10_000;

/**
 * The "Turn while driving" fix: a `linear` heading on `stepId` that starts at `fromRad`, the way
 * the robot already faces, and ends at `toRad`, the way the path ends, turning the short way. The
 * robot then turns gradually as it drives instead of on the spot. This is the one builder for the
 * fix; every check that finds a robot turning where it should be driving offers this one.
 */
export function turnWhileDrivingFix(stepId: string, fromRad: number, toRad: number): Fix {
  const from = fourDecimals(fromRad);
  return {
    kind: "linearHeading",
    stepId,
    label: "Turn while driving",
    params: { fromRad: from, toRad: fourDecimals(from + wrapAngle(toRad - from)) },
  };
}

/**
 * The "Start from where the robot is" fix: the step's first segment starts from `"current"`. The
 * one builder for it; CONTINUITY at a step's start, MOVES_ROBOT and the Steps panel's "Connect the
 * next step" all use it (issue #186).
 */
export const startFromCurrentFix = (stepId: string): Fix => ({
  kind: "startFromCurrent",
  stepId,
  label: "Start from where the robot is",
  params: {},
});

/**
 * The "Rename to ..." fix for STEP_ID: `stepId`, an explicit id outside the step id rule, renamed
 * to `newId`, one inside it. The one builder for it.
 */
export const renameStepFix = (stepId: string, newId: string): Fix => ({
  kind: "renameStep",
  stepId,
  label: `Rename to ${newId}`,
  params: { newId },
});

/** Applies several fixes in order. Each one sees the document the one before it produced. */
export const applyFixes = (auto: Auto, fixes: readonly Fix[]): Auto =>
  fixes.reduce((current, fix) => applyFix(current, fix), auto);
