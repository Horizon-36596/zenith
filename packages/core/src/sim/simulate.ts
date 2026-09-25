import type { Field, Robot, Step } from "@horizon36596/zenith-schema";
import { commandSeconds } from "../estimate.js";
import { robotLimits } from "../kinematics.js";
import type { LedgerEntry } from "../ledger.js";
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
import { copyFollowerState, PedroFollower, type FollowerState, type MotionState } from "./follower.js";
import { followerParams, plantParams, runParams } from "./params.js";
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

/** The per-run context every command reads. */
interface Context {
  robot: Robot;
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

class Engine implements SimClock {
  tick = 0;
  readonly tickS: number;
  readonly fidelity: SimFidelity;
  readonly plant: MecanumPlant;
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

  constructor(
    readonly ctx: Context,
    readonly plan: Plan,
    tickS: number,
    fidelity: SimFidelity,
    plant: MecanumPlant,
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
    return record;
  }

  endRecord(record: SimStepRecord, interrupted: boolean): void {
    record.endS = this.timeS;
    record.interrupted = interrupted;
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
class TopSequence implements SimCommand {
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
  constructor(
    private readonly engine: Engine,
    private readonly step: PlanStep,
    private readonly stepCtx: StepContext,
    private readonly speedFraction: number,
  ) {}
  initialize(): void {
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
    this.engine.follow(this.path, this.speedFraction);
  }
  execute(): void {}
  isFinished(): boolean {
    return !this.engine.follower.following;
  }
  end(interrupted: boolean): void {
    if (interrupted) {
      this.engine.holdHere();
      return;
    }
    const record = this.stepCtx.record;
    if (record !== null && this.engine.follower.holdEnd) {
      this.engine.pendingSettle = { record, generation: this.engine.generation };
    }
  }
}

/** The `WaitUntilCommand` an `endCondition` races the path against, fired by arc length. */
class ConditionTrigger implements SimCommand {
  private fired = false;
  constructor(
    private readonly engine: Engine,
    private readonly follow: FollowCommand,
    private readonly fraction: number | null,
    private readonly stepCtx: StepContext,
    private readonly condition: string,
  ) {}
  initialize(): void {
    this.fired = false;
  }
  execute(): void {}
  isFinished(): boolean {
    if (this.fired) return true;
    const path = this.follow.path;
    if (this.fraction === null || path === null || !this.engine.follower.following) return false;
    if (this.engine.follower.distanceAlongIn() + 1e-9 >= this.fraction * path.runtimeTotalIn) {
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
  seconds: number;
}

/** `PathMarkers.Runner`: fires each marker's command once the follower has come far enough. */
class MarkerRunner implements SimCommand {
  private fired: boolean[] = [];
  private sorted: { distanceIn: number; spec: MarkerSpec }[] = [];
  private running: SimCommand[] = [];
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
    const withDistance = this.markers.map((spec) => ({ distanceIn: spec.distanceOf(total), spec }));
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
  private distanceAlongIn(): number {
    if (this.engine.follower.following) this.seenFollowing = true;
    else if (this.seenFollowing) return this.total();
    return this.engine.follower.distanceAlongIn();
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
      const command: SimCommand = new TimedCommand(this.engine, item.spec.seconds);
      command.initialize();
      if (command.isFinished()) command.end(false);
      else this.running.push(command);
    }
  }
  execute(): void {
    this.furthestIn = Math.max(this.furthestIn, this.distanceAlongIn());
    this.fireDue();
    for (let i = this.running.length - 1; i >= 0; i -= 1) {
      const command = this.running[i] as SimCommand;
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
    for (let i = this.running.length - 1; i >= 0; i -= 1) (this.running[i] as SimCommand).end(true);
    this.running = [];
  }
}

// ------------------------------------------------------------------------------------------------
// Conditions
// ------------------------------------------------------------------------------------------------

type ConditionClass = "full" | "empty" | "unknown";

function conditionClass(ctx: Context, condition: string): ConditionClass {
  if (ctx.fullConditions.includes(condition)) return "full";
  if (ctx.emptyConditions.includes(condition)) return "empty";
  return "unknown";
}

/** The declared conditions whose `ledger` key reads `kind`, when the robot file marks any. */
function markedConditions(robot: Robot, kind: "full" | "empty"): string[] {
  const conditions: unknown = (robot as unknown as Record<string, unknown>)["conditions"];
  if (!Array.isArray(conditions)) return [];
  const names: string[] = [];
  for (const entry of conditions) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (record["ledger"] === kind && typeof record["name"] === "string") names.push(record["name"]);
  }
  return names;
}

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
 * Where along a path its `endCondition` fires, as a fraction of arc length, or null for never.
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
  const value = readsTrue(ctx, cls, holds);
  if (value === null) {
    stepCtx.unknownReasons.push(NO_LEDGER(condition));
    return null;
  }
  return value ? 0 : null;
}

/** Which side a branch takes. With nothing to go on, the `then` side, and the step says so. */
function branchSide(ctx: Context, step: PlanStep, condition: string, stepCtx: StepContext): boolean {
  const holds = ctx.holds.get(step.id)?.before ?? null;
  const custom = ctx.options.conditions?.({ kind: "branch", stepId: step.id, condition, holds });
  if (custom !== undefined && custom !== null) return Boolean(custom);
  const value = readsTrue(ctx, conditionClass(ctx, condition), holds);
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

function buildStep(engine: Engine, step: PlanStep, parentId: string | null): SimCommand {
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
      let drive: SimCommand = follow;
      if (authored.endCondition !== undefined) {
        const condition = authored.endCondition.condition;
        const fraction = endConditionFraction(ctx, step, condition, stepCtx);
        drive = new RaceCommand([follow, new ConditionTrigger(engine, follow, fraction, stepCtx, condition)]);
      }
      const markers = authored.markers ?? [];
      if (markers.length > 0) {
        const specs: MarkerSpec[] = markers.map((marker) => {
          const at = marker.at;
          const distanceOf =
            "t" in at
              ? (total: number) => at.t * total
              : "distanceIn" in at
                ? () => at.distanceIn
                : (total: number) => total - at.distanceFromEndIn;
          return {
            distanceOf,
            name: marker.command.name,
            seconds: commandTiming(ctx, marker.command.name, marker.command.args).seconds,
          };
        });
        drive = new DeadlineCommand(drive, [new MarkerRunner(engine, follow, specs, stepCtx)]);
      }
      body = drive;
      break;
    }
    case "command": {
      const timing = commandTiming(ctx, authored.name, authored.args);
      if (timing.reason !== null) stepCtx.unknownReasons.push(timing.reason);
      body = new TimedCommand(engine, timing.seconds);
      break;
    }
    case "wait": {
      if (authored.until !== undefined) {
        const seconds = waitSeconds(ctx, step, authored.until, stepCtx);
        body = new WaitUntilCommand(engine, seconds, stepCtx, authored.until);
      } else {
        // `WaitRobotTime(Math.round(seconds * 1000))`: whole milliseconds.
        body = new TimedCommand(engine, Math.round((authored.seconds ?? 0) * 1000) / 1000);
      }
      break;
    }
    case "sequence": {
      body = new SequenceCommand((step.children ?? []).map((child) => buildStep(engine, child, step.id)));
      break;
    }
    case "parallel": {
      const children = step.children ?? [];
      const members = children.map((child) => buildStep(engine, child, step.id));
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
        children.slice(0, thenCount).map((child) => buildStep(engine, child, step.id)),
      );
      const elseChildren = children.slice(thenCount);
      const elseSide: SimCommand =
        authored.else === undefined || authored.else.length === 0
          ? new InstantCommand()
          : new SequenceCommand(elseChildren.map((child) => buildStep(engine, child, step.id)));
      const condition = authored.condition;
      const side = branchSide(ctx, step, condition, stepCtx);
      body = new ConditionalCommand(() => side, thenSide, elseSide);
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

function stepKey(step: PlanStep, holds: ReadonlyMap<string, HoldsView>): string {
  const view = holds.get(step.id);
  return JSON.stringify({
    id: step.id,
    step: step.step,
    start: step.startPose,
    segments: step.segments?.map((segment) => segment.pointsIn) ?? null,
    before: view?.before ?? null,
    after: view?.after ?? null,
    children: step.children?.map((child) => stepKey(child, holds)) ?? null,
  });
}

function prefixKeys(
  plan: Plan,
  robot: Robot,
  field: Field,
  options: SimOptions,
  holds: ReadonlyMap<string, HoldsView>,
): string[] {
  const { ledger: _ledger, season: _season, conditions: _conditions, ...plain } = options;
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

interface Setup {
  engine: Engine;
  maxTimeS: number;
  periodS: number | null;
  members: SimCommand[];
}

function setup(plan: Plan, robot: Robot, field: Field, options: SimOptions): Setup {
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
    robot,
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
    new MecanumPlant(plant, start.xIn, start.yIn, start.headingRad),
    follower,
  );
  engine.prefixKeys = prefixKeys(plan, robot, field, options, holds);
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
    if (done) return true;
    if ((engine.tick + 1) * engine.tickS > maxTimeS + 1e-9) {
      root.end(true);
      engine.event("periodEnded", { detail: "The routine had not finished when the time ran out." });
      return false;
    }
    engine.plant.update(engine.tickS);
    engine.tick += 1;
  }
}

function finish(engine: Engine, plan: Plan, completed: boolean, periodS: number | null): SimTrace {
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
  const limit = Math.min(fromStepIndex ?? plan.steps.length, plan.steps.length - 1);
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
