import type { Field, Robot } from "@horizon36596/zenith-schema";
import type { Plan } from "../types.js";
import type { DrivePowers, MotionState } from "../sim/follower.js";
import { normalizeAngle } from "../sim/pedroPath.js";
import type { PlantState } from "../sim/plant.js";
import {
  finish,
  setup,
  TopSequence,
  type Engine,
  type EngineHost,
  type EnginePlant,
  type HostCommand,
} from "../sim/simulate.js";
import type { FollowerParams, SimTrace } from "../sim/types.js";

/**
 * A live run: the same command tree and the same Pedro ForesightV3 follower the instant sim runs,
 * with the plant taken out. Another program (a driving simulator, a game, a test rig) owns the
 * robot. Each tick it hands the run where the robot is and how fast it is moving, and gets back
 * the robot-frame powers Pedro would write to the drivetrain. Named commands run on the host
 * (`LiveHost.command`) and conditions are read from it (`LiveHost.condition`), so an intake
 * really collects and a `hopperFull` end condition fires when the hopper really fills.
 *
 * A tick runs in the robot's own order, the order `simulate` uses: the follower reads the belief
 * and computes its powers, then the command tree executes (steps end, the next start, paths go to
 * the follower), then the belief is recorded for the trace. The host applies the powers and
 * advances its own world before the next tick.
 *
 * With a host that runs no commands and reads no conditions, fed by the instant sim's own plant,
 * a live run is the instant sim: the trace is byte-identical (`live.test.ts` holds it to that).
 */

/** Where the robot is, in the field frame of the auto file's own alliance. */
export interface LiveBelief {
  xIn: number;
  yIn: number;
  /** Any angle; the run normalises it. */
  headingRad: number;
  /** Field-frame velocity. */
  vxInPerS: number;
  vyInPerS: number;
  /** Counter-clockwise positive. */
  omegaRadPerS: number;
  /**
   * The same velocity in the robot frame (forward, left), when the localizer reports it. Left out,
   * it is rotated from the field-frame velocity, which agrees to the last bit only most of the
   * time: Pedro's closest-point search stops on a threshold, so a last-bit difference can
   * occasionally change a tick. Pass it to reproduce another run exactly.
   */
  twistForwardInPerS?: number;
  twistLeftInPerS?: number;
}

/** A named command the host runs for real: the scheduler's life cycle. */
export type LiveCommand = HostCommand;

/** What a live run asks the program it runs inside. Both methods are optional; see `EngineHost`. */
export interface LiveHost {
  /**
   * The host's own command for `name`, or null to time it by its `estimateS`. Called as the
   * command tree is built, once for every place the file names a command.
   */
  command?(
    name: string,
    args: Readonly<Record<string, string | number | boolean>>,
    stepId: string,
  ): LiveCommand | null;
  /** Reads a condition now. Called once per tick while a step waits on it. */
  condition?(name: string, stepId: string): boolean;
}

export interface LiveOptions {
  /** Seconds per tick: the host's fixed step. */
  tickS: number;
  /** Pedro gains to use over `robot.json`'s and the defaults. */
  follower?: Partial<FollowerParams>;
}

export interface LiveTick {
  /**
   * The powers the drivetrain holds after this tick: robot frame, forward, strafe to the left and
   * turn counter-clockwise, before the mecanum normalisation. A tick on which Pedro writes no
   * power (the tick it switches to holding) keeps the previous tick's, as a motor would.
   */
  powers: DrivePowers;
  /** True once the whole routine has ended. The follower keeps holding the end pose after. */
  finished: boolean;
  /** The steps running now, outermost first. */
  activeStepIds: readonly string[];
}

export interface LiveRun {
  tick(belief: LiveBelief): LiveTick;
  /** Interrupts whatever is running, as the end of the period does. The follower stops. */
  cancel(): void;
  readonly finished: boolean;
  /** Seconds since the first tick, on the run's own tick clock. */
  readonly timeS: number;
  /** Everything so far as a `Trace`, with `source: "live"`. */
  trace(): SimTrace;
}

/** A plant whose motion the host writes; the engine's drive calls are only remembered. */
class HostPlant implements EnginePlant {
  state: PlantState;
  private current: MotionState;
  powers: DrivePowers = { forward: 0, strafe: 0, turn: 0 };

  constructor(start: { x: number; y: number; heading: number }) {
    this.state = { x: start.x, y: start.y, heading: start.heading, speeds: [0, 0, 0, 0], powers: [0, 0, 0, 0] };
    this.current = {
      x: start.x,
      y: start.y,
      heading: normalizeAngle(start.heading),
      vx: 0,
      vy: 0,
      omega: 0,
      twistX: 0,
      twistY: 0,
    };
  }

  set(belief: LiveBelief): void {
    const heading = normalizeAngle(belief.headingRad);
    const cos = Math.cos(heading);
    const sin = Math.sin(heading);
    this.current = {
      x: belief.xIn,
      y: belief.yIn,
      heading,
      vx: belief.vxInPerS,
      vy: belief.vyInPerS,
      omega: belief.omegaRadPerS,
      twistX: belief.twistForwardInPerS ?? belief.vxInPerS * cos + belief.vyInPerS * sin,
      twistY: belief.twistLeftInPerS ?? -belief.vxInPerS * sin + belief.vyInPerS * cos,
    };
    this.state.x = belief.xIn;
    this.state.y = belief.yIn;
    this.state.heading = belief.headingRad;
  }

  motion(): MotionState {
    return this.current;
  }

  drive(powers: DrivePowers): void {
    this.powers = { forward: powers.forward, strafe: powers.strafe, turn: powers.turn };
  }

  update(): void {}
}

class Run implements LiveRun {
  private started = false;
  private done = false;
  private cancelled = false;

  constructor(
    private readonly engine: Engine,
    private readonly plantRef: HostPlant,
    private readonly root: TopSequence,
    private readonly plan: Plan,
    private readonly periodS: number | null,
  ) {}

  get finished(): boolean {
    return this.done;
  }

  get timeS(): number {
    return this.engine.timeS;
  }

  tick(belief: LiveBelief): LiveTick {
    const engine = this.engine;
    this.plantRef.set(belief);
    if (this.cancelled) {
      return { powers: { forward: 0, strafe: 0, turn: 0 }, finished: this.done, activeStepIds: [] };
    }
    // Tick n is stamped n * tickS, the way `simulate` stamps it: the clock moves on as each tick
    // after the first begins, and stops with the routine, so the trace ends on the tick it ended.
    if (!this.started) {
      this.started = true;
      this.root.initialize();
    } else if (!this.done) engine.tick += 1;
    const wasDone = this.done;
    engine.driveTick();
    if (!this.done) {
      this.root.execute();
      if (this.root.isFinished()) {
        this.root.end(false);
        this.done = true;
      }
    }
    // The trace ends on the tick the routine ends, as `simulate`'s does; the follower goes on
    // holding the end pose after that, but that is the robot parked, not the routine running.
    if (!wasDone) engine.recordTick();
    return { powers: this.plantRef.powers, finished: this.done, activeStepIds: [...engine.openStepIds] };
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    if (this.started && !this.done) {
      this.root.end(true);
      this.engine.event("periodEnded", { detail: "The run was cancelled before the routine finished." });
    }
    this.plantRef.powers = { forward: 0, strafe: 0, turn: 0 };
  }

  trace(): SimTrace {
    const trace = finish(this.engine, this.plan, this.done, this.periodS);
    return { ...trace, source: "live" };
  }
}

/**
 * Starts a live run of `plan`. The plan's start pose is where the robot is expected to be; the
 * first `tick` may say otherwise, and the run follows from wherever the belief puts it.
 */
export function createLiveRun(
  plan: Plan,
  robot: Robot,
  field: Field,
  host: LiveHost,
  options: LiveOptions,
): LiveRun {
  const made: { plant: HostPlant | null } = { plant: null };
  const engineHost: EngineHost = host;
  const { engine, periodS, members } = setup(
    plan,
    robot,
    field,
    {
      tickS: options.tickS,
      fidelity: "robot",
      ...(options.follower === undefined ? {} : { follower: options.follower }),
    },
    {
      plant: (start) => {
        made.plant = new HostPlant(start);
        return made.plant;
      },
      host: engineHost,
    },
  );
  if (made.plant === null) throw new Error("The live run was built without its plant.");
  return new Run(engine, made.plant, new TopSequence(engine, members, 0), plan, periodS);
}
