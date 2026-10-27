/**
 * A legal start pose for a new auto, found rather than invented: poses touching each wall of the
 * field are tried in a fixed order and the first one the season's own start rule accepts is used.
 * The rule is the one that raises START_ILLEGAL (`SeasonRules.startLegal`, for BIOBUZZ the
 * field's `startRules`: touching a wall, in the alliance's own half, outside the named zones and
 * not touching the named containers), so the pose passes the same check the Problems panel runs.
 *
 * Nothing here knows a season's numbers. The candidates come from the field's `sizeIn` and frame
 * and the robot's start footprint; the rule comes from the season plugin the field names. With no
 * `startRules`, or a season this build does not carry, there is nothing to be legal against, and
 * the caller keeps its old behaviour.
 *
 * For the Problems panel's fix on START_ILLEGAL, `chooseLegalStart` also checks the whole auto at
 * each of the nearest legal starts, so the start it picks does not trade START_ILLEGAL for another
 * error, such as the robot turning against the wall it now starts on (issue #155).
 */
import { fieldBounds, flattenSteps, footprintAt, footprintBoundsIn } from "@horizon36596/zenith-core";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import type { Finding, Plan, SeasonRules } from "@horizon36596/zenith-core";
import type { Auto, Field, Robot, Waypoints } from "@horizon36596/zenith-schema";
import { safeCheck, safeEstimate, safePlan, safeResolve } from "../lib/coreSafe";

/** How far apart the tried positions along a wall are: a quarter of a 24 in tile. */
export const START_STEP_IN = 6;

/** How far past a wall rounding to hundredths may leave a corner and still count as inside. */
const EDGE_TOLERANCE_IN = 0.01;

type Alliance = "RED" | "BLUE";

interface Wall {
  /** Which coordinate the wall fixes, and on which side of the field it is. */
  axis: "x" | "y";
  side: -1 | 1;
}

/** The walls in the order they are tried: the audience wall (-y) first, then the far one, then the sides. */
const WALLS: readonly Wall[] = [
  { axis: "y", side: -1 },
  { axis: "y", side: 1 },
  { axis: "x", side: -1 },
  { axis: "x", side: 1 },
];

export interface LegalStart {
  xIn: number;
  yIn: number;
  headingRad: number;
  /** Which wall it touches, as `y = -72 in`, for the provenance string. */
  wall: string;
}

/** The heading that faces away from `wall`, into the field, then along it both ways, then at it. */
function headingsFor(wall: Wall): number[] {
  const into = wall.axis === "y" ? (wall.side < 0 ? Math.PI / 2 : -Math.PI / 2) : wall.side < 0 ? 0 : Math.PI;
  return [into, into + Math.PI / 2, into - Math.PI / 2, into + Math.PI].map(normalise);
}

/** Into (-pi, pi], rounded so a quarter turn is written as 1.5708 and not 1.5707963267948966. */
function normalise(radians: number): number {
  let value = radians;
  while (value <= -Math.PI) value += 2 * Math.PI;
  while (value > Math.PI) value -= 2 * Math.PI;
  return Math.round(value * 10_000) / 10_000;
}

/** Offsets along a wall from its middle outward: 0, -6, +6, -12, +12, ... within `half`. */
function offsetsAlong(half: number): number[] {
  const offsets = [0];
  for (let step = START_STEP_IN; step <= half; step += START_STEP_IN) offsets.push(-step, step);
  return offsets;
}

/** The body's axis-aligned extent around the pose, which is what touching a wall is measured on. */
function bodyExtent(robot: Robot, headingRad: number): { minX: number; maxX: number; minY: number; maxY: number } {
  const corners = footprintAt({ xIn: 0, yIn: 0, headingRad }, robot, "startIn").bodyIn;
  return {
    minX: Math.min(...corners.map((corner) => corner.xIn)),
    maxX: Math.max(...corners.map((corner) => corner.xIn)),
    minY: Math.min(...corners.map((corner) => corner.yIn)),
    maxY: Math.max(...corners.map((corner) => corner.yIn)),
  };
}

const hundredths = (value: number): number => Math.round(value * 100) / 100;

/** A legal start, with the wall it touches, so it can be turned and pushed back onto the same wall. */
interface WallStart {
  start: LegalStart;
  wall: Wall;
}

/**
 * The pose at `alongIn` on `wall` facing `headingRad`, pushed onto the wall so the body's outermost
 * corner touches it, or null when its start footprint, mouths included, leaves the field or the
 * season's start rule refuses it for `alliance`. Rounded to hundredths before it is checked, so the
 * pose written is the pose that passed.
 */
function poseOnWall(
  field: Field,
  robot: Robot,
  alliance: Alliance,
  rules: SeasonRules,
  wall: Wall,
  alongIn: number,
  headingRad: number,
): WallStart | null {
  const bounds = fieldBounds(field);
  const extent = bodyExtent(robot, headingRad);
  // The fixed coordinate that puts the body's outermost corner exactly on the wall.
  const fixed =
    wall.axis === "y"
      ? wall.side < 0
        ? bounds.minYIn - extent.minY
        : bounds.maxYIn - extent.maxY
      : wall.side < 0
        ? bounds.minXIn - extent.minX
        : bounds.maxXIn - extent.maxX;
  const pose =
    wall.axis === "y"
      ? { xIn: hundredths(alongIn), yIn: hundredths(fixed), headingRad }
      : { xIn: hundredths(fixed), yIn: hundredths(alongIn), headingRad };
  const box = footprintBoundsIn(pose, robot, "startIn");
  const inside =
    box.minXIn >= bounds.minXIn - EDGE_TOLERANCE_IN &&
    box.maxXIn <= bounds.maxXIn + EDGE_TOLERANCE_IN &&
    box.minYIn >= bounds.minYIn - EDGE_TOLERANCE_IN &&
    box.maxYIn <= bounds.maxYIn + EDGE_TOLERANCE_IN;
  if (!inside) return null;
  if (rules.startLegal(field, pose, robot, alliance).length > 0) return null;
  const at = wall.axis === "y" ? (wall.side < 0 ? bounds.minYIn : bounds.maxYIn) : wall.side < 0 ? bounds.minXIn : bounds.maxXIn;
  return { start: { ...pose, wall: `${wall.axis} = ${String(hundredths(at))} in` }, wall };
}

/**
 * Every start pose, touching a wall with the robot's body, that the field's season accepts for
 * `alliance` with no START_ILLEGAL finding, in the fixed order `findLegalStart` tries them. For each
 * wall, `extraHeadings` are tried before the four the wall gives, so a caller that wants to keep the
 * robot's own heading can. Nothing is yielded when the season has no start rule to check. The whole
 * start footprint, mouths included, stays inside the field.
 */
function* legalStarts(
  field: Field,
  robot: Robot,
  alliance: Alliance,
  extraHeadings: readonly number[] = [],
): Generator<WallStart> {
  if (field.startRules === undefined) return;
  const season = resolveSeason(field);
  if (!season.known) return;
  const bounds = fieldBounds(field);
  const centre = { xIn: (bounds.minXIn + bounds.maxXIn) / 2, yIn: (bounds.minYIn + bounds.maxYIn) / 2 };
  for (const wall of WALLS) {
    const alongHalf = wall.axis === "y" ? (bounds.maxXIn - bounds.minXIn) / 2 : (bounds.maxYIn - bounds.minYIn) / 2;
    const middle = wall.axis === "y" ? centre.xIn : centre.yIn;
    const headings = [...new Set([...extraHeadings.map(normalise), ...headingsFor(wall)])];
    for (const headingRad of headings) {
      for (const offset of offsetsAlong(alongHalf)) {
        const found = poseOnWall(field, robot, alliance, season.rules, wall, middle + offset, headingRad);
        if (found !== null) yield found;
      }
    }
  }
}

/**
 * The first start pose, touching a wall with the robot's body, that the field's season accepts for
 * `alliance` with no START_ILLEGAL finding, or null when the season has no start rule to check or no
 * tried pose passes it. The whole start footprint, mouths included, stays inside the field.
 */
export function findLegalStart(field: Field, robot: Robot, alliance: Alliance): LegalStart | null {
  for (const found of legalStarts(field, robot, alliance)) return found.start;
  return null;
}

/** How far a heading turns to reach another, in radians, the short way round. */
const turnBetween = (fromRad: number, toRad: number): number => Math.abs(normalise(toRad - fromRad));

/**
 * The legal starts closest to `from`, nearest first, at most `limit` of them. Closest is the
 * shortest move of the robot's centre; between poses equally far, the one that turns the robot
 * least comes first, then the one tried first, and the robot's own heading is tried on every wall
 * so it is kept whenever it can be.
 */
function nearestLegalStarts(
  field: Field,
  robot: Robot,
  alliance: Alliance,
  from: { xIn: number; yIn: number; headingRad?: number },
  limit: number,
): WallStart[] {
  const heading = from.headingRad ?? 0;
  const ranked = [...legalStarts(field, robot, alliance, [heading])].map((found, order) => ({
    found,
    order,
    distance: hundredths(Math.hypot(found.start.xIn - from.xIn, found.start.yIn - from.yIn)),
    turn: turnBetween(heading, found.start.headingRad),
  }));
  ranked.sort((a, b) => a.distance - b.distance || a.turn - b.turn || a.order - b.order);
  return ranked.slice(0, limit).map((entry) => entry.found);
}

/**
 * The legal start closest to `from`, the first `chooseLegalStart` tries. Null when there is no
 * start rule to check or no tried pose passes it, as for `findLegalStart`.
 */
export function nearestLegalStart(
  field: Field,
  robot: Robot,
  alliance: Alliance,
  from: { xIn: number; yIn: number; headingRad?: number },
): LegalStart | null {
  return nearestLegalStarts(field, robot, alliance, from, 1)[0]?.start ?? null;
}

/** How many of the legal starts nearest the planned one the fix builds and checks the auto for. */
export const LEGAL_START_TRIES = 40;

/**
 * How many times the second pass turns a start to the first path's heading and pushes it back onto
 * the wall: moving it changes the path's heading a little, so it is worked out again from there.
 */
const TURN_ROUNDS = 3;

/** Closer than this, in radians, the heading the first path asks for is the start's own. */
const SAME_HEADING_RAD = 1e-4;

/**
 * More than this, in radians, between the start's heading and the one its first path starts with,
 * and the robot turns on the spot before it drives. Two degrees, the turn PERIMETER calls a turn
 * where a path starts (`check.ts`).
 */
const TURN_ON_THE_SPOT_RAD = (2 * Math.PI) / 180;

/** The auto checked with the start at one candidate, as the fix would write it. */
export interface StartTrial {
  /** Every finding `check` raises for that auto, with the same robot, field and season. */
  findings: readonly Finding[];
  /**
   * The heading the first path in run order has where it starts, which for a tangent path is its
   * start tangent; null when the routine has no path.
   */
  firstPathHeadingRad: number | null;
}

/** Resolves, plans, estimates and checks `auto` as the Problems panel does, or null when it cannot. */
export function trialStart(auto: Auto, robot: Robot, field: Field, waypoints: Waypoints | undefined): StartTrial | null {
  const resolved = safeResolve(auto, waypoints, robot);
  if (!resolved.ok) return null;
  const planned = safePlan(resolved.value, robot, field);
  if (!planned.ok) return null;
  const estimated = safeEstimate(planned.value, robot);
  const checked = safeCheck(planned.value, estimated.ok ? estimated.value : null, robot, field, resolveSeason(field).rules);
  if (!checked.ok) return null;
  const firstPath = flattenSteps(planned.value.steps).find((step) => step.kind === "path" && step.samples.length > 0);
  return { findings: checked.value, firstPathHeadingRad: firstPath?.samples[0]?.pose.headingRad ?? null };
}

const findingKey = (finding: Finding): string => `${finding.code} ${finding.stepId}`;

/** The first error in `after` that `before` does not have as many of, by code and step, or null. */
function addedError(before: readonly Finding[], after: readonly Finding[]): Finding | null {
  const left = new Map<string, number>();
  for (const finding of before) {
    if (finding.severity === "error") left.set(findingKey(finding), (left.get(findingKey(finding)) ?? 0) + 1);
  }
  for (const finding of after) {
    if (finding.severity !== "error") continue;
    const count = left.get(findingKey(finding)) ?? 0;
    if (count === 0) return finding;
    left.set(findingKey(finding), count - 1);
  }
  return null;
}

/** Where the fix puts the start, and the error the auto gains there when every start tried gains one. */
export interface LegalStartChoice {
  start: LegalStart;
  /** Null when the auto gains no error the start's old pose did not already give it. */
  remaining: Finding | null;
}

/**
 * Where "Move the start to the nearest legal spot" puts the start (issue #155). It walks the
 * `tries` legal starts nearest the planned one, nearest first. For each, `trial` builds the auto as
 * the fix would write it, the path points on the start carried with it, and checks it; a start is
 * clean when the auto gains no error-severity finding `before` did not have. In order, it takes:
 *
 * 1. the first clean start where the first path leaves facing the way the robot starts, so the
 *    robot does not turn on the spot against the wall it now touches;
 * 2. else the first of those starts that is clean turned to the heading its first path starts
 *    with, which for a tangent path is its start tangent, and pushed back onto the same wall. Moving
 *    it changes that heading a little, so it is turned again from there, up to three times, until
 *    the path leaves facing the way the robot starts; a clean start that still turns a little is
 *    kept for step 3;
 * 3. else the first clean start that turns on the spot: one from step 2 first, since it turns the
 *    least, then one from step 1, since the checks find nothing wrong with either;
 * 4. else the nearest legal start, with the error the auto gains there.
 *
 * Step 3 matters for a square robot, which can turn a quarter turn flush with a wall and end inside
 * the field: the checks look at the pose it ends the turn in, not the ones it passes through. A
 * `trial` that cannot plan the auto (null) is never chosen. Null when there is no legal start to try.
 */
export function chooseLegalStart(
  plan: Plan,
  before: readonly Finding[],
  trial: (start: LegalStart) => StartTrial | null,
  tries: number = LEGAL_START_TRIES,
): LegalStartChoice | null {
  const { field, robot } = plan;
  const alliance = plan.auto.alliance;
  const candidates = nearestLegalStarts(field, robot, alliance, plan.startPose, tries);
  const nearest = candidates[0];
  if (nearest === undefined) return null;
  const clean = (result: StartTrial | null): result is StartTrial =>
    result !== null && addedError(before, result.findings) === null;
  const turnsOnTheSpot = (start: LegalStart, result: StartTrial): boolean =>
    result.firstPathHeadingRad !== null && Math.abs(normalise(result.firstPathHeadingRad - start.headingRad)) > TURN_ON_THE_SPOT_RAD;

  const trials = new Map<WallStart, StartTrial | null>();
  for (const candidate of candidates) {
    const result = trial(candidate.start);
    trials.set(candidate, result);
    if (clean(result) && !turnsOnTheSpot(candidate.start, result)) return { start: candidate.start, remaining: null };
  }

  const rules = resolveSeason(field).rules;
  let turnedButClean: LegalStart | null = null;
  for (const candidate of candidates) {
    let at = candidate;
    let wanted = trials.get(candidate)?.firstPathHeadingRad ?? null;
    for (let round = 0; round < TURN_ROUNDS && wanted !== null; round += 1) {
      if (Math.abs(normalise(wanted - at.start.headingRad)) < SAME_HEADING_RAD) break;
      const along = at.wall.axis === "y" ? at.start.xIn : at.start.yIn;
      const turned = poseOnWall(field, robot, alliance, rules, at.wall, along, normalise(wanted));
      if (turned === null) break;
      const result = trial(turned.start);
      if (clean(result)) {
        if (!turnsOnTheSpot(turned.start, result)) return { start: turned.start, remaining: null };
        turnedButClean ??= turned.start;
      }
      at = turned;
      wanted = result?.firstPathHeadingRad ?? null;
    }
  }
  if (turnedButClean !== null) return { start: turnedButClean, remaining: null };

  for (const candidate of candidates) {
    if (clean(trials.get(candidate) ?? null)) return { start: candidate.start, remaining: null };
  }

  const fallback = trials.get(nearest) ?? null;
  return { start: nearest.start, remaining: fallback === null ? null : addedError(before, fallback.findings) };
}

/**
 * Whether the Problems panel offers "Move the start to the nearest legal spot": there is a
 * START_ILLEGAL finding. A start that follows a waypoint is offered it too: taking it makes the
 * start a pose of its own, as a drag does, and leaves the waypoint, which other autos may use, where
 * it is (issue #133). Cheap, so it can run on every plan; the search itself, `chooseLegalStart`,
 * runs only when the fix is clicked.
 */
export function offersLegalStartFix(plan: Plan | null, findings: readonly Finding[]): boolean {
  return plan !== null && findings.some((finding) => finding.code === "START_ILLEGAL");
}

/**
 * The legal start nearest the planned one, checked against the same robot, field and alliance the
 * finding was raised for: the first one the fix tries, and the one it keeps when every start it
 * tries gains an error. Null when no pose touching a wall passes.
 */
export const legalStartFor = (plan: Plan): LegalStart | null =>
  nearestLegalStart(plan.field, plan.robot, plan.auto.alliance, plan.startPose);
