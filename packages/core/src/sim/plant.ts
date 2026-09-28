import type { DrivePowers, MotionState } from "./follower.js";
import { normalizeAngle } from "./pedroPath.js";
import type { PlantParams } from "./types.js";

/**
 * The simulated chassis, matched to the robot repository's headless sim: four
 * first-order wheels, `MecanumDrivePlant`'s mounting-sign
 * bookkeeping (which cancels and so is left out), and `MecanumPoseIntegrator`'s forward kinematics
 * with its roller-slip factor on the lateral velocity. The powers reach the wheels the way Pedro's
 * `Mecanum.applyDrive` and `CachedMotor.setPower` write them.
 *
 * One deliberate difference, and only with `coast: "natural"` (the `robot` fidelity): when every
 * wheel is unpowered the chassis loses speed at the measured natural deceleration per axis, the
 * model Pedro's own `getCoastDisplacement` uses, instead of at the first-order rate. The Gradle
 * plant uses one rate for both, which `BiobuzzSimConfig.MAX_ACCEL`'s javadoc records as sheding
 * 387 in/s^2 at zero power where the robot measured 89.
 */

export interface PlantState {
  x: number;
  /** Field-frame y, inches. */
  y: number;
  /** Unwrapped, like `MecanumPoseIntegrator.heading`. */
  heading: number;
  /** Wheel speeds as fractions of full speed, [FL, FR, BL, BR]. */
  speeds: [number, number, number, number];
  /** The powers the motors were last given, as `CachedMotor` holds them. */
  powers: [number, number, number, number];
}

export const copyPlantState = (state: PlantState): PlantState => ({
  x: state.x,
  y: state.y,
  heading: state.heading,
  speeds: [...state.speeds],
  powers: [...state.powers],
});

export class MecanumPlant {
  readonly params: PlantParams;
  readonly lateralEfficiency: number;
  state: PlantState;

  constructor(params: PlantParams, x: number, y: number, heading: number) {
    this.params = params;
    this.lateralEfficiency = params.maxStrafeVelInPerS / params.maxForwardVelInPerS;
    this.state = { x, y, heading, speeds: [0, 0, 0, 0], powers: [0, 0, 0, 0] };
  }

  /**
   * `Mecanum.applyDrive`: wheel powers, normalised so none exceeds 1, each through
   * `CachedMotor.setPower`, which skips a change smaller than the threshold unless the sign flips.
   */
  drive(powers: DrivePowers): void {
    const f = powers.forward;
    const s = powers.strafe;
    const t = powers.turn;
    const wheels = [f - s - t, f + s + t, f + s - t, f - s + t];
    let max = 1;
    for (const wheel of wheels) max = Math.max(max, Math.abs(wheel));
    for (let i = 0; i < 4; i += 1) this.setPower(i, (wheels[i] as number) / max);
  }

  /** `Mecanum.stop`. */
  stop(): void {
    for (let i = 0; i < 4; i += 1) this.setPower(i, 0);
  }

  private setPower(wheel: number, power: number): void {
    if (!Number.isFinite(power)) return;
    const desired = power < -1 ? -1 : power > 1 ? 1 : power;
    const last = this.state.powers[wheel] as number;
    if (Math.abs(last - desired) >= this.params.powerThreshold || Math.sign(last) !== Math.sign(desired)) {
      this.state.powers[wheel] = desired;
    }
  }

  /** The chassis velocity the wheels give right now: body-frame forward, left, and turn rate. */
  bodyVelocity(): { vx: number; vy: number; omega: number } {
    const [fl, fr, bl, br] = this.state.speeds;
    const v = this.params.maxForwardVelInPerS;
    return {
      vx: (v * (fl + fr + bl + br)) / 4,
      vy: ((v * (-fl + fr + bl - br)) / 4) * this.lateralEfficiency,
      omega: (v * (-fl + fr - bl + br)) / (4 * this.params.leverArmIn),
    };
  }

  /** The true motion state, as a localizer that measures velocity would report it. */
  motion(): MotionState {
    const body = this.bodyVelocity();
    const h = this.state.heading;
    const cos = Math.cos(h);
    const sin = Math.sin(h);
    return {
      x: this.state.x,
      y: this.state.y,
      heading: normalizeAngle(h),
      vx: body.vx * cos - body.vy * sin,
      vy: body.vx * sin + body.vy * cos,
      omega: body.omega,
      twistX: body.vx,
      twistY: body.vy,
    };
  }

  /** One tick: the wheels chase their powers, then the pose integrates the chassis velocity. */
  update(dt: number): void {
    const p = this.params;
    const st = this.state;
    const unpowered = st.powers.every((power) => Math.abs(power) < p.stopSnapFraction);

    if (p.coast === "natural" && unpowered) {
      this.coastNaturally(dt);
    } else {
      for (let i = 0; i < 4; i += 1) {
        const power = st.powers[i] as number;
        let speed = st.speeds[i] as number;
        speed += (power - speed) * p.wheelResponseRatePerS * dt;
        if (Math.abs(speed) < p.stopSnapFraction && Math.abs(power) < p.stopSnapFraction) speed = 0;
        st.speeds[i] = speed;
      }
    }

    const body = this.bodyVelocity();
    const cos = Math.cos(st.heading);
    const sin = Math.sin(st.heading);
    st.x += (body.vx * cos - body.vy * sin) * dt;
    st.y += (body.vx * sin + body.vy * cos) * dt;
    st.heading += body.omega * dt;
    const half = p.fieldHalfIn;
    st.x = Math.max(-half, Math.min(half, st.x));
    st.y = Math.max(-half, Math.min(half, st.y));
  }

  /**
   * Every wheel unpowered on a floating drivetrain: each body axis sheds speed at its own measured
   * rate, forward and strafe from `robot.json`, rotation at the forward rate over the lever arm.
   * The wheel speeds are then set back from the body velocity, which is exact because the
   * forward kinematics lose only the mode a mecanum cannot drive.
   */
  private coastNaturally(dt: number): void {
    const p = this.params;
    const body = this.bodyVelocity();
    const shed = (value: number, rate: number): number => {
      const step = rate * dt;
      return Math.abs(value) <= step ? 0 : value - Math.sign(value) * step;
    };
    const vx = shed(body.vx, p.forwardDecelInPerS2);
    const vy = shed(body.vy, p.strafeDecelInPerS2);
    const omega = shed(body.omega, p.forwardDecelInPerS2 / p.leverArmIn);
    const v = p.maxForwardVelInPerS;
    const wheelsVy = vy / this.lateralEfficiency;
    const turn = omega * p.leverArmIn;
    const speeds = this.state.speeds;
    speeds[0] = (vx - wheelsVy - turn) / v;
    speeds[1] = (vx + wheelsVy + turn) / v;
    speeds[2] = (vx + wheelsVy - turn) / v;
    speeds[3] = (vx - wheelsVy + turn) / v;
  }
}
