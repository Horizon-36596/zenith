import type { ConditionLedgerTest, Field, Robot, Step } from "@horizon36596/zenith-schema";
import { driftTarget } from "../drift.js";
import { commandSeconds, envelopeWindowS, stepTimeoutS } from "../estimate.js";
import { robotLimits } from "../kinematics.js";
import type { LedgerEntry } from "../ledger.js";
import { conditionTestOf, evaluateLedgerTest, markedConditions } from "../ledgerConditions.js";
import type { SeasonState } from "../season.js";
import type { Plan, PlanStep } from "../types.js";
import {
  ConditionalCommand,
  DeadlineCommand,
  InstantCommand,
  ParallelAllCommand,
  RaceCommand,
  SequenceCommand,
  TimedCommand,
  type SimClock,
  type SimCommand,
} from "./commands.js";
import type { XY } from "./curves.js";
import {
  copyFollowerState,
  PedroFollower,
  type DrivePowers,
  type FollowerState,
  type MotionState,
} from "./follower.js";
import { DriftCommand } from "./driftCommand.js";
import { followerParams, plantParams, runParams } from "./params.js";
import { holdTurnRad, TURN_SETTLED_RAD, TurnSettle, turnSettled } from "../turnInPlace.js";
import { buildSimPath, normalizeAngle, normalizeSigned, type SimPath } from "./pedroPath.js";
import { copyPlantState, MecanumPlant, type PlantState } from "./plant.js";
import type {
  ConditionQuery,
  SimCheckpoint,
  SimEvent,
  SimFidelity,
  SimOptions,
  SimRun,
  SimStepRecord,
  SimTrace,
  TracePoseRow,
  TraceVelocityRow,
} from "./types.js";
import type { TraceLedgerRow } from "../trace.js";

/**
 * The instant sim (site/docs/simulation.md): the routine run tick by tick through a
 * port of the command tree the robot builds, Pedro's ForesightV3 follower and the Gradle sim's
 * mecanum plant. Pure and deterministic: the same inputs give byte-identical trace JSON, because
 * nothing here reads a clock, draws a random number or iterates anything unordered.
 *
 * One tick, in the order the robot's loop runs it (`CommandScheduler.run` runs subsystem
 * `periodic()` first, and biobuzz's `Drive.periodic()` is where the follower updates):
 *
 * 1. The follower reads the localizer and computes its powers; the drivetrain writes them.
 * 2. The command tree executes: steps finish, the next ones start, paths are handed to the follower.
 * 3. The pose at the start of the tick is recorded, stamped with the tick's time, which is what the
 *    Gradle harness records too.
 * 4. The plant advances one tick.
 */

/** Pedro reports millimetres from the OctoQuad; the Gradle `FakeOctoQuad` rounds to them. */
const MM_PER_IN = 25.4;

/** `FakeOctoQuad`'s heading resolution in the robot repository: 1/5000 rad. */
const HEADING_STEPS_PER_RAD = 5000;

const round4 = (value: number): number => {
  const rounded = Math.round(value * 1e4) / 1e4;
  return rounded === 0 ? 0 : rounded;
};

const roundTime = (value: number): number => Math.round(value * 1e6) / 1e6;

const sumHolds = (holds: Readonly<Record<string, number>>): number => {
  let total = 0;
  for (const key of Object.keys(holds).sort()) total += holds[key] as number;
  return total;
};

/** What the sim knows about each step's place in the ledger, by step id. */
interface HoldsView {
  before: Readonly<Record<string, number>> | null;
  after: Readonly<Record<string, number>> | null;
  entry: LedgerEntry;
}

/**
 * What the engine drives and reads its belief from. `MecanumPlant` is the instant sim's own; a live
 * run (`../live/`) passes one whose motion another program writes each tick.
 */
export interface EnginePlant {
  state: PlantState;
  motion(): MotionState;
  drive(powers: DrivePowers): void;
  update(dt: number): void;
}

/**
 * A command a host program runs for real, in place of the instant sim's `estimateS` timer. The
 * life cycle is the scheduler's (`SimCommand`).
 */
export type HostCommand = SimCommand;

/**
 * What a live run asks the program it runs inside. Either method may be left out: a missing
 * `command`, or one that returns null, times the command by its `estimateS` as the instant sim
 * does; a missing `condition` resolves conditions from the ledger as the instant sim does.
 */
export interface EngineHost {
  command?(
    name: string,
    args: Readonly<Record<string, string | number | boolean>>,
    stepId: string,
  ): HostCommand | null;
  condition?(name: string, stepId: string): boolean;
}

/** The per-run context every command reads. */
interface Context {
  host: EngineHost | null;
  robot: Robot;
  /** The routine's alliance, which a quantity condition's `Own` and `Opponent` stand for. */
  alliance: "RED" | "BLUE";
  options: SimOptions;
  fidelity: SimFidelity;
  unknownCommandS: number;
  defaultSpeedFraction: number;
  fullConditions: readonly string[];
  emptyConditions: readonly string[];
  holds: ReadonlyMap<string, HoldsView>;
}

/** A step's record and the flags its inner commands set on it. */
interface StepContext {
  record: SimStepRecord | null;
  unknownReasons: string[];
}

interface PendingSettle {
  record: SimStepRecord;
  generation: number;
}

/** Everything a checkpoint copies. Opaque outside this file. */
interface CheckpointState {
  tick: number;
  plant: PlantState;
  follower: FollowerState;
  generation: number;
  records: number;
  events: number;
  ledger: number;
  pendingSettle: number | null;
}

export class Engine implements SimClock {
  tick = 0;
  readonly tickS: number;
  readonly fidelity: SimFidelity;
  readonly plant: EnginePlant;
  readonly follower: PedroFollower;
  /** Bumped every time a command gives the follower a new job, so a settle watch can tell. */
  generation = 0;
  pendingSettle: PendingSettle | null = null;

  records: SimStepRecord[] = [];
  events: SimEvent[] = [];
  poses: TracePoseRow[] = [];
  truthPoses: TracePoseRow[] = [];
  velocities: TraceVelocityRow[] = [];
  ledgerRows: TraceLedgerRow[] = [];
  checkpoints: SimCheckpoint[] = [];
  /** Filled by `TopSequence` before step i starts; null entries are not recorded. */
  prefixKeys: readonly string[] = [];
  /** Checkpoints at or below this index are already known and not taken again. */
  skipCheckpointsThrough = 0;
  /** The ids of the steps that have started and not ended, outermost first. */
  readonly openStepIds: string[] = [];

  constructor(
    readonly ctx: Context,
    readonly plan: Plan,
    tickS: number,
    fidelity: SimFidelity,
    plant: EnginePlant,
    follower: PedroFollower,
  ) {
    this.tickS = tickS;
    this.fidelity = fidelity;
    this.plant = plant;
    this.follower = follower;
  }

  get timeS(): number {
    return roundTime(this.tick * this.tickS);
  }

  /** What the localizer reports: the truth, or the Gradle harness's quantised pose and no velocity. */
  belief(): MotionState {
    const motion = this.plant.motion();
    if (this.fidelity !== "gradle") return motion;
    const st = this.plant.state;
    return {
      x: Math.round(st.x * MM_PER_IN) / MM_PER_IN,
      y: Math.round(st.y * MM_PER_IN) / MM_PER_IN,
      heading: normalizeAngle(Math.round(st.heading * HEADING_STEPS_PER_RAD) / HEADING_STEPS_PER_RAD),
      vx: 0,
      vy: 0,
      omega: 0,
      twistX: 0,
      twistY: 0,
    };
  }

  follow(path: SimPath, speedFraction: number): void {
    this.generation += 1;
    this.follower.follow(path, speedFraction);
  }

  holdHere(): void {
    this.generation += 1;
    const b = this.belief();
    this.follower.hold({ x: b.x, y: b.y, heading: b.heading });
  }

  /** `follower.hold(pose)` at a given pose: how the runtime runs a turn on the spot. */
  holdAt(pose: { x: number; y: number; heading: number }): void {
    this.generation += 1;
    this.follower.hold(pose);
  }

  event(kind: string, extra: Omit<SimEvent, "timeS" | "kind">): void {
    this.events.push({ timeS: this.timeS, kind, ...extra });
  }

  startRecord(step: PlanStep, parentId: string | null, stepCtx: StepContext): SimStepRecord {
    const record: SimStepRecord = {
      id: step.id,
      startS: this.timeS,
      endS: this.timeS,
      interrupted: false,
      kind: step.kind,
      parentId,
      timedOut: false,
      conditionFired: false,
      unknown: stepCtx.unknownReasons.length > 0,
    };
    if (stepCtx.unknownReasons.length > 0) record.unknownReason = stepCtx.unknownReasons.join(" ");
    this.records.push(record);
    this.openStepIds.push(record.id);
    return record;
  }

  endRecord(record: SimStepRecord, interrupted: boolean): void {
    record.endS = this.timeS;
    record.interrupted = interrupted;
    const open = this.openStepIds.lastIndexOf(record.id);
    if (open >= 0) this.openStepIds.splice(open, 1);
    const view = this.ctx.holds.get(record.id);
    const entry = view?.entry;
    if (entry !== undefined && entry.row !== null) {
      const row: TraceLedgerRow = { timeS: record.endS };
      if (view?.after !== null && view?.after !== undefined) row.held = sumHolds(view.after);
      if (entry.launched > 0) row.launches = entry.launched;
      this.ledgerRows.push(row);
    }
  }

  /** Called by the top-level sequence just before step `index` starts. */
  beforeTopLevelStep(index: number): void {
    if (index === 0 || index <= this.skipCheckpointsThrough) return;
    const key = this.prefixKeys[index];
    if (key === undefined) return;
    const pending = this.pendingSettle;
    const state: CheckpointState = {
      tick: this.tick,
      plant: copyPlantState(this.plant.state),
      follower: copyFollowerState(this.follower.state),
      generation: this.generation,
      records: this.records.length,
      events: this.events.length,
      ledger: this.ledgerRows.length,
      pendingSettle: pending === null ? null : this.records.indexOf(pending.record),
    };
    this.checkpoints.push({ stepIndex: index, prefixKey: key, state });
  }

  /** Phase 1: the follower and the drivetrain. */
  driveTick(): void {
    const powers = this.follower.update(this.belief(), this.timeS);
    if (powers !== null) this.plant.drive(powers);
    const pending = this.pendingSettle;
    if (pending !== null) {
      if (pending.generation !== this.generation || this.follower.state.mode !== "HOLD") {
        if (pending.generation !== this.generation || this.follower.state.mode === "IDLE") {
          this.pendingSettle = null;
        }
      } else if (this.follower.endConstraintsMet()) {
        pending.record.settledS = this.timeS;
        this.event("settled", { stepId: pending.record.id });
        this.pendingSettle = null;
      }
    }
  }

  /**
   * True once the step named by `SimOptions.stopAfterStepId` has closed and nothing more of it is
   * pending: its settle watch has fired, been dropped or been replaced. A settle that `driveTick`
   * will drop on its next pass (the next step gave the follower a new job, or the follower is
   * idle) counts as dropped now, so the run stops on the tick the step closed, not one later.
   */
  stopReached(): boolean {
    const id = this.ctx.options.stopAfterStepId;
    if (id === undefined || this.openStepIds.includes(id)) return false;
    const record = this.records.find((r) => r.id === id && r.parentId === null);
    if (record === undefined) return false;
    const pending = this.pendingSettle;
    if (pending === null || pending.record !== record) return true;
    return pending.generation !== this.generation || this.follower.state.mode === "IDLE";
  }

  /**
   * Cuts the run back to the moment the step named by `stopAfterStepId` was done with: its
   * `settledS` when its hold settled, else its `endS`. The run may have gone on past it while a
   * settle watch that never fired was still pending, so everything after is dropped. A step that
   * started by then and was still open is closed there as interrupted, one that started later is
   * removed, and so are the checkpoints and settle times beyond it, and the timeout and condition
   * flags of every step cut off there.
   */
  truncateToStop(): boolean {
    const id = this.ctx.options.stopAfterStepId;
    const target = this.records.find((r) => r.id === id && r.parentId === null);
    // A step the period interrupted never closed, so there is nothing to cut back to.
    if (target === undefined || target.interrupted) return false;
    const stopS = target.settledS ?? target.endS;
    const keep = Math.min(this.poses.length, Math.round(stopS / this.tickS) + 1);
    this.poses.length = keep;
    this.truthPoses.length = Math.min(this.truthPoses.length, keep);
    this.velocities.length = keep;
    this.tick = keep - 1;
    const limit = stopS + 1e-9;
    this.records = this.records.filter((r) => r.startS <= limit);
    for (const record of this.records) {
      if (record.endS > limit || this.openStepIds.includes(record.id)) {
        record.endS = stopS;
        record.interrupted = true;
        // A timeout or condition that ended it did so after the cut, with its event dropped below.
        record.timedOut = false;
        record.conditionFired = false;
      }
      if (record.settledS !== undefined && record.settledS > limit) delete record.settledS;
    }
    this.events = this.events.filter((e) => e.timeS <= limit);
    this.ledgerRows = this.ledgerRows.filter((row) => row.timeS <= limit);
    this.checkpoints = this.checkpoints.filter((c) => (c.state as CheckpointState).tick < keep);
    return true;
  }

  /** True when `stopAfterStepId` names a top-level step that is not the routine's last. */
  stopsBeforeEnd(): boolean {
    const id = this.ctx.options.stopAfterStepId;
    if (id === undefined) return false;
    const index = this.plan.steps.findIndex((step) => step.id === id);
    return index >= 0 && index < this.plan.steps.length - 1;
  }

  /** Phase 3: record the pose the tick started from. */
  recordTick(): void {
    const t = this.timeS;
    const b = this.belief();
    this.poses.push([t, round4(b.x), round4(b.y), round4(normalizeSigned(b.heading))]);
    const m = this.plant.motion();
    if (this.fidelity === "gradle") {
      this.truthPoses.push([t, round4(m.x), round4(m.y), round4(normalizeSigned(m.heading))]);
    }
    this.velocities.push([t, round4(m.vx), round4(m.vy), round4(m.omega)]);
  }
}

// ------------------------------------------------------------------------------------------------
// Commands that need the engine
// ------------------------------------------------------------------------------------------------

/** `AutoStep`: records the step's start and end around its body. */
class StepCommand implements SimCommand {
  constructor(
    private readonly engine: Engine,
    private readonly step: PlanStep,
    private readonly parentId: string | null,
    private readonly stepCtx: StepContext,
    private readonly body: SimCommand,
  ) {}
  initialize(): void {
    this.stepCtx.record = this.engine.startRecord(this.step, this.parentId, this.stepCtx);
    this.body.initialize();
  }
  execute(): void {
    this.body.execute();
  }
  isFinished(): boolean {
    return this.body.isFinished();
  }
  end(interrupted: boolean): void {
    this.body.end(interrupted);
    if (this.stepCtx.record !== null) this.engine.endRecord(this.stepCtx.record, interrupted);
  }
}

/** The routine's own `SequentialCommandGroup`, which also takes the checkpoints. */
export class TopSequence implements SimCommand {
  private index = 0;
  constructor(
    private readonly engine: Engine,
    private readonly members: readonly SimCommand[],
    private readonly offset: number,
  ) {}
  private start(): void {
    const member = this.members[this.index];
    if (member === undefined) return;
    this.engine.beforeTopLevelStep(this.index + this.offset);
    member.initialize();
  }
  initialize(): void {
    this.index = 0;
    this.start();
  }
  execute(): void {
    const current = this.members[this.index];
    if (current === undefined) return;
    current.execute();
    if (current.isFinished()) {
      current.end(false);
      this.index += 1;
      this.start();
    }
  }
  isFinished(): boolean {
    return this.index >= this.members.length;
  }
  end(interrupted: boolean): void {
    if (interrupted) this.members[this.index]?.end(true);
  }
}

/** `FollowPath`, built when it starts the way the runtime's `DeferredCommand` builds a `current` leg. */
class FollowCommand implements SimCommand {
  path: SimPath | null = null;
  /** For a turn on the spot, when the hold is done (`TurnSettle`), as `TurnInPlace` asks it. */
  private settle: TurnSettle | null = null;
  /** The command has ended, done or cut short, so a wait watching it beside it can end too. */
  ended = false;
  constructor(
    private readonly engine: Engine,
    private readonly step: PlanStep,
    private readonly stepCtx: StepContext,
    private readonly speedFraction: number,
  ) {}
  initialize(): void {
    this.ended = false;
    const authored = this.step.step as Extract<Step, { kind: "path" }>;
    const polygons: XY[][] = (this.step.segments ?? []).map((segment) =>
      segment.pointsIn.map((point) => ({ x: point.xIn, y: point.yIn })),
    );
    const first = polygons[0];
    if (first !== undefined && authored.segments[0]?.from === "current") {
      const b = this.engine.belief();
      first[0] = { x: b.x, y: b.y };
    }
    this.path = buildSimPath(polygons, authored.heading, this.step.startPose.headingRad);
    // A path this short is a turn on the spot (`TurnInPlace` in the runtime): the follower holds
    // the end point at the end heading rather than following, until the robot has settled there.
    this.settle = this.path.turn === null ? null : new TurnSettle(this.path.turn);
    if (this.path.turn !== null) this.engine.holdAt(this.path.turn);
    else this.engine.follow(this.path, this.speedFraction);
  }
  execute(): void {}
  isFinished(): boolean {
    // Heading and position both: the runtime holds every path of 2 in or less, so a short drive
    // with no heading change is settled on heading from the first loop and must still arrive. A
    // hold that comes to rest just outside the tolerances ends once it has been still a while.
    if (this.settle !== null) return this.settle.done(this.engine.belief(), this.engine.timeS);
    return !this.engine.follower.following;
  }
  end(interrupted: boolean): void {
    this.ended = true;
    if (interrupted) {
      this.engine.holdHere();
      return;
    }
    const record = this.stepCtx.record;
    if (record !== null && (this.engine.follower.holdEnd || (this.path?.turn ?? null) !== null)) {
      this.engine.pendingSettle = { record, generation: this.engine.generation };
    }
  }
}

/**
 * The `WaitUntilCommand` an `endCondition` races the path against, fired by arc length. The robot
 * reads the condition every loop whatever the follower is doing, so it also ends a turn on the
 * spot (`Parallel.race(TurnInPlace, WaitUntilCommand)` in the runtime): there the fraction is of
 * the turn done rather than of the arc length.
 */
class ConditionTrigger implements SimCommand {
  private fired = false;
  /** Where a turn on the spot started, for `turnProgress`. */
  private turnStart: { x: number; y: number; heading: number } | null = null;
  constructor(
    private readonly engine: Engine,
    private readonly follow: FollowCommand,
    private readonly fraction: number | null,
    private readonly stepCtx: StepContext,
    private readonly condition: string,
    /**
     * A wait beside the path rather than the path's own end condition: it also fires when the path
     * ends before its fire point, cut short by its own end condition or Timeout, or ending on the
     * tick it reaches a fire point at its very end. The ledger has the path collect what it collects
     * by its end, and a wait that never fired would hold its group to the end of the period.
     */
    private readonly firesWhenPathEnds = false,
  ) {}
  initialize(): void {
    this.fired = false;
    const b = this.engine.belief();
    this.turnStart = { x: b.x, y: b.y, heading: b.heading };
  }
  execute(): void {}
  /**
   * How much of a turn on the spot is done, 0 to 1: the share of its heading change made so far,
   * or, for a hold with no heading change past the settle tolerance (a short drive), the share of
   * the move to the held point; 1 once the turn has settled within its tolerances. APPROX: the
   * ledger's pieces are taken as arriving evenly over the turn, as they are taken as evenly spaced
   * along a path.
   */
  private turnProgress(held: { x: number; y: number; heading: number }): number {
    const start = this.turnStart;
    const b = this.engine.belief();
    if (start === null || turnSettled(held, b)) return 1;
    const turnRad = Math.abs(holdTurnRad(start.heading, held.heading));
    if (turnRad >= TURN_SETTLED_RAD) return 1 - Math.abs(holdTurnRad(b.heading, held.heading)) / turnRad;
    const moveIn = Math.hypot(held.x - start.x, held.y - start.y);
    return moveIn < 1e-9 ? 1 : 1 - Math.hypot(held.x - b.x, held.y - b.y) / moveIn;
  }
  isFinished(): boolean {
    if (this.fired) return true;
    const path = this.follow.path;
    const pathEnded = this.firesWhenPathEnds && this.follow.ended;
    const reached =
      pathEnded ||
      (this.fraction !== null &&
        path !== null &&
        (path.turn !== null
          ? this.turnProgress(path.turn) + 1e-9 >= this.fraction
          : this.engine.follower.following &&
            this.engine.follower.distanceAlongIn() + 1e-9 >= this.fraction * path.runtimeTotalIn));
    if (reached) {
      this.fired = true;
      if (this.stepCtx.record !== null) this.stepCtx.record.conditionFired = true;
      this.engine.event("conditionFired", {
        ...(this.stepCtx.record === null ? {} : { stepId: this.stepCtx.record.id }),
        detail: this.condition,
      });
    }
    return this.fired;
  }
  end(): void {}
}

/**
 * The `WaitUntilCommand` a live run races a path against, or waits on: the host's condition,
 * read once per tick, exactly as `WaitUntilCommand` reads its `BooleanSupplier`.
 */
class HostConditionWait implements SimCommand {
  private fired = false;
  constructor(
    private readonly engine: Engine,
    private readonly read: () => boolean,
    private readonly stepCtx: StepContext,
    private readonly condition: string,
  ) {}
  initialize(): void {
    this.fired = false;
  }
  execute(): void {}
  isFinished(): boolean {
    if (this.fired) return true;
    if (!this.read()) return false;
    this.fired = true;
    if (this.stepCtx.record !== null) this.stepCtx.record.conditionFired = true;
    this.engine.event("conditionFired", {
      ...(this.stepCtx.record === null ? {} : { stepId: this.stepCtx.record.id }),
      detail: this.condition,
    });
    return true;
  }
  end(): void {}
}

/** A `WaitUntilCommand` on a `wait` step: the resolved seconds, or never. */
class WaitUntilCommand extends TimedCommand {
  private announced = false;
  constructor(
    private readonly engine: Engine,
    seconds: number | null,
    private readonly stepCtx: StepContext,
    private readonly condition: string,
  ) {
    super(engine, seconds);
  }
  override initialize(): void {
    this.announced = false;
    super.initialize();
  }
  override isFinished(): boolean {
    const finished = super.isFinished();
    if (finished && !this.announced) {
      this.announced = true;
      if (this.stepCtx.record !== null) this.stepCtx.record.conditionFired = true;
      this.engine.event("conditionFired", {
        ...(this.stepCtx.record === null ? {} : { stepId: this.stepCtx.record.id }),
        detail: this.condition,
      });
    }
    return finished;
  }
}

/** `RobotTimeout`: a race against `WaitRobotTime`, flagging the step when the clock wins. */
class TimeoutRace extends RaceCommand {
  constructor(
    private readonly engine: Engine,
    private readonly body: SimCommand,
    private readonly timer: SimCommand,
    private readonly stepCtx: StepContext,
  ) {
    super([body, timer]);
  }
  override end(): void {
    const timedOut = this.timer.isFinished() && !this.body.isFinished();
    super.end();
    if (timedOut && this.stepCtx.record !== null) {
      this.stepCtx.record.timedOut = true;
      this.engine.event("timedOut", { stepId: this.stepCtx.record.id });
    }
  }
}

interface MarkerSpec {
  distanceOf: (total: number) => number;
  name: string;
  /** The subsystems `robot.json` says the command needs, as the runtime's requirements. */
  requires: readonly string[];
  /** Builds the marker's command as it fires. */
  make: () => SimCommand;
}

/**
 * `PathMarkers.Runner`: fires each marker's command once the follower has come far enough. A marker
 * that starts ends, interrupted, any running marker that needs one of its subsystems, as the runtime's
 * runner does.
 */
class MarkerRunner implements SimCommand {
  private fired: boolean[] = [];
  private sorted: { distanceIn: number; spec: MarkerSpec }[] = [];
  private running: { command: SimCommand; requires: readonly string[] }[] = [];
  private furthestIn = 0;
  private seenFollowing = false;
  constructor(
    private readonly engine: Engine,
    private readonly follow: FollowCommand,
    private readonly markers: readonly MarkerSpec[],
    private readonly stepCtx: StepContext,
  ) {}
  private total(): number {
    return this.follow.path?.runtimeTotalIn ?? 0;
  }
  initialize(): void {
    const total = this.total();
    // A turn on the spot drives nowhere, so the runtime fires every one of its markers as it starts.
    const turn = (this.follow.path?.turn ?? null) !== null;
    const withDistance = this.markers.map((spec) => ({ distanceIn: turn ? 0 : spec.distanceOf(total), spec }));
    // A stable insertion sort, as the runtime's, so ties fire in file order.
    const sorted: { distanceIn: number; spec: MarkerSpec }[] = [];
    for (const item of withDistance) {
      let at = sorted.length;
      while (at > 0 && (sorted[at - 1] as { distanceIn: number }).distanceIn > item.distanceIn) at -= 1;
      sorted.splice(at, 0, item);
    }
    this.sorted = sorted;
    this.fired = sorted.map(() => false);
    this.running = [];
    this.furthestIn = 0;
    this.seenFollowing = false;
    this.fireDue();
  }
  /**
   * `MarkerProgress.update`: a follower that stopped following after this path was seen counts as
   * the whole path driven, and one not yet seen as none of it. Only a path that finished reaches the
   * first case: an end condition races this runner along with the path, so it ends the runner on the
   * loop it cuts the path short (see `buildStep`).
   */
  private distanceAlongIn(): number {
    if (this.engine.follower.following) {
      this.seenFollowing = true;
      return this.engine.follower.distanceAlongIn();
    }
    return this.seenFollowing ? this.total() : 0;
  }
  private fireDue(): void {
    for (let i = 0; i < this.sorted.length; i += 1) {
      if (this.fired[i]) continue;
      const item = this.sorted[i] as { distanceIn: number; spec: MarkerSpec };
      if (this.furthestIn + 1e-9 < item.distanceIn) return;
      this.fired[i] = true;
      this.engine.event("markerFired", {
        ...(this.stepCtx.record === null ? {} : { stepId: this.stepCtx.record.id }),
        command: item.spec.name,
      });
      const command: SimCommand = item.spec.make();
      const requires = item.spec.requires;
      for (let r = this.running.length - 1; r >= 0; r -= 1) {
        const other = this.running[r] as { command: SimCommand; requires: readonly string[] };
        if (other.requires.some((subsystem) => requires.includes(subsystem))) {
          other.command.end(true);
          this.running.splice(r, 1);
        }
      }
      command.initialize();
      if (command.isFinished()) command.end(false);
      else this.running.push({ command, requires });
    }
  }
  execute(): void {
    this.furthestIn = Math.max(this.furthestIn, this.distanceAlongIn());
    this.fireDue();
    for (let i = this.running.length - 1; i >= 0; i -= 1) {
      const command = (this.running[i] as { command: SimCommand }).command;
      command.execute();
      if (command.isFinished()) {
        command.end(false);
        this.running.splice(i, 1);
      }
    }
  }
  isFinished(): boolean {
    return false;
  }
  end(): void {
    for (let i = this.running.length - 1; i >= 0; i -= 1) (this.running[i] as { command: SimCommand }).command.end(true);
    this.running = [];
  }
}

// ------------------------------------------------------------------------------------------------
// Conditions
// ------------------------------------------------------------------------------------------------

type ConditionClass = "full" | "empty" | "quantity" | "unknown";

function conditionClass(ctx: Context, condition: string): ConditionClass {
  if (ctx.fullConditions.includes(condition)) return "full";
  if (ctx.emptyConditions.includes(condition)) return "empty";
  return quantityTest(ctx, condition) === null ? "unknown" : "quantity";
}

/** The `{ quantity, min, max }` test `robot.json` gives a condition, when it gives one. */
function quantityTest(ctx: Context, condition: string): ConditionLedgerTest | null {
  const test = conditionTestOf(ctx.robot, condition);
  return test === null || typeof test === "string" ? null : test;
}

/** How a quantity condition reads against one ledger state, or null when the ledger cannot say. */
function quantityReads(ctx: Context, condition: string, state: SeasonState | null): boolean | null {
  const test = quantityTest(ctx, condition);
  const season = ctx.options.season;
  if (test === null || state === null || season === undefined) return null;
  return evaluateLedgerTest(test, state, season, ctx.robot, ctx.alliance);
}

const NO_QUANTITY = (condition: string): string =>
  `"${condition}" reads a number the ledger keeps, and no ledger that keeps it was given, so it is taken as never reading true.`;

const NOT_SEEN = (condition: string): string =>
  `The instant sim cannot see "${condition}", so it is taken as never reading true.`;

const NO_LEDGER = (condition: string): string =>
  `"${condition}" depends on what the robot holds, and no ledger with a capacity was given, so it is taken as never reading true.`;

/** The ledger's view of a full or empty condition against a hold count, or null when it cannot say. */
function readsTrue(
  ctx: Context,
  cls: ConditionClass,
  holds: Readonly<Record<string, number>> | null,
): boolean | null {
  if (holds === null || cls === "unknown") return null;
  const count = sumHolds(holds);
  if (cls === "empty") return count === 0;
  const max = ctx.robot.capacity?.max;
  if (max === undefined) return null;
  return count >= max;
}

/**
 * Where along a path its `endCondition` fires, as a fraction of arc length (of the turn done, for a
 * turn on the spot), or null for never.
 * APPROX: the ledger says how many pieces a step collects or releases, not where; they are taken
 * as evenly spaced, each at the middle of its share of the path.
 */
function endConditionFraction(
  ctx: Context,
  step: PlanStep,
  condition: string,
  stepCtx: StepContext,
): number | null {
  const view = ctx.holds.get(step.id) ?? null;
  const query: ConditionQuery = {
    kind: "endCondition",
    stepId: step.id,
    condition,
    holdsBefore: view?.before ?? null,
    holdsAfter: view?.after ?? null,
  };
  const custom = ctx.options.conditions?.(query);
  if (custom !== undefined) return typeof custom === "number" ? custom : null;

  const cls = conditionClass(ctx, condition);
  if (cls === "unknown") {
    stepCtx.unknownReasons.push(NOT_SEEN(condition));
    return null;
  }
  if (cls === "quantity") {
    // The ledger changes a quantity once per step, so the condition either holds as the path
    // starts, becomes true by its end, or never does on it.
    const atStart = quantityReads(ctx, condition, view?.entry.before ?? null);
    if (atStart === null) {
      stepCtx.unknownReasons.push(NO_QUANTITY(condition));
      return null;
    }
    if (atStart) return 0;
    return quantityReads(ctx, condition, view?.entry.after ?? null) === true ? 1 : null;
  }
  const before = view?.before ?? null;
  const after = view?.after ?? null;
  const atStart = readsTrue(ctx, cls, before);
  if (atStart === null || after === null) {
    stepCtx.unknownReasons.push(NO_LEDGER(condition));
    return null;
  }
  if (atStart) return 0;
  if (readsTrue(ctx, cls, after) !== true) return null;
  const h0 = sumHolds(before as Record<string, number>);
  const h1 = sumHolds(after);
  const pieces = Math.abs(h1 - h0);
  if (pieces === 0) return null;
  const needed = cls === "full" ? (ctx.robot.capacity?.max ?? h1) - h0 : h0;
  return Math.max(0, Math.min(1, (needed - 0.5) / pieces));
}

/** Seconds after a `wait until` starts that it ends, or null for never. */
function waitSeconds(ctx: Context, step: PlanStep, condition: string, stepCtx: StepContext): number | null {
  const holds = ctx.holds.get(step.id)?.before ?? null;
  const custom = ctx.options.conditions?.({ kind: "wait", stepId: step.id, condition, holds });
  if (custom !== undefined) return typeof custom === "number" ? custom : null;
  const cls = conditionClass(ctx, condition);
  if (cls === "unknown") {
    stepCtx.unknownReasons.push(NOT_SEEN(condition));
    return null;
  }
  if (cls === "quantity") {
    const reads = quantityReads(ctx, condition, ctx.holds.get(step.id)?.entry.before ?? null);
    if (reads === null) {
      stepCtx.unknownReasons.push(NO_QUANTITY(condition));
      return null;
    }
    return reads ? 0 : null;
  }
  const value = readsTrue(ctx, cls, holds);
  if (value === null) {
    stepCtx.unknownReasons.push(NO_LEDGER(condition));
    return null;
  }
  return value ? 0 : null;
}

/**
 * Which side a branch takes: the side the ledger took when it could read the condition, so the
 * preview and the ledger always follow the same arm. With nothing to go on, the `then` side, and
 * the step says so.
 */
function branchSide(ctx: Context, step: PlanStep, condition: string, stepCtx: StepContext): boolean {
  const view = ctx.holds.get(step.id);
  const holds = view?.before ?? null;
  const custom = ctx.options.conditions?.({ kind: "branch", stepId: step.id, condition, holds });
  if (custom !== undefined && custom !== null) return Boolean(custom);
  const decided = view?.entry.branch ?? null;
  if (decided !== null && decided.known) return decided.then;
  const cls = conditionClass(ctx, condition);
  const value =
    cls === "quantity" ? quantityReads(ctx, condition, view?.entry.before ?? null) : readsTrue(ctx, cls, holds);
  if (value === null) {
    stepCtx.unknownReasons.push(
      `The instant sim cannot tell how "${condition}" reads, so it takes the then side.`,
    );
    return true;
  }
  return value;
}

// ------------------------------------------------------------------------------------------------
// Building the command tree
// ------------------------------------------------------------------------------------------------

function commandTiming(ctx: Context, name: string, args: Readonly<Record<string, string | number | boolean>> | undefined): {
  seconds: number;
  reason: string | null;
} {
  const spec = ctx.robot.commands.find((command) => command.name === name);
  if (spec === undefined) {
    return { seconds: ctx.unknownCommandS, reason: `"${name}" is not in the command registry.` };
  }
  const seconds = commandSeconds(name, args, ctx.robot);
  if (seconds === null) {
    return {
      seconds: ctx.unknownCommandS,
      reason: `"${name}" has no estimateS, so it is taken as ${String(ctx.unknownCommandS)} s.`,
    };
  }
  if (spec.movesRobot === true) {
    return { seconds, reason: `"${name}" moves the robot in ways the instant sim does not drive.` };
  }
  return { seconds, reason: null };
}

/**
 * A command step's own body in the instant sim: a timer on its seconds, or, for a command that
 * drives the robot to the pose the plan takes from the next path's rejoin pose, the drift
 * (`driftCommand.ts`), which moves the robot there in the same time. Only the instant sim's own
 * plant drifts; a live run, whose plant another program writes, keeps the timer.
 */
function commandBody(engine: Engine, step: PlanStep, seconds: number, stepCtx: StepContext): SimCommand {
  const target = engine.ctx.host === null ? driftTarget(step, engine.ctx.robot) : null;
  if (target === null || seconds <= 0) return new TimedCommand(engine, seconds);
  const timeoutS = stepTimeoutS(step.step);
  const driftS = timeoutS === undefined ? seconds : Math.min(seconds, Math.round(timeoutS * 1000) / 1000);
  stepCtx.unknownReasons.push(
    "The sim moves the robot from where the step starts to the next path's rejoin pose over the step's time, a guess at where it goes, not a prediction.",
  );
  return new DriftCommand(engine, seconds, driftS, target);
}

/**
 * A named command: the host's own when it runs one, otherwise a timer on its `estimateS`. The host
 * is asked as the command is built, once per place the file names it, so a command in a marker and
 * the same command in a step are two objects, as they are on the robot.
 */
function namedCommand(
  engine: Engine,
  name: string,
  args: Readonly<Record<string, string | number | boolean>> | undefined,
  stepId: string,
  stepCtx: StepContext | null,
): SimCommand {
  const hosted = engine.ctx.host?.command?.(name, args ?? {}, stepId) ?? null;
  if (hosted !== null) return hosted;
  const timing = commandTiming(engine.ctx, name, args);
  if (timing.reason !== null && stepCtx !== null) stepCtx.unknownReasons.push(timing.reason);
  return new TimedCommand(engine, timing.seconds);
}

/** Each path step's follower, by step id, so a wait beside it in a parallel group can watch it. */
const followsOf = new WeakMap<Engine, Map<string, FollowCommand>>();

/**
 * A `wait until` inside a parallel group whose condition a path beside it makes true: it fires where
 * along that path the ledger's pieces make it true, as the path's own `endCondition` would, or when
 * that path ends, whichever comes first.
 *
 * The ledger runs a group's members one after another, so the wait's own "before" already holds
 * what the path beside it collects. Read as is, a race of a sweep and "wait until hopperFull" ended
 * on its first tick, with the sweep not driven (W2-18 of the 0.1.2 sweep).
 *
 * `groups` are the parallel groups the wait is inside, outermost first. The wait may sit anywhere
 * in one, inside a sequence or a nested group; the path it watches is a direct member of the
 * nearest of them that has one making the condition true. A path deeper inside a sibling member,
 * such as in a sequence beside the wait, is not watched, and the wait reads as before. Null too
 * when the condition already holds as that group starts.
 */
function siblingTrigger(
  engine: Engine,
  step: PlanStep,
  groups: readonly PlanStep[],
  condition: string,
  stepCtx: StepContext,
): SimCommand | null {
  const ctx = engine.ctx;
  if (groups.length === 0 || ctx.options.conditions !== undefined) return null;
  const cls = conditionClass(ctx, condition);
  if (cls !== "full" && cls !== "empty") return null;
  for (let at = groups.length - 1; at >= 0; at -= 1) {
    const group = groups[at] as PlanStep;
    const first = group.children?.[0];
    const atGroupStart = readsTrue(ctx, cls, first === undefined ? null : (ctx.holds.get(first.id)?.before ?? null));
    if (atGroupStart !== false) continue;
    for (const sibling of group.children ?? []) {
      if (sibling.id === step.id || sibling.step.kind !== "path") continue;
      const follow = followsOf.get(engine)?.get(sibling.id);
      if (follow === undefined) continue;
      if (readsTrue(ctx, cls, ctx.holds.get(sibling.id)?.after ?? null) !== true) continue;
      const scratch: StepContext = { record: null, unknownReasons: [] };
      const fraction = endConditionFraction(ctx, sibling, condition, scratch);
      if (fraction === null) continue;
      return new ConditionTrigger(engine, follow, fraction, stepCtx, condition, true);
    }
  }
  return null;
}

/** `groups`: the parallel groups `step` is inside, outermost first, for `siblingTrigger`. */
function buildStep(engine: Engine, step: PlanStep, parentId: string | null, groups: readonly PlanStep[] = []): SimCommand {
  const ctx = engine.ctx;
  const stepCtx: StepContext = { record: null, unknownReasons: [] };
  const authored = step.step;
  let body: SimCommand;

  switch (authored.kind) {
    case "path": {
      const follow = new FollowCommand(
        engine,
        step,
        stepCtx,
        authored.speedFraction ?? ctx.defaultSpeedFraction,
      );
      let follows = followsOf.get(engine);
      if (follows === undefined) followsOf.set(engine, (follows = new Map()));
      follows.set(step.id, follow);
      let drive: SimCommand = follow;
      // The end condition races the path and its markers together, as `AutoBuilder` builds it, so a
      // path cut short ends the marker runner on the loop the condition fires.
      let cut: SimCommand | null = null;
      if (authored.endCondition !== undefined) {
        const condition = authored.endCondition.condition;
        const read = ctx.host?.condition;
        if (read !== undefined) {
          const trigger = new HostConditionWait(engine, () => read.call(ctx.host, condition, step.id), stepCtx, condition);
          cut = trigger;
        } else {
          const fraction = endConditionFraction(ctx, step, condition, stepCtx);
          cut = new ConditionTrigger(engine, follow, fraction, stepCtx, condition);
        }
      }
      const markers = authored.markers ?? [];
      if (markers.length > 0) {
        const specs: MarkerSpec[] = markers.map((marker) => {
          const at = marker.at;
          // A distance from either end stays on the path, as the generated code clamps it, so a path
          // shortened after its marker was set never puts the marker past either end (W2-11).
          const distanceOf =
            "t" in at
              ? (total: number) => at.t * total
              : "distanceIn" in at
                ? (total: number) => Math.min(total, at.distanceIn)
                : (total: number) => Math.max(0, total - at.distanceFromEndIn);
          const name = marker.command.name;
          const args = marker.command.args;
          return {
            distanceOf,
            name,
            requires: ctx.robot.commands.find((command) => command.name === name)?.requires ?? [],
            make: () => namedCommand(engine, name, args, step.id, null),
          };
        });
        drive = new DeadlineCommand(drive, [new MarkerRunner(engine, follow, specs, stepCtx)]);
      }
      if (cut !== null) drive = new RaceCommand([drive, cut]);
      body = drive;
      break;
    }
    case "command": {
      // A host that runs its own commands (live/) answers first, as namedCommand does.
      const hosted = ctx.host?.command?.(authored.name, authored.args ?? {}, step.id) ?? null;
      if (hosted !== null) {
        body = hosted;
        break;
      }
      const timing = commandTiming(ctx, authored.name, authored.args);
      // A command with no estimate of its own runs for its envelope's window when it declares one,
      // the same number the estimate uses (spec 13 section 10). The sim still cannot say where it
      // leaves the robot, so the step stays marked as one the sim does not predict.
      const windowS = commandSeconds(authored.name, authored.args, ctx.robot) === null ? envelopeWindowS(authored) : null;
      if (windowS !== null) {
        const which = authored.envelope?.actualDurationS === undefined ? "maxDurationS" : "what-if actualDurationS";
        stepCtx.unknownReasons.push(
          `"${authored.name}" has no estimate of its own, so it runs for its envelope's ${which} of ${String(windowS)} s; the instant sim cannot tell where it leaves the robot.`,
        );
      } else if (timing.reason !== null) {
        stepCtx.unknownReasons.push(timing.reason);
      }
      body = commandBody(engine, step, windowS ?? timing.seconds, stepCtx);
      break;
    }
    case "wait": {
      const read = ctx.host?.condition;
      if (authored.until !== undefined && read !== undefined) {
        const condition = authored.until;
        body = new HostConditionWait(engine, () => read.call(ctx.host, condition, step.id), stepCtx, condition);
      } else if (authored.until !== undefined) {
        const beside = siblingTrigger(engine, step, groups, authored.until, stepCtx);
        body = beside ?? new WaitUntilCommand(engine, waitSeconds(ctx, step, authored.until, stepCtx), stepCtx, authored.until);
      } else {
        // `WaitRobotTime(Math.round(seconds * 1000))`: whole milliseconds.
        body = new TimedCommand(engine, Math.round((authored.seconds ?? 0) * 1000) / 1000);
      }
      break;
    }
    case "transfer": {
      // Planner-only: the robot runtime runs a transfer as a wait of zero seconds, and so does the
      // sim. Its effect is the ledger's, which the conditions read.
      body = new TimedCommand(engine, 0);
      break;
    }
    case "sequence": {
      body = new SequenceCommand((step.children ?? []).map((child) => buildStep(engine, child, step.id, groups)));
      break;
    }
    case "parallel": {
      const children = step.children ?? [];
      // The paths first, so a wait anywhere in the group on a condition a path beside it makes true
      // finds that path's follower (`siblingTrigger`). The members keep their order.
      const inside = [...groups, step];
      const members: SimCommand[] = [];
      children.forEach((child, index) => {
        if (child.step.kind === "path") members[index] = buildStep(engine, child, step.id, inside);
      });
      children.forEach((child, index) => {
        if (child.step.kind !== "path") members[index] = buildStep(engine, child, step.id, inside);
      });
      if (authored.mode === "all") body = new ParallelAllCommand(members);
      else if (authored.mode === "race") body = new RaceCommand(members);
      else {
        const at = children.findIndex(
          (child) => child.id === authored.deadline || child.step.id === authored.deadline,
        );
        if (at < 0) {
          stepCtx.unknownReasons.push(
            "Its deadline names none of its own steps, which the runtime refuses; the sim waits for all of them.",
          );
          body = new ParallelAllCommand(members);
        } else {
          body = new DeadlineCommand(
            members[at] as SimCommand,
            members.filter((_, index) => index !== at),
          );
        }
      }
      break;
    }
    case "branch": {
      const children = step.children ?? [];
      const thenCount = authored.then.length;
      const thenSide = new SequenceCommand(
        children.slice(0, thenCount).map((child) => buildStep(engine, child, step.id, groups)),
      );
      const elseChildren = children.slice(thenCount);
      const elseSide: SimCommand =
        authored.else === undefined || authored.else.length === 0
          ? new InstantCommand()
          : new SequenceCommand(elseChildren.map((child) => buildStep(engine, child, step.id, groups)));
      const condition = authored.condition;
      const read = ctx.host?.condition;
      if (read !== undefined) {
        // `ConditionalCommand` reads its supplier as it starts, so a live run asks the host then.
        body = new ConditionalCommand(() => read.call(ctx.host, condition, step.id), thenSide, elseSide);
      } else {
        const side = branchSide(ctx, step, condition, stepCtx);
        body = new ConditionalCommand(() => side, thenSide, elseSide);
      }
      break;
    }
  }

  if ("timeoutS" in authored && authored.timeoutS !== undefined) {
    const timer = new TimedCommand(engine, Math.round(authored.timeoutS * 1000) / 1000);
    body = new TimeoutRace(engine, body, timer, stepCtx);
  }
  return new StepCommand(engine, step, parentId, stepCtx, body);
}

// ------------------------------------------------------------------------------------------------
// The ledger's holds, by step
// ------------------------------------------------------------------------------------------------

function holdsByStep(plan: Plan, options: SimOptions): Map<string, HoldsView> {
  const views = new Map<string, HoldsView>();
  const ledger = options.ledger;
  if (ledger === undefined) return views;
  const season = options.season;
  const tracked = season?.holds !== undefined;
  let previous: Readonly<Record<string, number>> | null = tracked
    ? (season?.holds?.(ledger.initialState) ?? null)
    : (plan.auto.start.holds ?? null);
  for (const entry of ledger.entries) {
    const known = tracked || Object.keys(entry.holds).length > 0;
    const before = tracked && season?.holds !== undefined ? season.holds(entry.before) : previous;
    const after = known ? entry.holds : null;
    views.set(entry.stepId, { before, after, entry });
    previous = after ?? previous;
  }
  return views;
}

// ------------------------------------------------------------------------------------------------
// Keys for re-simulation
// ------------------------------------------------------------------------------------------------

/** cyrb53, a small well-mixed 53-bit string hash. Only ever compared for equality. */
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/**
 * What a step's key is made of: everything about it that the run reads, with its children's parts
 * nested as they are. The whole tree is stringified once, in `stepKey`. Stringifying each child on
 * its own and embedding that string in its parent escaped every quote again at each level, so the
 * key doubled per level of nesting and about 30 nested groups threw `RangeError: Invalid string
 * length` (issue #389).
 */
function stepKeyParts(step: PlanStep, holds: ReadonlyMap<string, HoldsView>): object {
  const view = holds.get(step.id);
  return {
    id: step.id,
    step: step.step,
    start: step.startPose,
    segments: step.segments?.map((segment) => segment.pointsIn) ?? null,
    before: view?.before ?? null,
    after: view?.after ?? null,
    // A condition may read any number the ledger keeps, and a transfer earlier in the routine
    // changes them without changing this step, so the whole state is part of the key.
    ledgerBefore: view?.entry.before ?? null,
    ledgerAfter: view?.entry.after ?? null,
    branch: view?.entry.branch ?? null,
    children: step.children?.map((child) => stepKeyParts(child, holds)) ?? null,
  };
}

function stepKey(step: PlanStep, holds: ReadonlyMap<string, HoldsView>): string {
  return JSON.stringify(stepKeyParts(step, holds));
}

function prefixKeys(
  plan: Plan,
  robot: Robot,
  field: Field,
  options: SimOptions,
  holds: ReadonlyMap<string, HoldsView>,
): string[] {
  // `stopAfterStepId` only says where a run ends, so it stays out of the key and a stopped run's
  // checkpoints serve any later run.
  const {
    ledger: _ledger,
    season: _season,
    conditions: _conditions,
    stopAfterStepId: _stopAfterStepId,
    ...plain
  } = options;
  let key = hash(
    JSON.stringify({ robot, field, options: plain, start: plan.startPose, auto: plan.auto.start }),
  );
  const keys = [key];
  for (const step of plan.steps) {
    key = hash(key + stepKey(step, holds));
    keys.push(key);
  }
  return keys;
}

// ------------------------------------------------------------------------------------------------
// Running
// ------------------------------------------------------------------------------------------------

export interface EngineSetup {
  engine: Engine;
  maxTimeS: number;
  periodS: number | null;
  members: SimCommand[];
}

/**
 * How an engine is built for a live run: its plant, its host, and no checkpoints. Internal to the
 * package; `../live/` is the only other caller.
 */
export interface LiveEngineParts {
  plant: (start: { x: number; y: number; heading: number }) => EnginePlant;
  host: EngineHost;
}

export function setup(
  plan: Plan,
  robot: Robot,
  field: Field,
  options: SimOptions,
  live: LiveEngineParts | null = null,
): EngineSetup {
  const run = runParams(field, options);
  const limits = robotLimits(robot);
  const plant = plantParams(robot, field, run.fidelity, options);
  const follower = new PedroFollower(
    followerParams(robot, options),
    plant.maxForwardVelInPerS,
    plant.maxStrafeVelInPerS,
    limits.holdEnd,
  );
  const start = plan.startPose;
  const holds = holdsByStep(plan, options);
  const ctx: Context = {
    host: live?.host ?? null,
    robot,
    alliance: plan.auto.alliance,
    options,
    fidelity: run.fidelity,
    unknownCommandS: options.unknownCommandS ?? 0,
    defaultSpeedFraction: limits.defaultPathSpeedFraction,
    fullConditions:
      options.fullConditions ??
      (markedConditions(robot, "full").length > 0 ? markedConditions(robot, "full") : ["hopperFull"]),
    emptyConditions:
      options.emptyConditions ??
      (markedConditions(robot, "empty").length > 0 ? markedConditions(robot, "empty") : ["hopperEmpty"]),
    holds,
  };
  const engine = new Engine(
    ctx,
    plan,
    run.tickS,
    run.fidelity,
    live === null
      ? new MecanumPlant(plant, start.xIn, start.yIn, start.headingRad)
      : live.plant({ x: start.xIn, y: start.yIn, heading: start.headingRad }),
    follower,
  );
  if (live === null) engine.prefixKeys = prefixKeys(plan, robot, field, options, holds);
  else engine.skipCheckpointsThrough = Number.POSITIVE_INFINITY;
  const members = plan.steps.map((step) => buildStep(engine, step, null));
  return { engine, maxTimeS: run.maxTimeS, periodS: run.periodS, members };
}

/**
 * Runs ticks until the routine finishes or the time runs out. `midTick` resumes a tick that a
 * checkpoint interrupted just after the command tree ran.
 */
function runLoop(engine: Engine, root: SimCommand, maxTimeS: number, midTick: boolean): boolean {
  let resume = midTick;
  for (;;) {
    if (!resume) {
      engine.driveTick();
      root.execute();
    }
    resume = false;
    const done = root.isFinished();
    if (done) root.end(false);
    engine.recordTick();
    // A settle watch that never fired can hold the run past the named step until the routine ends
    // or the time runs out, so those two end the run the same way a stop does: cut back.
    if (done) return !engine.stopsBeforeEnd() || !engine.truncateToStop();
    if (engine.stopReached()) {
      engine.truncateToStop();
      return false;
    }
    if ((engine.tick + 1) * engine.tickS > maxTimeS + 1e-9) {
      root.end(true);
      engine.event("periodEnded", { detail: "The routine had not finished when the time ran out." });
      engine.truncateToStop();
      return false;
    }
    engine.plant.update(engine.tickS);
    engine.tick += 1;
  }
}

export function finish(engine: Engine, plan: Plan, completed: boolean, periodS: number | null): SimTrace {
  const capabilities = ["steps", "poses", "velocities", "events"];
  if (engine.ctx.options.ledger !== undefined) capabilities.push("ledger");
  if (engine.fidelity === "gradle") capabilities.push("truthPoses");
  return {
    formatVersion: 1,
    auto: plan.auto.name,
    sha: null,
    simTimeS: engine.timeS,
    tickS: engine.tickS,
    capabilities,
    steps: engine.records,
    poses: engine.poses,
    truthPoses: engine.truthPoses,
    structureContacts: [],
    ledger: engine.ledgerRows,
    events: engine.events,
    source: "instant",
    fidelity: engine.fidelity,
    velocities: engine.velocities,
    completed,
    periodS,
  };
}

/** Runs the routine from the start and keeps the checkpoints `resimulate` needs. */
export function simulateRun(plan: Plan, robot: Robot, field: Field, options: SimOptions = {}): SimRun {
  const { engine, maxTimeS, periodS, members } = setup(plan, robot, field, options);
  const root = new TopSequence(engine, members, 0);
  root.initialize();
  const completed = runLoop(engine, root, maxTimeS, false);
  return { trace: finish(engine, plan, completed, periodS), checkpoints: engine.checkpoints, resumedFromStep: 0 };
}

/**
 * The instant sim: the routine as the robot would run it, tick by tick, as a `Trace` with the
 * sim's additions (`SimTrace`). The default fidelity is `robot`; pass `fidelity: "gradle"` to
 * reproduce the robot repository's headless harness instead.
 */
export function simulate(plan: Plan, robot: Robot, field: Field, options: SimOptions = {}): SimTrace {
  return simulateRun(plan, robot, field, options).trace;
}

/**
 * Re-simulates after an edit, from the latest checkpoint whose every earlier top-level step, and
 * every input, is unchanged. `fromStepIndex`, when given, is the first step the caller knows was
 * edited; the sim never resumes later than it. The result is identical to `simulateRun` on the
 * same inputs, only faster. A `conditions` resolver is not part of the key: pass the same one.
 */
export function resimulate(
  previous: SimRun,
  plan: Plan,
  robot: Robot,
  field: Field,
  options: SimOptions = {},
  fromStepIndex?: number,
): SimRun {
  const { engine, maxTimeS, periodS, members } = setup(plan, robot, field, options);
  // Never resume past the step a run stops after: the stop is detected as that step closes, which a
  // run starting later has already passed.
  const stopIndex =
    options.stopAfterStepId === undefined
      ? -1
      : plan.steps.findIndex((step) => step.id === options.stopAfterStepId);
  const limit = Math.min(
    fromStepIndex ?? plan.steps.length,
    plan.steps.length - 1,
    stopIndex < 0 ? plan.steps.length : stopIndex,
  );
  let checkpoint: SimCheckpoint | null = null;
  for (const candidate of previous.checkpoints) {
    if (candidate.stepIndex > limit) break;
    if (engine.prefixKeys[candidate.stepIndex] === candidate.prefixKey) checkpoint = candidate;
  }
  if (checkpoint === null) return simulateRun(plan, robot, field, options);

  const state = checkpoint.state as CheckpointState;
  const trace = previous.trace;
  engine.tick = state.tick;
  engine.plant.state = copyPlantState(state.plant);
  engine.follower.state = copyFollowerState(state.follower);
  engine.generation = state.generation;
  engine.records = trace.steps.slice(0, state.records).map((record) => ({ ...record }));
  engine.events = trace.events.slice(0, state.events);
  engine.ledgerRows = trace.ledger.slice(0, state.ledger);
  engine.poses = trace.poses.slice(0, state.tick);
  engine.truthPoses = trace.truthPoses.slice(0, state.tick);
  engine.velocities = trace.velocities.slice(0, state.tick);
  if (state.pendingSettle !== null) {
    const record = engine.records[state.pendingSettle] as SimStepRecord;
    delete record.settledS;
    engine.pendingSettle = { record, generation: state.generation };
  }
  engine.checkpoints = previous.checkpoints.filter((c) => c.stepIndex <= checkpoint.stepIndex);
  engine.skipCheckpointsThrough = checkpoint.stepIndex;

  const index = checkpoint.stepIndex;
  const root = new TopSequence(engine, members.slice(index), index);
  root.initialize();
  const completed = runLoop(engine, root, maxTimeS, true);
  return {
    trace: finish(engine, plan, completed, periodS),
    checkpoints: engine.checkpoints,
    resumedFromStep: index,
  };
}

/** The recorded pose at `timeS`, interpolated between ticks, with the heading taken the short way. */
export function simPoseAt(
  trace: { poses: readonly TracePoseRow[] },
  timeS: number,
): { xIn: number; yIn: number; headingRad: number } | null {
  const poses = trace.poses;
  const first = poses[0];
  const last = poses[poses.length - 1];
  if (first === undefined || last === undefined) return null;
  if (timeS <= first[0]) return { xIn: first[1], yIn: first[2], headingRad: first[3] };
  if (timeS >= last[0]) return { xIn: last[1], yIn: last[2], headingRad: last[3] };
  let lo = 0;
  let hi = poses.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((poses[mid] as TracePoseRow)[0] <= timeS) lo = mid;
    else hi = mid;
  }
  const a = poses[lo] as TracePoseRow;
  const b = poses[hi] as TracePoseRow;
  const span = b[0] - a[0];
  const u = span <= 0 ? 0 : (timeS - a[0]) / span;
  return {
    xIn: a[1] + (b[1] - a[1]) * u,
    yIn: a[2] + (b[2] - a[2]) * u,
    headingRad: normalizeSigned(a[3] + normalizeSigned(b[3] - a[3]) * u),
  };
}
