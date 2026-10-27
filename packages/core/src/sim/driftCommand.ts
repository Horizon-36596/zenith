import { angleDelta } from "../geometry/angle.js";
import type { Pose } from "../geometry/vec.js";
import { smoothstep, smoothstepRate } from "../drift.js";
import { elapsedAtLeast, type SimClock, type SimCommand } from "./commands.js";
import { MecanumPlant } from "./plant.js";

/** What the drift needs of the engine: its clock, its plant, and a way to leave the follower holding. */
export interface DriftEngine extends SimClock {
  readonly plant: { state: { x: number; y: number; heading: number } };
  holdAt(pose: { x: number; y: number; heading: number }): void;
}

/**
 * The instant sim's drift (`../drift.ts`, issue #481): a `movesRobot` command whose end the plan
 * takes from the next path's rejoin pose. The sim cannot drive what the command does, so instead of
 * holding the robot still for the command's seconds it moves the plant kinematically, every tick,
 * along the same eased straight line the ideal playback draws: from where the robot really is when
 * the step starts to the rejoin pose, heading the short way, with the velocity of that motion. On
 * its last tick the robot is on the rejoin pose at rest and the follower holds it there, so the
 * next path starts from the rejoin pose as the estimate does.
 *
 * It finishes exactly when a `TimedCommand` of `seconds` would, so the step's times and its timeout
 * do not change. The motion takes `driftS`, which is `seconds` unless a shorter timeout stops the
 * step first: the estimate and the ideal playback count the step only up to its timeout, so the
 * drift arrives by then. It needs the instant sim's own plant: a plant another program writes (a
 * live run) is never moved, and the command is then only a timer.
 */
export class DriftCommand implements SimCommand {
  private startTick = 0;
  private from: { x: number; y: number; heading: number } | null = null;
  private turnRad = 0;
  private arrived = false;

  constructor(
    private readonly engine: DriftEngine,
    private readonly seconds: number,
    private readonly driftS: number,
    private readonly to: Pose,
  ) {}

  initialize(): void {
    this.startTick = this.engine.tick;
    this.arrived = false;
    const state = this.engine.plant.state;
    this.from = { x: state.x, y: state.y, heading: state.heading };
    // The plant's heading is unwrapped, so the turn is added to it rather than written as a wrapped angle.
    this.turnRad = angleDelta(state.heading, this.to.headingRad);
  }

  execute(): void {
    const from = this.from;
    const plant = this.engine.plant;
    if (this.arrived || from === null || !(plant instanceof MecanumPlant)) return;
    const done = elapsedAtLeast(this.engine, this.startTick, this.driftS);
    const elapsedS = (this.engine.tick - this.startTick) * this.engine.tickS;
    const u = done || this.driftS <= 0 ? 1 : Math.min(1, elapsedS / this.driftS);
    const f = smoothstep(u);
    const rate = done || this.driftS <= 0 ? 0 : smoothstepRate(u) / this.driftS;
    const dx = this.to.xIn - from.x;
    const dy = this.to.yIn - from.y;
    const pose = { x: from.x + dx * f, y: from.y + dy * f, heading: from.heading + this.turnRad * f };
    plant.place(pose, { vx: dx * rate, vy: dy * rate, omega: this.turnRad * rate });
    if (u >= 1) {
      // At rest on the end pose, and held there by the follower until the next step gives it a job.
      this.engine.holdAt(pose);
      this.arrived = true;
    }
  }

  isFinished(): boolean {
    return elapsedAtLeast(this.engine, this.startTick, this.seconds);
  }

  end(): void {}
}
