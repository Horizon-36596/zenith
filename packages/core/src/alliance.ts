import type { Field, Projection, ProjectionPhaseLabel, Robot } from "@horizon36596/zenith-schema";
import { footprintBoundsIn } from "./footprint.js";
import { angleDelta, wrapAngle } from "./geometry/angle.js";
import { convexPolygonsOverlap, rectCorners, type Rect } from "./geometry/sat.js";
import { add, rotate, type Pose, type Vec2 } from "./geometry/vec.js";
import { runLedger, type LedgerRun } from "./ledger.js";
import { mirrorHeadingRad, mirrorVec, type MirrorIds, type MirrorMode } from "./mirror.js";
import { flattenSteps } from "./plan.js";
import { noSeasonRules, type SeasonRules } from "./season.js";
import { simPoseAt, simulate } from "./sim/simulate.js";
import { traceDurationS, type Trace } from "./trace.js";
import type { Finding, Plan } from "./types.js";

/**
 * The alliance checks of spec 13 section 9: two autos on one field, the
 * user's own and a partner's, compared in time.
 *
 * Every finding here says "predicted", because both sides are instant-sim predictions and neither
 * is a promise about the match. These findings are deliberately a separate function from `check`:
 * they never feed `zenith validate`, a save, a deploy, a `propose` or a run, and `check.ts` does
 * not import this module (a test asserts it).
 *
 * Pure, like the rest of core: nothing here reads a file, a clock or a random number.
 */

/** The spacing of the comparison grid, in seconds. Projections are recorded on the same grid. */
export const ALLIANCE_TICK_S = 0.1;

/**
 * How much each robot's bounding box is grown before an overlap counts as a collision, in inches.
 * SPEC: spec 13 section 9 ("default 2 in").
 */
export const ALLIANCE_COLLISION_MARGIN_IN = 2;

/**
 * How much each box is grown before a close pass counts as a near miss, in inches.
 * SPEC: spec 13 section 9 ("default 6 in").
 */
export const ALLIANCE_NEAR_MISS_MARGIN_IN = 6;

/** The longest start offset `smallestClearingOffset` tries, in seconds. */
export const ALLIANCE_MAX_CLEARING_OFFSET_S = 10;

/**
 * The side of one field tile, in inches.
 * SPEC: the FTC game manual's field is a 6 x 6 grid of 24 in soft foam tiles (12 ft square), so in
 * the centre-origin frame the tile edges sit at every multiple of 24 in from -72 in to 72 in.
 */
export const FIELD_TILE_IN = 24;

/**
 * How many tiles make one side of the field.
 * SPEC: the FTC game manual's 6 x 6 grid of tiles.
 */
export const FIELD_TILES_PER_SIDE = 6;

/** Ticks per second on the comparison grid, kept as an integer so grid times are exact. */
const TICKS_PER_S = 10;

/** Slack for comparing grid times, in seconds: far below a tick and far above rounding error. */
const TIME_EPSILON_S = 1e-6;

// ---------------------------------------------------------------------------------------------
// The partner's input: the projection a sharing team sends (spec 13 section 8.2).
// ---------------------------------------------------------------------------------------------

/** A phase label from the fixed list a projection uses. */
export type AlliancePhaseLabel = ProjectionPhaseLabel;

/**
 * What the alliance checks read from a partner's projection: the schema's own `Projection`, as
 * `parseProjection` in `@horizon36596/zenith-schema` returns it and `projectShare` builds it. Only
 * the keys the checks use are required, so the propose level's structure and the `$schema` id are
 * optional here; there is one validator for a projection file, and it is the schema's.
 */
export type AllianceProjection = Omit<Projection, "$schema" | "structure"> & Partial<Pick<Projection, "$schema" | "structure">>;

// ---------------------------------------------------------------------------------------------
// One robot on the alliance, whichever side it came from.
// ---------------------------------------------------------------------------------------------

/**
 * The one box a robot is compared by: the union of its expanded footprint and every mouth, in the
 * robot frame. `centreOffsetIn` is where the box centre sits relative to the pose the trajectory
 * records (the centre of rotation), in the robot frame: +x toward the front, +y to the left.
 */
export interface AllianceBox {
  lengthIn: number;
  widthIn: number;
  centreOffsetIn: Vec2;
}

/** A time span of a robot's auto, labelled from the projection's fixed list. */
export interface AlliancePhase {
  startS: number;
  endS: number;
  label: AlliancePhaseLabel;
  /** The step that ran, for the user's own robot; a projection never names its steps. */
  stepId?: string;
}

/** A field element a robot's ledger says it takes from or scores into, and when. */
export interface AllianceClaim {
  elementId: string;
  action: "take" | "score";
  /** Seconds from the robot's own start, before any start offset. */
  atS: number;
  stepId?: string;
  /**
   * Where the robot is when it makes the claim, in the robot's own alliance frame, when that is
   * known: the ledger's launch pose for the user's own robot, which is not where its step began
   * when a marker launches mid-path. Left out, the claim is read at the robot's pose at `atS`, which
   * is all a projection says.
   */
  poseIn?: Pose;
}

/**
 * The season's `claimPlace` hook bound to a field: the physical place a robot at `pose` takes from
 * or scores into when its ledger names `elementId`, for an id that names different places over a
 * match, such as a BIOBUZZ hive's up cell, which is the other cell after every tip. Null when the
 * id always names one place, or when the pose does not say which.
 */
export type ClaimPlace = (elementId: string, pose: Pose) => string | null;

/** An area a robot declares it stays inside, for a time span, while its path is not known. */
export interface AllianceEnvelope {
  startS: number;
  endS: number;
  polygon: Vec2[];
}

/**
 * One robot's predicted auto, in the shape the alliance checks compare. A partner's comes from its
 * projection (`allianceRobotFromProjection`); the user's own from its instant-sim trace
 * (`allianceRobotFromTrace`, or `ownAllianceRobot` from a plan).
 *
 * Every time is seconds from that robot's own start. Every pose is in the frame of `alliance`, the
 * alliance the auto was written for; `checkAlliance` mirrors a partner written for the other one.
 */
export interface AllianceRobot {
  /** How findings name the robot: "your robot", or the partner's title. */
  label: string;
  /** The alliance the poses are written for; unknown means no mirror is ever applied. */
  alliance?: "RED" | "BLUE";
  startPose: Pose;
  boundingBox: AllianceBox;
  /** The pose every 0.1 s from t = 0. The robot holds the last one after its auto ends. */
  poses: Pose[];
  phases: AlliancePhase[];
  claims: AllianceClaim[];
  envelopes: AllianceEnvelope[];
  /** How long the auto runs, in seconds. */
  totalS: number;
}

/** A partner's projection as an alliance robot. `label` defaults to its title, then "your partner". */
export function allianceRobotFromProjection(projection: AllianceProjection, label?: string): AllianceRobot {
  const poses = projection.trajectory.poses.map(([xIn, yIn, headingRad]) => ({ xIn, yIn, headingRad }));
  return {
    label: label ?? projection.title ?? "your partner",
    alliance: projection.alliance,
    startPose: { ...projection.startPose },
    boundingBox: {
      lengthIn: projection.boundingBox.lengthIn,
      widthIn: projection.boundingBox.widthIn,
      centreOffsetIn: { ...projection.boundingBox.centreOffsetIn },
    },
    poses,
    phases: projection.phases.map((phase) => ({ ...phase })),
    claims: projection.claims.map((claim) => ({ ...claim })),
    envelopes: projection.envelopes.map((envelope) => ({
      startS: envelope.startS,
      endS: envelope.endS,
      polygon: envelope.polygon.map((vertex) => ({ ...vertex })),
    })),
    totalS: projection.totalS,
  };
}

/**
 * The robot's one comparison box, the union of `expandedIn` and every mouth box, which is what a
 * projection carries (spec 13 section 8.2), so both sides of the comparison use the same box.
 */
export function allianceBoxForRobot(robot: Robot): AllianceBox {
  const bounds = footprintBoundsIn({ xIn: 0, yIn: 0, headingRad: 0 }, robot, "expandedIn");
  return {
    lengthIn: bounds.maxXIn - bounds.minXIn,
    widthIn: bounds.maxYIn - bounds.minYIn,
    centreOffsetIn: { xIn: (bounds.minXIn + bounds.maxXIn) / 2, yIn: (bounds.minYIn + bounds.maxYIn) / 2 },
  };
}

const GROUP_KINDS = new Set(["sequence", "parallel", "branch"]);

/** The phase label a step of the user's own auto gets, from its kind and what its ledger claims. */
function phaseLabel(kind: string | undefined, claims: readonly AllianceClaim[]): AlliancePhaseLabel {
  if (claims.some((claim) => claim.action === "score")) return "score";
  if (claims.some((claim) => claim.action === "take")) return "collect";
  if (kind === "path") return "drive";
  if (kind === "wait") return "wait";
  return "other";
}

export interface AllianceRobotFromTraceOptions {
  /** The alliance the auto is written for, so a partner on the other can be mirrored onto it. */
  alliance?: "RED" | "BLUE";
  /** How findings name this robot. Default "your robot". */
  label?: string;
}

/**
 * The user's own robot from a trace: its poses resampled onto the 0.1 s grid, a phase per step
 * that ran (group steps left out, since their members say more), and the box from `robot.json`.
 *
 * `ledgerClaims` are the elements the ledger says the auto takes and scores, with the times their
 * steps start (`allianceClaimsFromLedger` works them out). Without them no element conflict can be
 * found.
 */
export function allianceRobotFromTrace(
  trace: Trace,
  robot: Robot,
  ledgerClaims: readonly AllianceClaim[] = [],
  options: AllianceRobotFromTraceOptions = {},
): AllianceRobot {
  const totalS = traceDurationS(trace);
  const count = Math.ceil(totalS * TICKS_PER_S - TIME_EPSILON_S) + 1;
  const poses: Pose[] = [];
  for (let tick = 0; tick < count; tick += 1) {
    const sampled = simPoseAt(trace, tick / TICKS_PER_S);
    if (sampled === null) break;
    poses.push(sampled);
  }
  if (poses.length === 0) throw new Error("A trace needs at least one pose to be compared with a partner.");

  const phases: AlliancePhase[] = [];
  for (const step of trace.steps) {
    const kind = (step as { kind?: unknown }).kind;
    const kindName = typeof kind === "string" ? kind : undefined;
    if (kindName !== undefined && GROUP_KINDS.has(kindName)) continue;
    const stepClaims = ledgerClaims.filter((claim) => claim.stepId === step.id);
    phases.push({ startS: step.startS, endS: step.endS, label: phaseLabel(kindName, stepClaims), stepId: step.id });
  }

  return {
    label: options.label ?? "your robot",
    ...(options.alliance === undefined ? {} : { alliance: options.alliance }),
    startPose: poses[0] as Pose,
    boundingBox: allianceBoxForRobot(robot),
    poses,
    phases,
    claims: ledgerClaims.map((claim) => ({ ...claim })),
    envelopes: [],
    totalS,
  };
}

/**
 * What the ledger says the auto takes and scores, timed by the trace: a collection is claimed on
 * the container it collects from and a launch on the target it launches into, each at the moment
 * the step that does it begins. A step the trace never ran claims nothing.
 */
export function allianceClaimsFromLedger(plan: Plan, ledgerRun: LedgerRun, trace: Trace): AllianceClaim[] {
  const startOf = new Map<string, number>();
  for (const step of trace.steps) if (!startOf.has(step.id)) startOf.set(step.id, step.startS);
  const stepsById = new Map(flattenSteps(plan.steps).map((step) => [step.id, step.step]));

  const claims: AllianceClaim[] = [];
  for (const entry of ledgerRun.entries) {
    const atS = startOf.get(entry.stepId);
    if (atS === undefined) continue;
    if (entry.collected !== null) {
      claims.push({ elementId: entry.collected.containerId, action: "take", atS, stepId: entry.stepId });
    }
    if (entry.launched > 0) {
      const step = stepsById.get(entry.stepId);
      const expected = step !== undefined && "expect" in step ? step.expect : undefined;
      const target = expected?.launchesInto ?? entry.target;
      if (target !== null && target !== "") {
        claims.push({
          elementId: target,
          action: "score",
          atS,
          stepId: entry.stepId,
          ...(entry.launchPose === undefined ? {} : { poseIn: { ...entry.launchPose } }),
        });
      }
    }
  }
  return claims;
}

/**
 * The user's own robot for a planned auto: the instant sim run once, its ledger claims, and the box
 * from the plan's `robot.json`. This is what the CLI, the MCP server and the editor all call, so
 * the three compare the same prediction.
 */
export function ownAllianceRobot(
  plan: Plan,
  field: Field,
  season: SeasonRules = noSeasonRules,
  label = "your robot",
): AllianceRobot {
  const ledgerRun = runLedger(plan, field, season);
  const trace = simulate(plan, plan.robot, field, { ledger: ledgerRun, season });
  const claims = allianceClaimsFromLedger(plan, ledgerRun, trace);
  return allianceRobotFromTrace(trace, plan.robot, claims, { alliance: plan.auto.alliance, label });
}

/**
 * The same robot on the other alliance, by the field's own mirror: every pose, envelope and the
 * box offset moved, and every claimed element renamed by the season's `mirrorId` hook when it is
 * given (an element with no counterpart keeps its name, since a shared element is the same one).
 * A field with no mirror leaves every pose where it is, but the robot is still on the other
 * alliance now, so a later `checkAlliance` does not mirror it again by its default.
 */
export function mirrorAllianceRobot(robot: AllianceRobot, mode: MirrorMode, mirrorId?: MirrorIds): AllianceRobot {
  const otherAlliance = robot.alliance === undefined ? {} : { alliance: robot.alliance === "RED" ? ("BLUE" as const) : ("RED" as const) };
  if (mode === "none") return { ...robot, ...otherAlliance };
  const reflects = mode === "mirrorX" || mode === "mirrorY";
  const mirrorPoseOf = (pose: Pose): Pose => ({
    ...mirrorVec(pose, mode),
    headingRad: mirrorHeadingRad(pose.headingRad, mode),
  });
  const rename = (id: string): string => (mirrorId === undefined ? id : (mirrorId(id) ?? id));
  return {
    ...robot,
    ...otherAlliance,
    startPose: mirrorPoseOf(robot.startPose),
    boundingBox: {
      ...robot.boundingBox,
      // A point symmetry is a half turn, which carries the robot frame with it; a reflection
      // swaps the robot's left and right.
      centreOffsetIn: {
        xIn: robot.boundingBox.centreOffsetIn.xIn,
        yIn: reflects ? -robot.boundingBox.centreOffsetIn.yIn : robot.boundingBox.centreOffsetIn.yIn,
      },
    },
    poses: robot.poses.map(mirrorPoseOf),
    phases: robot.phases.map((phase) => ({ ...phase })),
    claims: robot.claims.map((claim) => ({
      ...claim,
      elementId: rename(claim.elementId),
      ...(claim.poseIn === undefined ? {} : { poseIn: mirrorPoseOf(claim.poseIn) }),
    })),
    envelopes: robot.envelopes.map((envelope) => ({
      ...envelope,
      polygon: envelope.polygon.map((vertex) => mirrorVec(vertex, mode)),
    })),
  };
}

/**
 * The field tile a point is on, counted from the south-west corner: `column` 0 to 5 along +x and
 * `row` 0 to 5 along +y, with the tile's edges in inches. A point on an edge between two tiles
 * belongs to the tile on its positive side, and the field's north and east walls belong to the
 * last tile. Null for a point outside the field.
 */
export interface FieldTile {
  column: number;
  row: number;
  minXIn: number;
  maxXIn: number;
  minYIn: number;
  maxYIn: number;
}

export function fieldTileOf(point: Vec2): FieldTile | null {
  const halfIn = (FIELD_TILE_IN * FIELD_TILES_PER_SIDE) / 2;
  if (!(Math.abs(point.xIn) <= halfIn && Math.abs(point.yIn) <= halfIn)) return null;
  const index = (valueIn: number): number =>
    Math.min(FIELD_TILES_PER_SIDE - 1, Math.floor((valueIn + halfIn) / FIELD_TILE_IN));
  const column = index(point.xIn);
  const row = index(point.yIn);
  return {
    column,
    row,
    minXIn: column * FIELD_TILE_IN - halfIn,
    maxXIn: (column + 1) * FIELD_TILE_IN - halfIn,
    minYIn: row * FIELD_TILE_IN - halfIn,
    maxYIn: (row + 1) * FIELD_TILE_IN - halfIn,
  };
}

// ---------------------------------------------------------------------------------------------
// Geometry on the grid.
// ---------------------------------------------------------------------------------------------

/** How long a robot's prediction runs, in seconds from its own start. */
const durationS = (robot: AllianceRobot): number =>
  Math.max(robot.totalS, (robot.poses.length - 1) / TICKS_PER_S);

/**
 * Where a robot is at `timeS` on the alliance clock, given its start offset: its start pose while
 * the offset runs, its final pose after its auto ends, and the recorded poses interpolated between.
 */
export function alliancePoseAt(robot: AllianceRobot, timeS: number, offsetS = 0): Pose {
  const localS = timeS - offsetS;
  if (localS <= TIME_EPSILON_S) return robot.startPose;
  const last = robot.poses.length - 1;
  const position = localS * TICKS_PER_S;
  const index = Math.floor(position + TIME_EPSILON_S);
  if (index >= last) return robot.poses[last] as Pose;
  const a = robot.poses[index] as Pose;
  const b = robot.poses[index + 1] as Pose;
  const u = Math.max(0, position - index);
  if (u < TIME_EPSILON_S) return a;
  return {
    xIn: a.xIn + (b.xIn - a.xIn) * u,
    yIn: a.yIn + (b.yIn - a.yIn) * u,
    headingRad: wrapAngle(a.headingRad + angleDelta(a.headingRad, b.headingRad) * u),
  };
}

/** The robot's box at a pose, in the field frame, four corners counter-clockwise. */
function boxAt(robot: AllianceRobot, pose: Pose): Vec2[] {
  const box = robot.boundingBox;
  const rect: Rect = {
    centreIn: add(pose, rotate(box.centreOffsetIn, pose.headingRad)),
    lengthIn: box.lengthIn,
    widthIn: box.widthIn,
    headingRad: pose.headingRad,
  };
  return rectCorners(rect);
}

const centreOf = (polygon: readonly Vec2[]): Vec2 => {
  let xIn = 0;
  let yIn = 0;
  for (const vertex of polygon) {
    xIn += vertex.xIn;
    yIn += vertex.yIn;
  }
  return { xIn: xIn / polygon.length, yIn: yIn / polygon.length };
};

function pointSegmentDistanceIn(p: Vec2, a: Vec2, b: Vec2): number {
  const abX = b.xIn - a.xIn;
  const abY = b.yIn - a.yIn;
  const lengthSquared = abX * abX + abY * abY;
  const u =
    lengthSquared === 0
      ? 0
      : Math.min(1, Math.max(0, ((p.xIn - a.xIn) * abX + (p.yIn - a.yIn) * abY) / lengthSquared));
  return Math.hypot(p.xIn - (a.xIn + abX * u), p.yIn - (a.yIn + abY * u));
}

/**
 * How two convex polygons stand: the gap between them in inches when apart, or how deep they
 * overlap when they touch. The gap between two convex shapes that do not meet is always from a
 * vertex of one to an edge of the other.
 */
function separation(a: readonly Vec2[], b: readonly Vec2[]): { gapIn: number; overlapIn: number } {
  const overlap = convexPolygonsOverlap(a, b);
  if (overlap.overlaps) return { gapIn: 0, overlapIn: overlap.penetrationIn };
  let gapIn = Infinity;
  for (const [points, edges] of [
    [a, b],
    [b, a],
  ] as const) {
    for (const p of points) {
      for (let i = 0; i < edges.length; i += 1) {
        const from = edges[i] as Vec2;
        const to = edges[(i + 1) % edges.length] as Vec2;
        gapIn = Math.min(gapIn, pointSegmentDistanceIn(p, from, to));
      }
    }
  }
  return { gapIn, overlapIn: 0 };
}

const orientation = (a: Vec2, b: Vec2, c: Vec2): number =>
  (b.xIn - a.xIn) * (c.yIn - a.yIn) - (b.yIn - a.yIn) * (c.xIn - a.xIn);

const onSegment = (a: Vec2, b: Vec2, p: Vec2): boolean =>
  Math.min(a.xIn, b.xIn) <= p.xIn &&
  p.xIn <= Math.max(a.xIn, b.xIn) &&
  Math.min(a.yIn, b.yIn) <= p.yIn &&
  p.yIn <= Math.max(a.yIn, b.yIn);

function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  return (
    (o1 === 0 && onSegment(a, b, c)) ||
    (o2 === 0 && onSegment(a, b, d)) ||
    (o3 === 0 && onSegment(c, d, a)) ||
    (o4 === 0 && onSegment(c, d, b))
  );
}

/** Even-odd point in polygon, which works for a concave envelope as well as a convex one. */
function pointInPolygon(p: Vec2, polygon: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i] as Vec2;
    const b = polygon[j] as Vec2;
    if (a.yIn > p.yIn !== b.yIn > p.yIn) {
      const crossingXIn = a.xIn + ((p.yIn - a.yIn) * (b.xIn - a.xIn)) / (b.yIn - a.yIn);
      if (p.xIn < crossingXIn) inside = !inside;
    }
  }
  return inside;
}

/**
 * Whether an oriented box meets a polygon, which may be concave: some edge of one crosses an edge
 * of the other, or one lies wholly inside the other.
 */
export function boxIntersectsPolygon(box: readonly Vec2[], polygon: readonly Vec2[]): boolean {
  for (let i = 0; i < box.length; i += 1) {
    const a = box[i] as Vec2;
    const b = box[(i + 1) % box.length] as Vec2;
    for (let j = 0; j < polygon.length; j += 1) {
      if (segmentsIntersect(a, b, polygon[j] as Vec2, polygon[(j + 1) % polygon.length] as Vec2)) return true;
    }
  }
  if (box.length > 0 && pointInPolygon(box[0] as Vec2, polygon)) return true;
  return polygon.length > 0 && pointInPolygon(polygon[0] as Vec2, box);
}

// ---------------------------------------------------------------------------------------------
// The checks.
// ---------------------------------------------------------------------------------------------

export interface AllianceOptions {
  /** Each box is grown by this before an overlap counts as ALLIANCE_COLLISION. Default 2 in. */
  collisionMarginIn?: number;
  /** Each box is grown by this before a close pass counts as ALLIANCE_NEAR_MISS. Default 6 in. */
  nearMissMarginIn?: number;
  /** How long the user's robot waits at its start pose before its auto begins. Default 0 s. */
  ownStartOffsetS?: number;
  /** The same for each partner, by index. Missing entries are 0 s. */
  partnerStartOffsetsS?: number[];
  /**
   * The field's mirror (`mirrorForField`), applied to a partner written for the other alliance.
   * Default point symmetry, which is how BIOBUZZ and most FTC fields are symmetric.
   */
  mirror?: MirrorMode;
  /** The season's `mirrorId` hook, to rename a mirrored partner's claimed elements. */
  mirrorId?: MirrorIds;
  /**
   * The season's `claimPlace` hook, bound to the field, so two claims on one element id that land
   * in different physical places do not conflict. Left out, an element id is one place.
   */
  claimPlace?: ClaimPlace;
}

const seconds = (valueS: number): string => `${valueS.toFixed(1)} s`;
const inches = (valueIn: number): string => `${valueIn.toFixed(1)} in`;
/** A margin as the user set it, without trailing zeros: "2 in", "0.5 in". */
const margin = (valueIn: number): string => `${String(Number(valueIn.toFixed(2)))} in`;

/** What a robot is doing at an alliance time, for a message, and the step when it is known. */
function activity(robot: AllianceRobot, timeS: number, offsetS: number): { text: string; stepId?: string } {
  const localS = timeS - offsetS;
  if (localS < -TIME_EPSILON_S) {
    return { text: `waiting out its ${seconds(offsetS)} start offset` };
  }
  let found: AlliancePhase | undefined;
  let foundIndex = -1;
  robot.phases.forEach((phase, index) => {
    const inside =
      phase.startS <= localS + TIME_EPSILON_S &&
      (localS < phase.endS - TIME_EPSILON_S ||
        (phase.endS <= phase.startS + TIME_EPSILON_S && localS <= phase.endS + TIME_EPSILON_S));
    // The latest-starting phase is the innermost one when phases nest.
    if (inside && (found === undefined || phase.startS >= found.startS)) {
      found = phase;
      foundIndex = index;
    }
  });
  if (found === undefined || foundIndex < 0) {
    return { text: localS >= durationS(robot) - TIME_EPSILON_S ? "parked at its final pose" : "between phases" };
  }
  const phase: AlliancePhase = found;
  return phase.stepId === undefined
    ? { text: `in a ${phase.label} phase` }
    : { text: `in step ${JSON.stringify(phase.stepId)} (${phase.label})`, stepId: phase.stepId };
}

const ALLIANCE_STEP_ID = "(alliance)";

interface Episode {
  firstTick: number;
  lastTick: number;
  closestTick: number;
  closestGapIn: number;
  deepestOverlapIn: number;
  deepestTick: number;
}

const startEpisode = (tick: number, gapIn: number, overlapIn: number): Episode => ({
  firstTick: tick,
  lastTick: tick,
  closestTick: tick,
  closestGapIn: gapIn,
  deepestOverlapIn: overlapIn,
  deepestTick: tick,
});

function extendEpisode(episode: Episode, tick: number, gapIn: number, overlapIn: number): void {
  episode.lastTick = tick;
  if (gapIn < episode.closestGapIn) {
    episode.closestGapIn = gapIn;
    episode.closestTick = tick;
  }
  if (overlapIn > episode.deepestOverlapIn) {
    episode.deepestOverlapIn = overlapIn;
    episode.deepestTick = tick;
  }
}

function validateOptions(options: AllianceOptions): void {
  const collision = options.collisionMarginIn ?? ALLIANCE_COLLISION_MARGIN_IN;
  const near = options.nearMissMarginIn ?? ALLIANCE_NEAR_MISS_MARGIN_IN;
  if (!Number.isFinite(collision) || collision < 0) {
    throw new RangeError("collisionMarginIn must be a finite number of inches, zero or more.");
  }
  if (!Number.isFinite(near) || near < collision) {
    throw new RangeError("nearMissMarginIn must be a finite number of inches at least as large as collisionMarginIn.");
  }
  for (const offset of [options.ownStartOffsetS ?? 0, ...(options.partnerStartOffsetsS ?? [])]) {
    if (!Number.isFinite(offset) || offset < 0) {
      throw new RangeError("A start offset must be a finite number of seconds, zero or more.");
    }
  }
}

/**
 * Compares the user's robot with each partner on a 0.1 s grid and returns the alliance findings,
 * partner by partner in the order given, each partner's in time order:
 *
 * - ALLIANCE_START_OVERLAP (error): the two boxes overlap at their start poses, or the two start
 *   poses (each robot's centre of rotation) are on the same field tile. No start offset can fix
 *   it, since a robot waiting out an offset holds its start pose.
 * - ALLIANCE_COLLISION (error): the boxes, each grown by `collisionMarginIn`, overlap. One finding
 *   per contiguous run of ticks, at its first tick, naming both robots' phases and the closest
 *   approach of the ungrown boxes during the run.
 * - ALLIANCE_NEAR_MISS (warning): the boxes, each grown by `nearMissMarginIn`, overlap in a run of
 *   ticks with no collision in it. One finding per run, not one per tick.
 *
 * A box "grown by a margin" is grown by it in every direction, rounded at the corners, so two
 * grown boxes overlap exactly when the real boxes come closer than twice the margin. That keeps
 * "the closest approach" in every message on the same measure the test uses.
 * - ALLIANCE_ENVELOPE (warning): the user's box meets a partner's envelope polygon while that
 *   envelope is active. One finding per contiguous run.
 * - ALLIANCE_ELEMENT_CONFLICT (warning): both claim the same element with the same action. One
 *   finding per element and action, naming the robot that gets there first. With a `claimPlace`
 *   hook, two claims on one id whose places are both known and differ are not the same element.
 *
 * A robot holds its start pose while its start offset runs and its final pose after its auto ends.
 * A partner written for the other alliance is mirrored onto the user's first. Partners are not
 * compared with each other: the checks are about the user's own auto.
 */
export function checkAlliance(
  own: AllianceRobot,
  partners: readonly AllianceRobot[],
  options: AllianceOptions = {},
): Finding[] {
  validateOptions(options);
  const collisionMarginIn = options.collisionMarginIn ?? ALLIANCE_COLLISION_MARGIN_IN;
  const nearMissMarginIn = options.nearMissMarginIn ?? ALLIANCE_NEAR_MISS_MARGIN_IN;
  const ownOffsetS = options.ownStartOffsetS ?? 0;
  const findings: Finding[] = [];
  partners.forEach((given, index) => {
    const partner = alignPartner(own, given, options);
    const partnerOffsetS = options.partnerStartOffsetsS?.[index] ?? 0;
    findings.push(
      ...checkPair(own, partner, ownOffsetS, partnerOffsetS, collisionMarginIn, nearMissMarginIn, options.claimPlace),
    );
  });
  return findings;
}

/** The partner in the user's alliance frame: mirrored when it was written for the other alliance. */
function alignPartner(own: AllianceRobot, partner: AllianceRobot, options: AllianceOptions): AllianceRobot {
  if (own.alliance === undefined || partner.alliance === undefined || own.alliance === partner.alliance) {
    return partner;
  }
  return mirrorAllianceRobot(partner, options.mirror ?? "pointSymmetry", options.mirrorId);
}

function checkPair(
  own: AllianceRobot,
  partner: AllianceRobot,
  ownOffsetS: number,
  partnerOffsetS: number,
  collisionMarginIn: number,
  nearMissMarginIn: number,
  claimPlace: ClaimPlace | undefined,
): Finding[] {
  const findings: Finding[] = [];
  const name = partner.label;

  // Start poses.
  const ownStart = boxAt(own, own.startPose);
  const partnerStart = boxAt(partner, partner.startPose);
  const startOverlap = convexPolygonsOverlap(ownStart, partnerStart);
  if (startOverlap.overlaps) {
    findings.push({
      severity: "error",
      stepId: ALLIANCE_STEP_ID,
      timeS: 0,
      code: "ALLIANCE_START_OVERLAP",
      message: `Predicted start overlap with ${name}: the two start poses overlap by ${inches(startOverlap.penetrationIn)}, so both robots cannot be set up where the autos say. A start offset cannot fix this; one of the start poses has to move.`,
      geometry: { polygonIn: partnerStart, penetrationIn: startOverlap.penetrationIn },
    });
  } else {
    // Two robots are never set up on one tile, even when their boxes happen to clear each other.
    const ownTile = fieldTileOf(own.startPose);
    const partnerTile = fieldTileOf(partner.startPose);
    if (ownTile !== null && partnerTile !== null && ownTile.column === partnerTile.column && ownTile.row === partnerTile.row) {
      const span = `x ${String(ownTile.minXIn)} to ${String(ownTile.maxXIn)} in, y ${String(ownTile.minYIn)} to ${String(ownTile.maxYIn)} in`;
      findings.push({
        severity: "error",
        stepId: ALLIANCE_STEP_ID,
        timeS: 0,
        code: "ALLIANCE_START_OVERLAP",
        message: `Predicted start overlap with ${name}: both robots start on the same field tile (${span}), so both cannot be set up where the autos say. A start offset cannot fix this; one of the start poses has to move to another tile.`,
        geometry: {
          polygonIn: [
            { xIn: ownTile.minXIn, yIn: ownTile.minYIn },
            { xIn: ownTile.maxXIn, yIn: ownTile.minYIn },
            { xIn: ownTile.maxXIn, yIn: ownTile.maxYIn },
            { xIn: ownTile.minXIn, yIn: ownTile.maxYIn },
          ],
        },
      });
    }
  }

  // The grid, out to the moment both robots have finished and every envelope has ended.
  const envelopeEndS = partner.envelopes.reduce((latest, envelope) => Math.max(latest, envelope.endS), 0);
  const endS = Math.max(ownOffsetS + durationS(own), partnerOffsetS + Math.max(durationS(partner), envelopeEndS));
  const lastTick = Math.ceil(endS * TICKS_PER_S - TIME_EPSILON_S);

  const timed: Finding[] = [];
  let collision: Episode | null = null;
  let near: (Episode & { collided: boolean }) | null = null;

  const ownPoseAt = (tick: number): Pose => alliancePoseAt(own, tick / TICKS_PER_S, ownOffsetS);
  const partnerPoseAt = (tick: number): Pose => alliancePoseAt(partner, tick / TICKS_PER_S, partnerOffsetS);

  const describe = (tick: number): { ownText: string; partnerText: string; stepId: string; midIn: Vec2; partnerBox: Vec2[] } => {
    const timeS = tick / TICKS_PER_S;
    const ownDoing = activity(own, timeS, ownOffsetS);
    const partnerDoing = activity(partner, timeS, partnerOffsetS);
    const ownBox = boxAt(own, ownPoseAt(tick));
    const partnerBox = boxAt(partner, partnerPoseAt(tick));
    const a = centreOf(ownBox);
    const b = centreOf(partnerBox);
    return {
      ownText: ownDoing.text,
      partnerText: partnerDoing.text,
      stepId: ownDoing.stepId ?? ALLIANCE_STEP_ID,
      midIn: { xIn: (a.xIn + b.xIn) / 2, yIn: (a.yIn + b.yIn) / 2 },
      partnerBox,
    };
  };

  /** When a run of ticks happened; a run still going when both autos have ended says so. */
  const spanOf = (episode: Episode): string => {
    const from = seconds(episode.firstTick / TICKS_PER_S);
    if (episode.lastTick === lastTick && episode.lastTick > episode.firstTick) {
      return `from ${from} on, and still do when both autos have ended`;
    }
    return episode.lastTick === episode.firstTick
      ? `at ${from}`
      : `from ${from} to ${seconds(episode.lastTick / TICKS_PER_S)}`;
  };

  const closest = (episode: Episode): string =>
    episode.deepestOverlapIn > 0
      ? `the boxes overlap by up to ${inches(episode.deepestOverlapIn)} at ${seconds(episode.deepestTick / TICKS_PER_S)}`
      : `the closest approach is ${inches(episode.closestGapIn)} at ${seconds(episode.closestTick / TICKS_PER_S)}`;

  const endCollision = (episode: Episode): void => {
    const at = describe(episode.firstTick);
    timed.push({
      severity: "error",
      stepId: at.stepId,
      timeS: episode.firstTick / TICKS_PER_S,
      code: "ALLIANCE_COLLISION",
      message: `Predicted collision with ${name} at ${seconds(episode.firstTick / TICKS_PER_S)}: your robot is ${at.ownText} and ${name} is ${at.partnerText}. The two boxes, each grown by ${margin(collisionMarginIn)}, overlap ${spanOf(episode)}; ${closest(episode)}.`,
      geometry: {
        pointIn: at.midIn,
        polygonIn: at.partnerBox,
        ...(episode.deepestOverlapIn > 0 ? { penetrationIn: episode.deepestOverlapIn } : {}),
      },
    });
  };

  const endNear = (episode: Episode & { collided: boolean }): void => {
    if (episode.collided) return;
    const at = describe(episode.closestTick);
    timed.push({
      severity: "warning",
      stepId: at.stepId,
      timeS: episode.firstTick / TICKS_PER_S,
      code: "ALLIANCE_NEAR_MISS",
      message: `Predicted near miss with ${name} ${spanOf(episode)}: the closest approach is ${inches(episode.closestGapIn)} at ${seconds(episode.closestTick / TICKS_PER_S)}, while your robot is ${at.ownText} and ${name} is ${at.partnerText}. That is inside the ${margin(nearMissMarginIn)} near-miss margin on each robot, without touching the ${margin(collisionMarginIn)} collision margin.`,
      geometry: { pointIn: at.midIn, polygonIn: at.partnerBox },
    });
  };

  for (let tick = 0; tick <= lastTick; tick += 1) {
    const { gapIn, overlapIn } = separation(boxAt(own, ownPoseAt(tick)), boxAt(partner, partnerPoseAt(tick)));
    const collides = overlapIn > 0 || gapIn < 2 * collisionMarginIn;
    const close = collides || gapIn < 2 * nearMissMarginIn;

    if (collides) {
      if (collision === null) collision = startEpisode(tick, gapIn, overlapIn);
      else extendEpisode(collision, tick, gapIn, overlapIn);
    } else if (collision !== null) {
      endCollision(collision);
      collision = null;
    }

    if (close) {
      if (near === null) near = { ...startEpisode(tick, gapIn, overlapIn), collided: collides };
      else {
        extendEpisode(near, tick, gapIn, overlapIn);
        near.collided = near.collided || collides;
      }
    } else if (near !== null) {
      endNear(near);
      near = null;
    }
  }
  if (collision !== null) endCollision(collision);
  if (near !== null) endNear(near);

  timed.push(...checkEnvelopes(own, partner, ownOffsetS, partnerOffsetS));
  // Stable, so two findings at one time keep the order they were raised in.
  timed.sort((a, b) => (a.timeS ?? 0) - (b.timeS ?? 0));
  findings.push(...timed);
  findings.push(...checkClaims(own, partner, ownOffsetS, partnerOffsetS, claimPlace));
  return findings;
}

/** ALLIANCE_ENVELOPE: the user's box inside a partner's envelope while the envelope is active. */
function checkEnvelopes(
  own: AllianceRobot,
  partner: AllianceRobot,
  ownOffsetS: number,
  partnerOffsetS: number,
): Finding[] {
  const findings: Finding[] = [];
  const name = partner.label;
  for (const envelope of partner.envelopes) {
    const fromS = envelope.startS + partnerOffsetS;
    const toS = envelope.endS + partnerOffsetS;
    const firstTick = Math.ceil(fromS * TICKS_PER_S - TIME_EPSILON_S);
    const lastTick = Math.floor(toS * TICKS_PER_S + TIME_EPSILON_S);
    let run: { first: number; last: number } | null = null;
    const emit = (span: { first: number; last: number }): void => {
      const timeS = span.first / TICKS_PER_S;
      const doing = activity(own, timeS, ownOffsetS);
      findings.push({
        severity: "warning",
        stepId: doing.stepId ?? ALLIANCE_STEP_ID,
        timeS,
        code: "ALLIANCE_ENVELOPE",
        message: `Predicted entry into ${name}'s envelope at ${seconds(timeS)}, while your robot is ${doing.text}: it stays inside until ${seconds(span.last / TICKS_PER_S)}. ${name} has reserved that area from ${seconds(fromS)} to ${seconds(toS)} while its path is not known. Passing through is allowed.`,
        geometry: { polygonIn: envelope.polygon.map((vertex) => ({ ...vertex })) },
      });
    };
    for (let tick = firstTick; tick <= lastTick; tick += 1) {
      const inside = boxIntersectsPolygon(
        boxAt(own, alliancePoseAt(own, tick / TICKS_PER_S, ownOffsetS)),
        envelope.polygon,
      );
      if (inside) {
        if (run === null) run = { first: tick, last: tick };
        else run.last = tick;
      } else if (run !== null) {
        emit(run);
        run = null;
      }
    }
    if (run !== null) emit(run);
  }
  return findings;
}

/** A claim with the alliance time it is made at and the physical place it lands, when known. */
interface PlacedClaim {
  claim: AllianceClaim;
  atS: number;
  place: string | null;
}

/** A robot's claims in time order, each placed by the season's hook at the pose it was made from. */
function placedClaims(robot: AllianceRobot, offsetS: number, claimPlace: ClaimPlace | undefined): PlacedClaim[] {
  return robot.claims
    .map((claim) => ({
      claim,
      atS: claim.atS + offsetS,
      place:
        claimPlace === undefined ? null : claimPlace(claim.elementId, claim.poseIn ?? alliancePoseAt(robot, claim.atS)),
    }))
    .sort((a, b) => a.atS - b.atS);
}

/**
 * Whether two claims are on the same element: the same id and action, in the same place. A place
 * that is not known may be either, so it matches any.
 */
const sameElement = (a: PlacedClaim, b: PlacedClaim): boolean =>
  a.claim.elementId === b.claim.elementId &&
  a.claim.action === b.claim.action &&
  (a.place === null || b.place === null || a.place === b.place);

/**
 * ALLIANCE_ELEMENT_CONFLICT: both robots take from, or score into, the same element. A BIOBUZZ
 * hive's up cell is one id for two physical cells, the other one up after every tip, so with the
 * season's `claimPlace` hook a claim is placed at the pose it was made from and two claims in
 * different cells are not a conflict.
 */
function checkClaims(
  own: AllianceRobot,
  partner: AllianceRobot,
  ownOffsetS: number,
  partnerOffsetS: number,
  claimPlace: ClaimPlace | undefined,
): Finding[] {
  const findings: Finding[] = [];
  const name = partner.label;
  const ours = placedClaims(own, ownOffsetS, claimPlace);
  const theirs = placedClaims(partner, partnerOffsetS, claimPlace);
  const seen = new Set<string>();
  for (const mine of ours) {
    const { claim } = mine;
    const key = `${claim.action}\u0000${claim.elementId}\u0000${mine.place ?? ""}`;
    if (seen.has(key)) continue;
    // Time order, so the first match is the partner's earliest.
    const rival = theirs.find((other) => sameElement(mine, other));
    if (rival === undefined) continue;
    seen.add(key);
    // `ours` is in time order too, so `mine` is our robot's earliest claim with this key.
    const ownAtS = mine.atS;
    const partnerAtS = rival.atS;
    const place = mine.place ?? rival.place;
    const element = place === null ? claim.elementId : `${claim.elementId} (${place})`;
    const verb = claim.action === "take" ? "take from" : "score into";
    const order =
      Math.abs(ownAtS - partnerAtS) < ALLIANCE_TICK_S / 2
        ? `both get there at about ${seconds(ownAtS)}`
        : ownAtS < partnerAtS
          ? `your robot gets there first, at ${seconds(ownAtS)}, and ${name} at ${seconds(partnerAtS)}`
          : `${name} gets there first, at ${seconds(partnerAtS)}, and your robot at ${seconds(ownAtS)}`;
    findings.push({
      severity: "warning",
      stepId: claim.stepId ?? ALLIANCE_STEP_ID,
      timeS: Math.min(ownAtS, partnerAtS),
      code: "ALLIANCE_ELEMENT_CONFLICT",
      message: `Predicted element conflict with ${name}: both autos ${verb} ${element}; ${order}.`,
    });
  }
  return findings;
}

/** A start offset for the user's robot that the fix search found. */
export interface ClearingOffset {
  /** Seconds the user's robot should wait at its start pose. */
  offsetS: number;
}

/**
 * The alliance codes a later start or a wait step can clear, which are the ones the two one-click
 * fixes of spec 13 section 9 are offered for. The other two have no automatic fix, on purpose:
 *
 * - ALLIANCE_START_OVERLAP: a robot waiting out an offset or a wait holds its start pose, so no
 *   amount of waiting moves it off its partner's tile. One of the two start poses has to move, and
 *   which one, and where to, is for the two teams to agree.
 * - ALLIANCE_ELEMENT_CONFLICT: both ledgers still claim the element whenever each robot gets
 *   there, so no delay removes the claim. Which team takes it is a strategy decision.
 */
export type ClearableAllianceCode = "ALLIANCE_COLLISION" | "ALLIANCE_NEAR_MISS" | "ALLIANCE_ENVELOPE";

/**
 * For each clearable code, every code a fix for it must leave no finding of. A fix never trades a
 * warning for a predicted collision, so every set holds ALLIANCE_COLLISION. A near miss is cleared
 * only when the robots also stop colliding, because `checkAlliance` reports a close pass that
 * turns into a collision as the collision alone.
 */
const CLEARS: Record<ClearableAllianceCode, readonly string[]> = {
  ALLIANCE_COLLISION: ["ALLIANCE_COLLISION"],
  ALLIANCE_NEAR_MISS: ["ALLIANCE_COLLISION", "ALLIANCE_NEAR_MISS"],
  ALLIANCE_ENVELOPE: ["ALLIANCE_COLLISION", "ALLIANCE_ENVELOPE"],
};

/** Whether a finding code is one a later start or a wait can clear. */
export function isClearableAllianceCode(code: string): code is ClearableAllianceCode {
  return Object.prototype.hasOwnProperty.call(CLEARS, code);
}

/** Whether a set of findings leaves nothing that a fix for `code` has to clear. */
export function allianceFixCleared(findings: readonly Finding[], code: ClearableAllianceCode): boolean {
  const clears = CLEARS[code];
  return !findings.some((finding) => clears.includes(finding.code));
}

/**
 * The "delay my start until this clears" fix: the smallest start offset for the user's robot, in
 * 0.1 s steps from 0 s up to 10 s, that leaves no finding of `code` with any partner, and no
 * ALLIANCE_COLLISION either (`allianceFixCleared`). The code defaults to ALLIANCE_COLLISION. 0
 * means nothing needs to change. Null means no offset in that range clears it.
 *
 * For ALLIANCE_ENVELOPE that is the smallest delay that keeps the user's robot out of every
 * partner envelope while the envelope is active: at most the wait until the window closes, and
 * less when the robot only has to arrive after its partner has left.
 *
 * ALLIANCE_START_OVERLAP is left out of the test on purpose: a robot waiting out an offset holds
 * its start pose, so no offset can fix overlapping starts, and counting it would make every
 * search fail. A start overlap that also collides at the first tick still fails the search,
 * through the collision it causes. Element conflicts never block an offset, and neither do the
 * warnings `code` does not name. `options.ownStartOffsetS` is ignored; the partners keep theirs.
 */
export function smallestClearingOffset(
  own: AllianceRobot,
  partners: readonly AllianceRobot[],
  options: AllianceOptions = {},
  code: ClearableAllianceCode = "ALLIANCE_COLLISION",
): ClearingOffset | null {
  const maxTicks = Math.round(ALLIANCE_MAX_CLEARING_OFFSET_S * TICKS_PER_S);
  for (let tick = 0; tick <= maxTicks; tick += 1) {
    const offsetS = tick / TICKS_PER_S;
    const findings = checkAlliance(own, partners, { ...options, ownStartOffsetS: offsetS });
    if (allianceFixCleared(findings, code)) return { offsetS };
  }
  return null;
}
