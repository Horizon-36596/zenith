/**
 * The proposed version of a partner's auto as a timed robot, for the proposer's alliance view
 * (spec 13 section 14: "the proposer's alliance view runs the proposed
 * version against their own auto, so they can show the collision going away before sending").
 *
 * A projection's trajectory is the partner's own instant sim, on the partner's robot; a proposal
 * changes the structure, so the trajectory has to be made again. The share never carries the
 * partner's drive limits (section 8.2), so this is an approximation, and it says so:
 *
 * 1. The synthetic auto (`synthetic.ts`) is planned and run through core's instant sim with the
 *    proposer's own drive limits, once for the share as it is and once for the proposal.
 * 2. Commands and waits take the time the share says they take either way; only driving is
 *    uncertain. So the time spent in steps that drive is scaled by one factor, chosen so that the
 *    share as it is takes exactly the partner's own shared `totalS`. A proposal that only moves a
 *    pose is then timed on the partner's pace, not the proposer's.
 * 3. With no change at all, the partner's own shared trajectory is used as it is, so the proposer
 *    sees exactly the alliance view they had before.
 *
 * Pure: no DOM, no clock, no store.
 */
import {
  allianceRobotFromProjection,
  allianceRobotFromTrace,
  simPoseAt,
  simulate,
  type AllianceEnvelope,
  type AllianceRobot,
  type Plan,
  type PlanStep,
  type Pose,
  type Trace,
  type TraceStep,
} from "@horizon36596/zenith-core";
import type { Projection } from "@horizon36596/zenith-schema";

/** The drive scale is kept inside this range; outside it the two robots are too unlike to scale. */
export const DRIVE_SCALE_LIMITS = { min: 0.25, max: 4 } as const;

/** The grid the alliance checks compare on, in seconds. */
const TICK_S = 0.1;

/** The ids of every path step in the plan, inside groups too. */
function pathIds(steps: readonly PlanStep[], into: Set<string> = new Set()): Set<string> {
  for (const step of steps) {
    if (step.kind === "path") into.add(step.id);
    pathIds(step.children ?? [], into);
  }
  return into;
}

/** One stretch of the sim's clock, and whether the robot drives in it. */
interface Span {
  startS: number;
  endS: number;
  drives: boolean;
}

/**
 * The stretches of the sim's clock in which a path step ran, in time order, joined where they
 * overlap. Only the path steps themselves count, not the groups that hold them, so a wait or a
 * command beside a path in a sequence keeps its shared time.
 */
export function spansOf(plan: Plan, trace: Pick<Trace, "steps">): Span[] {
  const paths = pathIds(plan.steps);
  const runs = trace.steps
    .filter((record) => paths.has(record.id) && record.endS > record.startS)
    .map((record) => ({ startS: record.startS, endS: record.endS }))
    .sort((a, b) => a.startS - b.startS);
  const spans: Span[] = [];
  for (const run of runs) {
    const last = spans[spans.length - 1];
    if (last !== undefined && run.startS <= last.endS) last.endS = Math.max(last.endS, run.endS);
    else spans.push({ ...run, drives: true });
  }
  return spans;
}

/**
 * The factor that makes the share's own synthetic run take the partner's shared total: the shared
 * total less the time spent not driving, over the time spent driving. 1 when there is no driving,
 * or when the factor would fall outside `DRIVE_SCALE_LIMITS`.
 */
export function driveScale(spans: readonly Span[], simTotalS: number, sharedTotalS: number): number {
  let driveS = 0;
  for (const span of spans) if (span.drives) driveS += Math.max(0, span.endS - span.startS);
  if (driveS <= 1e-6) return 1;
  const fixedS = Math.max(0, simTotalS - driveS);
  const scale = (sharedTotalS - fixedS) / driveS;
  if (!Number.isFinite(scale) || scale < DRIVE_SCALE_LIMITS.min || scale > DRIVE_SCALE_LIMITS.max) return 1;
  return scale;
}

/**
 * The sim's clock stretched: time inside a driving span runs `scale` times as long, everything
 * else as it was. Returns the stretched time for a sim time.
 */
export function warpClock(spans: readonly Span[], scale: number): (simS: number) => number {
  return (simS: number): number => {
    let shift = 0;
    for (const span of spans) {
      if (!span.drives) continue;
      if (simS <= span.startS) break;
      const inside = Math.min(simS, span.endS) - span.startS;
      shift += inside * (scale - 1);
    }
    return simS + shift;
  };
}

/** The inverse of `warpClock`, by bisection on the monotone warp: the sim time for a stretched time. */
function unwarp(warp: (simS: number) => number, targetS: number, simTotalS: number): number {
  let low = 0;
  let high = Math.max(simTotalS, 1e-6);
  if (targetS <= 0) return 0;
  if (warp(high) <= targetS) return high;
  for (let iteration = 0; iteration < 40; iteration += 1) {
    const middle = (low + high) / 2;
    if (warp(middle) < targetS) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

/** A robot's poses on the 0.1 s grid, from a sim trace put on the stretched clock. */
function warpedPoses(trace: Pick<Trace, "poses" | "simTimeS">, warp: (simS: number) => number): { poses: Pose[]; totalS: number } {
  const totalS = warp(trace.simTimeS);
  const count = Math.max(1, Math.ceil(totalS / TICK_S - 1e-9) + 1);
  const poses: Pose[] = [];
  for (let tick = 0; tick < count; tick += 1) {
    const pose = simPoseAt(trace, unwarp(warp, tick * TICK_S, trace.simTimeS));
    if (pose === null) break;
    poses.push(pose);
  }
  return { poses, totalS };
}

/** The inputs of the timed preview: the share, and the synthetic plans of it and of the proposal. */
export interface PreviewRobotInput {
  projection: Projection;
  /** The synthetic plan of the share's own structure; null when it could not be planned. */
  basePlan: Plan | null;
  /** The synthetic plan of the proposal's preview structure; null when it could not be planned. */
  proposedPlan: Plan | null;
  /** Whether the proposal holds any change; with none the shared trajectory is used as it is. */
  changed: boolean;
  /** How the findings name the robot. */
  label: string;
  /** Extra envelopes the proposal declares, by the synthetic step id they belong to. */
  proposedEnvelopes?: ReadonlyMap<string, { polygon: { xIn: number; yIn: number }[]; maxDurationS: number } | null>;
  /** The sim runs, when the caller already has them (the canvas shows the same one). */
  baseTrace?: Trace;
  proposedTrace?: Trace;
}

/** The timed preview robot, and how it was timed, for the view to say. */
export interface PreviewRobot {
  robot: AllianceRobot;
  /** The drive-time factor applied, 1 when none was. */
  driveScale: number;
  /** True when the partner's own shared trajectory was used as it is. */
  shared: boolean;
  /** The proposed run's stretched clock, so the canvas's playback matches the robot the checks use. */
  toPreviewS: (simS: number) => number;
  /** The sim trace of the proposal, before the stretch. */
  trace: Trace | null;
  /** Each step of the run on the stretched clock, for the canvas's step timing. */
  steps: TraceStep[];
}

/** A trace's steps on a stretched clock. */
const warpSteps = (steps: readonly TraceStep[], warp: (simS: number) => number): TraceStep[] =>
  steps.map((step) => ({ ...step, startS: warp(step.startS), endS: warp(step.endS) }));

/**
 * The proposed version of the partner's auto as an alliance robot, timed as the file comment says.
 * Its box, alliance and claims are the share's own; its phases come from the proposed run. Throws
 * nothing: a plan the sim cannot run falls back to the shared trajectory, with `shared` true.
 */
export function previewPartnerRobot(input: PreviewRobotInput): PreviewRobot {
  const sharedRobot = allianceRobotFromProjection(input.projection, input.label);
  const identity = (simS: number): number => simS;
  const { basePlan, proposedPlan } = input;
  const baseTrace = basePlan === null ? null : (input.baseTrace ?? tryRun(basePlan));
  const scale = basePlan === null || baseTrace === null ? 1 : driveScale(spansOf(basePlan, baseTrace), baseTrace.simTimeS, input.projection.totalS);
  const sharedSteps = basePlan === null || baseTrace === null ? [] : warpSteps(baseTrace.steps, warpClock(spansOf(basePlan, baseTrace), scale));
  const asShared = (trace: Trace | null): PreviewRobot => ({ robot: sharedRobot, driveScale: scale, shared: true, toPreviewS: identity, trace, steps: sharedSteps });
  if (!input.changed || proposedPlan === null || baseTrace === null) return asShared(baseTrace);
  const proposedTrace = input.proposedTrace ?? tryRun(proposedPlan);
  if (proposedTrace === null) return asShared(null);
  const warp = warpClock(spansOf(proposedPlan, proposedTrace), scale);
  const { poses, totalS } = warpedPoses(proposedTrace, warp);
  if (poses.length === 0) return asShared(proposedTrace);

  const fromTrace = allianceRobotFromTrace(proposedTrace, proposedPlan.robot, [], {
    alliance: input.projection.alliance,
    label: input.label,
  });
  const byId = new Map(proposedTrace.steps.map((step) => [step.id, step]));
  const envelopes: AllianceEnvelope[] = sharedRobot.envelopes.map((envelope) => ({ ...envelope }));
  const proposed: NonNullable<PreviewRobotInput["proposedEnvelopes"]> = input.proposedEnvelopes ?? new Map();
  for (const [stepId, envelope] of proposed) {
    const record = byId.get(stepId);
    if (envelope === null || record === undefined) continue;
    const startS = warp(record.startS);
    envelopes.push({ startS, endS: startS + envelope.maxDurationS, polygon: envelope.polygon.map((vertex) => ({ ...vertex })) });
  }
  const robot: AllianceRobot = {
    ...sharedRobot,
    startPose: poses[0] ?? sharedRobot.startPose,
    poses,
    phases: fromTrace.phases.map((phase) => ({ ...phase, startS: warp(phase.startS), endS: warp(phase.endS) })),
    envelopes,
    totalS,
  };
  return { robot, driveScale: scale, shared: false, toPreviewS: warp, trace: proposedTrace, steps: warpSteps(proposedTrace.steps, warp) };
}

/** Runs the instant sim on a plan, or null when it cannot. */
function tryRun(planned: Plan): Trace | null {
  try {
    return simulate(planned, planned.robot, planned.field);
  } catch {
    return null;
  }
}

/**
 * A timed robot as a trace the canvas can play: its 0.1 s poses as rows, and the steps on the same
 * clock, so the robot outline on the field is exactly the robot the alliance checks compare.
 */
export function robotTrace(robot: Pick<AllianceRobot, "poses">, steps: readonly TraceStep[]): { poses: [number, number, number, number][]; steps: TraceStep[]; tickS: number } {
  return {
    poses: robot.poses.map((pose, tick) => [tick * TICK_S, pose.xIn, pose.yIn, pose.headingRad]),
    steps: steps.map((step) => ({ ...step })),
    tickS: TICK_S,
  };
}
