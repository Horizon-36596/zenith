import type { Field, Robot } from "@horizon36596/zenith-schema";
import { PERIMETER_TOLERANCE_IN } from "../check.js";
import { autoKeepOuts } from "../checks/motion.js";
import { opponentSideBox } from "../checks/opponentSide.js";
import { fieldBounds } from "../footprint.js";
import { angleDelta } from "../geometry/angle.js";
import { obstacleShadows } from "../geometry/obstacle.js";
import {
  convexHull,
  convexPolygonClearance,
  inflateBox,
  polygonBoxClearance,
  type Box2,
} from "../geometry/sat.js";
import type { Vec2 } from "../geometry/vec.js";
import { robotHeightIn } from "../kinematics.js";
import type { OwnSide } from "../season.js";
import type { PlanSample } from "../types.js";

/**
 * How near the optimizer lets the robot's footprint come to what it must not touch: the signed
 * clearance, its required value with the end exemption, the squared-hinge penalty the search adds to its
 * objective, and the conservative swept test of the hard final check.
 *
 * Three kinds of thing are measured, with the same predicates `check()` uses:
 *
 * - Structures: solid obstacles with a part below the robot's top (`obstacleShadows`), cleared by
 *   the safety margin.
 * - Walls: the field's perimeter (`fieldBounds`), with no margin.
 * - Keep-outs: zones whose rule applies in autonomous (`autoKeepOuts`), with no margin. They are
 *   hard constraints here although KEEPOUT is only a warning in `check()`. When the season names
 *   the side the robot stays on in auto (`SeasonRules.ownSide`), the other side is one more
 *   keep-out, `CENTRE_LINE_KEEPOUT_ID`, so no route crosses the line OPPONENT_SIDE reports
 *   (issue #365).
 *
 * Every function takes the plan's samples as they are, so what is measured is the footprint
 * `plan()` sweeps: the expanded body plus every mouth. Nothing here samples a path; the caller
 * decides the spacing (0.5 in for the final check).
 *
 * Pure (CLAUDE.md rule 1).
 */

/**
 * Float noise allowed when a clearance is compared with its requirement, in inches. It is
 * arithmetic slack, not a margin: a robot that is exactly at its margin passes, and no real
 * clearance is this small.
 */
export const CLEARANCE_EPSILON_IN = 1e-9;

/** A solid obstacle the footprint must clear by the margin. */
export interface ClearanceStructure {
  id: string;
  /** The box around the obstacle's shadow; the shadow itself for a box obstacle. */
  boxIn: Box2;
  /** The obstacle's shadow, counter-clockwise. It is not `boxIn` for a slanted strut. */
  polygonIn: readonly Vec2[];
  /** True when `polygonIn` is `boxIn`, so the box tests apply as they are. */
  isBox: boolean;
}

/** A zone that applies in autonomous, which the footprint must stay out of. */
export interface ClearanceKeepOut {
  id: string;
  boxIn: Box2;
}

/** What the footprint has to stay clear of, from one robot and one field. */
export interface ClearanceWorld {
  boundsIn: Box2;
  structures: readonly ClearanceStructure[];
  keepOuts: readonly ClearanceKeepOut[];
}

/**
 * The id of the keep-out that stands for the other alliance's side (`opponentSideBox`). The empty
 * string, because a field zone's id has at least one character (`zoneSchema`), so no zone can be
 * mistaken for it, whatever the field calls its zones. The optimizer's sentences call it the
 * centre line, through `keepOutWords`.
 */
export const CENTRE_LINE_KEEPOUT_ID = "";

/** How a sentence names a keep-out: the centre line for that one, the zone's id for the rest. */
export const keepOutWords = (id: string | null): string =>
  id === CENTRE_LINE_KEEPOUT_ID ? "the centre line" : `the keep-out ${JSON.stringify(id)}`;

/**
 * The obstacles of a field for a robot, filtered as `check()` filters them: solid to the robot
 * (`solidToRobot ?? true`) and with a part below `robotHeightIn(robot)`, so a bar above the
 * robot's top is passable; only the zones with `appliesInAuto`; and, given `ownSide`, the other
 * alliance's side as the last keep-out.
 */
export function clearanceWorld(robot: Robot, field: Field, ownSide: OwnSide | null = null): ClearanceWorld {
  const structures = obstacleShadows(field.obstacles ?? [], robotHeightIn(robot)).map(
    (shadow): ClearanceStructure => ({
      id: shadow.obstacle.id,
      boxIn: shadow.boxIn,
      polygonIn: shadow.polygonIn,
      isBox: shadow.obstacle.kind === "box",
    }),
  );
  const keepOuts = autoKeepOuts(field).map(
    (zone): ClearanceKeepOut => ({
      id: zone.id,
      boxIn: { minXIn: zone.minXIn, maxXIn: zone.maxXIn, minYIn: zone.minYIn, maxYIn: zone.maxYIn },
    }),
  );
  if (ownSide !== null) keepOuts.push({ id: CENTRE_LINE_KEEPOUT_ID, boxIn: opponentSideBox(ownSide, field) });
  return { boundsIn: fieldBounds(field), structures, keepOuts };
}

/** The polygons the checks sweep at one sample: the body first, then each mouth. */
const polygonsOf = (sample: PlanSample): Vec2[][] => [sample.footprintIn, ...sample.mouthsIn];

/** Signed clearance of the nearest polygon to a structure: the smallest over the polygons. */
function structureClearanceIn(polygons: readonly (readonly Vec2[])[], structure: ClearanceStructure): number {
  let nearest = Infinity;
  for (const polygon of polygons) {
    const clearance = structure.isBox
      ? polygonBoxClearance(polygon, structure.boxIn)
      : convexPolygonClearance(polygon, structure.polygonIn);
    if (clearance < nearest) nearest = clearance;
  }
  return nearest;
}

/** How far inside the bounds the polygons stay: the smallest corner distance to a wall, negative outside. */
function wallClearanceIn(polygons: readonly (readonly Vec2[])[], bounds: Box2): number {
  let nearest = Infinity;
  for (const polygon of polygons) {
    for (const point of polygon) {
      const inside = Math.min(
        point.xIn - bounds.minXIn,
        bounds.maxXIn - point.xIn,
        point.yIn - bounds.minYIn,
        bounds.maxYIn - point.yIn,
      );
      if (inside < nearest) nearest = inside;
    }
  }
  return nearest;
}

function keepOutClearanceIn(polygons: readonly (readonly Vec2[])[], keepOut: ClearanceKeepOut): number {
  let nearest = Infinity;
  for (const polygon of polygons) nearest = Math.min(nearest, polygonBoxClearance(polygon, keepOut.boxIn));
  return nearest;
}

/** The signed clearances of every sample to every structure, wall and keep-out. */
export interface MeasuredClearances {
  /** `structuresIn[k][i]` is sample i's clearance to structure k of the world. */
  structuresIn: number[][];
  /** How far inside the walls sample i is; negative when it pokes out. */
  wallsIn: number[];
  /** `keepOutsIn[k][i]` is sample i's signed clearance to keep-out k. */
  keepOutsIn: number[][];
}

export function measureClearances(world: ClearanceWorld, samples: readonly PlanSample[]): MeasuredClearances {
  const polygons = samples.map(polygonsOf);
  return {
    structuresIn: world.structures.map((structure) => polygons.map((p) => structureClearanceIn(p, structure))),
    wallsIn: polygons.map((p) => wallClearanceIn(p, world.boundsIn)),
    keepOutsIn: world.keepOuts.map((keepOut) => polygons.map((p) => keepOutClearanceIn(p, keepOut))),
  };
}

/** What one structure requires of each sample, and which samples the end exemption covers. */
export interface RequiredClearance {
  /** The clearance sample i must have, in inches: the margin, or what the exemption lowers it to. */
  requiredIn: number[];
  /** True for the samples inside an exemption run, where the margin does not apply. */
  exempt: boolean[];
}

/**
 * The clearance each sample must have to one structure, given the clearances the route's own
 * samples have to it.
 *
 * The margin applies everywhere except at an end that already sits closer than the margin, such as
 * a scoring pose against a face:
 *
 * - Leaving S: over the run of samples from the first one while the clearance is still below the
 *   margin, a sample must not penetrate and must not be closer than the sample before it. Its
 *   requirement is the previous sample's clearance, held between 0 and the margin. The first sample
 *   requires 0.
 * - Arriving at E: the same in reverse, from the last sample back. Its requirement is the next
 *   sample's clearance, so the clearance may only grow as the route moves away from E.
 * - Everywhere else the requirement is the margin. The exemption adds no constant.
 *
 * A sample in both runs (a route that never reaches the margin) must satisfy both. Because the
 * requirement reads the route's own clearances, a route that comes back toward the structure
 * inside the run has a sample whose clearance is below its requirement, and fails.
 */
export function requiredClearanceIn(clearancesIn: readonly number[], marginIn: number): RequiredClearance {
  const n = clearancesIn.length;
  const requiredIn = new Array<number>(n).fill(marginIn);
  const exempt = new Array<boolean>(n).fill(false);
  const held = (value: number): number => Math.max(0, Math.min(marginIn, value));
  const at = (i: number): number => clearancesIn[i] as number;

  const fromStart = new Array<number>(n).fill(-Infinity);
  for (let i = 0; i < n && at(i) < marginIn; i += 1) {
    exempt[i] = true;
    fromStart[i] = i === 0 ? 0 : held(at(i - 1));
  }
  const fromEnd = new Array<number>(n).fill(-Infinity);
  for (let i = n - 1; i >= 0 && at(i) < marginIn; i -= 1) {
    exempt[i] = true;
    fromEnd[i] = i === n - 1 ? 0 : held(at(i + 1));
  }
  for (let i = 0; i < n; i += 1) {
    if (exempt[i] === true) requiredIn[i] = Math.max(fromStart[i] as number, fromEnd[i] as number);
  }
  return { requiredIn, exempt };
}

/** Which kind of thing a clearance is measured to. */
export type ClearanceKind = "structure" | "wall" | "keepOut";

/** The worst place a route comes too close, for the card and for an `infeasible` result. */
export interface ClearanceViolation {
  kind: ClearanceKind;
  /** The obstacle's or zone's id; null for the walls. */
  id: string | null;
  /** The sample, or for a swept violation the first sample of the pair. */
  sampleIndex: number;
  /** How much more clearance it needed, in inches. */
  shortfallIn: number;
}

export interface ClearancePenalty {
  /** The sum over samples and obstacles of the squared shortfall, in square inches; 0 when clear. */
  penalty: number;
  /** The largest single shortfall, or null when nothing falls short. */
  worst: ClearanceViolation | null;
}

const hinge = (shortfallIn: number): number => (shortfallIn > 0 ? shortfallIn * shortfallIn : 0);

/**
 * The squared-hinge penalty the search adds to a candidate's objective: for every sample and every
 * obstacle, the square of how much clearance it falls short of its requirement. Structures
 * require the margin (with the end exemption of `requiredClearanceIn`); walls and keep-outs
 * require 0, and the walls may be passed by `PERIMETER_TOLERANCE_IN` as in `check()`. It is 0 for a route that clears everything and grows smoothly as one pushes in, so
 * the search is pulled out of an obstacle rather than only told it is in one.
 *
 * The weight is the caller's: it multiplies this, and doubles for each start (section 6.3).
 */
export function clearancePenalty(
  world: ClearanceWorld,
  samples: readonly PlanSample[],
  marginIn: number,
): ClearancePenalty {
  const measured = measureClearances(world, samples);
  let penalty = 0;
  let worst: ClearanceViolation | null = null;
  const note = (kind: ClearanceKind, id: string | null, sampleIndex: number, shortfallIn: number): void => {
    penalty += hinge(shortfallIn);
    if (shortfallIn > CLEARANCE_EPSILON_IN && (worst === null || shortfallIn > worst.shortfallIn)) {
      worst = { kind, id, sampleIndex, shortfallIn };
    }
  };

  for (const [k, structure] of world.structures.entries()) {
    const clearances = measured.structuresIn[k] as number[];
    const { requiredIn } = requiredClearanceIn(clearances, marginIn);
    for (const [i, clearance] of clearances.entries()) {
      note("structure", structure.id, i, (requiredIn[i] as number) - clearance);
    }
  }
  // The walls get the slack `check()` and the swept test give them, so a fixed end riding the wall
  // is neither charged nor reported as the worst shortfall.
  for (const [i, inside] of measured.wallsIn.entries()) note("wall", null, i, -inside - PERIMETER_TOLERANCE_IN);
  for (const [k, keepOut] of world.keepOuts.entries()) {
    for (const [i, clearance] of (measured.keepOutsIn[k] as number[]).entries()) note("keepOut", keepOut.id, i, -clearance);
  }
  return { penalty, worst };
}

/** The result of the swept test. */
export interface SweptResult {
  ok: boolean;
  /** The pair that falls furthest short, or null when `ok`. */
  worst: ClearanceViolation | null;
}

/** The farthest any footprint corner is from the pose it is rotated about, over both samples. */
function reachIn(a: PlanSample, b: PlanSample): number {
  let reach = 0;
  for (const sample of [a, b]) {
    for (const polygon of polygonsOf(sample)) {
      for (const point of polygon) {
        reach = Math.max(reach, Math.hypot(point.xIn - sample.pose.xIn, point.yIn - sample.pose.yIn));
      }
    }
  }
  return reach;
}

/**
 * The farthest the centre can stray from the straight line between two samples, in inches, from
 * the arc length between them. A curve of length L between two points a chord c apart stays inside
 * the ellipse with those points as foci and L as its major axis, whose half minor axis is
 * sqrt(L^2 - c^2) / 2, so this holds whatever the curve does between the samples. It is 0 for a
 * straight stretch, and for samples with no arc length between them: a turn on the spot, or the
 * instant sim's poses, which carry an arc length of 0 and move straight from one tick to the next.
 */
function chordDeviationIn(a: PlanSample, b: PlanSample): number {
  const lengthIn = Math.abs(b.sIn - a.sIn);
  const chordIn = Math.hypot(b.pose.xIn - a.pose.xIn, b.pose.yIn - a.pose.yIn);
  return lengthIn > chordIn ? Math.sqrt(lengthIn * lengthIn - chordIn * chordIn) / 2 : 0;
}

/** The hulls of consecutive footprints: the body's, then each mouth's. */
function hullsOf(a: PlanSample, b: PlanSample): Vec2[][] {
  const first = polygonsOf(a);
  const second = polygonsOf(b);
  return first.map((polygon, k) => convexHull([...polygon, ...(second[k] ?? [])]));
}

/**
 * The conservative swept test of the hard final check, over the samples of one planned path. For each
 * pair of consecutive samples, the convex hull of the two footprints (the body's and each mouth's) must
 *
 * - clear every structure's box grown by the required clearance,
 * - stay inside the field bounds, and
 * - stay out of every keep-out that applies in auto,
 *
 * with each box also grown by the rotation bulge `r * (1 - cos(dh / 2))` and the chord deviation.
 * Here `r` is the farthest footprint corner from the centre of rotation, and `dh` the heading
 * change between the two samples: the bulge is the most a corner's arc can leave the straight line
 * between its two sample positions. The chord deviation is the most the centre can leave the
 * straight line between the two samples on a curved path, from the arc length between them
 * (`chordDeviationIn`). So a thin bar cannot hide between samples: the hull holds the straight
 * motion, the bulge holds the turn and the chord deviation holds the curve.
 *
 * The pair's requirement is the margin, except for a pair with a sample in an exemption run
 * (`requiredClearanceIn`): there the margin is dropped and the hull, grown by the bulge and the
 * chord deviation, must not penetrate the structure, because a footprint already closer than the
 * margin is allowed to be where it is. The samples themselves must not close in (checked here as
 * well).
 *
 * The walls take the same growth too, but may be passed by `PERIMETER_TOLERANCE_IN`, the slack
 * `check()` itself gives the walls, so a robot riding the wall is not failed by arithmetic.
 *
 * With an `allowance`, a shortfall fails only when it is larger than the allowance for its thing,
 * and `worst` is the largest of those, as measured.
 *
 * A single sample is tested alone. An empty list throws: there is nothing to test, and passing it
 * would let a plan with no samples through the hard check. The test is conservative: it can reject
 * a route the robot would clear, never accept one it would not, so no result of it reads as a
 * clearance guarantee for the real robot.
 */
export function sweptClearanceCheck(
  world: ClearanceWorld,
  samples: readonly PlanSample[],
  marginIn: number,
  allowance: SweptAllowance = NO_ALLOWANCE,
): SweptResult {
  let worst: ClearanceViolation | null = null;
  sweep(world, samples, marginIn, (kind, id, sampleIndex, shortfallIn) => {
    const allowedIn = allowance.get(shortfallKey(kind, id)) ?? 0;
    if (shortfallIn > allowedIn + CLEARANCE_EPSILON_IN && (worst === null || shortfallIn > worst.shortfallIn)) {
      worst = { kind, id, sampleIndex, shortfallIn };
    }
  });
  return { ok: worst === null, worst };
}

/** The key of a thing a shortfall is measured to, in a `SweptAllowance`: its kind and its id. */
export const shortfallKey = (kind: ClearanceKind, id: string | null): string => `${kind}|${id ?? ""}`;

/**
 * How far the swept test lets a route fall short of each thing, in inches, by `shortfallKey`; a thing
 * it does not hold is allowed nothing. The hard final check builds one from an original that
 * `check()` passes (`sweptShortfalls`), so a route is held to being no worse than that original.
 */
export type SweptAllowance = ReadonlyMap<string, number>;

const NO_ALLOWANCE: SweptAllowance = new Map();

/** The largest shortfall on each thing the swept test finds falling short, by `shortfallKey`; empty when it passes. */
export function sweptShortfalls(world: ClearanceWorld, samples: readonly PlanSample[], marginIn: number): Map<string, number> {
  const largest = new Map<string, number>();
  sweep(world, samples, marginIn, (kind, id, _sampleIndex, shortfallIn) => {
    if (shortfallIn <= CLEARANCE_EPSILON_IN) return;
    const key = shortfallKey(kind, id);
    if (shortfallIn > (largest.get(key) ?? 0)) largest.set(key, shortfallIn);
  });
  return largest;
}

/** The swept test of `sweptClearanceCheck`, which hears every shortfall it measures, positive or not. */
function sweep(
  world: ClearanceWorld,
  samples: readonly PlanSample[],
  marginIn: number,
  note: (kind: ClearanceKind, id: string | null, sampleIndex: number, shortfallIn: number) => void,
): void {
  if (samples.length === 0) throw new Error("The swept clearance test needs at least one sample.");
  const measured = measureClearances(world, samples);
  const requirements = world.structures.map((_, k) => requiredClearanceIn(measured.structuresIn[k] as number[], marginIn));

  // The exempted samples are held to "no penetration and no closer than the sample before"; the
  // hull below holds every other sample, since it contains it.
  for (const [k, structure] of world.structures.entries()) {
    const { requiredIn, exempt } = requirements[k] as RequiredClearance;
    for (const [i, clearance] of (measured.structuresIn[k] as number[]).entries()) {
      if (exempt[i] === true) note("structure", structure.id, i, (requiredIn[i] as number) - clearance);
    }
  }

  const pairs: [number, number][] =
    samples.length === 1 ? [[0, 0]] : samples.slice(1).map((_, i): [number, number] => [i, i + 1]);
  for (const [from, to] of pairs) {
    const exemptPair = (k: number): boolean => {
      const { exempt } = requirements[k] as RequiredClearance;
      return exempt[from] === true || exempt[to] === true;
    };
    sweptPairShortfalls(world, samples[from] as PlanSample, samples[to] as PlanSample, marginIn, exemptPair, (kind, id, shortfallIn) =>
      note(kind, id, from, shortfallIn),
    );
  }
}

/**
 * The swept test of one pair of consecutive samples, as `sweptClearanceCheck` runs it for every
 * pair: the hulls of the two footprints against every structure's box grown by the margin, the
 * rotation bulge and the chord deviation (by the bulge and the chord deviation only, for a
 * structure `exemptStructure` says the pair is exempt from), against the field bounds shrunk by the
 * bulge and the chord deviation with `PERIMETER_TOLERANCE_IN` of slack, and against every keep-out
 * grown by the bulge and the chord deviation.
 *
 * `note` hears every shortfall in inches, positive when the pair falls short, once per structure,
 * once for the walls and once per keep-out, in that order. The optimizer's heading dynamic program
 * (`headingDp.ts`) runs it on one transition between two stations, which is the "rotation clears"
 * test of spec 16 section 6.4.
 */
export function sweptPairShortfalls(
  world: ClearanceWorld,
  a: PlanSample,
  b: PlanSample,
  marginIn: number,
  exemptStructure: (index: number) => boolean,
  note: (kind: ClearanceKind, id: string | null, shortfallIn: number) => void,
): void {
  const hulls = hullsOf(a, b);
  // What the motion between the samples can add to the hull: the turn's bulge and the curve's
  // deviation from the chord. Every box takes it, an exempt one too; only the margin is exempt.
  const sweepIn =
    reachIn(a, b) * (1 - Math.cos(Math.abs(angleDelta(a.pose.headingRad, b.pose.headingRad)) / 2)) + chordDeviationIn(a, b);

  for (const [k, structure] of world.structures.entries()) {
    const growthIn = exemptStructure(k) ? sweepIn : marginIn + sweepIn;
    let slackIn = Infinity;
    for (const hull of hulls) {
      const gap = structure.isBox
        ? polygonBoxClearance(hull, inflateBox(structure.boxIn, growthIn))
        : convexPolygonClearance(hull, structure.polygonIn) - growthIn;
      if (gap < slackIn) slackIn = gap;
    }
    note("structure", structure.id, -slackIn);
  }

  const inner = inflateBox(world.boundsIn, -sweepIn);
  note("wall", null, -wallClearanceIn(hulls, inner) - PERIMETER_TOLERANCE_IN);

  for (const keepOut of world.keepOuts) {
    const grown: ClearanceKeepOut = { id: keepOut.id, boxIn: inflateBox(keepOut.boxIn, sweepIn) };
    note("keepOut", keepOut.id, -keepOutClearanceIn(hulls, grown));
  }
}
