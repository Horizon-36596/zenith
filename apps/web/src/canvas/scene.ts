/**
 * The draw model: everything the live layer paints, in world inches, derived once per document
 * change rather than per frame. Projecting it to screen pixels is the only work a frame does, which
 * is what keeps a drag inside its 16 ms budget on a twenty-step auto.
 *
 * v2 (site/docs/editor.md) removed the footprint ghosts: the scene no longer stamps
 * robot outlines along a path. What it carries instead is the clock: every sample's time on the
 * estimated run (`estimate.timeAtSampleS`, offset by where the step starts), so the one robot
 * outline can be put at the playback time or at the hovered point with its time beside it.
 *
 * Nothing here touches the DOM, so the shapes are unit-testable and the whole module is a pure
 * function of the props.
 */
import {
  flattenSteps,
  lerpAngle,
  type Estimate,
  type Finding,
  type PathGeometry,
  type Plan,
  type PlanStep,
  type Pose,
  type Severity,
  type Vec2,
} from "@horizon36596/zenith-core";
import type { Heading } from "@horizon36596/zenith-schema";
import { bezierNodes, type BezierNode } from "./bezier.js";
import type { PointTarget, TraceOverlay } from "./types.js";

/** One draggable endpoint of a segment, with the pose a heading handle would rotate. */
export interface SceneHandle {
  target: PointTarget;
  poseIn: Pose;
  /**
   * True for a step's start written as `"current"`: it is the previous step's end, which has its
   * own handle, so this one is neither drawn nor grabbable (dragging it would silently replace
   * `"current"` with a literal pose and break the chain).
   */
  chained: boolean;
}

/** A Bezier control point, and the endpoints its hairlines run to. */
export interface SceneControl {
  target: PointTarget;
  pointIn: Vec2;
  /** The end this handle belongs to; the middle control of an odd count belongs to both. */
  anchorIn: Vec2;
  anchorsIn: Vec2[];
}

export interface SceneMarker {
  markerIndex: number;
  t: number;
  pointIn: Vec2;
  label: string;
}

/** A stretch of a path a finding points at, as a t range. */
export interface SceneHighlight {
  severity: Severity;
  t0: number;
  t1: number;
}

export interface SceneStep {
  stepId: string;
  kind: PlanStep["kind"];
  /** The drawn polyline: one pose per plan sample. */
  poses: Pose[];
  ts: number[];
  sIns: number[];
  lengthIn: number;
  handles: SceneHandle[];
  controls: SceneControl[];
  markers: SceneMarker[];
  highlights: SceneHighlight[];
  /** Each segment's control polygon `[from, ...controls, to]`, for the Bezier node rules. */
  polygons: Vec2[][];
  nodes: BezierNode[];
  /** The estimated clock at each sample, in seconds from the start of the routine, or null. */
  timesS: number[] | null;
  /** The heading mode the file gives a path step, for the heading handles; absent for any other. */
  heading?: Heading;
}

/** Where a step sits on the estimated clock, for the playback head. */
export interface SceneSpan {
  stepId: string;
  startS: number;
  endS: number;
}

export interface Scene {
  steps: SceneStep[];
  startPose: Pose;
  spans: SceneSpan[];
  /** Null when there is no estimate: the canvas owns no time model of its own. */
  totalS: number | null;
}

/** A finding with no t covers its whole step; one with a t gets a band this wide either side. */
const FINDING_BAND_T = 0.03;

const severityRank: Readonly<Record<Severity, number>> = { info: 0, warning: 1, error: 2 };

/** The pose at an arc length along a step, interpolated between plan samples. */
export function poseAtDistance(step: SceneStep, sIn: number): Pose {
  const count = step.poses.length;
  if (count === 0) return { xIn: 0, yIn: 0, headingRad: 0 };
  const first = step.poses[0] as Pose;
  if (count === 1 || sIn <= 0) return first;
  const last = step.poses[count - 1] as Pose;
  if (sIn >= step.lengthIn) return last;

  let index = 0;
  while (index + 1 < count && (step.sIns[index + 1] as number) < sIn) index += 1;
  const next = Math.min(index + 1, count - 1);
  const a = step.poses[index] as Pose;
  const b = step.poses[next] as Pose;
  const sa = step.sIns[index] as number;
  const sb = step.sIns[next] as number;
  const u = sb - sa <= 1e-9 ? 0 : (sIn - sa) / (sb - sa);
  return {
    xIn: a.xIn + (b.xIn - a.xIn) * u,
    yIn: a.yIn + (b.yIn - a.yIn) * u,
    headingRad: lerpAngle(a.headingRad, b.headingRad, u),
  };
}

export const poseAtT = (step: SceneStep, t: number): Pose =>
  poseAtDistance(step, step.lengthIn * Math.min(1, Math.max(0, t)));

/** The value of a per-sample series at arc-length parameter t, interpolated. */
function seriesAtT(step: SceneStep, series: readonly number[], t: number): number | null {
  const count = Math.min(step.ts.length, series.length);
  if (count === 0) return null;
  const clamped = Math.min(1, Math.max(0, t));
  if (count === 1 || clamped <= (step.ts[0] as number)) return series[0] as number;
  for (let index = 0; index + 1 < count; index += 1) {
    const ta = step.ts[index] as number;
    const tb = step.ts[index + 1] as number;
    if (clamped <= tb) {
      const u = tb - ta <= 1e-12 ? 0 : (clamped - ta) / (tb - ta);
      return (series[index] as number) + ((series[index + 1] as number) - (series[index] as number)) * u;
    }
  }
  return series[count - 1] as number;
}

interface MarkerAtShape {
  t?: number;
  distanceIn?: number;
  distanceFromEndIn?: number;
}

function markerT(at: MarkerAtShape, lengthIn: number): number {
  if (at.t !== undefined) return at.t;
  if (lengthIn <= 0) return 0;
  if (at.distanceIn !== undefined) return Math.min(1, Math.max(0, at.distanceIn / lengthIn));
  if (at.distanceFromEndIn !== undefined) {
    return Math.min(1, Math.max(0, 1 - at.distanceFromEndIn / lengthIn));
  }
  return 0;
}

function buildHighlights(findings: readonly Finding[], stepId: string): SceneHighlight[] {
  const out: SceneHighlight[] = [];
  for (const finding of findings) {
    if (finding.stepId !== stepId) continue;
    if (finding.severity === "info") continue;
    const t = finding.t;
    if (t === undefined) {
      out.push({ severity: finding.severity, t0: 0, t1: 1 });
    } else {
      out.push({
        severity: finding.severity,
        t0: Math.max(0, t - FINDING_BAND_T),
        t1: Math.min(1, t + FINDING_BAND_T),
      });
    }
  }
  return out.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
}

function buildStep(planStep: PlanStep, findings: readonly Finding[]): SceneStep {
  const poses: Pose[] = [];
  const ts: number[] = [];
  const sIns: number[] = [];
  for (const sample of planStep.samples) {
    poses.push(sample.pose);
    ts.push(sample.t);
    sIns.push(sample.sIn);
  }

  const authored = planStep.step;
  const firstFrom = authored.kind === "path" ? authored.segments[0]?.from : undefined;
  const handles: SceneHandle[] = [];
  const controls: SceneControl[] = [];
  const polygons: Vec2[][] = [];
  const segments = planStep.segments ?? [];
  for (const [segmentIndex, segment] of segments.entries()) {
    polygons.push(segment.pointsIn.map((point) => ({ xIn: point.xIn, yIn: point.yIn })));
    if (segmentIndex === 0) {
      handles.push({
        target: { segmentIndex, pointKind: "from" },
        poseIn: segment.fromPose,
        chained: firstFrom === "current",
      });
    }
    handles.push({ target: { segmentIndex, pointKind: "to" }, poseIn: segment.toPose, chained: false });
    const count = segment.pointsIn.length;
    for (let i = 1; i + 1 < count; i += 1) {
      // A control's hairline runs to the end it belongs to: the first half to `from`, the second
      // half to `to`, so a cubic reads as two handles, one at each end, the way CAD tools draw it.
      const fromIn = segment.pointsIn[0] as Vec2;
      const toIn = segment.pointsIn[count - 1] as Vec2;
      const middle = (count - 1) / 2;
      const anchorsIn = i < middle ? [fromIn] : i > middle ? [toIn] : [fromIn, toIn];
      controls.push({
        target: { segmentIndex, pointKind: "control", controlIndex: i - 1 },
        pointIn: segment.pointsIn[i] as Vec2,
        anchorIn: anchorsIn[0] as Vec2,
        anchorsIn,
      });
    }
  }

  const step: SceneStep = {
    stepId: planStep.id,
    kind: planStep.kind,
    poses,
    ts,
    sIns,
    lengthIn: planStep.lengthIn,
    handles,
    controls,
    markers: [],
    highlights: buildHighlights(findings, planStep.id),
    polygons,
    nodes: bezierNodes(polygons),
    timesS: null,
    ...(authored.kind === "path" && authored.heading !== undefined ? { heading: authored.heading } : {}),
  };

  if (authored.kind === "path" && authored.markers !== undefined) {
    for (const [markerIndex, marker] of authored.markers.entries()) {
      const t = markerT(marker.at, planStep.lengthIn);
      step.markers.push({ markerIndex, t, pointIn: poseAtT(step, t), label: marker.command.name });
    }
  }
  return step;
}

export interface BuildSceneInput {
  plan: Plan;
  findings: readonly Finding[];
  estimate: Estimate | null;
}

/**
 * Lay the steps on the estimated clock: a top-level list and a `sequence` run one after another, a
 * `parallel` group's members all start together, and a branch's arms (its `then` members, then its
 * `else` members) each run in order from the branch's start. A group lasts its own estimate, or
 * its longest member when it has none.
 */
function layOut(
  steps: readonly PlanStep[],
  startS: number,
  nominal: (id: string) => number | null,
  spans: SceneSpan[],
): number {
  let clockS = startS;
  for (const step of steps) {
    const ownS = nominal(step.id);
    const children = step.children;
    if (children === undefined || children.length === 0) {
      spans.push({ stepId: step.id, startS: clockS, endS: clockS + (ownS ?? 0) });
      clockS += ownS ?? 0;
      continue;
    }
    let longestS = 0;
    if (step.kind === "parallel") {
      for (const child of children) longestS = Math.max(longestS, layOut([child], clockS, nominal, spans) - clockS);
    } else if (step.kind === "branch") {
      const authored = step.step as { then?: unknown[] };
      const thenCount = Array.isArray(authored.then) ? authored.then.length : children.length;
      const thenEnd = layOut(children.slice(0, thenCount), clockS, nominal, spans);
      const elseEnd = layOut(children.slice(thenCount), clockS, nominal, spans);
      longestS = Math.max(thenEnd, elseEnd) - clockS;
    } else {
      longestS = layOut(children, clockS, nominal, spans) - clockS;
    }
    const groupS = ownS ?? longestS;
    spans.push({ stepId: step.id, startS: clockS, endS: clockS + groupS });
    clockS += groupS;
  }
  return clockS;
}

export function buildScene(input: BuildSceneInput): Scene {
  const { plan, findings, estimate } = input;
  const byId = estimate?.byStepId ?? {};
  const nominal = (id: string): number | null => byId[id]?.nominalS ?? null;

  const spans: SceneSpan[] = [];
  const totalS = layOut(plan.steps, 0, nominal, spans);
  const spanOf = new Map(spans.map((span) => [span.stepId, span]));

  const steps: SceneStep[] = [];
  for (const planStep of flattenSteps(plan.steps)) {
    if (planStep.samples.length < 2) continue;
    const step = buildStep(planStep, findings);
    const span = spanOf.get(planStep.id);
    const atSample = byId[planStep.id]?.timeAtSampleS;
    if (estimate !== null && span !== undefined) {
      step.timesS =
        atSample !== undefined && atSample.length === step.poses.length
          ? atSample.map((seconds) => span.startS + seconds)
          : step.ts.map((t) => span.startS + t * (span.endS - span.startS));
    }
    steps.push(step);
  }

  return { steps, startPose: plan.startPose, spans, totalS: estimate === null ? null : totalS };
}

/** The pose on the estimated clock at `atS`, or null when nothing has a time. */
export function poseAtTime(scene: Scene, atS: number): Pose | null {
  if (scene.totalS === null) return null;
  // The step whose motion covers `atS`, else the last one to have finished before it.
  let last: Pose = scene.startPose;
  let lastEndS = -Infinity;
  for (const step of scene.steps) {
    const times = step.timesS;
    if (times === null || times.length === 0) continue;
    const startS = times[0] as number;
    const endS = times[times.length - 1] as number;
    if (atS >= startS && atS <= endS && endS > startS) {
      for (let index = 0; index + 1 < times.length; index += 1) {
        const ta = times[index] as number;
        const tb = times[index + 1] as number;
        if (atS <= tb) {
          const u = tb - ta <= 1e-12 ? 0 : (atS - ta) / (tb - ta);
          const a = step.poses[index] as Pose;
          const b = step.poses[index + 1] as Pose;
          return {
            xIn: a.xIn + (b.xIn - a.xIn) * u,
            yIn: a.yIn + (b.yIn - a.yIn) * u,
            headingRad: lerpAngle(a.headingRad, b.headingRad, u),
          };
        }
      }
    }
    if (endS <= atS && endS >= lastEndS) {
      lastEndS = endS;
      last = step.poses[step.poses.length - 1] ?? last;
    }
  }
  return last;
}

/** The estimated time the robot reaches arc-length t of a step, or null without an estimate. */
export function timeAtT(step: SceneStep, t: number): number | null {
  return step.timesS === null ? null : seriesAtT(step, step.timesS, t);
}

/** The pose a recorded trace was at, interpolated between its rows. */
export function tracePoseAt(
  poses: ReadonlyArray<readonly [number, number, number, number]>,
  atS: number,
): Pose | null {
  if (poses.length === 0) return null;
  const first = poses[0] as readonly [number, number, number, number];
  if (atS <= first[0]) return { xIn: first[1], yIn: first[2], headingRad: first[3] };
  const last = poses[poses.length - 1] as readonly [number, number, number, number];
  if (atS >= last[0]) return { xIn: last[1], yIn: last[2], headingRad: last[3] };

  // Binary search: a 30 s trace at 0.01 s ticks is 3000 rows and this runs every frame.
  let lo = 0;
  let hi = poses.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((poses[mid] as readonly [number, number, number, number])[0] < atS) lo = mid;
    else hi = mid;
  }
  const a = poses[lo] as readonly [number, number, number, number];
  const b = poses[hi] as readonly [number, number, number, number];
  const u = b[0] - a[0] <= 1e-9 ? 0 : (atS - a[0]) / (b[0] - a[0]);
  return {
    xIn: a[1] + (b[1] - a[1]) * u,
    yIn: a[2] + (b[2] - a[2]) * u,
    headingRad: lerpAngle(a[3], b[3], u),
  };
}

/**
 * The time a trace passes closest to a point while running one step: the instant sim's answer to
 * "when does the robot get here", used for the hover readout. Null when the trace has no such step.
 */
export function traceTimeNear(trace: TraceOverlay, stepId: string, pointIn: Vec2): number | null {
  const span = trace.steps.find((step) => step.id === stepId);
  if (span === undefined) return null;
  let best: number | null = null;
  let bestIn = Infinity;
  for (const row of trace.poses) {
    if (row[0] < span.startS - 1e-9) continue;
    if (row[0] > span.endS + 1e-9) break;
    const distanceIn = Math.hypot(row[1] - pointIn.xIn, row[2] - pointIn.yIn);
    if (distanceIn < bestIn) {
      bestIn = distanceIn;
      best = row[0];
    }
  }
  return best;
}

/**
 * Where arc-length t of a step falls as a segment and that segment's own curve parameter u, which
 * is what the split-segment fix takes (`core.applyFix({ kind: "splitSegment" })`).
 */
export function splitLocation(geometry: PathGeometry, t: number): { segmentIndex: number; u: number } {
  const sIn = geometry.distanceAt(t);
  const count = geometry.curves.length;
  let segmentIndex = 0;
  while (segmentIndex + 1 < count && (geometry.breaks[segmentIndex + 1] as number) <= sIn) segmentIndex += 1;
  const curve = geometry.curves[segmentIndex];
  if (curve === undefined) return { segmentIndex: 0, u: 0.5 };
  return { segmentIndex, u: curve.uAtLength(sIn - (geometry.breaks[segmentIndex] as number)) };
}
