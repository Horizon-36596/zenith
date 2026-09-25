import { childLists, type Auto, type PoseSource, type Segment, type Step, type Waypoints } from "@horizon36596/zenith-schema";
import { childPrefix, effectiveId } from "./edit/ids.js";
import { wrapAngle } from "./geometry/angle.js";
import { makePath } from "./geometry/path.js";
import type { Pose, Vec2 } from "./geometry/vec.js";
import { headingFunction } from "./heading.js";
import type { Finding } from "./types.js";

export interface ResolvedSegment {
  kind: Segment["kind"];
  /** The control polygon: start, any control points, end. */
  pointsIn: Vec2[];
  fromPose: Pose;
  toPose: Pose;
}

export interface ResolvedStep {
  id: string;
  kind: Step["kind"];
  step: Step;
  startPose: Pose;
  endPose: Pose;
  segments?: ResolvedSegment[];
  children?: ResolvedStep[];
}

export interface ResolvedAuto {
  auto: Auto;
  startPose: Pose;
  steps: ResolvedStep[];
  /** SCHEMA findings for unresolvable references, CONTINUITY for a `current` with no previous. */
  findings: Finding[];
}

const ORIGIN: Pose = { xIn: 0, yIn: 0, headingRad: 0 };

/** Resolves waypoint references to poses and `"current"` to the previous step's end pose. */
export function resolve(auto: Auto, waypoints?: Waypoints): ResolvedAuto {
  const findings: Finding[] = [];
  const named = waypoints?.waypoints ?? {};

  const resolvePose = (
    source: PoseSource,
    stepId: string,
    current: Pose | null,
    fallbackHeadingRad: number,
  ): Pose => {
    if (source === "current") {
      if (current === null) {
        findings.push({
          severity: "error",
          stepId,
          code: "CONTINUITY",
          message: 'from: "current" needs a previous step that defines where the robot ended.',
        });
        return { ...ORIGIN, headingRad: fallbackHeadingRad };
      }
      return current;
    }
    if ("ref" in source) {
      const waypoint = named[source.ref];
      if (waypoint === undefined) {
        findings.push({
          severity: "error",
          stepId,
          code: "SCHEMA",
          message: `No waypoint named ${JSON.stringify(source.ref)} in waypoints.json.`,
        });
        return { ...(current ?? ORIGIN), headingRad: fallbackHeadingRad };
      }
      return { xIn: waypoint.xIn, yIn: waypoint.yIn, headingRad: waypoint.headingRad };
    }
    return {
      xIn: source.xIn,
      yIn: source.yIn,
      headingRad: source.headingRad ?? fallbackHeadingRad,
    };
  };

  const startId = "start";
  const start = auto.start.pose;
  let startPose: Pose;
  if ("ref" in start) {
    startPose = resolvePose(start, startId, null, 0);
  } else {
    if (start.headingRad === undefined) {
      findings.push({
        severity: "error",
        stepId: startId,
        code: "SCHEMA",
        message: "The start pose needs a headingRad: nothing else can supply the robot's heading.",
      });
    }
    startPose = { xIn: start.xIn, yIn: start.yIn, headingRad: start.headingRad ?? 0 };
  }

  // `together` is set for the members of a parallel group: they all run at once, so every one of
  // them starts where the group started (`"current"` included), not where the member written
  // before it ends. This is the same rule the CONTINUITY check applies.
  const resolveSteps = (
    steps: readonly Step[],
    prefix: string,
    entry: Pose,
    together = false,
  ): ResolvedStep[] => {
    const resolved: ResolvedStep[] = [];
    let current = entry;
    for (const [index, step] of steps.entries()) {
      if (together) current = entry;
      const id = effectiveId(step, index, prefix);
      const startOfStep = current;
      if (step.kind === "path") {
        const segments: ResolvedSegment[] = [];
        let cursor: Pose = current;
        for (const segment of step.segments) {
          const fromPose = resolvePose(segment.from, id, cursor, cursor.headingRad);
          const toPose = resolvePose(segment.to, id, fromPose, fromPose.headingRad);
          const controls: Vec2[] =
            segment.kind === "bezier"
              ? segment.control.map((point) => ({ xIn: point.xIn, yIn: point.yIn }))
              : [];
          segments.push({
            kind: segment.kind,
            pointsIn: [
              { xIn: fromPose.xIn, yIn: fromPose.yIn },
              ...controls,
              { xIn: toPose.xIn, yIn: toPose.yIn },
            ],
            fromPose,
            toPose,
          });
          cursor = toPose;
        }
        const endPose = headingForEnd(step, segments, cursor);
        resolved.push({ id, kind: step.kind, step, startPose: startOfStep, endPose, segments });
        current = endPose;
        continue;
      }
      if (step.kind === "sequence") {
        // A sequence chains its members exactly like the top level: each starts where the one
        // before it ended, and the group ends where its last member does.
        const children = resolveSteps(step.steps, childPrefix(id, 1, 0), current);
        const endPose = children[children.length - 1]?.endPose ?? current;
        resolved.push({ id, kind: step.kind, step, startPose: startOfStep, endPose, children });
        current = endPose;
        continue;
      }
      if (step.kind === "parallel" || step.kind === "branch") {
        const branches = childLists(step);
        const children: ResolvedStep[] = [];
        let endPose = current;
        for (const [branchIndex, branch] of branches.entries()) {
          const branchSteps = resolveSteps(
            branch,
            childPrefix(id, branches.length, branchIndex),
            current,
            step.kind === "parallel",
          );
          children.push(...branchSteps);
          if (step.kind === "parallel") {
            const deadline =
              step.deadline === undefined
                ? undefined
                : branchSteps.find((child) => child.id === step.deadline);
            // The member that decides where the group ends is its deadline, or else the last
            // member that drives: a path, or a sequence or group with a path inside it.
            const mover = deadline ?? [...branchSteps].reverse().find(containsPath);
            if (mover !== undefined) endPose = mover.endPose;
          } else if (branchIndex === 0) {
            const last = branchSteps[branchSteps.length - 1];
            if (last !== undefined) endPose = last.endPose;
          }
        }
        resolved.push({ id, kind: step.kind, step, startPose: startOfStep, endPose, children });
        current = endPose;
        continue;
      }
      resolved.push({ id, kind: step.kind, step, startPose: startOfStep, endPose: current });
    }
    return resolved;
  };

  return { auto, startPose, steps: resolveSteps(auto.steps, "step", startPose), findings };
}

/** Anything shaped like a step tree: a resolved step, a planned step or a step estimate. */
export interface StepTree {
  kind: Step["kind"];
  children?: readonly StepTree[];
}

/**
 * True for a path step, or a group with a path step somewhere inside it: the members of a parallel
 * group that can decide where the robot ends up, and the ones whose exit speed carries on.
 */
export function containsPath(step: StepTree): boolean {
  if (step.kind === "path") return true;
  return (step.children ?? []).some(containsPath);
}

/**
 * The heading the robot holds at the end of a path step: the mode's own h(1), evaluated over the
 * geometry the step resolved to, which is exactly what `plan` samples at the last point.
 *
 * `tangent`, `tangentReversed` and `facePoint` need the geometry to answer, so this takes the
 * resolved segments rather than trusting the `to` pose's `headingRad`: that pose only says where
 * the robot stops, and a mode that computes the heading overrides whatever it carries. Without
 * this, `resolve` and `plan` disagree about where the next step starts and every stationary step
 * after a path is checked at a heading the robot never holds.
 *
 * With no mode declared the step keeps the heading it arrives with; `plan` raises HEADING_MISSING.
 */
function headingForEnd(
  step: Extract<Step, { kind: "path" }>,
  segments: readonly ResolvedSegment[],
  end: Pose,
): Pose {
  const heading = step.heading;
  if (heading === undefined) return end;
  if (heading.mode === "constant") return { ...end, headingRad: wrapAngle(heading.headingRad) };
  if (segments.length === 0) {
    return heading.mode === "linear" ? { ...end, headingRad: wrapAngle(heading.toRad) } : end;
  }
  const geometry = makePath(segments.map((segment) => segment.pointsIn));
  return { ...end, headingRad: headingFunction(heading, geometry)(1) };
}
