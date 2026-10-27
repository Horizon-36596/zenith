import {
  childLists,
  formatIssue,
  projectionSchema,
  SCHEMA_ID,
  type CommandCall,
  type Field,
  type Heading,
  type MarkerAt,
  type Projection,
  type ProjectionClaim,
  type ProjectionEnvelope,
  type ProjectionHeading,
  type ProjectionMarker,
  type ProjectionNamedCommand,
  type ProjectionPhase,
  type ProjectionPhaseLabel,
  type ProjectionPoint,
  type ProjectionPose,
  type ProjectionPoseRow,
  type ProjectionRangeHeading,
  type ProjectionSegment,
  type ProjectionStep,
  type ProjectionStructure,
  type RangeHeading,
  type Robot,
  type Step,
} from "@horizon36596/zenith-schema";
import { commandSeconds } from "./estimate.js";
import { footprintBoundsIn } from "./footprint.js";
import { wrapAngle } from "./geometry/angle.js";
import { runLedger, type LedgerRun } from "./ledger.js";
import { flattenSteps } from "./plan.js";
import { containsPath } from "./resolve.js";
import { simPoseAt } from "./sim/simulate.js";
import type { Trace, TraceStep } from "./trace.js";
import type { Plan, PlanStep } from "./types.js";

/**
 * `projectShare`: the projection another team receives when an auto is shared with it
 * (spec 13 sections 8.2 and 16, M-C3).
 *
 * It is built from an allowlist. Every field of the result is copied, by name, into a new object
 * from the one input that should supply it; nothing is ever cloned from the auto and then pruned,
 * because a key added to the auto format later would then leak by default. The result never holds
 * a command or condition name, an argument, a note, a description, an author, a date, a
 * provenance string, a file path, the author's step ids, or anything from `robot.json` beyond one
 * bounding box and each command's estimated time and two flags. At the propose level every step
 * is named by an opaque id (`s1`, `s2`, ...) that `projectionStepIdMap` maps back.
 *
 * The one exception is the sharer's own choice: with `includeCommands` (owner ruling 2026-09-27,
 * "Include command names" in the share dialog) the projection also carries a `commands` list that
 * names what each command token stands for, with the call's arguments and when its step ran. It is
 * built from the same allowlist walk: only each call's name and arguments are copied, never anything
 * from the robot file's command table, and condition names stay tokens.
 *
 * Pure and deterministic: the same inputs give the same object, and so the same canonical bytes.
 *
 * The frame. Every pose is in the season's frame (section 9). For every shipped season the field
 * file is the season package's own field, with the same frame (for BIOBUZZ,
 * `packages/season-biobuzz/field/biobuzz.field.json` and the example projects' field agree), so the
 * conversion from the field's frame to the season's is the identity and none is applied. The
 * poses are in the auto's own alliance, which `alliance` records; a partner mirrors them with the
 * field's own mirror when it plays the other alliance.
 */

/** What the projection is built from: the plan, the instant-sim trace of it, and the files. */
export interface ProjectShareInput {
  plan: Plan;
  /** The instant sim's trace of `plan` (`simulate`), or any trace with the same three keys. */
  trace: Pick<Trace, "poses" | "steps" | "simTimeS">;
  robot: Robot;
  field: Field;
  /**
   * The ledger of `plan`, with the season's rules, when the caller has it: it is what names the
   * target a launch scores into. Without it the ledger is run with no season, so collections are
   * still claimed but a launch only claims the target its step's `expect.launchesInto` names.
   */
  ledger?: LedgerRun;
}

export interface ProjectShareOptions {
  level: "view" | "propose";
  /** The title to show the other team. The auto's own title is never read; the sharer passes it. */
  title?: string;
  /**
   * Coarser rounding for the timed layer (section 8.2): positions to 2 in, headings to 5 degrees and
   * times to 0.25 s. The trajectory stays at 10 Hz. The structure is not coarsened, because a
   * proposal edits the real poses.
   */
  coarsen?: boolean;
  /**
   * The share dialog's "Include command names" checkbox, off by default: add the `commands` list,
   * which names each command token with its arguments. When it is off or absent the projection is
   * exactly what it was before the option existed, byte for byte.
   */
  includeCommands?: boolean;
}

/** Thrown when the inputs cannot make a projection that meets its own schema. */
export class ProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectionError";
  }
}

/** One degree, in radians. */
const DEGREE_RAD = Math.PI / 180;

/** The rounding of the timed layer, fine by default and coarse on request. */
export interface ProjectionQuanta {
  positionIn: number;
  headingRad: number;
  /** Seconds; the fine value is the canonical form's millisecond. */
  timeS: number;
}

/** The default rounding of section 8.2: 0.5 in and 1 degree, with times to the millisecond. */
export const PROJECTION_FINE_QUANTA: Readonly<ProjectionQuanta> = { positionIn: 0.5, headingRad: DEGREE_RAD, timeS: 0.001 };

/** The coarsen option: 2 in, 5 degrees and 0.25 s. */
export const PROJECTION_COARSE_QUANTA: Readonly<ProjectionQuanta> = { positionIn: 2, headingRad: 5 * DEGREE_RAD, timeS: 0.25 };

/**
 * The bounding box is always rounded outward to the fine position quantum, even when coarsened:
 * it is the robot's size, which anyone watching a match can see, and a 2 in step would grow it by
 * up to 4 in in each direction and raise collisions that are not there.
 */
const BOX_QUANTUM_IN = PROJECTION_FINE_QUANTA.positionIn;

/** The trajectory's sample rate, fixed by the format. */
const RATE_HZ = 10;

/** Absorbs floating-point noise before a floor or a ceiling. */
const EPSILON = 1e-9;

/** Rounds to `digits` decimals the way the canonical form does, never giving -0. */
function fixed(value: number, digits: number): number {
  const rounded = Number(value.toFixed(digits));
  return rounded === 0 ? 0 : rounded;
}

const inches = (value: number): number => fixed(value, 3);
const radians = (value: number): number => fixed(value, 4);
const seconds = (value: number): number => fixed(value, 3);

const toQuantum = (value: number, quantum: number): number => inches(Math.round(value / quantum) * quantum);
const floorTo = (value: number, quantum: number): number => Math.floor(value / quantum + EPSILON) * quantum;
const ceilTo = (value: number, quantum: number): number => Math.ceil(value / quantum - EPSILON) * quantum;

/** A heading rounded to the quantum, wrapped to (-pi, pi], at the canonical four decimals. */
const headingToQuantum = (headingRad: number, quantum: number): number =>
  radians(wrapAngle(Math.round(headingRad / quantum) * quantum));

const timeToQuantum = (value: number, quanta: ProjectionQuanta): number => seconds(Math.round(value / quanta.timeS) * quanta.timeS);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** The trace's step records by id, the first when an id repeats. */
function recordsById(steps: readonly TraceStep[]): Map<string, TraceStep> {
  const byId = new Map<string, TraceStep>();
  for (const record of steps) if (!byId.has(record.id)) byId.set(record.id, record);
  return byId;
}

/** Every id in a planned step's subtree, the step's own first. */
const subtreeIds = (step: PlanStep): string[] => flattenSteps([step]).map((each) => each.id);

// ------------------------------------------------------------------------------------------------
// Bounding box and trajectory
// ------------------------------------------------------------------------------------------------

/**
 * The union of the expanded footprint and every mouth box, in the robot frame: an axis-aligned
 * box around the point the path follows, with no mouth layout. `centreOffsetIn` is where the box's
 * centre sits relative to that point.
 */
function boundingBoxOf(robot: Robot): Projection["boundingBox"] {
  const bounds = footprintBoundsIn({ xIn: 0, yIn: 0, headingRad: 0 }, robot, "expandedIn");
  const minXIn = floorTo(bounds.minXIn, BOX_QUANTUM_IN);
  const maxXIn = ceilTo(bounds.maxXIn, BOX_QUANTUM_IN);
  const minYIn = floorTo(bounds.minYIn, BOX_QUANTUM_IN);
  const maxYIn = ceilTo(bounds.maxYIn, BOX_QUANTUM_IN);
  return {
    lengthIn: inches(maxXIn - minXIn),
    widthIn: inches(maxYIn - minYIn),
    centreOffsetIn: { xIn: inches((minXIn + maxXIn) / 2), yIn: inches((minYIn + maxYIn) / 2) },
  };
}

function quantizedPose(pose: { xIn: number; yIn: number; headingRad: number }, quanta: ProjectionQuanta): ProjectionPose {
  return {
    xIn: toQuantum(pose.xIn, quanta.positionIn),
    yIn: toQuantum(pose.yIn, quanta.positionIn),
    headingRad: headingToQuantum(pose.headingRad, quanta.headingRad),
  };
}

/** One row every 0.1 s from t = 0 to the end of the run, read off the trace. */
function trajectoryOf(input: ProjectShareInput, totalS: number, quanta: ProjectionQuanta): Projection["trajectory"] {
  const count = Math.floor(totalS * RATE_HZ + EPSILON) + 1;
  const poses: ProjectionPoseRow[] = [];
  for (let index = 0; index < count; index += 1) {
    // `index / RATE_HZ` rather than a running sum, so the sample times never drift.
    const pose = simPoseAt(input.trace, index / RATE_HZ) ?? input.plan.startPose;
    const rounded = quantizedPose(pose, quanta);
    poses.push([rounded.xIn, rounded.yIn, rounded.headingRad]);
  }
  return {
    rateHz: RATE_HZ,
    positionQuantumIn: inches(quanta.positionIn),
    headingQuantumRad: radians(quanta.headingRad),
    poses,
  };
}

// ------------------------------------------------------------------------------------------------
// Phases and claims
// ------------------------------------------------------------------------------------------------

/**
 * The label of one unit of time, from the fixed list. A launch anywhere in the unit makes it
 * `score`, else a collection makes it `collect` (both from the ledger); otherwise a wait is `wait`,
 * a unit that drives is `drive`, and anything else, such as a command, is `other`.
 */
function labelOf(step: PlanStep, ledger: LedgerRun): ProjectionPhaseLabel {
  const entries = subtreeIds(step).flatMap((id) => {
    const entry = ledger.byStepId[id];
    return entry === undefined ? [] : [entry];
  });
  if (entries.some((entry) => entry.launched > 0)) return "score";
  if (entries.some((entry) => entry.collected !== null)) return "collect";
  if (step.kind === "wait") return "wait";
  if (containsPath(step)) return "drive";
  return "other";
}

interface PhaseUnit {
  step: PlanStep;
  record: TraceStep;
}

/**
 * The steps that become phases, in the order they ran: a sequence and the arm of a branch that ran
 * are opened up, since their members run one after another; a parallel group is one unit, since
 * its members overlap. A step with no record in the trace did not run and has no phase.
 */
function phaseUnits(steps: readonly PlanStep[], records: ReadonlyMap<string, TraceStep>, out: PhaseUnit[] = []): PhaseUnit[] {
  for (const step of steps) {
    const record = records.get(step.id);
    if (record === undefined) continue;
    if (step.kind === "sequence" || step.kind === "branch") {
      phaseUnits(step.children ?? [], records, out);
      continue;
    }
    out.push({ step, record });
  }
  return out;
}

/**
 * The phases: one per unit that takes time, labelled by `labelOf`, with neighbours of the same
 * label joined. The last unit that drives becomes `park` when its step id says park (any case) and
 * nothing after it drives, scores or collects (a closing command such as a cancel may follow). That
 * is the one place a step id decides a label, because nothing else in an auto names a park.
 */
function phasesOf(plan: Plan, records: ReadonlyMap<string, TraceStep>, ledger: LedgerRun, quanta: ProjectionQuanta): ProjectionPhase[] {
  const timed = phaseUnits(plan.steps, records).filter((unit) => unit.record.endS > unit.record.startS);
  const labels = timed.map((unit) => labelOf(unit.step, ledger));
  let lastActive = -1;
  labels.forEach((label, index) => {
    if (label === "drive" || label === "score" || label === "collect") lastActive = index;
  });
  const lastUnit = timed[lastActive];
  if (lastUnit !== undefined && labels[lastActive] === "drive" && /park/i.test(lastUnit.step.id)) labels[lastActive] = "park";
  const labelled = timed.map((unit, index) => ({
    startS: timeToQuantum(unit.record.startS, quanta),
    endS: timeToQuantum(unit.record.endS, quanta),
    label: labels[index] as ProjectionPhaseLabel,
  }));
  const phases: ProjectionPhase[] = [];
  for (const phase of labelled) {
    if (phase.endS <= phase.startS) continue;
    const previous = phases[phases.length - 1];
    if (previous !== undefined && previous.label === phase.label && phase.startS <= previous.endS) {
      previous.endS = Math.max(previous.endS, phase.endS);
      continue;
    }
    phases.push({ startS: phase.startS, endS: phase.endS, label: phase.label });
  }
  return phases;
}

/**
 * Whether a claim may name this id: an element, a container, a target or a zone of the field file,
 * or the start of an element's id, which is how a ledger names a row of elements (BIOBUZZ's
 * `gardenRed` for `gardenRed0` to `gardenRed3`). Either way the id says nothing the public field
 * file does not; anything else a ledger names came from the author's own text and is not carried.
 */
function claimableIds(field: Field): (id: string) => boolean {
  const exact = new Set<string>();
  const elementIds: string[] = [];
  for (const element of field.elements ?? []) {
    exact.add(element.id);
    elementIds.push(element.id);
    if (typeof element.container === "string") exact.add(element.container);
  }
  for (const target of field.targets ?? []) exact.add(target.id);
  for (const zone of field.zones ?? []) exact.add(zone.id);
  return (id) => id.length > 0 && (exact.has(id) || elementIds.some((elementId) => elementId.startsWith(id)));
}

/**
 * The field elements the ledger says the auto takes from or scores into, each at the time its step
 * starts, in time order. A launch scores into the step's `expect.launchesInto`, else the target
 * the season names as current.
 */
function claimsOf(plan: Plan, field: Field, records: ReadonlyMap<string, TraceStep>, ledger: LedgerRun, quanta: ProjectionQuanta): ProjectionClaim[] {
  const claimable = claimableIds(field);
  const steps = new Map(flattenSteps(plan.steps).map((step) => [step.id, step] as const));
  const claims: { claim: ProjectionClaim; order: number }[] = [];
  for (const entry of ledger.entries) {
    const record = records.get(entry.stepId);
    if (record === undefined) continue;
    const atS = timeToQuantum(record.startS, quanta);
    if (entry.collected !== null && claimable(entry.collected.containerId)) {
      claims.push({ claim: { elementId: entry.collected.containerId, action: "take", atS }, order: claims.length });
    }
    if (entry.launched > 0) {
      const authored = steps.get(entry.stepId)?.step;
      const expected = authored !== undefined && "expect" in authored ? authored.expect?.launchesInto : undefined;
      const target = expected ?? entry.target;
      if (target !== null && claimable(target)) {
        claims.push({ claim: { elementId: target, action: "score", atS }, order: claims.length });
      }
    }
  }
  claims.sort((a, b) => a.claim.atS - b.claim.atS || a.order - b.order);
  return claims.map((each) => each.claim);
}

// ------------------------------------------------------------------------------------------------
// Envelopes
// ------------------------------------------------------------------------------------------------

/**
 * The shape of the optional `envelope` a step may carry (section 10), read through this narrow
 * type so the code does not depend on whether the auto schema declares the key yet. Only the
 * polygon and the duration are read; the provenance never is.
 */
interface EnvelopeRead {
  polygon: ProjectionPoint[];
  maxDurationS: number;
}

function envelopeOf(step: Step): EnvelopeRead | null {
  const raw: unknown = (step as unknown as Record<string, unknown>)["envelope"];
  if (!isRecord(raw)) return null;
  const polygon = raw["polygon"];
  const maxDurationS = raw["maxDurationS"];
  if (!Array.isArray(polygon) || polygon.length < 3 || !isFiniteNumber(maxDurationS) || maxDurationS < 0) return null;
  const points: ProjectionPoint[] = [];
  for (const point of polygon) {
    if (!isRecord(point) || !isFiniteNumber(point["xIn"]) || !isFiniteNumber(point["yIn"])) return null;
    points.push({ xIn: inches(point["xIn"]), yIn: inches(point["yIn"]) });
  }
  return { polygon: points, maxDurationS };
}

/**
 * Every envelope of a step that ran, over the span from the step's start to that start plus
 * `maxDurationS`. The span is rounded outward, so rounding never shortens it.
 */
function envelopesOf(plan: Plan, records: ReadonlyMap<string, TraceStep>, quanta: ProjectionQuanta): ProjectionEnvelope[] {
  const envelopes: ProjectionEnvelope[] = [];
  for (const step of flattenSteps(plan.steps)) {
    const envelope = envelopeOf(step.step);
    const record = records.get(step.id);
    if (envelope === null || record === undefined) continue;
    envelopes.push({
      startS: seconds(floorTo(record.startS, quanta.timeS)),
      endS: seconds(ceilTo(record.startS + envelope.maxDurationS, quanta.timeS)),
      polygon: envelope.polygon,
    });
  }
  return envelopes;
}

// ------------------------------------------------------------------------------------------------
// The structure (propose level)
// ------------------------------------------------------------------------------------------------

/**
 * The opaque id of every step, `s1` to `sN` in step order: depth first, a group before its
 * members, a branch's `then` arm before its `else` arm, which is the order `flattenSteps` walks.
 * It is keyed on the planned step itself, so two steps that share an id in the file still get one
 * opaque id each. The author's step ids never leave the device: the owning team maps an opaque id
 * back with `projectionStepIdMap`, by rebuilding it from the revision the share is pinned to.
 */
function opaqueStepIds(steps: readonly PlanStep[]): Map<PlanStep, string> {
  const ids = new Map<PlanStep, string>();
  for (const step of flattenSteps(steps)) ids.set(step, `s${String(ids.size + 1)}`);
  return ids;
}

/**
 * What an opaque token stands for in the auto it was projected from, so the team that owns the
 * auto can map a proposal's tokens back (`projectionTokenMap`). `stepId` is the real step's id.
 * None of this is ever put in a projection.
 */
export type ProjectionTokenSource =
  | { kind: "commandStep"; stepId: string; command: CommandCall }
  | { kind: "marker"; stepId: string; markerIndex: number; command: CommandCall }
  | { kind: "endCondition"; stepId: string; condition: string }
  | { kind: "waitUntil"; stepId: string; condition: string }
  | { kind: "branchCondition"; stepId: string; condition: string };

/**
 * Hands out the opaque names in the structure: step ids from `opaqueStepIds`, and command and
 * condition tokens counted from 1 in step order, each kind apart. It remembers what each token
 * stands for, which stays on the device (`projectionTokenMap`).
 */
class Tokens {
  private commands = 0;
  private conditions = 0;
  readonly sources = new Map<string, ProjectionTokenSource>();
  constructor(private readonly stepIds: ReadonlyMap<PlanStep, string>) {}
  stepId(step: PlanStep): string {
    const id = this.stepIds.get(step);
    if (id === undefined) throw new ProjectionError(`The step ${JSON.stringify(step.id)} is not in the plan it was projected from.`);
    return id;
  }
  command(source: ProjectionTokenSource): string {
    this.commands += 1;
    const token = `cmd${String(this.commands)}`;
    this.sources.set(token, source);
    return token;
  }
  condition(source: ProjectionTokenSource): { token: string } {
    this.conditions += 1;
    const token = `cond${String(this.conditions)}`;
    this.sources.set(token, source);
    return { token };
  }
}

/** A command call copied by name, for the owner's side only. */
const callOf = (name: string, args: CommandCall["args"]): CommandCall => (args === undefined ? { name } : { name, args: { ...args } });

const exactPose = (pose: { xIn: number; yIn: number; headingRad: number }): ProjectionPose => ({
  xIn: inches(pose.xIn),
  yIn: inches(pose.yIn),
  headingRad: radians(pose.headingRad),
});

const exactPoint = (point: { xIn: number; yIn: number }): ProjectionPoint => ({ xIn: inches(point.xIn), yIn: inches(point.yIn) });

function rangeHeadingOf(heading: RangeHeading): ProjectionRangeHeading {
  switch (heading.mode) {
    case "tangent":
      return { mode: "tangent" };
    case "tangentReversed":
      return { mode: "tangentReversed" };
    case "constant":
      return { mode: "constant", headingRad: radians(heading.headingRad) };
    case "linear":
      return { mode: "linear", fromRad: radians(heading.fromRad), toRad: radians(heading.toRad) };
    case "facePoint":
      return {
        mode: "facePoint",
        xIn: inches(heading.xIn),
        yIn: inches(heading.yIn),
        ...(heading.offsetRad === undefined ? {} : { offsetRad: radians(heading.offsetRad) }),
      };
  }
}

function headingOf(heading: Heading): ProjectionHeading {
  if (heading.mode !== "piecewise") return rangeHeadingOf(heading);
  return {
    mode: "piecewise",
    ranges: heading.ranges.map((range) => ({ startT: range.startT, endT: range.endT, heading: rangeHeadingOf(range.heading) })),
  };
}

function markerAtOf(at: MarkerAt): MarkerAt {
  if ("t" in at) return { t: at.t };
  if ("distanceIn" in at) return { distanceIn: inches(at.distanceIn) };
  return { distanceFromEndIn: inches(at.distanceFromEndIn) };
}

function segmentsOf(step: PlanStep): ProjectionSegment[] {
  return (step.segments ?? []).map((segment): ProjectionSegment => {
    const from = exactPose(segment.fromPose);
    const to = exactPose(segment.toPose);
    if (segment.kind === "line") return { kind: "line", from, to };
    return { kind: "bezier", from, control: segment.pointsIn.slice(1, -1).map(exactPoint), to };
  });
}

function structureStepsOf(steps: readonly PlanStep[], robot: Robot, tokens: Tokens): ProjectionStep[] {
  return steps.map((step) => structureStepOf(step, robot, tokens));
}

/** One step, copied field by field; a command becomes a token, a condition name a token. */
function structureStepOf(step: PlanStep, robot: Robot, tokens: Tokens): ProjectionStep {
  const authored = step.step;
  const children = step.children ?? [];
  switch (authored.kind) {
    case "path":
      // Spread in the schema's key order. Marker tokens are handed out before the end condition's.
      return {
        id: tokens.stepId(step),
        kind: "path",
        ...(authored.timeoutS === undefined ? {} : { timeoutS: seconds(authored.timeoutS) }),
        segments: segmentsOf(step),
        ...(authored.heading === undefined ? {} : { heading: headingOf(authored.heading) }),
        ...(authored.speedFraction === undefined ? {} : { speedFraction: authored.speedFraction }),
        ...(authored.markers === undefined
          ? {}
          : {
              markers: authored.markers.map(
                (marker, markerIndex): ProjectionMarker => ({
                  at: markerAtOf(marker.at),
                  token: tokens.command({
                    kind: "marker",
                    stepId: step.id,
                    markerIndex,
                    command: callOf(marker.command.name, marker.command.args),
                  }),
                }),
              ),
            }),
        ...(authored.endCondition === undefined
          ? {}
          : { endCondition: tokens.condition({ kind: "endCondition", stepId: step.id, condition: authored.endCondition.condition }) }),
      };
    case "command": {
      const spec = robot.commands.find((command) => command.name === authored.name);
      const estimate = commandSeconds(authored.name, authored.args, robot);
      return {
        id: tokens.stepId(step),
        kind: "command",
        token: tokens.command({ kind: "commandStep", stepId: step.id, command: callOf(authored.name, authored.args) }),
        estimateS: estimate === null ? null : seconds(estimate),
        stationary: spec?.stationary === true,
        movesRobot: spec?.movesRobot === true,
        ...(authored.timeoutS === undefined ? {} : { timeoutS: seconds(authored.timeoutS) }),
      };
    }
    case "wait":
      return {
        id: tokens.stepId(step),
        kind: "wait",
        ...(authored.seconds === undefined ? {} : { seconds: seconds(authored.seconds) }),
        ...(authored.until === undefined ? {} : { until: tokens.condition({ kind: "waitUntil", stepId: step.id, condition: authored.until }) }),
        ...(authored.timeoutS === undefined ? {} : { timeoutS: seconds(authored.timeoutS) }),
      };
    case "transfer":
      // A transfer is the sharing team's own planning note (what they expect a partner or a human
      // player to do), not something the robot does, so the share carries only what the robot
      // runs in its place: a wait of zero seconds.
      return { id: tokens.stepId(step), kind: "wait", seconds: 0 };
    case "sequence":
      return { id: tokens.stepId(step), kind: "sequence", steps: structureStepsOf(children, robot, tokens) };
    case "parallel": {
      // The deadline names a member by its id. It is carried, as that member's opaque id, only
      // when it names one of them.
      const member =
        authored.deadline === undefined
          ? undefined
          : children.find((child) => child.id === authored.deadline || child.step.id === authored.deadline);
      const deadline = member === undefined ? undefined : tokens.stepId(member);
      return {
        id: tokens.stepId(step),
        kind: "parallel",
        mode: authored.mode,
        ...(deadline === undefined ? {} : { deadline }),
        steps: structureStepsOf(children, robot, tokens),
      };
    }
    case "branch": {
      const condition = tokens.condition({ kind: "branchCondition", stepId: step.id, condition: authored.condition });
      const thenCount = childLists(authored)[0]?.length ?? 0;
      const thenSteps = structureStepsOf(children.slice(0, thenCount), robot, tokens);
      if (authored.else === undefined) return { id: tokens.stepId(step), kind: "branch", condition, then: thenSteps };
      return {
        id: tokens.stepId(step),
        kind: "branch",
        condition,
        then: thenSteps,
        else: structureStepsOf(children.slice(thenCount), robot, tokens),
      };
    }
  }
}

// ------------------------------------------------------------------------------------------------
// The projection
// ------------------------------------------------------------------------------------------------

/**
 * The projection of one auto for another team, at the level the sharer chose. See the file
 * comment for what it holds, what it never holds and the frame it is in. Throws `ProjectionError`
 * when the result would break the projection schema's caps (for example a title over 200
 * characters or a run over 300 s), rather than cutting anything short without saying so.
 */
export function projectShare(input: ProjectShareInput, options: ProjectShareOptions): Projection {
  const { plan, field, robot } = input;
  const quanta = options.coarsen === true ? PROJECTION_COARSE_QUANTA : PROJECTION_FINE_QUANTA;
  const ledger = input.ledger ?? runLedger(plan, field);
  const records = recordsById(input.trace.steps);
  const exactTotalS = Math.max(input.trace.simTimeS, 0);

  const projection: Projection = {
    $schema: SCHEMA_ID.projection,
    formatVersion: 1,
    kind: "projection",
    level: options.level,
    // The season id the field file names (`biobuzz`), the same one its `rules.plugin` implements.
    season: field.season,
    alliance: plan.auto.alliance,
    ...(options.title === undefined || options.title.trim().length === 0 ? {} : { title: options.title }),
    startPose: quantizedPose(plan.startPose, quanta),
    boundingBox: boundingBoxOf(robot),
    trajectory: trajectoryOf(input, exactTotalS, quanta),
    phases: phasesOf(plan, records, ledger, quanta),
    claims: claimsOf(plan, field, records, ledger, quanta),
    envelopes: envelopesOf(plan, records, quanta),
    totalS: timeToQuantum(exactTotalS, quanta),
  };
  if (options.level === "propose" || options.includeCommands === true) {
    const projected = projectStructure(plan, robot);
    if (options.level === "propose") projection.structure = projected.structure;
    if (options.includeCommands === true) projection.commands = namedCommandsOf(projected.tokens, records, quanta);
  }

  const checked = projectionSchema.safeParse(projection);
  if (!checked.success) {
    throw new ProjectionError(
      `This auto cannot be shared as a projection:\n  ${checked.error.issues.map(formatIssue).join("\n  ")}`,
    );
  }
  return projection;
}

/**
 * The `commands` list of a projection made with `includeCommands`: one entry per command token, in
 * token order, copied field by field from what the token stands for. Condition tokens are skipped,
 * because the option names commands only. Each entry's span is its step's run in the trace, on the
 * timed layer's rounding, and is left out when the step did not run.
 */
function namedCommandsOf(
  sources: ReadonlyMap<string, ProjectionTokenSource>,
  records: ReadonlyMap<string, TraceStep>,
  quanta: ProjectionQuanta,
): ProjectionNamedCommand[] {
  const named: ProjectionNamedCommand[] = [];
  for (const [token, source] of sources) {
    if (source.kind !== "commandStep" && source.kind !== "marker") continue;
    const record = records.get(source.stepId);
    const args = source.command.args;
    const startS = record === undefined ? null : timeToQuantum(record.startS, quanta);
    const endS = record === undefined || startS === null ? null : Math.max(timeToQuantum(record.endS, quanta), startS);
    named.push({
      token,
      kind: source.kind === "commandStep" ? "command" : "marker",
      name: source.command.name,
      ...(args === undefined ? {} : { args: { ...args } }),
      ...(startS === null || endS === null ? {} : { startS, endS }),
    });
  }
  return named;
}

/** The propose level's structure, with what its opaque names stand for, which never leaves the device. */
export interface ProjectedStructure {
  structure: ProjectionStructure;
  /** Each opaque step id, `s1` to `sN` in step order, to the planned step it stands for. */
  steps: Map<string, PlanStep>;
  /** Each opaque token to what it stands for, in the order the tokens were handed out. */
  tokens: Map<string, ProjectionTokenSource>;
}

/**
 * The structure a propose projection carries, built by the one walk `projectShare` uses, together
 * with what each opaque step id and token stands for. It needs no trace, so the owning team can
 * build it for the revision a share is pinned to and for the auto as it is now, and compare the two
 * step by step. Pure and deterministic.
 */
export function projectStructure(plan: Plan, robot: Robot): ProjectedStructure {
  const stepIds = opaqueStepIds(plan.steps);
  const tokens = new Tokens(stepIds);
  const structure: ProjectionStructure = { steps: structureStepsOf(plan.steps, robot, tokens) };
  const steps = new Map<string, PlanStep>();
  for (const [step, opaque] of stepIds) steps.set(opaque, step);
  return { structure, steps, tokens: tokens.sources };
}

/**
 * What each opaque token in a propose projection stands for, rebuilt from the same inputs the way
 * `projectionStepIdMap` rebuilds the step ids: nothing about it is stored in the projection. A view
 * projection holds no tokens, so its map is empty.
 */
export function projectionTokenMap(input: ProjectShareInput, options: ProjectShareOptions): Map<string, ProjectionTokenSource> {
  if (options.level !== "propose") return new Map();
  return projectStructure(input.plan, input.robot).tokens;
}

/**
 * Which real step each opaque step id in the projection stands for, as `sN` to the step's id in
 * the auto. It is computed by the same walk `projectShare` uses, so the team that owns the auto
 * maps a proposal's step ids back by calling this on the revision the share was made from; nothing
 * about the mapping is stored in the projection. A view projection holds no step ids, so its map is
 * empty. Pure: the same inputs always give the same map, in step order.
 */
export function projectionStepIdMap(input: ProjectShareInput, options: ProjectShareOptions): Map<string, string> {
  const map = new Map<string, string>();
  if (options.level !== "propose") return map;
  for (const [step, opaque] of opaqueStepIds(input.plan.steps)) map.set(opaque, step.id);
  return map;
}
