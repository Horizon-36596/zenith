import type { Field, Robot } from "@horizon36596/zenith-schema";
import { footprintAt } from "./footprint.js";
import { makePath, sampleDistances, SAMPLE_SPACING_IN, type PathGeometry } from "./geometry/path.js";
import { wrapAngle } from "./geometry/angle.js";
import type { Pose } from "./geometry/vec.js";
import { headingFunction } from "./heading.js";
import type { ResolvedAuto, ResolvedStep } from "./resolve.js";
import { holdTurnRad, TURN_IN_PLACE_LENGTH_IN, TURN_SAMPLE_RAD } from "./turnInPlace.js";
import type { Finding, Plan, PlanSample, PlanStep } from "./types.js";

export interface PlanOptions {
  /** Distance between footprint samples along a path, in inches. The spec's default is 2. */
  sampleSpacingIn?: number;
  /** Which footprint box to sweep. The checks use the expanded one. */
  footprint?: "startIn" | "expandedIn";
  /**
   * Reuse the geometry of a step that has not structurally changed. On by default: dragging one
   * waypoint in the editor replans one step and hands back the rest, which is what keeps the
   * checks under a frame. Turn it off to measure the cold cost of planning.
   */
  memoize?: boolean;
}

/**
 * The memo of planned steps, keyed on the robot (footprints depend on it) and then on the step's
 * structure. Planning is pure, so a step whose geometry, heading and start pose are unchanged has
 * the same samples as last time; sweeping the footprint is the expensive part and this is what
 * makes an edit cost one step rather than the whole routine.
 *
 * A hit hands back the same `PlanStep` object, so a plan's steps are to be read and not written to.
 * The per-robot map is bounded, because an editor session drags a waypoint hundreds of times and
 * every drag is a new key.
 */
const MEMO_LIMIT = 1024;
const memo = new WeakMap<Robot, Map<string, { step: PlanStep; findings: Finding[] }>>();

/** The structure a planned step depends on, as a string; a miss costs a replan and nothing worse. */
const identityOf = (step: ResolvedStep): unknown => ({
  id: step.id,
  kind: step.kind,
  step: step.step,
  startPose: step.startPose,
  endPose: step.endPose,
  segments: step.segments?.map((segment) => segment.pointsIn),
  children: step.children?.map(identityOf),
});

/**
 * A WeakMap cannot be emptied, so every key carries this number and raising it makes the next
 * lookup miss for every robot.
 */
let cacheEpoch = 0;

/** Forgets every memoised step, for a caller that has edited a robot or field file in place. */
export function clearPlanCache(): void {
  cacheEpoch += 1;
}

/**
 * Turns a resolved auto into per-step geometry: the samples every 2 in of arc (plus the endpoints
 * and every segment boundary) with the pose, the heading and the footprint at each
 * (site/docs/paths-explained.md).
 *
 * Pure and deterministic: the same files always give the same samples, so the CLI, the editor and
 * a reviewer see the same answer.
 */
export function plan(
  resolved: ResolvedAuto,
  robot: Robot,
  field: Field,
  options: PlanOptions = {},
): Plan {
  const spacingIn = options.sampleSpacingIn ?? SAMPLE_SPACING_IN;
  const which = options.footprint ?? "expandedIn";
  const findings: Finding[] = [...resolved.findings];

  const perRobot = memo.get(robot) ?? new Map<string, { step: PlanStep; findings: Finding[] }>();
  memo.set(robot, perRobot);

  const staticSample = (pose: Pose): PlanSample => {
    const footprint = footprintAt(pose, robot, which);
    return { sIn: 0, t: 0, pose, footprintIn: footprint.bodyIn, mouthsIn: footprint.mouthsIn };
  };

  const planned = (step: ResolvedStep): PlanStep => {
    if (step.kind === "path" && step.segments !== undefined && step.segments.length > 0) {
      const geometry: PathGeometry = makePath(step.segments.map((segment) => segment.pointsIn));
      const heading = step.step.kind === "path" ? step.step.heading : undefined;
      if (heading === undefined) {
        findings.push({
          severity: "error",
          stepId: step.id,
          code: "HEADING_MISSING",
          message:
            "A path step needs a heading mode: Pedro throws at run time without an interpolator.",
        });
      }
      // With no mode declared, hold the heading the step started at so the footprint sweep still
      // means something; the HEADING_MISSING error above is what stops the file being valid.
      const headingAt =
        heading === undefined
          ? () => step.startPose.headingRad
          : headingFunction(heading, geometry);

      if (geometry.lengthIn <= TURN_IN_PLACE_LENGTH_IN) {
        const turn = turnSamples(step, geometry);
        return {
          id: step.id,
          kind: step.kind,
          step: step.step,
          startPose: (turn[0] as PlanSample).pose,
          endPose: (turn[turn.length - 1] as PlanSample).pose,
          lengthIn: geometry.lengthIn,
          samples: turn,
          geometry,
          segments: step.segments,
        };
      }

      const samples: PlanSample[] = [];
      for (const sIn of sampleDistances(geometry, spacingIn)) {
        const t = geometry.tAtDistance(sIn);
        const point = geometry.pointAtDistance(sIn);
        const pose: Pose = { xIn: point.xIn, yIn: point.yIn, headingRad: headingAt(t) };
        const footprint = footprintAt(pose, robot, which);
        samples.push({
          sIn,
          t,
          pose,
          footprintIn: footprint.bodyIn,
          mouthsIn: footprint.mouthsIn,
        });
      }
      const last = samples[samples.length - 1];
      const endPose = last === undefined ? step.endPose : last.pose;
      return {
        id: step.id,
        kind: step.kind,
        step: step.step,
        startPose: samples[0]?.pose ?? step.startPose,
        endPose,
        lengthIn: geometry.lengthIn,
        samples,
        geometry,
        segments: step.segments,
      };
    }

    if (step.children !== undefined) {
      const children = step.children.map(planStep);
      return {
        id: step.id,
        kind: step.kind,
        step: step.step,
        startPose: step.startPose,
        endPose: step.endPose,
        lengthIn: children.reduce((sum, child) => sum + child.lengthIn, 0),
        samples: [],
        children,
      };
    }

    return {
      id: step.id,
      kind: step.kind,
      step: step.step,
      startPose: step.startPose,
      endPose: step.endPose,
      lengthIn: 0,
      samples: [staticSample(step.startPose)],
    };
  };

  /**
   * A turn on the spot (`turnInPlace.ts`), sampled by angle at its one point. The runtime holds the
   * step's end heading there, so the robot turns from the heading it arrives with, the step's
   * resolved start, to the end heading `resolve` gives the next step, the short way round, as the
   * hold turns it. A sample at least every `TURN_SAMPLE_RAD`, so PERIMETER and STRUCTURE sweep the
   * corners through the whole turn; `t` runs from 0 to 1 through the turn and `sIn` stays 0.
   */
  const turnSamples = (step: ResolvedStep, geometry: PathGeometry): PlanSample[] => {
    const point = geometry.pointAtDistance(geometry.lengthIn);
    const fromRad = step.startPose.headingRad;
    const toRad = step.endPose.headingRad;
    const turnRad = holdTurnRad(fromRad, toRad);
    const count = Math.max(1, Math.ceil(Math.abs(turnRad) / TURN_SAMPLE_RAD - 1e-9));
    const samples: PlanSample[] = [];
    for (let index = 0; index <= count; index += 1) {
      const t = index / count;
      const headingRad = index === count ? toRad : wrapAngle(fromRad + turnRad * t);
      const pose: Pose = { xIn: point.xIn, yIn: point.yIn, headingRad };
      const footprint = footprintAt(pose, robot, which);
      samples.push({ sIn: 0, t, pose, footprintIn: footprint.bodyIn, mouthsIn: footprint.mouthsIn });
    }
    return samples;
  };

  const planStep = (step: ResolvedStep): PlanStep => {
    if (options.memoize === false) return planned(step);
    const key = `${String(cacheEpoch)}|${which}|${String(spacingIn)}|${JSON.stringify(identityOf(step))}`;
    const hit = perRobot.get(key);
    if (hit !== undefined) {
      findings.push(...hit.findings);
      return hit.step;
    }
    const before = findings.length;
    const fresh = planned(step);
    perRobot.set(key, { step: fresh, findings: findings.slice(before) });
    if (perRobot.size > MEMO_LIMIT) {
      const oldest = perRobot.keys().next();
      if (oldest.done !== true) perRobot.delete(oldest.value);
    }
    return fresh;
  };

  return {
    auto: resolved.auto,
    robot,
    field,
    startPose: resolved.startPose,
    steps: resolved.steps.map(planStep),
    findings,
  };
}

/** Every step of a plan, parallel and branch children included, in order. */
export function flattenSteps(steps: readonly PlanStep[]): PlanStep[] {
  const out: PlanStep[] = [];
  for (const step of steps) {
    out.push(step);
    if (step.children !== undefined) out.push(...flattenSteps(step.children));
  }
  return out;
}
