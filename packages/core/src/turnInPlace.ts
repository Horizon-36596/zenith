import { wrapAngle } from "./geometry/angle.js";
import { turnInPlaceS, type RobotLimits } from "./kinematics.js";
import type { PlanStep } from "./types.js";

/**
 * A turn on the spot: a path step with no length, which the robot runtime runs as
 * `follower.hold` at the step's end pose until the robot has settled there (decision D10, issue
 * #187). Pedro is never handed the zero-length line, so the robot turns from the heading it arrives
 * with to the end heading, the short way, and the plan, the estimate, the ideal level and the instant
 * sim all model exactly that turn.
 *
 * The runtime holds every path step of `TURN_IN_PLACE_MAX_IN` or less, and `TurnSettle` says when
 * the hold is done: at once when the heading is within `TURN_SETTLED_RAD` and the position within
 * `TURN_ARRIVED_IN` of the held pose, or once the robot has come to rest near it for
 * `TURN_STILL_S`. A short drive with no heading change is therefore not done before the robot has
 * moved, and a hold that rests a little further off than the tolerance still ends.
 */

/**
 * A path step at most this long, in inches, is a turn on the spot for the planner: its ends are one
 * spot. The same figure as `IDEAL_POSITION_TOLERANCE_IN`, the ideal level's "same place".
 */
export const TURN_IN_PLACE_LENGTH_IN = 0.01;

/**
 * The longest path step the runtime runs as a turn on the spot rather than hands to Pedro, in
 * inches: `PedroPaths.TURN_IN_PLACE_MAX_IN` in robot/auto-runtime. The runtime measures the path it
 * builds, so a turn written from `"current"` is still a turn when the robot arrives a little short of
 * where the step before it ended. A path step this short that does have a length is still planned as
 * a path, and the estimate gives it at least the time its heading change takes at the angular limit.
 */
export const TURN_IN_PLACE_MAX_IN = 2;

/**
 * The heading error a turn on the spot ends within at once, in radians: two degrees. SET FROM SIM:
 * about twice the largest error the instant sim's hold comes to rest at with Pedro's default heading
 * P, 1.5 per rad, over a sweep of every whole degree of target (0.019 rad, `turnInPlace.test.ts`),
 * because the sim's motors stop below 0.02 power and Pedro skips a power change under 0.01. One
 * degree, the first figure, sat right at that error and some turns never ended. Pedro's own hold end
 * constraint, 0.007 rad, is tighter still. `PedroPaths.TURN_SETTLED_RAD` in the runtime.
 */
export const TURN_SETTLED_RAD = (2 * Math.PI) / 180;

/**
 * How near the held point the robot must be before a turn on the spot ends at once, in inches: half
 * an inch, set by hand, the same figure as `CONTINUITY_TOLERANCE_IN`, the editor's "same spot"
 * (`PedroPaths.TURN_ARRIVED_IN`). Pedro's own hold end constraint, 0.1 in, is tighter than a hold's
 * translational P can always reach against friction, as with the heading.
 */
export const TURN_ARRIVED_IN = 0.5;

/**
 * How long the robot must stay still near the held pose before a turn on the spot ends anyway, in
 * seconds: a quarter of a second, set by hand (`PedroPaths.TURN_STILL_S`). A hold whose P cannot
 * push the robot inside `TURN_SETTLED_RAD` and `TURN_ARRIVED_IN` against friction, a weaker heading P
 * than the sim's or a stickier floor, leaves the robot at rest a little off; the turn has then done
 * all it will, and waiting longer would only stop the routine.
 */
export const TURN_STILL_S = 0.25;

/**
 * "Still", for `TURN_STILL_S`: the heading stays within this of where it was when the robot last
 * moved, in radians, a quarter of a degree, set by hand (`PedroPaths.TURN_STILL_RAD`). About one
 * degree a second over the quarter second, slower than any turn the hold still drives.
 */
export const TURN_STILL_RAD = (0.25 * Math.PI) / 180;

/**
 * "Still", for `TURN_STILL_S`: the position stays within this of where it was when the robot last
 * moved, in inches, set by hand (`PedroPaths.TURN_STILL_IN`). A fifth of an inch a second.
 */
export const TURN_STILL_IN = 0.05;

/**
 * "Near", for `TURN_STILL_S`: a robot at rest ends the turn only within this heading error, in
 * radians, ten degrees, set by hand (`PedroPaths.TURN_NEAR_RAD`), and within `TURN_IN_PLACE_MAX_IN`
 * of the held point. So a robot that has not started moving yet, or is pinned against something far
 * from the turn, is not taken for one that has finished; the step's `timeoutS` ends that one.
 */
export const TURN_NEAR_RAD = (10 * Math.PI) / 180;

type PoseXYH = { readonly x: number; readonly y: number; readonly heading: number };

/**
 * Whether a held turn on the spot has settled within the tolerances: the heading within
 * `TURN_SETTLED_RAD` of the held heading, the short way round, and the position within
 * `TURN_ARRIVED_IN` of the held point. `PedroPaths.turnSettled` in the runtime.
 */
export function turnSettled(held: PoseXYH, robot: PoseXYH): boolean {
  return (
    Math.abs(holdTurnRad(robot.heading, held.heading)) < TURN_SETTLED_RAD &&
    Math.hypot(held.x - robot.x, held.y - robot.y) < TURN_ARRIVED_IN
  );
}

/**
 * When a held turn on the spot is done, `PedroPaths.TurnSettle` in the runtime, which both runtimes'
 * `TurnInPlace` and the instant sim's `FollowCommand` ask every loop. Done at once when
 * `turnSettled`; otherwise done once the robot has stayed within `TURN_STILL_RAD` and
 * `TURN_STILL_IN` of one pose for `TURN_STILL_S` while within `TURN_NEAR_RAD` and
 * `TURN_IN_PLACE_MAX_IN` of the held pose. The clock is passed in, so asking twice in one loop
 * changes nothing, and the class stays free of a clock of its own.
 */
export class TurnSettle {
  private anchor: PoseXYH | null = null;
  private anchorS = 0;

  constructor(readonly held: PoseXYH) {}

  /** Whether the turn is done, given the robot's pose now and the time now in seconds. */
  done(robot: PoseXYH, nowS: number): boolean {
    if (turnSettled(this.held, robot)) return true;
    const anchor = this.anchor;
    if (
      anchor === null ||
      Math.abs(holdTurnRad(anchor.heading, robot.heading)) > TURN_STILL_RAD ||
      Math.hypot(anchor.x - robot.x, anchor.y - robot.y) > TURN_STILL_IN
    ) {
      this.anchor = { x: robot.x, y: robot.y, heading: robot.heading };
      this.anchorS = nowS;
      return false;
    }
    return (
      nowS - this.anchorS >= TURN_STILL_S &&
      Math.abs(holdTurnRad(robot.heading, this.held.heading)) < TURN_NEAR_RAD &&
      Math.hypot(this.held.x - robot.x, this.held.y - robot.y) < TURN_IN_PLACE_MAX_IN
    );
  }
}

/**
 * The extra seconds a newly inserted turn on the spot's default `timeoutS` allows on top of the
 * estimate of a half turn: one and a half seconds, set by hand. The estimate times only the turn at
 * the angular limit; the hold also brakes and settles. Over a sweep of every whole degree of target
 * the instant sim's longest turn on the spot ran 0.67 s past its estimate with Pedro's default
 * heading P, and 1.2 s past it with a heading P of 0.4 that ends on `TURN_STILL_S`
 * (`turnInPlace.test.ts`), so the margin covers both with room for a robot's own loop.
 */
export const TURN_TIMEOUT_MARGIN_S = 1.5;

/**
 * The `timeoutS` the editor gives a newly inserted turn on the spot, in seconds, so a hold that
 * never settles cannot stop the routine: the estimate's time for a half turn, the most a turn on the
 * spot can turn because the hold goes the short way, plus `TURN_TIMEOUT_MARGIN_S`, rounded up to a
 * tenth of a second. A half turn, not the turn as inserted, so dragging the end heading round later
 * never leaves a timeout that cuts the turn short.
 */
export function defaultTurnTimeoutS(limits: RobotLimits): number {
  return Math.ceil((turnInPlaceS(limits, Math.PI) + TURN_TIMEOUT_MARGIN_S) * 10 - 1e-9) / 10;
}

/** The most the planned sweep of a turn on the spot turns between two of its samples: 5 degrees. */
export const TURN_SAMPLE_RAD = (5 * Math.PI) / 180;

/** True for a planned path step that is a turn on the spot: it has geometry and no length. */
export const isTurnInPlace = (step: Pick<PlanStep, "kind" | "geometry">): boolean =>
  step.kind === "path" && step.geometry !== undefined && step.geometry.lengthIn <= TURN_IN_PLACE_LENGTH_IN;

/**
 * The turn a hold makes from one heading to another, signed, in radians: Pedro's
 * `Angle.normalizeSigned` of the error, into [-pi, pi), so an exact half turn goes clockwise, as
 * the hold's heading correction turns it on the robot.
 */
export function holdTurnRad(fromRad: number, toRad: number): number {
  const wrapped = wrapAngle(toRad - fromRad);
  return wrapped === Math.PI ? -Math.PI : wrapped;
}
