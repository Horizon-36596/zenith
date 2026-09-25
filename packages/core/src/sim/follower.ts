import type { XY } from "./curves.js";
import { normalizeAngle, normalizeSigned, theta, turnDirection, type SimPath } from "./pedroPath.js";
import type { FollowerParams } from "./types.js";

/**
 * Pedro Pathing v3's follower as biobuzz runs it: `follower/Follower.java`,
 * `algorithm/ForesightV3.java` and `algorithm/ForesightPowerAllocator.java` from
 * core-3.0.0-20260828.185437-17, and the power maths of `revhub/drivetrains/Mecanum.java` and
 * `CachedMotor.java` from the matching revhub jar. Ported line for line where it decides anything;
 * the ADR lists the few places it is not.
 *
 * ForesightV3 is not the drive/translational/heading/centripetal PIDF follower of Pedro v1 and v2.
 * It projects where the robot would stop if it braked now (a per-axis brake model, linear plus
 * quadratic in speed), finds the closest point on the path to that projected pose, and drives along
 * the tangent there at full feedforward until the projected stop passes the end, then brakes. The
 * translational and heading terms are P controllers on the projected pose. V3 passes a zero vector
 * where Foresight v1 put its centripetal term, so there is none.
 */

/** Robot-frame drive powers: forward, strafe left, turn counter-clockwise. */
export interface DrivePowers {
  forward: number;
  strafe: number;
  turn: number;
}

/**
 * What the localizer hands the follower: `MotionState`. The pose heading is in [0, 2pi) as Pedro's
 * `Pose` keeps it; the velocity is field-frame and the twist is the same velocity in the robot frame.
 */
export interface MotionState {
  x: number;
  y: number;
  heading: number;
  vx: number;
  vy: number;
  omega: number;
  twistX: number;
  twistY: number;
}

export type FollowerMode = "FOLLOW" | "HOLD" | "IDLE";

const ZERO: DrivePowers = { forward: 0, strafe: 0, turn: 0 };

/** `DiamondDrivetrainModel.interpolateVelocity`. */
export const diamondVelocity = (xRadius: number, yRadius: number, thetaRad: number): number =>
  1 / (Math.abs(Math.cos(thetaRad)) / xRadius + Math.abs(Math.sin(thetaRad)) / yRadius);

/** `Utils.solveQuadratic`: the two roots of a x^2 + b x + c, in the numerically stable form. */
export function solveQuadratic(a: number, b: number, c: number): [number, number] {
  const sqrtD = Math.sqrt(b * b - 4 * a * c);
  const signed = b < 0 || Object.is(b, -0) ? -sqrtD : sqrtD;
  const q = -0.5 * (b + signed);
  return [q / a, c / q];
}

/** `Control.clampBrakingPower`: cap power that opposes the motion at `maxBrakingPower`. */
export function clampBrakingPower(power: number, directionOfMotion: number, max: number): number {
  if (directionOfMotion * power >= 0) return power;
  return Math.sign(power) * Math.min(Math.abs(power), max);
}

/** `Control.cosineScale`. */
const cosineScale = (error: number, falloff: number): number =>
  Math.cos(Math.min(Math.abs(error) * (Math.PI / 2 / falloff), Math.PI / 2));

/** `Mecanum.computeWheelPowersUnnormalized`, in [FL, FR, BL, BR] order. */
export function wheelPowers(p: DrivePowers, out: number[] = [0, 0, 0, 0]): number[] {
  out[0] = p.forward - p.strafe - p.turn;
  out[1] = p.forward + p.strafe + p.turn;
  out[2] = p.forward + p.strafe - p.turn;
  out[3] = p.forward - p.strafe + p.turn;
  return out;
}

const scratchA = [0, 0, 0, 0];
const scratchB = [0, 0, 0, 0];

/** `Mecanum.maxScaling`: the largest share of `delta` that keeps every wheel inside [-1, 1]. */
export function mecanumMaxScaling(current: DrivePowers, delta: DrivePowers): number {
  let lambda = 1;
  const a = wheelPowers(current, scratchA);
  const b = wheelPowers(delta, scratchB);
  for (let i = 0; i < 4; i += 1) {
    const ai = a[i] as number;
    const bi = b[i] as number;
    if (Math.abs(bi) < 1e-9) continue;
    const t1 = (1 - ai) / bi;
    const t2 = (-1 - ai) / bi;
    if (t1 >= 0 && t1 < lambda) lambda = t1;
    if (t2 >= 0 && t2 < lambda) lambda = t2;
  }
  return lambda < 0 ? 0 : lambda > 1 ? 1 : lambda;
}

/** Everything the follower carries between ticks, so a checkpoint can copy it. */
export interface FollowerState {
  mode: FollowerMode;
  path: SimPath | null;
  segmentIndex: number;
  /** `maxVelocityConstraint` while the path's `setPathSpeed` modifier is applied. */
  maxVelocityInPerS: number;
  holdPose: { x: number; y: number; heading: number } | null;
  closestT: number;
  projectedClosestT: number;
  curveCompletion: number;
  remainingDistance: number;
  tangentialSpeed: number;
  closestTangentX: number;
  closestTangentY: number;
  translationalError: number;
  headingError: number;
  busy: boolean;
  /** Pedro's hold `Timer`, as the time the hold's timer started, or null before its first tick. */
  holdTimerStartS: number | null;
}

export const initialFollowerState = (): FollowerState => ({
  mode: "IDLE",
  path: null,
  segmentIndex: 0,
  maxVelocityInPerS: Infinity,
  holdPose: null,
  closestT: 0,
  projectedClosestT: 0,
  curveCompletion: 0,
  remainingDistance: 0,
  tangentialSpeed: 0,
  closestTangentX: 0,
  closestTangentY: 0,
  translationalError: 0,
  headingError: 0,
  busy: false,
  holdTimerStartS: null,
});

export const copyFollowerState = (state: FollowerState): FollowerState => ({
  ...state,
  holdPose: state.holdPose === null ? null : { ...state.holdPose },
});

/** One vector or turn power queued for `clampPowers`, in priority order. */
type Queued = { angular: false; x: number; y: number } | { angular: true; value: number };

export class PedroFollower {
  readonly params: FollowerParams;
  readonly forwardVel: number;
  readonly strafeVel: number;
  /** `Follower.holdEnd`: hold the end pose when a path finishes, rather than stop. */
  readonly holdEnd: boolean;
  state: FollowerState;

  constructor(params: FollowerParams, forwardVel: number, strafeVel: number, holdEnd: boolean) {
    this.params = params;
    this.forwardVel = forwardVel;
    this.strafeVel = strafeVel;
    this.holdEnd = holdEnd;
    this.state = initialFollowerState();
  }

  follow(path: SimPath, speedFraction: number): void {
    this.clear();
    const s = this.state;
    s.mode = "FOLLOW";
    s.path = path;
    s.segmentIndex = 0;
    // `FORESIGHT_CONFIG.setPathSpeed(f)`: the velocity cap is a fraction of the forward maximum.
    s.maxVelocityInPerS = this.forwardVel * speedFraction;
    this.reset();
  }

  hold(pose: { x: number; y: number; heading: number }): void {
    this.clear();
    this.state.mode = "HOLD";
    this.state.holdPose = { ...pose };
  }

  stop(): void {
    this.clear();
    this.state.mode = "IDLE";
  }

  private clear(): void {
    const s = this.state;
    s.path = null;
    s.holdPose = null;
    s.maxVelocityInPerS = Infinity;
  }

  /** `ForesightV3.reset`. */
  private reset(): void {
    const s = this.state;
    s.holdTimerStartS = null;
    s.busy = true;
    s.closestT = 0;
    s.projectedClosestT = 0;
  }

  get following(): boolean {
    return this.state.mode === "FOLLOW";
  }

  /** `PathTracker.remainingPaths`. */
  private remaining(): number {
    const s = this.state;
    return s.path === null ? 0 : s.path.segments.length - s.segmentIndex;
  }

  /**
   * `Follower.update(deltaTime)`: the powers to write this tick, or null when Pedro writes none and
   * the motors keep what they were last given (the tick a finished path hands over to the hold).
   */
  update(motion: MotionState, nowS: number): DrivePowers | null {
    const s = this.state;
    switch (s.mode) {
      case "FOLLOW": {
        if (s.path === null || s.segmentIndex >= s.path.segments.length) {
          const end = s.path?.endPose ?? { x: motion.x, y: motion.y, heading: motion.heading };
          if (this.holdEnd) this.hold(end);
          else this.stop();
          return null;
        }
        return this.calculatePath(motion);
      }
      case "HOLD":
        return this.calculateHold(motion, nowS);
      case "IDLE":
        return ZERO;
    }
  }

  /** How far along the current path the follower says it is, as `PathMarkers.Runner` reads it. */
  distanceAlongIn(): number {
    const s = this.state;
    const path = s.path;
    if (path === null) return 0;
    const lengths = path.runtimeLengthsIn;
    if (s.segmentIndex >= lengths.length) return path.runtimeTotalIn;
    let before = 0;
    for (let i = 0; i < s.segmentIndex; i += 1) before += lengths[i] as number;
    let completion = s.curveCompletion;
    if (Number.isNaN(completion)) completion = 0;
    completion = Math.max(0, Math.min(1, completion));
    return before + completion * (lengths[s.segmentIndex] as number);
  }

  /** Pedro's hold end constraints, which `settledS` reports. */
  endConstraintsMet(): boolean {
    const s = this.state;
    const p = this.params;
    return (
      s.mode === "HOLD" &&
      s.tangentialSpeed < p.endVelocityToleranceInPerS &&
      Math.abs(s.translationalError) < p.endTranslationalToleranceIn &&
      Math.abs(s.headingError) < p.endHeadingToleranceRad
    );
  }

  /** `ForesightV3.getBrakeDisplacement`: where braking now would leave the robot, relative to it. */
  private brakeDisplacement(motion: MotionState): { x: number; y: number; heading: number } {
    const p = this.params;
    const vx = motion.twistX;
    const vy = motion.twistY;
    const w = motion.omega;
    const bodyX = p.brakeQuadraticForwardS2PerIn * vx * Math.abs(vx) + p.brakeLinearForwardS * vx;
    const bodyY = p.brakeQuadraticStrafeS2PerIn * vy * Math.abs(vy) + p.brakeLinearStrafeS * vy;
    const headingDisp = w * Math.abs(w) * p.headingBrakeQuadraticS2PerRad + w * p.headingBrakeLinearS;
    const h = motion.heading;
    let dx: number;
    let dy: number;
    if (Math.abs(headingDisp) < 1e-9) {
      // `Pose.exp(Twist)` with no rotation: the body displacement turned into the field frame.
      dx = bodyX * Math.cos(h) - bodyY * Math.sin(h);
      dy = bodyX * Math.sin(h) + bodyY * Math.cos(h);
    } else {
      const sin = Math.sin(headingDisp);
      const cos = Math.cos(headingDisp);
      const localX = (sin * bodyX - (1 - cos) * bodyY) / headingDisp;
      const localY = ((1 - cos) * bodyX + sin * bodyY) / headingDisp;
      dx = localX * Math.cos(h) - localY * Math.sin(h);
      dy = localX * Math.sin(h) + localY * Math.cos(h);
    }
    return { x: dx, y: dy, heading: normalizeAngle(headingDisp) };
  }

  /** `ForesightV3.getVelocityToBrakeInTime`. */
  private velocityToBrakeInTime(distance: number, tangent: XY, heading: number): number {
    const p = this.params;
    const cos = Math.cos(-heading);
    const sin = Math.sin(-heading);
    const tx = Math.abs(tangent.x * cos - tangent.y * sin);
    const ty = Math.abs(tangent.x * sin + tangent.y * cos);
    const k1 = p.brakeQuadraticForwardS2PerIn * tx * tx * tx + p.brakeQuadraticStrafeS2PerIn * ty * ty * ty;
    const k2 = p.brakeLinearForwardS * tx * tx + p.brakeLinearStrafeS * ty * ty;
    const [r1, r2] = solveQuadratic(k1, k2, -Math.abs(distance) / p.brakeAggression);
    const result = Math.max(r1, r2) * Math.sign(distance);
    // Pedro produces NaN here only when both the distance and the linear term are exactly zero.
    return Number.isNaN(result) ? 0 : result;
  }

  /** `ForesightV3.translationalCorrection`: [error, field-frame power vector]. */
  private translationalCorrection(
    px: number,
    py: number,
    heading: number,
    targetX: number,
    targetY: number,
    normal: XY,
  ): [number, number, number] {
    const p = this.params;
    const ex = targetX - px;
    const ey = targetY - py;
    const nn = normal.x * normal.x + normal.y * normal.y;
    if (!(nn > 0)) return [0, 0, 0];
    const scale = (ex * normal.x + ey * normal.y) / nn;
    const dispX = normal.x * scale;
    const dispY = normal.y * scale;
    const error = Math.hypot(dispX, dispY);
    if (error < p.minCorrectionDistanceIn) return [0, 0, 0];
    const cos = Math.cos(-heading);
    const sin = Math.sin(-heading);
    const bx = dispX * cos - dispY * sin;
    const by = dispX * sin + dispY * cos;
    const gx = p.forwardTranslationalPowerPerIn * bx;
    const gy = p.strafeTranslationalPowerPerIn * by;
    const bb = bx * bx + by * by;
    const k = bb === 0 ? 0 : (gx * bx + gy * by) / bb;
    const cx = bx * k;
    const cy = by * k;
    const c2 = Math.cos(heading);
    const s2 = Math.sin(heading);
    return [error, cx * c2 - cy * s2, cx * s2 + cy * c2];
  }

  /** `ForesightPowerAllocator.getDrivePowers`. */
  private drivePowers(fx: number, fy: number, turn: number, motion: MotionState): DrivePowers {
    const h = -motion.heading;
    const cos = Math.cos(h);
    const sin = Math.sin(h);
    const rx = fx * cos - fy * sin;
    const ry = fx * sin + fy * cos;
    const max = this.params.maxBrakingPower;
    return {
      forward: clampBrakingPower(rx, motion.twistX, max),
      strafe: clampBrakingPower(ry, motion.twistY, max),
      turn,
    };
  }

  /** `ForesightPowerAllocator.allocatePowers` and `clampPowers`. */
  private allocate(
    motion: MotionState,
    headingFeedforward: number,
    tx: number,
    ty: number,
    dx: number,
    dy: number,
    headingPower: number,
    translationalError: number,
    headingError: number,
  ): DrivePowers {
    const p = this.params;
    const translationalPriority = Math.abs(translationalError) > p.translationalDeviationToleranceIn;
    const headingPriority = Math.abs(headingError) > p.headingDeviationToleranceRad;
    const ff = headingFeedforward + headingPower * p.headingDriveRatio;
    const fb = headingPower * (1 - p.headingDriveRatio);

    // The normal feedforward vector V3 passes is zero, so it is left out of every order below.
    const translational: Queued = { angular: false, x: tx, y: ty };
    const drive: Queued = { angular: false, x: dx, y: dy };
    const feedforward: Queued = { angular: true, value: ff };
    const feedback: Queued = { angular: true, value: fb };
    const order: Queued[] =
      translationalPriority && headingPriority
        ? [feedforward, translational, feedback, drive]
        : headingPriority
          ? [feedforward, feedback, translational, drive]
          : [feedforward, translational, drive, feedback];

    let pathX = 0;
    let pathY = 0;
    let turn = 0;
    for (const item of order) {
      const current = this.drivePowers(pathX, pathY, turn, motion);
      if (item.angular) {
        const delta = this.drivePowers(0, 0, item.value, motion);
        turn += mecanumMaxScaling(current, delta) * item.value;
      } else {
        const delta = this.drivePowers(item.x, item.y, 0, motion);
        const scaling = mecanumMaxScaling(current, delta);
        pathX += item.x * scaling;
        pathY += item.y * scaling;
      }
    }
    return this.drivePowers(pathX, pathY, turn, motion);
  }

  /** `ForesightV3.calculatePath`, with Pedro's recursion on advancing a segment as a loop. */
  private calculatePath(motion: MotionState): DrivePowers {
    const s = this.state;
    const p = this.params;
    const path = s.path as SimPath;

    for (let guard = 0; guard <= path.segments.length; guard += 1) {
      const segment = path.segments[s.segmentIndex];
      if (segment === undefined) return ZERO;
      const curve = segment.curve;

      s.closestT = curve.closestT(motion.x, motion.y, s.closestT);
      if (s.closestT >= 1 - p.endParametricT) {
        // The end constraint: this segment is done. Advance, and either carry on with the next one
        // this same tick or, at the last, drive nothing and let the next update hand over to hold.
        s.closestT = 1;
        s.segmentIndex += 1;
        this.reset();
        if (s.segmentIndex < path.segments.length) continue;
        return ZERO;
      }

      const targetHeading = segment.heading(s.closestT);
      const closest = curve.get(s.closestT);
      s.remainingDistance = curve.remainingDistance(s.closestT);
      s.curveCompletion = curve.lengthIn === 0 ? 1 : 1 - s.remainingDistance / curve.lengthIn;
      const tangent = curve.tangent(s.closestT);
      s.closestTangentX = tangent.x;
      s.closestTangentY = tangent.y;
      s.tangentialSpeed = motion.vx * tangent.x + motion.vy * tangent.y;
      s.translationalError = Math.hypot(motion.x - closest.x, motion.y - closest.y);
      s.headingError = normalizeSigned(targetHeading - motion.heading);

      const disp = this.brakeDisplacement(motion);
      const projX = motion.x + disp.x;
      const projY = motion.y + disp.y;
      const projHeading = normalizeAngle(motion.heading + disp.heading);
      s.projectedClosestT = curve.closestT(projX, projY, s.projectedClosestT);
      const projectedTargetHeading = segment.heading(s.projectedClosestT);
      const projTangent = curve.tangent(s.projectedClosestT);
      const projTarget = curve.get(s.projectedClosestT);
      const projNormal = { x: -projTangent.y, y: projTangent.x };
      let projectedRemaining = curve.remainingDistance(s.projectedClosestT);
      if (projectedRemaining <= 0.01) {
        projectedRemaining =
          projTangent.x * (projTarget.x - projX) + projTangent.y * (projTarget.y - projY);
      }
      const angleToTangent = theta(projTangent) - projHeading;

      const brakeVelocity = this.velocityToBrakeInTime(projectedRemaining, projTangent, projHeading);
      const isBraking = brakeVelocity <= 0 || projectedRemaining <= 0;

      // `brakeAtEnd` is true in biobuzz and by default, so only a segment before the last hands
      // over early: once the projected stop passes its end, the next segment takes the robot.
      if (isBraking && this.remaining() > 1) {
        s.segmentIndex += 1;
        continue;
      }

      const headingError = normalizeSigned(projectedTargetHeading - projHeading);
      const currentHeadingError = normalizeSigned(targetHeading - motion.heading);
      const total = p.headingPowerPerRad * headingError;
      let feedback = p.headingPowerPerRad * currentHeadingError;
      let feedforward: number;
      if (Math.abs(total) <= 1e-3) {
        feedback = 0;
        feedforward = 0;
      } else if (total * feedback < 0) {
        feedforward = total;
        feedback = 0;
      } else if (Math.abs(feedback) >= Math.abs(total)) {
        feedforward = 0;
        feedback = total;
      } else {
        feedforward = total - feedback;
      }
      feedforward += p.headingStaticPower * Math.sign(turnDirection(headingError));

      const drivePower = this.drivePower(isBraking, brakeVelocity, angleToTangent);
      let driveX = projTangent.x * drivePower;
      let driveY = projTangent.y * drivePower;

      const [translationalError, tx, ty] = this.translationalCorrection(
        projX,
        projY,
        projHeading,
        projTarget.x,
        projTarget.y,
        projNormal,
      );

      if (s.projectedClosestT <= p.endParametricT) {
        const start = curve.start;
        const toStartX = start.x - projX;
        const toStartY = start.y - projY;
        const alongToStart = toStartX * s.closestTangentX + toStartY * s.closestTangentY;
        const beforePath =
          alongToStart > 1 && translationalError > p.translationalDeviationToleranceIn;
        const headingBeforePath = Math.abs(headingError) > p.headingDeviationToleranceRad;
        if (beforePath && p.cosineScale) {
          driveX *= alongToStart / translationalError;
          driveY *= alongToStart / translationalError;
        }
        if (headingBeforePath && p.cosineScale) {
          if (p.turnBeforeDriving) {
            driveX = 0;
            driveY = 0;
          }
          const scalar = this.driveScalar(0, headingError);
          driveX *= scalar;
          driveY *= scalar;
        }
      } else if (
        (Math.abs(headingError) > 2 * p.headingDeviationToleranceRad ||
          Math.abs(translationalError) > 2 * p.translationalDeviationToleranceIn) &&
        p.cosineScale
      ) {
        const scalar = this.driveScalar(translationalError, headingError);
        driveX *= scalar;
        driveY *= scalar;
      }

      return this.allocate(
        motion,
        feedforward,
        tx,
        ty,
        driveX,
        driveY,
        feedback,
        translationalError,
        headingError,
      );
    }
    return ZERO;
  }

  /** `ForesightPowerAllocator.getDriveScalar`. */
  private driveScalar(normalError: number, headingError: number): number {
    const p = this.params;
    return (
      cosineScale(normalError, p.translationalDeviationToleranceIn) *
      cosineScale(headingError, p.headingDeviationToleranceRad)
    );
  }

  /** `ForesightV3.drive` and `coast`, with no acceleration or deceleration constraint set. */
  private drivePower(isBraking: boolean, profiledVelocity: number, angleToTangent: number): number {
    const p = this.params;
    const maxAchievable = diamondVelocity(this.forwardVel, this.strafeVel, angleToTangent);
    const target = Math.min(profiledVelocity, maxAchievable);
    if (isBraking) return p.brakeFeedforwardPowerPerInPerS * target;
    let coastTarget = maxAchievable;
    if (Number.isFinite(this.state.maxVelocityInPerS)) {
      coastTarget = Math.min(coastTarget, this.state.maxVelocityInPerS);
    }
    if (coastTarget >= maxAchievable) return 1;
    const error = Math.max(0, coastTarget);
    return Math.max(p.coastPowerPerInPerS * error + p.coastFeedforwardPowerPerInPerS * coastTarget, 0);
  }

  /** `ForesightV3.calculateHold`, without the optional hold scaling (`hold(pose)` passes false). */
  private calculateHold(motion: MotionState, nowS: number): DrivePowers {
    const s = this.state;
    const p = this.params;
    const target = s.holdPose as { x: number; y: number; heading: number };
    if (s.holdTimerStartS === null) s.holdTimerStartS = nowS;

    const disp = this.brakeDisplacement(motion);
    const projX = motion.x + disp.x;
    const projY = motion.y + disp.y;
    const projHeading = normalizeAngle(motion.heading + disp.heading);
    const projError = normalizeSigned(target.heading - projHeading);
    const headingCorrection =
      p.headingPowerPerRad * projError + p.headingStaticPower * Math.sign(turnDirection(projError));
    s.headingError = normalizeSigned(target.heading - motion.heading);

    const dispX = target.x - projX;
    const dispY = target.y - projY;
    const dist = Math.hypot(dispX, dispY);
    s.translationalError = Math.hypot(target.x - motion.x, target.y - motion.y);
    if (dist < 1e-9) {
      s.tangentialSpeed = 0;
      s.closestTangentX = 0;
      s.closestTangentY = 0;
    } else {
      s.closestTangentX = dispX / dist;
      s.closestTangentY = dispY / dist;
      s.tangentialSpeed = s.closestTangentX * motion.vx + s.closestTangentY * motion.vy;
    }

    const timedOut = nowS - s.holdTimerStartS > p.holdTimeoutS;
    if ((s.busy && timedOut) || this.endConstraintsMet()) s.busy = false;

    // Pedro divides by the distance here and so produces NaN when the projected pose sits exactly on
    // the target; `CachedMotor` then ignores the NaN. No correction is the same outcome.
    let tx = 0;
    let ty = 0;
    if (dist >= 1e-9) {
      [, tx, ty] = this.translationalCorrection(projX, projY, projHeading, target.x, target.y, {
        x: dispX / dist,
        y: dispY / dist,
      });
    }
    return this.drivePowers(tx, ty, headingCorrection, motion);
  }
}
