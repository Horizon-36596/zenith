import type { Heading, HeadingRange, PathStep } from "@horizon36596/zenith-schema";
import { formatNumber } from "../canonicalize.js";
import { angleDelta } from "../geometry/angle.js";
import type { PathGeometry } from "../geometry/path.js";
import { headingFunction, rangeHeadingFunction } from "../heading.js";
import { MIN_RANGE_T } from "../headingRanges.js";
import { END_HEADING_TOLERANCE_RAD, stepGeometry, type CandidateRange, type RouteEnds } from "./candidate.js";

/**
 * The heading holds of Optimize path (issue #448): "hold the start heading for the first N in" and
 * "hold the end heading for the last N in". A hold is a constraint the person gives the optimizer, in
 * inches of the route's own arc length, and 0 is off.
 *
 * - **Every candidate respects them.** `withHolds` writes them into each heading seed the search
 *   builds, and `headingHoldProblem` refuses, at emit, any route the search moves off them, so no
 *   route that breaks a hold is ever scored.
 * - **The hard final check enforces them** (section 4.4 step 3), with the same `headingHoldProblem`.
 *
 * Pure (CLAUDE.md rule 1).
 */

/** What the person asked the heading to hold, in inches of arc length; 0 is off. */
export interface HeadingHolds {
  /** Hold the arrival heading, S's, over the first this many inches of the route. */
  startIn: number;
  /** Hold E's heading over the last this many inches of the route. */
  endIn: number;
}

/** No holds: the default, which changes nothing the search does. */
export const NO_HOLDS: HeadingHolds = { startIn: 0, endIn: 0 };

/** True when either hold is on. */
export const holdsActive = (holds: HeadingHolds): boolean => holds.startIn > 0 || holds.endIn > 0;

/**
 * Arithmetic slack on a hold's length, in inches (SPEC: canonical inch resolution), so a range end
 * written on four decimals of t that falls a hair inside the hold is not refused for rounding.
 */
export const HOLD_SLACK_IN = 0.001;

/** The spacing the hold is tested at along the route, in inches (SPEC: `FINAL_SAMPLE_SPACING_IN`, the final check's own). */
const HOLD_TEST_SPACING_IN = 0.5;

/** Arithmetic slack when a t is rounded to four decimals, in 1e-4 steps. It is not a tolerance. */
const ROUNDING_SLACK = 1e-6;

const inches = (value: number): string => `${formatNumber(Math.round(value * 1000) / 1000, 3)} in`;

/** The words for the holds that are on, for a sentence: "its start heading over the first 12 in". */
export function holdWords(holds: HeadingHolds): string {
  const parts: string[] = [];
  if (holds.startIn > 0) parts.push(`its start heading over the first ${inches(holds.startIn)}`);
  if (holds.endIn > 0) parts.push(`its end heading over the last ${inches(holds.endIn)}`);
  return parts.join(" and ");
}

/** The t where the start hold ends and the end hold starts on a route, rounded outward to the four decimals ranges are written on. */
export function holdSpan(geometry: PathGeometry, holds: HeadingHolds): { startT: number; endT: number } {
  const lengthIn = geometry.lengthIn;
  if (lengthIn <= 0) return { startT: 0, endT: 1 };
  // The slack keeps float noise, such as 10 / 100 * 10000 = 1000.0000000000001, from rounding a whole step outward.
  const startT = holds.startIn > 0 ? Math.min(1, Math.ceil((holds.startIn / lengthIn) * 10000 - ROUNDING_SLACK) / 10000) : 0;
  const endT = holds.endIn > 0 ? Math.max(0, Math.floor((1 - holds.endIn / lengthIn) * 10000 + ROUNDING_SLACK) / 10000) : 1;
  return { startT, endT };
}

/**
 * Why a heading breaks the holds on this route, in a sentence, or null when it keeps them. The
 * heading must stay within `END_HEADING_TOLERANCE_RAD` of the arrival heading over the first
 * `startIn` and of E's over the last `endIn`, tested every 0.5 in and at each hold's own end, and
 * it must not jump at a range boundary at or inside a hold, which the hold's end is: a constant hold
 * beside a tangent range on a bend would jump there. The holds may not overlap: a route shorter
 * than both together keeps neither, unless its two ends face the same way, when one heading held
 * from end to end keeps both and the per-hold tests decide.
 */
export function headingHoldProblem(heading: Heading, geometry: PathGeometry, ends: RouteEnds, holds: HeadingHolds): string | null {
  if (!holdsActive(holds)) return null;
  const lengthIn = geometry.lengthIn;
  const endsAgree = Math.abs(angleDelta(ends.arrivalHeadingRad, ends.endHeadingRad)) <= END_HEADING_TOLERANCE_RAD;
  if (!endsAgree && holds.startIn + holds.endIn > lengthIn + HOLD_SLACK_IN) {
    return `The route is ${inches(lengthIn)} long, shorter than the heading holds together (${inches(holds.startIn + holds.endIn)}).`;
  }
  const at = headingFunction(heading, geometry);
  const breaks = (fromIn: number, toIn: number, wantRad: number): boolean => {
    if (toIn <= fromIn) return false;
    for (let sIn = fromIn; ; sIn = Math.min(toIn, sIn + HOLD_TEST_SPACING_IN)) {
      if (Math.abs(angleDelta(at(geometry.tAtDistance(sIn)), wantRad)) > END_HEADING_TOLERANCE_RAD) return true;
      if (sIn >= toIn) return false;
    }
  };
  if (holds.startIn > 0 && breaks(0, Math.min(lengthIn, holds.startIn - HOLD_SLACK_IN), ends.arrivalHeadingRad)) {
    return `The heading turns within the first ${inches(holds.startIn)} of the route, where it must hold the start heading.`;
  }
  if (holds.endIn > 0 && breaks(Math.max(0, lengthIn - holds.endIn + HOLD_SLACK_IN), lengthIn, ends.endHeadingRad)) {
    return `The heading is not E's over the last ${inches(holds.endIn)} of the route, where it must hold the end heading.`;
  }
  if (heading.mode === "piecewise") {
    const { startT, endT } = holdSpan(geometry, holds);
    for (let index = 0; index + 1 < heading.ranges.length; index += 1) {
      const range = heading.ranges[index] as HeadingRange;
      const inStart = holds.startIn > 0 && range.endT <= startT + ROUNDING_SLACK;
      const inEnd = holds.endIn > 0 && range.endT >= endT - ROUNDING_SLACK;
      if (!inStart && !inEnd) continue;
      const before = rangeHeadingFunction(range, geometry)(range.endT);
      const after = rangeHeadingFunction(heading.ranges[index + 1] as HeadingRange, geometry)(range.endT);
      if (Math.abs(angleDelta(before, after)) > END_HEADING_TOLERANCE_RAD) {
        return `The heading jumps ${inches(geometry.distanceAt(range.endT))} along the route, where the ${inStart ? "start" : "end"} heading hold meets the next range.`;
      }
    }
  }
  return null;
}

/** `headingHoldProblem` for an emitted path step over its own geometry. */
export function stepHoldProblem(step: PathStep, ends: RouteEnds, holds: HeadingHolds): string | null {
  if (!holdsActive(holds)) return null;
  if (step.heading === undefined) return "The step has no heading, so it holds none.";
  const geometry = stepGeometry(step, ends);
  if (typeof geometry === "string") return geometry;
  return headingHoldProblem(step.heading, geometry, ends, holds);
}

/** True for the two modes whose heading is the route's own tangent, absolute in t. */
const followsTangent = (mode: CandidateRange["mode"]): mode is "tangent" | "tangentReversed" =>
  mode === "tangent" || mode === "tangentReversed";

/**
 * A heading seed with the holds written in: the arrival heading held constant up to the start
 * hold's end, then the seed's own ranges fitted into what is left by scaling their ends, then E's
 * heading held constant over the end hold. Each range keeps its mode, so a tangent stretch is still
 * a tangent stretch.
 *
 * The heading stays continuous at both holds. A linear first range starts on the arrival heading,
 * which the start hold holds, and a linear last range now ends on E's, which the end hold holds. A
 * tangent range is absolute in t, so beside a hold on a bend it would jump: the tangent at the start
 * hold's end is not the tangent at 0 the seed was fitted to, and the tangent where the end hold
 * starts is not E's. There a linear range is put between the hold and the tangent range, as wide as
 * that hold and never narrower than `MIN_RANGE_T`, so it turns through the bend over about the
 * stretch of route the tangent took to bend that far.
 *
 * Null when the holds leave no room for the seed between them (`MIN_RANGE_T`). With no holds the
 * seed is returned as it is.
 */
export function withHolds(
  ranges: readonly CandidateRange[],
  geometry: PathGeometry,
  ends: RouteEnds,
  holds: HeadingHolds,
): CandidateRange[] | null {
  if (!holdsActive(holds)) return [...ranges];
  const { startT, endT } = holdSpan(geometry, holds);
  const width = endT - startT;
  // The holds meet or leave no room: only one heading held from end to end can keep both.
  if (width < MIN_RANGE_T - 1e-12) {
    return Math.abs(angleDelta(ends.arrivalHeadingRad, ends.endHeadingRad)) <= END_HEADING_TOLERANCE_RAD ? [{ mode: "constant", endT: 1 }] : null;
  }
  const out: CandidateRange[] = startT > 0 ? [{ mode: "constant", endT: startT }] : [];
  for (const [index, range] of ranges.entries()) {
    const last = index === ranges.length - 1;
    const end = last ? endT : Math.round((startT + range.endT * width) * 10000) / 10000;
    const previousEnd = out.length === 0 ? 0 : (out[out.length - 1] as CandidateRange).endT;
    if (end - previousEnd < MIN_RANGE_T - 1e-12) return null;
    // A constant range right after the start hold holds the same heading, so the two are one.
    if (range.mode === "constant" && out[out.length - 1]?.mode === "constant") {
      out[out.length - 1] = { mode: "constant", endT: end };
      continue;
    }
    // The seed's last range ended on E's heading by being last; followed by the end hold, it says so.
    out.push(last && endT < 1 && range.mode === "linear" ? { mode: "linear", endT: end, endHeadingRad: ends.endHeadingRad } : { ...range, endT: end });
  }
  const tangentAt = (mode: "tangent" | "tangentReversed"): ((t: number) => number) => headingFunction({ mode }, geometry);
  // Range ends in 1e-4 steps, the four decimals they are written on, so the sums below are exact.
  const units = (t: number): number => Math.round(t * 10000);
  const minUnits = units(MIN_RANGE_T);
  // The start hold, then a tangent range that would start off the arrival heading: turn onto it first.
  const held = out[0];
  const afterStart = out[1];
  if (held?.mode === "constant" && held.endT === startT && startT > 0 && afterStart !== undefined && followsTangent(afterStart.mode)) {
    if (Math.abs(angleDelta(tangentAt(afterStart.mode)(startT), ends.arrivalHeadingRad)) > END_HEADING_TOLERANCE_RAD) {
      const turnEnd = units(startT) + Math.max(minUnits, units(startT));
      if (units(afterStart.endT) - turnEnd < minUnits) return null;
      out.splice(1, 0, { mode: "linear", endT: turnEnd / 10000 });
    }
  }
  if (endT < 1) {
    // A tangent range that would end off E's heading, then the end hold: turn into E's heading first.
    const beforeEnd = out[out.length - 1];
    if (beforeEnd !== undefined && followsTangent(beforeEnd.mode)) {
      if (Math.abs(angleDelta(tangentAt(beforeEnd.mode)(endT), ends.endHeadingRad)) > END_HEADING_TOLERANCE_RAD) {
        const turnStart = units(endT) - Math.max(minUnits, units(1 - endT));
        const previousEnd = out.length < 2 ? 0 : units((out[out.length - 2] as CandidateRange).endT);
        if (turnStart - previousEnd < minUnits) return null;
        out[out.length - 1] = { mode: beforeEnd.mode, endT: turnStart / 10000 };
        out.push({ mode: "linear", endT, endHeadingRad: ends.endHeadingRad });
      }
    }
    if (out[out.length - 1]?.mode === "constant") (out[out.length - 1] as CandidateRange).endT = 1;
    else out.push({ mode: "constant", endT: 1 });
  }
  return out;
}
