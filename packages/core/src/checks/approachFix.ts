import type { Heading, Robot, Step } from "@horizon36596/zenith-schema";
import { wrapAngle } from "../geometry/angle.js";
import type { Pose, Vec2 } from "../geometry/vec.js";
import { footprintAt, footprintPolygons } from "../footprint.js";
import { convexPolygonsOverlap, polygonOutsideBox } from "../geometry/sat.js";
import { flattenSteps } from "../plan.js";
import type { SeasonRules, SeasonState, TargetId } from "../season.js";
import type { Finding, Fix, Plan, PlanStep } from "../types.js";
import { planWithFix, recheckBaseline, rechecksClean, threeDecimals, type PushContext } from "./pushBack.js";

/**
 * LEGAL_APPROACH's one-click fix, "Move to approach" (0.1.2 UX sweep W2-2): the end of the leg
 * before the shot moves to a spot the season accepts, the robot turns there so the side of it the
 * author pointed at the target still points at it, and the fix is offered only when the auto,
 * checked again with the move, is no worse. The season's nearest legal pose is only where the
 * search starts: the hive frame's bars stand right where its approach band begins, so the nearest
 * pose is often inside one.
 */

/** How far from the season's nearest legal spot the search looks, in inches. */
const SEARCH_RADIUS_IN = 24;
/** The step between rings of candidates, in inches. */
const RING_STEP_IN = 2;
/** Candidates on each ring. */
const RING_POINTS = 16;
/** The most candidates kept after the cheap test of the robot standing at each, nearest the shot first. */
const MAX_CANDIDATES = 24;
/**
 * The most moves the auto is planned again for, to see what it runs into, over every candidate and
 * heading; and the most of those that pass it is checked again as a whole for. `check()` runs on
 * every frame of a drag in the editor, so these bound what the fix can cost there (the PR for the
 * 0.1.2 UX sweep fixes, #478, has the numbers).
 */
const MAX_RECHECKS = 3;
const MAX_WHOLE_CHECKS = 2;
/** How far the target may sit from where the author had it, relative to the robot, and still count as kept, in radians. */
const AIM_TOLERANCE_RAD = (2 * Math.PI) / 180;
/** How much deeper or nearer a finding the auto already has may get before a spot counts as worse, in inches. */
const WORSE_IN = 0.01;

/** Radians as canonical form writes them, to four decimals. */
const fourDecimals = (rad: number): number => Math.round(rad * 10_000) / 10_000;

/**
 * The heading the robot needs at `at` to point the launcher at `aim`, and whether a heading already
 * does.
 *
 * - A turret (`shooter.turretRangeRad` in `robot.json`) aims anywhere in its range, so any heading
 *   that keeps the target inside the range aims it, and the heading it is turned to otherwise puts
 *   the target in the middle of the range, as TURRET_RANGE measures it.
 * - Anything else keeps the author's own aim: the target sits at the same bearing from the robot's
 *   body at the new spot as it did at `shot`, so whichever side the author pointed at it, front,
 *   back or anywhere between, still points at it. `robot.json` says nothing about which side a fixed
 *   launcher is on, and the shot as written is the only word on it.
 */
function launcher(robot: Robot, shot: Pose, aim: Vec2): { wantAt: (at: Vec2) => number; aims: (at: Vec2, headingRad: number) => boolean } {
  const bearingFrom = (at: Vec2): number => Math.atan2(aim.yIn - at.yIn, aim.xIn - at.xIn);
  const turret = robot.shooter?.turretRangeRad;
  if (turret !== undefined) {
    const middle = (turret.minRad + turret.maxRad) / 2;
    return {
      wantAt: (at) => wrapAngle(bearingFrom(at) - middle),
      aims: (at, headingRad) => {
        const bearing = wrapAngle(bearingFrom(at) - headingRad);
        return bearing >= turret.minRad && bearing <= turret.maxRad;
      },
    };
  }
  const bodyBearingRad = wrapAngle(bearingFrom(shot) - shot.headingRad);
  return {
    wantAt: (at) => wrapAngle(bearingFrom(at) - bodyBearingRad),
    aims: (at, headingRad) => Math.abs(wrapAngle(bearingFrom(at) - bodyBearingRad - headingRad)) <= AIM_TOLERANCE_RAD,
  };
}

/** The heading at path fraction `t` of a planned step, from its nearest sample. */
function headingAtT(step: PlanStep, t: number): number {
  let best = step.samples[0];
  for (const sample of step.samples) {
    if (best === undefined || Math.abs(sample.t - t) < Math.abs(best.t - t)) best = sample;
  }
  return best?.pose.headingRad ?? step.startPose.headingRad;
}

/**
 * The step's heading rewritten so it ends at `wantRad`, changing as little as it can: a constant
 * heading becomes that constant, a linear one keeps its start, a piecewise one has only its last
 * range rewritten, and a heading the geometry decides (tangent, reversed tangent, facing a point)
 * becomes a linear turn from `arrivalRad`, the way the robot faces as it arrives, so it does not turn
 * on the spot before it drives. `moved` is the step planned with the end already moved, which says
 * where a piecewise heading's last range starts.
 */
function headingEndingAt(heading: Heading, moved: PlanStep, wantRad: number, arrivalRad: number): Heading {
  const towards = (fromRad: number): Heading => {
    const from = fourDecimals(fromRad);
    return { mode: "linear", fromRad: from, toRad: fourDecimals(from + wrapAngle(wantRad - from)) };
  };
  switch (heading.mode) {
    case "constant":
      return { mode: "constant", headingRad: fourDecimals(wantRad) };
    case "linear":
      return towards(heading.fromRad);
    case "piecewise": {
      const last = heading.ranges[heading.ranges.length - 1];
      if (last === undefined) return heading;
      const lastHeading: Heading =
        last.heading.mode === "constant"
          ? { mode: "constant", headingRad: fourDecimals(wantRad) }
          : last.heading.mode === "linear"
            ? towards(last.heading.fromRad)
            : towards(headingAtT(moved, last.startT));
      return { ...heading, ranges: [...heading.ranges.slice(0, -1), { ...last, heading: lastHeading as typeof last.heading }] };
    }
    default:
      return towards(arrivalRad);
  }
}

/** Spots around `centre`, ring by ring out to `SEARCH_RADIUS_IN`, the centre first. */
function spotsAround(centre: Vec2): Vec2[] {
  const spots: Vec2[] = [{ xIn: centre.xIn, yIn: centre.yIn }];
  for (let radiusIn = RING_STEP_IN; radiusIn <= SEARCH_RADIUS_IN; radiusIn += RING_STEP_IN) {
    for (let k = 0; k < RING_POINTS; k += 1) {
      const angle = (2 * Math.PI * k) / RING_POINTS;
      spots.push({ xIn: centre.xIn + radiusIn * Math.cos(angle), yIn: centre.yIn + radiusIn * Math.sin(angle) });
    }
  }
  return spots;
}

export interface ApproachFixInput {
  /** The leg that put the robot where it launches from, whose end the fix moves. */
  driving: PlanStep;
  /** Where the robot launches from as written. */
  shot: Pose;
  target: TargetId;
  /** The ledger's state as the launching step begins. */
  state: SeasonState;
  robot: Robot;
  season: SeasonRules;
  context: PushContext;
}

/** A finding as the comparison matches it across the two autos: its code, its step and what it is about. */
const findingKey = (finding: Finding): string =>
  `${finding.code}|${finding.stepId}|${finding.geometry?.obstacleId ?? finding.geometry?.zoneId ?? ""}`;

/**
 * How the moved auto's findings compare with the auto's as written: worse when it has an error the
 * auto did not, a warning that became an error, or a finding the auto already had gone deeper
 * (`penetrationIn`, as PERIMETER and STRUCTURE measure it) or nearer (CLEARANCE's `gapIn`);
 * otherwise the first warning it adds, if any. Info findings, the SET FROM EDITOR note among them,
 * do not count.
 */
export function compareFindings(before: readonly Finding[], after: readonly Finding[]): { worse: boolean; added: Finding | null } {
  const was = new Map<string, Finding[]>();
  for (const finding of before) {
    const key = findingKey(finding);
    was.set(key, [...(was.get(key) ?? []), finding]);
  }
  let added: Finding | null = null;
  for (const finding of after) {
    if (finding.severity === "info") continue;
    const previous = was.get(findingKey(finding)) ?? [];
    if (previous.length === 0) {
      if (finding.severity === "error") return { worse: true, added };
      added ??= finding;
      continue;
    }
    if (finding.severity === "error" && previous.every((each) => each.severity !== "error")) return { worse: true, added };
    const depthIn = finding.geometry?.penetrationIn;
    if (depthIn !== undefined && depthIn > Math.max(...previous.map((each) => each.geometry?.penetrationIn ?? 0)) + WORSE_IN) {
      return { worse: true, added };
    }
    const gapIn = finding.geometry?.gapIn;
    const gapsBefore = previous.flatMap((each) => (each.geometry?.gapIn === undefined ? [] : [each.geometry.gapIn]));
    if (gapIn !== undefined && gapsBefore.length > 0 && gapIn < Math.min(...gapsBefore) - WORSE_IN) return { worse: true, added };
  }
  return { worse: false, added };
}

/**
 * The "Move to approach" fix, or null when there is none worth offering: the season has no legal
 * spot, the leg has no end of its own to move, or no legal spot nearby leaves the auto no worse.
 *
 * Candidates are the season's nearest legal spot and spots on rings round it, kept only where the
 * season accepts the shot, the robot's centre is on the field and the robot, standing there turned
 * as the fix would leave it, is clear of the wall and every obstacle, and tried nearest the shot as
 * written first, at most `MAX_RECHECKS` moves planned again and `MAX_WHOLE_CHECKS` checked as a
 * whole. Each is the leg's end moved there, labelled SET FROM EDITOR like the other one-click
 * fixes, and, when the leg as moved would not keep the side of the robot the author pointed at the
 * target pointed at it, the leg's heading turned so it does. A spot is out when the auto, planned
 * again, runs into anything new or leaves a step starting away from the robot, as for `pushBackFix`,
 * or, checked as a whole (`context.findingsOf`), gains an error or has a finding it already had get
 * worse. The first spot that adds no warning either is the fix; failing that, the first that adds
 * one, which carries the warning's message in `addsWarning` so the editor can say so.
 */
export function legalApproachFix(input: ApproachFixInput): Fix | null {
  const { driving, shot, target, state, robot, season, context } = input;
  const written: Step = driving.step;
  if (written.kind !== "path") return null;
  const last = written.segments[written.segments.length - 1];
  if (last === undefined || last.to === "current") return null;
  const nearest = season.nearestLegalApproach?.(state, target, shot, robot) ?? null;
  if (nearest === null) return null;
  const index = flattenSteps(context.steps).indexOf(driving);
  if (index < 0) return null;

  const aim = season.targetPoint?.(state, target) ?? null;
  const aiming = aim === null ? null : launcher(robot, shot, aim);
  const flat = flattenSteps(context.steps);
  const arrivalRad = index === 0 ? context.startPose.headingRad : flat[index - 1]?.endPose?.headingRad;
  const { bounds, shadows, perimeterToleranceIn } = context;
  // The robot standing at the spot, turned as the fix would leave it: clear of the wall and every
  // obstacle, or no re-check of the whole auto could pass there. Testing this costs a few polygon
  // tests where a re-check plans the whole auto, so it goes first.
  const standsClear = (spot: Vec2, headingRad: number): boolean =>
    footprintPolygons(footprintAt({ ...spot, headingRad }, robot)).every(
      (polygon) =>
        polygonOutsideBox(polygon, bounds).worstIn <= perimeterToleranceIn &&
        shadows.every((shadow) => !convexPolygonsOverlap(polygon, shadow.polygonIn).overlaps),
    );
  const candidates = spotsAround(nearest)
    .map((spot) => ({ xIn: threeDecimals(spot.xIn), yIn: threeDecimals(spot.yIn) }))
    .filter((spot) => spot.xIn > bounds.minXIn && spot.xIn < bounds.maxXIn && spot.yIn > bounds.minYIn && spot.yIn < bounds.maxYIn)
    .filter((spot) => season.legalApproach(state, target, { ...spot, headingRad: shot.headingRad }, robot))
    .sort((a, b) => Math.hypot(a.xIn - shot.xIn, a.yIn - shot.yIn) - Math.hypot(b.xIn - shot.xIn, b.yIn - shot.yIn))
    .map((spot) => ({ spot, wantRad: aiming === null ? nearest.headingRad : aiming.wantAt(spot) }))
    .filter(({ wantRad }) => Number.isFinite(wantRad))
    .slice(0, MAX_CANDIDATES);

  let baseline: ReturnType<typeof recheckBaseline> | null = null;
  const aimedBy = robot.shooter?.turretRangeRad === undefined ? "fixed" : "turret";
  const label =
    aimedBy === "fixed"
      ? `Move the end of ${driving.id} to a legal spot, turned so the same side faces the target`
      : `Move the end of ${driving.id} to a legal spot, turned so the target is in the turret's range`;
  const { findingsOf } = context;
  let before: readonly Finding[] | null = null;
  let warned: Fix | null = null;
  let rechecks = 0;
  let wholeChecks = 0;
  for (const { spot, wantRad } of candidates) {
    if (rechecks >= MAX_RECHECKS || wholeChecks >= MAX_WHOLE_CHECKS) break;
    // Tested here, spot by spot, rather than over every candidate first: the search mostly stops at
    // one of the first few.
    if (!standsClear(spot, wantRad)) continue;
    baseline ??= recheckBaseline(context, index);
    const moveOnly: Extract<Fix, { kind: "moveToLegalApproach" }> = {
      kind: "moveToLegalApproach",
      stepId: driving.id,
      label,
      params: { xIn: spot.xIn, yIn: spot.yIn, headingRad: fourDecimals(wantRad), aim: aimedBy },
    };
    // The leg's own heading, kept or turned to end at `wantRad` as its mode allows; and, should that
    // make the auto worse (a constant heading the robot turns to on the spot against a wall, say), a
    // linear turn from the way the robot arrives, so it turns while it drives instead. A leg the plan
    // cannot place at the new end keeps the move alone, and the re-check decides.
    const movedOnly = planWithFix(moveOnly, context, baseline);
    const variants: { fix: Extract<Fix, { kind: "moveToLegalApproach" }>; planned?: Plan }[] = [{ fix: moveOnly, planned: movedOnly }];
    if (aiming !== null && written.heading !== undefined) {
      const step = flattenSteps(movedOnly.steps)[index];
      if (step !== undefined) {
        const endRad = step.endPose?.headingRad;
        const fromRad = arrivalRad ?? step.startPose.headingRad;
        const turned = { fix: { ...moveOnly, params: { ...moveOnly.params, heading: headingEndingAt(written.heading, step, wantRad, fromRad) } } };
        // A moved leg that aims wrong gives way to the turned one; one whose end heading the plan
        // does not say keeps the move alone first, and the turned one is tried after it.
        if (endRad === undefined) variants.push(turned);
        else if (!aiming.aims(spot, endRad)) variants[0] = turned;
        const turning = headingEndingAt({ mode: "tangent" }, step, wantRad, fromRad);
        if (variants.every((variant) => JSON.stringify(variant.fix.params.heading) !== JSON.stringify(turning))) variants.push({ fix: { ...moveOnly, params: { ...moveOnly.params, heading: turning } } });
      }
    }
    for (const variant of variants) {
      if (rechecks >= MAX_RECHECKS || wholeChecks >= MAX_WHOLE_CHECKS) break;
      rechecks += 1;
      const { fix } = variant;
      // One plan of the moved auto serves both the re-check and the whole check after it.
      const planned = variant.planned ?? planWithFix(fix, context, baseline);
      if (!rechecksClean(fix, context, baseline, { index }, planned)) continue;
      if (findingsOf === undefined) return fix;
      wholeChecks += 1;
      before ??= context.findingsBefore ?? findingsOf(baseline.planned);
      const { worse, added } = compareFindings(before, findingsOf(planned));
      if (worse) continue;
      if (added === null) return fix;
      warned ??= { ...fix, params: { ...fix.params, addsWarning: added.message } };
    }
  }
  return warned;
}
