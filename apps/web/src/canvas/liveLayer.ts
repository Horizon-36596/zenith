/**
 * The live layer: everything that moves. Drawn over the cached static field once per animation
 * frame while the pointer is down, and once per prop change otherwise.
 *
 * The look is a CAD tool's, not a dashboard's (site/docs/editor.md): 1 px
 * hairlines, hollow handles that fill when selected, square corner nodes and round smooth nodes,
 * no gradients, glows or heavy fills, and names only on hover or once zoomed in far enough to read
 * them without crowding. The only robot outline is the one at the playback time or under the
 * cursor (section 1: the footprint ghosts are gone).
 *
 * The BLUE mirror lives here and nowhere else: when `mirror` is not `"none"` every world point is
 * put through that kind of `field.json`'s `frame.mirror` on its way to the screen, and the pointer
 * goes back through the same function on its way out, so the shell only ever sees canonical RED
 * poses (finding 22: `mirrorVec`/`mirrorHeadingRad` are `@horizon36596/zenith-core`'s, the same ones `render`
 * uses, not a second hardcoded copy).
 */
import {
  footprintAt,
  mirrorHeadingRad,
  mirrorVec,
  radToDeg,
  type Box2,
  type Finding,
  type MirrorMode,
  type Pose,
  type Vec2,
} from "@horizon36596/zenith-core";
import type { Robot } from "@horizon36596/zenith-schema";
import { isPoseReset } from "../project/desktopTrace.js";
import { effectiveNodeKind, type NodeKind } from "./bezier.js";
import {
  headingHandlesFor,
  linkedKeys,
  rangeBoundariesFor,
  type HeadingHandle,
  type RangeBoundary,
} from "./headingHandles.js";
import { handleRank, type BoundaryEntry, type HandleEntry, type HeadingHandleEntry, type HitScene, type MarkerEntry, type PolylineEntry } from "./hit.js";
import { measure, measureDeltaLabel, measureLabel, type Measurement } from "./measure.js";
import type { Scene, SceneStep } from "./scene.js";
import { poseAtT } from "./scene.js";
import { isPointSelected, stepsWithHandles, type MarqueeCandidate, type ScreenRect } from "./selection.js";
import type { SnapResult } from "./snap.js";
import type { CanvasTheme } from "./theme.js";
import type { CanvasHit, Selection, TraceOverlay } from "./types.js";
import { headingToScreenAngle, scaleBarInches, worldToScreen, type ScreenVec, type View } from "./view.js";

/**
 * Handle sizes, in CSS pixels (UI_GUIDE 9.11). Endpoints are 8 px filled squares, or 8 px filled
 * circles where the node is smooth; control points are 7 px hollow squares. A selected handle
 * carries a 1 px ring outside it: on the field a selection has no colour of its own.
 *
 * Heading handles are arrows, not squares, in `--handle-heading` (sky), so they never read as a
 * point you can move: a 26 px shaft from the path with a filled head that is the grab point. One that
 * cannot be turned is dashed with a hollow head. A facing point is a ring with a cross.
 */
const NODE_PX = 8;
const NODE_HOVER_PX = 10;
const CONTROL_PX = 7;
const CONTROL_HOVER_PX = 9;
const SELECTED_RING_GAP_PX = 2;
/** Marker teardrops: 10 px tall, the tip on the path. */
const MARKER_PX = 10;
const MARKER_HEAD_R_PX = 3.5;
/** A heading arrow's length from the path to the tip of its head, in screen pixels, at any zoom. */
export const HEADING_ARROW_PX = 26;
const ARROW_HEAD_PX = 7;
const ARROW_HEAD_HOVER_PX = 9;
const FACE_POINT_R_PX = 5;
/** Half the length of a range boundary's tick across the path. */
const BOUNDARY_TICK_PX = 7;
const OVERLAY_PAD_PX = 8;
/** Step names are drawn on the path only once a 12 in tile is at least this many pixels. */
export const LABEL_MIN_PX_PER_IN = 7;

export interface ReadoutState {
  pointIn: Vec2 | null;
  headingRad: number | null;
  /** What the snap engine latched on to, named for the corner readout. */
  snapLabel: string | null;
}

/** The small chip that follows the cursor: drag values, or the hover readout on a path. */
export interface Bubble {
  xPx: number;
  yPx: number;
  /** The first line is the values; any further line is a note (the snap acting, a step name). */
  lines: string[];
}

export interface LiveLayerInput {
  scene: Scene;
  /** Review mode's base version, drawn dashed under the head. Absent in every other mode. */
  baseScene?: Scene | null;
  view: View;
  theme: CanvasTheme;
  robot: Robot;
  bounds: Box2;
  /** `"none"` at rest; otherwise the field's own `frame.mirror` kind, while a BLUE preview draws. */
  mirror: MirrorMode;
  selection: Selection;
  hover: CanvasHit | null;
  findings: readonly Finding[];
  trace: TraceOverlay | null;
  widthPx: number;
  heightPx: number;
  /** The addPath tool's preview from the anchor end pose to the pointer. */
  rubberBand: { fromIn: Pose; toIn: Vec2 } | null;
  snapFeedback: SnapResult | null;
  readout: ReadoutState;
  /** The session's remembered smooth and corner choices (`bezier.ts`). */
  nodeKinds: ReadonlyMap<string, NodeKind>;
  /**
   * The one robot outline: at the playback time, or at the hovered point of a path. `label` names
   * the playback level it comes from ("Ideal", "Instant sim", "Full sim") and is drawn under it.
   */
  robotPose: { poseIn: Pose; emphasis: "playback" | "hover"; label?: string | null } | null;
  /**
   * The ideal level's transitions (`core.idealTrajectory`): where one step ends away from where the
   * next begins, the straight line the ideal robot drives across the gap, drawn dashed. Optional;
   * empty or absent draws nothing.
   */
  transitions?: ReadonlyArray<{ fromIn: Pose; toIn: Pose }>;
  /** The recorded run's pose at the playback time, drawn as a small mark, not a second outline. */
  traceMarker: Pose | null;
  bubble: Bubble | null;
  marquee: ScreenRect | null;
  measurement: Measurement | null;
  /** "Field image: ..." while the field picture is showing. */
  credit: string | null;
  /** The inspector's hovered heading range, drawn over its stretch of the path. */
  highlightRange?: { stepId: string; startT: number; endT: number } | null;
  /** The heading handle being dragged, which draws as hovered for the whole drag. */
  activeHeadingHandle?: { stepId: string; key: string } | null;
}

type Painter = (ctx: CanvasRenderingContext2D, input: LiveLayerInput) => void;

const project = (view: View, mirror: MirrorMode, point: Vec2): ScreenVec =>
  worldToScreen(view, mirrorVec(point, mirror));

const projectPose = (view: View, mirror: MirrorMode, pose: Pose): Pose => ({
  ...mirrorVec(pose, mirror),
  headingRad: mirrorHeadingRad(pose.headingRad, mirror),
});

/** Half-pixel alignment, so a 1 px stroke lands on one row of pixels instead of smearing over two. */
const crisp = (valuePx: number): number => Math.round(valuePx) + 0.5;

function tracePolygon(ctx: CanvasRenderingContext2D, view: View, mirror: MirrorMode, corners: readonly Vec2[]): void {
  ctx.beginPath();
  for (const [index, corner] of corners.entries()) {
    const screen = project(view, mirror, corner);
    if (index === 0) ctx.moveTo(screen.xPx, screen.yPx);
    else ctx.lineTo(screen.xPx, screen.yPx);
  }
  ctx.closePath();
}

/** The polyline of one step, between two arc-length parameters. */
function tracePolyline(
  ctx: CanvasRenderingContext2D,
  view: View,
  mirror: MirrorMode,
  step: SceneStep,
  t0 = 0,
  t1 = 1,
): void {
  ctx.beginPath();
  let started = false;
  if (t0 > 0) {
    const start = project(view, mirror, poseAtT(step, t0));
    ctx.moveTo(start.xPx, start.yPx);
    started = true;
  }
  for (const [index, pose] of step.poses.entries()) {
    const t = step.ts[index] as number;
    if (t < t0 || t > t1) continue;
    const screen = project(view, mirror, pose);
    if (!started) {
      ctx.moveTo(screen.xPx, screen.yPx);
      started = true;
    } else {
      ctx.lineTo(screen.xPx, screen.yPx);
    }
  }
  if (t1 < 1) {
    const end = project(view, mirror, poseAtT(step, t1));
    if (started) ctx.lineTo(end.xPx, end.yPx);
  }
}

/** Every finding's geometry, drawn faintly under everything: the legal-approach band included. */
const drawFindingGeometry: Painter = (ctx, input) => {
  const { view, mirror, theme } = input;
  for (const finding of input.findings) {
    const geometry = finding.geometry;
    if (geometry === undefined) continue;
    const colour = finding.severity === "error" ? theme.sevError : theme.sevWarn;
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1;
    if (geometry.polygonIn !== undefined && geometry.polygonIn.length > 1) {
      tracePolygon(ctx, view, mirror, geometry.polygonIn);
      ctx.globalAlpha = 0.07;
      ctx.fillStyle = colour;
      ctx.fill();
      ctx.globalAlpha = 0.6;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    if (geometry.pointIn !== undefined) {
      const screen = project(view, mirror, geometry.pointIn);
      // A small cross, not a ring: it marks a place without looking like a handle.
      ctx.beginPath();
      ctx.moveTo(screen.xPx - 4, screen.yPx - 4);
      ctx.lineTo(screen.xPx + 4, screen.yPx + 4);
      ctx.moveTo(screen.xPx + 4, screen.yPx - 4);
      ctx.lineTo(screen.xPx - 4, screen.yPx + 4);
      ctx.stroke();
    }
  }
};

/**
 * Review mode's base version (06 section 4): the same polylines as the head, in `--path-ghost`,
 * dashed 4 4 and never interactive, so "what it was" sits under "what it becomes".
 */
const drawBasePaths: Painter = (ctx, input) => {
  const base = input.baseScene;
  if (base === null || base === undefined) return;
  const { view, mirror, theme } = input;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = theme.pathGhost;
  ctx.lineWidth = theme.pathWidthNormalPx;
  ctx.setLineDash([4, 4]);
  for (const step of base.steps) {
    tracePolyline(ctx, view, mirror, step);
    ctx.stroke();
  }
  ctx.setLineDash([]);
};

const drawPaths: Painter = (ctx, input) => {
  const { view, mirror, theme, selection, hover } = input;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const withHandles = stepsWithHandles(selection);

  for (const step of input.scene.steps) {
    // The finding underlay first, a little wider, so the path stays legible on top (UI_GUIDE 8.8).
    for (const highlight of step.highlights) {
      tracePolyline(ctx, view, mirror, step, highlight.t0, highlight.t1);
      ctx.strokeStyle = highlight.severity === "error" ? theme.sevError : theme.sevWarn;
      ctx.globalAlpha = 0.3;
      ctx.lineWidth = theme.pathWidthSelectedPx + 3;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    const selected = withHandles.has(step.stepId);
    const hovered = hover?.stepId === step.stepId;
    tracePolyline(ctx, view, mirror, step);
    ctx.strokeStyle = selected ? theme.pathSelected : hovered ? theme.pathHover : theme.pathEstimated;
    ctx.lineWidth = selected ? theme.pathWidthSelectedPx : theme.pathWidthNormalPx;
    // The mirror is a preview of the other alliance, so it reads as a ghost of the real thing.
    if (mirror !== "none") ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    const range = highlightedRange(input, step);
    if (range !== null) {
      tracePolyline(ctx, view, mirror, step, range.startT, range.endT);
      ctx.strokeStyle = theme.handleHeading;
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = theme.pathWidthSelectedPx + 4;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
};

/**
 * The stretch of a step to light up: the range the inspector is hovering, else the range whose
 * heading handle or boundary is under the pointer or being dragged.
 */
function highlightedRange(input: LiveLayerInput, step: SceneStep): { startT: number; endT: number } | null {
  const fromInspector = input.highlightRange;
  if (fromInspector !== null && fromInspector !== undefined) {
    return fromInspector.stepId === step.stepId ? fromInspector : null;
  }
  const heading = step.heading;
  if (heading?.mode !== "piecewise") return null;
  const key =
    input.activeHeadingHandle?.stepId === step.stepId
      ? input.activeHeadingHandle.key
      : input.hover?.stepId === step.stepId
        ? input.hover.headingHandle
        : undefined;
  const match = key === undefined ? null : /^r(\d+):/.exec(key);
  if (match === null) return null;
  const range = heading.ranges[Number(match[1]) - 1];
  return range === undefined ? null : { startT: range.startT, endT: range.endT };
}

/** Step names on the path, only once zoomed in far enough that they do not crowd. */
const drawStepLabels: Painter = (ctx, input) => {
  const { view, mirror, theme } = input;
  if (view.pxPerIn < LABEL_MIN_PX_PER_IN) return;
  ctx.font = `10px ${theme.fontMono}`;
  ctx.textBaseline = "middle";
  // text-mid, not text-lo: the names sit on the field, and the light-field ink darkens text-mid.
  ctx.fillStyle = theme.textMid;
  for (const step of input.scene.steps) {
    if (step.lengthIn < 6) continue;
    const middle = poseAtT(step, 0.5);
    const drawn = projectPose(view, mirror, middle);
    const screen = worldToScreen(view, drawn);
    const angle = headingToScreenAngle(view, drawn.headingRad);
    // Off to the side of the path, never on it: on whichever side lies to the right, because the
    // text runs rightwards from where it starts and would otherwise cross back over the line.
    let nx = Math.sin(angle);
    let ny = -Math.cos(angle);
    if (nx < 0) {
      nx = -nx;
      ny = -ny;
    }
    ctx.fillText(step.stepId, screen.xPx + nx * 10 + 4, screen.yPx + ny * 10);
  }
};

/**
 * Where a trace's polyline starts a new sub-path: row 0, and every row that jumps from the row
 * before it further than a robot can move in that time. Such a jump is the localizer being reset or
 * overwritten mid-run, and a line across it would draw a drive that never happened. The rule is the
 * desktop trace loader's `isPoseReset` (over 6 in and over 150 in/s), shared rather than copied, so
 * the loader's reset count and the gaps on the field always agree.
 */
export function traceBreaks(trace: TraceOverlay): number[] {
  const rows = trace.poses;
  if (rows.length === 0) return [];
  const tickS = trace.tickS ?? 0;
  const breaks = [0];
  for (let index = 1; index < rows.length; index += 1) {
    const before = rows[index - 1];
    const row = rows[index];
    if (before !== undefined && row !== undefined && isPoseReset(before, row, tickS)) breaks.push(index);
  }
  return breaks;
}

const drawTrace: Painter = (ctx, input) => {
  const { view, mirror, theme, trace } = input;
  if (trace === null || trace.poses.length === 0) return;
  ctx.strokeStyle = theme.pathActual;
  ctx.lineWidth = theme.pathWidthActualPx;
  ctx.lineJoin = "round";
  const breaks = new Set(traceBreaks(trace));
  ctx.beginPath();
  for (const [index, row] of trace.poses.entries()) {
    const screen = project(view, mirror, { xIn: row[1], yIn: row[2] });
    if (breaks.has(index)) ctx.moveTo(screen.xPx, screen.yPx);
    else ctx.lineTo(screen.xPx, screen.yPx);
  }
  ctx.stroke();
};

/** A small pose mark: a ring and a tick along the heading. */
function poseMark(ctx: CanvasRenderingContext2D, input: LiveLayerInput, poseIn: Pose, dot: boolean): void {
  const { view, mirror } = input;
  const pose = projectPose(view, mirror, poseIn);
  const centre = worldToScreen(view, pose);
  const angle = headingToScreenAngle(view, pose.headingRad);
  ctx.beginPath();
  ctx.arc(centre.xPx, centre.yPx, 4, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(centre.xPx + Math.cos(angle) * 4, centre.yPx + Math.sin(angle) * 4);
  ctx.lineTo(centre.xPx + Math.cos(angle) * 11, centre.yPx + Math.sin(angle) * 11);
  ctx.stroke();
  if (dot) {
    ctx.beginPath();
    ctx.arc(centre.xPx, centre.yPx, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** The routine's start and end, as small clean marks: no footprint of their own. */
const drawStartEnd: Painter = (ctx, input) => {
  const { theme } = input;
  ctx.strokeStyle = theme.fieldWaypoint;
  ctx.fillStyle = theme.fieldWaypoint;
  ctx.lineWidth = 1;
  poseMark(ctx, input, input.scene.startPose, false);
  const last = input.scene.steps[input.scene.steps.length - 1];
  const end = last?.poses[last.poses.length - 1];
  if (end !== undefined) poseMark(ctx, input, end, true);
};

const drawMarkers: Painter = (ctx, input) => {
  const { view, mirror, theme } = input;
  ctx.font = `10px ${theme.fontMono}`;
  ctx.textBaseline = "middle";
  for (const step of input.scene.steps) {
    for (const marker of step.markers) {
      const screen = project(view, mirror, marker.pointIn);
      const hovered = input.hover?.stepId === step.stepId && input.hover.markerIndex === marker.markerIndex;
      const selected = input.selection.stepId === step.stepId && input.selection.markerIndex === marker.markerIndex;
      // A teardrop with its tip on the path, hollow until hovered or selected. The head is a
      // circle; the two straight sides are its tangents from the tip.
      const radius = MARKER_HEAD_R_PX;
      const cy = screen.yPx - MARKER_PX + radius;
      const spread = Math.acos(radius / (screen.yPx - cy));
      ctx.beginPath();
      ctx.moveTo(screen.xPx, screen.yPx);
      ctx.arc(screen.xPx, cy, radius, Math.PI / 2 + spread, Math.PI * 2.5 - spread, false);
      ctx.closePath();
      ctx.lineWidth = 1;
      ctx.lineJoin = "miter";
      ctx.strokeStyle = theme.markerPin;
      ctx.fillStyle = selected || hovered ? theme.markerPin : theme.bgCanvas;
      ctx.fill();
      ctx.stroke();
      if (selected) {
        ctx.beginPath();
        ctx.arc(screen.xPx, cy, radius + SELECTED_RING_GAP_PX + 0.5, Math.PI / 2 + spread, Math.PI * 2.5 - spread, false);
        ctx.strokeStyle = theme.handleEndpoint;
        ctx.stroke();
      }
      if (hovered) {
        ctx.fillStyle = theme.textHi;
        ctx.fillText(marker.label, screen.xPx + 8, cy);
      }
    }
  }
};

/**
 * Where a heading handle is drawn and grabbed, in screen pixels: an arrow's base on the path and
 * its tip 26 px along the heading, or a facing point's own position (base and tip the same).
 */
export function headingHandleScreen(
  view: View,
  mirror: MirrorMode,
  handle: HeadingHandle,
): { base: ScreenVec; tip: ScreenVec; angle: number } {
  if (handle.role === "point") {
    const at = project(view, mirror, handle.poseIn);
    return { base: at, tip: at, angle: 0 };
  }
  const pose = projectPose(view, mirror, handle.poseIn);
  const base = worldToScreen(view, pose);
  const angle = headingToScreenAngle(view, pose.headingRad);
  return {
    base,
    tip: { xPx: base.xPx + Math.cos(angle) * HEADING_ARROW_PX, yPx: base.yPx + Math.sin(angle) * HEADING_ARROW_PX },
    angle,
  };
}

/** Where a range boundary's tick crosses the path, and the path's direction there, on screen. */
function boundaryScreen(view: View, mirror: MirrorMode, boundary: RangeBoundary): { at: ScreenVec; angle: number } {
  const pose = projectPose(view, mirror, boundary.poseIn);
  return { at: worldToScreen(view, pose), angle: headingToScreenAngle(view, pose.headingRad) };
}

/** A square of a given size centred on a point, on whole pixels so its 1 px edge stays crisp. */
function squarePath(ctx: CanvasRenderingContext2D, centre: ScreenVec, sizePx: number): void {
  const x = crisp(centre.xPx - sizePx / 2);
  const y = crisp(centre.yPx - sizePx / 2);
  ctx.rect(x, y, sizePx - 1, sizePx - 1);
}

const sameTargetAs = (hover: CanvasHit | null, stepId: string, target: { segmentIndex: number; pointKind: string; controlIndex?: number }): boolean =>
  hover?.stepId === stepId &&
  hover.point?.segmentIndex === target.segmentIndex &&
  hover.point.pointKind === target.pointKind &&
  (target.pointKind !== "control" || (hover.point.controlIndex ?? 0) === (target.controlIndex ?? 0));

const drawHandles: Painter = (ctx, input) => {
  const { view, mirror, theme, selection, hover } = input;
  // The step under the pointer shows its dots too, so any path's dot can be seen before it is
  // pressed and dragged (`projectHitScene`); only the selected steps keep theirs when it leaves.
  const withHandles = stepsWithHandles(selection);
  if (hover !== null) withHandles.add(hover.stepId);
  ctx.lineWidth = 1;

  for (const step of input.scene.steps) {
    if (!withHandles.has(step.stepId)) continue;

    // Hairlines first, so every handle sits on top of every line.
    ctx.strokeStyle = theme.handleControl;
    ctx.globalAlpha = 0.7;
    for (const control of step.controls) {
      const point = project(view, mirror, control.pointIn);
      for (const anchorIn of control.anchorsIn) {
        const anchor = project(view, mirror, anchorIn);
        ctx.beginPath();
        ctx.moveTo(anchor.xPx, anchor.yPx);
        ctx.lineTo(point.xPx, point.yPx);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    for (const control of step.controls) {
      const screen = project(view, mirror, control.pointIn);
      const hovered = sameTargetAs(hover, step.stepId, control.target);
      const selected = isPointSelected(selection, { stepId: step.stepId, point: control.target });
      const sizePx = hovered ? CONTROL_HOVER_PX : CONTROL_PX;
      ctx.beginPath();
      squarePath(ctx, screen, sizePx);
      ctx.fillStyle = selected ? theme.handleControl : theme.bgCanvas;
      ctx.fill();
      ctx.strokeStyle = theme.handleControl;
      ctx.stroke();
      if (selected) {
        ctx.beginPath();
        squarePath(ctx, screen, sizePx + SELECTED_RING_GAP_PX * 2 + 2);
        ctx.strokeStyle = theme.handleEndpoint;
        ctx.stroke();
      }
    }

    for (const handle of step.handles) {
      if (handle.chained) continue;
      const screen = project(view, mirror, handle.poseIn);
      const hovered = sameTargetAs(hover, step.stepId, handle.target);
      const selected = isPointSelected(selection, { stepId: step.stepId, point: handle.target });
      const nodeIndex = handle.target.pointKind === "from" ? handle.target.segmentIndex : handle.target.segmentIndex + 1;
      const node = step.nodes.find((candidate) => candidate.index === nodeIndex);
      const smooth = node !== undefined && effectiveNodeKind(input.nodeKinds, step.stepId, node) === "smooth";
      const sizePx = hovered ? NODE_HOVER_PX : NODE_PX;
      ctx.beginPath();
      if (smooth) ctx.arc(screen.xPx, screen.yPx, sizePx / 2, 0, Math.PI * 2);
      else squarePath(ctx, screen, sizePx);
      ctx.fillStyle = theme.handleEndpoint;
      ctx.fill();
      // A dark 1 px keyline, so a white handle still reads over a white path or a light tile.
      ctx.strokeStyle = theme.bgCanvas;
      ctx.stroke();
      if (selected) {
        const ring = sizePx + SELECTED_RING_GAP_PX * 2 + 2;
        ctx.beginPath();
        if (smooth) ctx.arc(screen.xPx, screen.yPx, ring / 2, 0, Math.PI * 2);
        else squarePath(ctx, screen, ring);
        ctx.strokeStyle = theme.handleEndpoint;
        ctx.stroke();
      }
    }
  }
};

/** The robot outline at a pose: the body, every mouth, and a heading tick. */
/** A filled or hollow arrow head with its point at `tip`, pointing along `angle`. */
function arrowHead(ctx: CanvasRenderingContext2D, tip: ScreenVec, angle: number, sizePx: number): void {
  const back = { xPx: tip.xPx - Math.cos(angle) * sizePx, yPx: tip.yPx - Math.sin(angle) * sizePx };
  const spread = sizePx * 0.55;
  const nx = -Math.sin(angle) * spread;
  const ny = Math.cos(angle) * spread;
  ctx.beginPath();
  ctx.moveTo(tip.xPx, tip.yPx);
  ctx.lineTo(back.xPx + nx, back.yPx + ny);
  ctx.lineTo(back.xPx - nx, back.yPx - ny);
  ctx.closePath();
}

/**
 * The heading handles and range boundaries of the steps whose handles show (spec 11 sections 3 and
 * 3a). Drawn after the point handles, so an arrow that crosses a point stays readable, and in the
 * heading colour only, so none of it can be mistaken for a point you can move.
 */
const drawHeadingHandles: Painter = (ctx, input) => {
  const { view, mirror, theme, selection, hover } = input;
  const withHandles = stepsWithHandles(selection);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const step of input.scene.steps) {
    if (!withHandles.has(step.stepId)) continue;
    const handles = headingHandlesFor(step, step.heading);
    const activeKey =
      input.activeHeadingHandle?.stepId === step.stepId
        ? input.activeHeadingHandle.key
        : hover?.stepId === step.stepId
          ? hover.headingHandle
          : undefined;
    const active = activeKey === undefined ? undefined : handles.find((handle) => handle.key === activeKey);
    const lit = new Set(active === undefined ? [] : linkedKeys(handles, active));

    // A Constant's two arrows are one angle: while either is hovered or turned, a dashed line joins
    // their tips so the link is visible.
    if (active?.linked === true) {
      const pair = handles.filter((handle) => lit.has(handle.key));
      if (pair.length === 2) {
        const a = headingHandleScreen(view, mirror, pair[0] as HeadingHandle).tip;
        const b = headingHandleScreen(view, mirror, pair[1] as HeadingHandle).tip;
        ctx.strokeStyle = theme.handleHeading;
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(a.xPx, a.yPx);
        ctx.lineTo(b.xPx, b.yPx);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
    }

    for (const handle of handles) {
      const hovered = lit.has(handle.key);
      const { base, tip, angle } = headingHandleScreen(view, mirror, handle);
      ctx.strokeStyle = theme.handleHeading;
      ctx.fillStyle = theme.handleHeading;
      if (handle.role === "point") {
        // Sight lines from the ends of its stretch, so the point reads as what the robot faces.
        const ends = handles.filter(
          (other) => other.rangeIndex === handle.rangeIndex && other.role !== "point",
        );
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        for (const end of ends) {
          const from = headingHandleScreen(view, mirror, end).base;
          ctx.beginPath();
          ctx.moveTo(from.xPx, from.yPx);
          ctx.lineTo(tip.xPx, tip.yPx);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        const radius = hovered ? FACE_POINT_R_PX + 1 : FACE_POINT_R_PX;
        ctx.beginPath();
        ctx.arc(tip.xPx, tip.yPx, radius, 0, Math.PI * 2);
        ctx.fillStyle = hovered ? theme.handleHeading : theme.bgCanvas;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(tip.xPx - radius - 3, tip.yPx);
        ctx.lineTo(tip.xPx + radius + 3, tip.yPx);
        ctx.moveTo(tip.xPx, tip.yPx - radius - 3);
        ctx.lineTo(tip.xPx, tip.yPx + radius + 3);
        ctx.lineWidth = 1;
        ctx.stroke();
        continue;
      }

      const head = hovered ? ARROW_HEAD_HOVER_PX : ARROW_HEAD_PX;
      const shaftEnd = { xPx: tip.xPx - Math.cos(angle) * head * 0.8, yPx: tip.yPx - Math.sin(angle) * head * 0.8 };
      ctx.globalAlpha = handle.editable ? 1 : 0.6;
      ctx.lineWidth = handle.editable ? (hovered ? 2 : 1.5) : 1;
      if (!handle.editable) ctx.setLineDash([3, 2]);
      ctx.beginPath();
      ctx.moveTo(base.xPx, base.yPx);
      ctx.lineTo(shaftEnd.xPx, shaftEnd.yPx);
      ctx.stroke();
      ctx.setLineDash([]);
      arrowHead(ctx, tip, angle, head);
      if (handle.editable) {
        ctx.fill();
      } else {
        ctx.fillStyle = theme.bgCanvas;
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      // A linked arrow carries a small ring at its base: the two ends of a Constant are one value.
      if (handle.linked) {
        ctx.beginPath();
        ctx.arc(base.xPx, base.yPx, 2.5, 0, Math.PI * 2);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    for (const boundary of rangeBoundariesFor(step, step.heading)) {
      const { at, angle } = boundaryScreen(view, mirror, boundary);
      const hovered = hover?.stepId === step.stepId && hover.rangeBoundary === boundary.index;
      const reach = hovered ? BOUNDARY_TICK_PX + 2 : BOUNDARY_TICK_PX;
      const nx = -Math.sin(angle);
      const ny = Math.cos(angle);
      ctx.strokeStyle = theme.bgCanvas;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(at.xPx - nx * reach, at.yPx - ny * reach);
      ctx.lineTo(at.xPx + nx * reach, at.yPx + ny * reach);
      ctx.stroke();
      ctx.strokeStyle = theme.handleHeading;
      ctx.lineWidth = hovered ? 2.5 : 2;
      ctx.stroke();
    }
  }
};

function drawRobotAt(ctx: CanvasRenderingContext2D, input: LiveLayerInput, poseIn: Pose, widthPx: number): void {
  const { view, mirror, theme } = input;
  const footprint = footprintAt(poseIn, input.robot, "expandedIn");
  ctx.strokeStyle = theme.robotOutline;
  ctx.lineWidth = widthPx;
  ctx.lineJoin = "miter";
  tracePolygon(ctx, view, mirror, footprint.bodyIn);
  ctx.fillStyle = theme.robotOutlineFill;
  ctx.fill();
  ctx.stroke();
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = 1;
  for (const mouth of footprint.mouthsIn) {
    tracePolygon(ctx, view, mirror, mouth);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // The heading tick: from the centre out through the front edge, in the annotation colour.
  const front = footprint.bodyIn;
  const a = front[0];
  const b = front[3];
  if (a === undefined || b === undefined) return;
  const centre = project(view, mirror, poseIn);
  const mid = project(view, mirror, { xIn: (a.xIn + b.xIn) / 2, yIn: (a.yIn + b.yIn) / 2 });
  const angle = headingToScreenAngle(view, mirrorHeadingRad(poseIn.headingRad, mirror));
  ctx.strokeStyle = theme.canvasAnnotation;
  ctx.lineWidth = 1.5;
  ctx.lineCap = "butt";
  ctx.beginPath();
  ctx.moveTo(centre.xPx, centre.yPx);
  ctx.lineTo(mid.xPx + Math.cos(angle) * 6, mid.yPx + Math.sin(angle) * 6);
  ctx.stroke();
}

const drawRobot: Painter = (ctx, input) => {
  const robot = input.robotPose;
  if (robot !== null) {
    drawRobotAt(ctx, input, robot.poseIn, 1.5);
    if (robot.label !== undefined && robot.label !== null) drawRobotLabel(ctx, input, robot.poseIn, robot.label);
  }
  const marker = input.traceMarker;
  if (marker !== null) {
    const { theme } = input;
    ctx.strokeStyle = theme.pathActual;
    ctx.fillStyle = theme.pathActual;
    ctx.lineWidth = 1;
    poseMark(ctx, input, marker, true);
  }
};

/** The playback level's name, small, just below the robot outline, so the pose says where it is from. */
function drawRobotLabel(ctx: CanvasRenderingContext2D, input: LiveLayerInput, poseIn: Pose, label: string): void {
  const { view, mirror, theme } = input;
  const footprint = footprintAt(poseIn, input.robot, "expandedIn");
  let bottomPx = -Infinity;
  let sumXPx = 0;
  for (const corner of footprint.bodyIn) {
    const screen = project(view, mirror, corner);
    bottomPx = Math.max(bottomPx, screen.yPx);
    sumXPx += screen.xPx;
  }
  const count = footprint.bodyIn.length;
  if (count === 0) return;
  ctx.font = `10px ${theme.fontMono}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  // A keyline in the canvas background, so the label reads over the field picture and the paths.
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  ctx.strokeStyle = theme.bgCanvas;
  ctx.strokeText(label, Math.round(sumXPx / count), Math.round(bottomPx + 4));
  ctx.fillStyle = theme.canvasAnnotation;
  ctx.fillText(label, Math.round(sumXPx / count), Math.round(bottomPx + 4));
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

/** The ideal robot's straight transitions across a gap between steps: thin and dashed. */
const drawTransitions: Painter = (ctx, input) => {
  const transitions = input.transitions;
  if (transitions === undefined || transitions.length === 0) return;
  const { view, mirror, theme } = input;
  ctx.strokeStyle = theme.canvasAnnotation;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 4]);
  for (const transition of transitions) {
    const from = project(view, mirror, transition.fromIn);
    const to = project(view, mirror, transition.toIn);
    if (Math.hypot(to.xPx - from.xPx, to.yPx - from.yPx) < 1) continue;
    ctx.beginPath();
    ctx.moveTo(from.xPx, from.yPx);
    ctx.lineTo(to.xPx, to.yPx);
    ctx.stroke();
  }
  ctx.setLineDash([]);
};

const drawRubberBand: Painter = (ctx, input) => {
  const band = input.rubberBand;
  if (band === null) return;
  const { view, mirror, theme } = input;
  const from = project(view, mirror, band.fromIn);
  const to = project(view, mirror, band.toIn);
  ctx.strokeStyle = theme.snapGuide;
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(from.xPx, from.yPx);
  ctx.lineTo(to.xPx, to.yPx);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(to.xPx, to.yPx, 3, 0, Math.PI * 2);
  ctx.stroke();
};

const drawSnapFeedback: Painter = (ctx, input) => {
  const snap = input.snapFeedback;
  if (snap === null || snap.kind === "none" || snap.kind === "grid") return;
  const { view, mirror, theme, bounds } = input;
  ctx.strokeStyle = theme.snapGuide;
  ctx.lineWidth = 1;
  if (snap.kind === "waypoint") {
    const screen = project(view, mirror, snap.pose);
    ctx.beginPath();
    ctx.arc(screen.xPx, screen.yPx, 8, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }
  for (const wall of snap.walls ?? []) {
    const a =
      wall.axis === "x"
        ? project(view, mirror, { xIn: wall.atIn, yIn: bounds.minYIn })
        : project(view, mirror, { xIn: bounds.minXIn, yIn: wall.atIn });
    const b =
      wall.axis === "x"
        ? project(view, mirror, { xIn: wall.atIn, yIn: bounds.maxYIn })
        : project(view, mirror, { xIn: bounds.maxXIn, yIn: wall.atIn });
    ctx.beginPath();
    ctx.moveTo(crisp(a.xPx), crisp(a.yPx));
    ctx.lineTo(crisp(b.xPx), crisp(b.yPx));
    ctx.stroke();
  }
};

const drawMarquee: Painter = (ctx, input) => {
  const rect = input.marquee;
  if (rect === null) return;
  const { theme } = input;
  const x = crisp(rect.minXPx);
  const y = crisp(rect.minYPx);
  const w = Math.round(rect.maxXPx - rect.minXPx);
  const h = Math.round(rect.maxYPx - rect.minYPx);
  ctx.globalAlpha = 0.06;
  ctx.fillStyle = theme.snapGuide;
  ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = theme.snapGuide;
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
};

/** An opaque bordered chip: anything floating over the canvas is opaque (UI_GUIDE anti-pattern 2). */
function chip(ctx: CanvasRenderingContext2D, theme: CanvasTheme, xPx: number, yPx: number, widthPx: number, heightPx: number): void {
  const x = Math.round(xPx);
  const y = Math.round(yPx);
  const w = Math.round(widthPx);
  const h = Math.round(heightPx);
  ctx.beginPath();
  ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, CHIP_RADIUS_PX);
  ctx.fillStyle = theme.bgRaised;
  ctx.fill();
  ctx.strokeStyle = theme.borderDefault;
  ctx.lineWidth = 1;
  ctx.stroke();
}

const BUBBLE_LINE_PX = 15;
const BUBBLE_PAD_X_PX = 7;
const BUBBLE_PAD_Y_PX = 4;
const BUBBLE_OFFSET_PX = 12;
const CHIP_RADIUS_PX = 3;

/** A chip of lines near a screen point, flipped to stay inside the canvas. */
function drawChipAt(
  ctx: CanvasRenderingContext2D,
  input: LiveLayerInput,
  anchorXPx: number,
  anchorYPx: number,
  lines: readonly string[],
  noteColour: string,
): void {
  const { theme } = input;
  if (lines.length === 0) return;
  const mono = `11px ${theme.fontMono}`;
  const ui = `11px ${theme.fontUi}`;
  let widthPx = 0;
  for (const [index, line] of lines.entries()) {
    ctx.font = index === 0 ? mono : ui;
    widthPx = Math.max(widthPx, ctx.measureText(line).width);
  }
  widthPx += BUBBLE_PAD_X_PX * 2;
  const heightPx = lines.length * BUBBLE_LINE_PX + BUBBLE_PAD_Y_PX * 2;
  let x = anchorXPx + BUBBLE_OFFSET_PX;
  let y = anchorYPx + BUBBLE_OFFSET_PX;
  if (x + widthPx > input.widthPx - 4) x = anchorXPx - BUBBLE_OFFSET_PX - widthPx;
  if (y + heightPx > input.heightPx - 4) y = anchorYPx - BUBBLE_OFFSET_PX - heightPx;
  x = Math.max(4, x);
  y = Math.max(4, y);
  chip(ctx, theme, x, y, widthPx, heightPx);
  ctx.textBaseline = "middle";
  for (const [index, line] of lines.entries()) {
    ctx.font = index === 0 ? mono : ui;
    ctx.fillStyle = index === 0 ? theme.textHi : noteColour;
    ctx.fillText(line, Math.round(x + BUBBLE_PAD_X_PX), Math.round(y + BUBBLE_PAD_Y_PX + BUBBLE_LINE_PX * (index + 0.5)));
  }
}

const drawMeasurement: Painter = (ctx, input) => {
  const measurement = input.measurement;
  if (measurement === null) return;
  const { view, mirror, theme } = input;
  const a = project(view, mirror, measurement.fromIn);
  const b = project(view, mirror, measurement.toIn);
  ctx.strokeStyle = theme.canvasAnnotation;
  ctx.fillStyle = theme.canvasAnnotation;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(a.xPx, a.yPx);
  ctx.lineTo(b.xPx, b.yPx);
  ctx.stroke();
  // End ticks across the line, the way a dimension is drawn.
  const length = Math.hypot(b.xPx - a.xPx, b.yPx - a.yPx);
  if (length > 1e-6) {
    const nx = -(b.yPx - a.yPx) / length;
    const ny = (b.xPx - a.xPx) / length;
    ctx.beginPath();
    for (const end of [a, b]) {
      ctx.moveTo(end.xPx - nx * 5, end.yPx - ny * 5);
      ctx.lineTo(end.xPx + nx * 5, end.yPx + ny * 5);
    }
    ctx.stroke();
    // The protractor: a short reference along field +X and the arc from it to the line.
    const zero = project(view, mirror, { xIn: measurement.fromIn.xIn + 1, yIn: measurement.fromIn.yIn });
    const zeroAngle = Math.atan2(zero.yPx - a.yPx, zero.xPx - a.xPx);
    const lineAngle = Math.atan2(b.yPx - a.yPx, b.xPx - a.xPx);
    const radius = Math.min(28, length * 0.6);
    ctx.globalAlpha = 0.6;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(a.xPx, a.yPx);
    ctx.lineTo(a.xPx + Math.cos(zeroAngle) * (radius + 8), a.yPx + Math.sin(zeroAngle) * (radius + 8));
    ctx.stroke();
    ctx.setLineDash([]);
    let sweep = lineAngle - zeroAngle;
    while (sweep > Math.PI) sweep -= Math.PI * 2;
    while (sweep < -Math.PI) sweep += Math.PI * 2;
    ctx.beginPath();
    ctx.arc(a.xPx, a.yPx, radius, zeroAngle, zeroAngle + sweep, sweep < 0);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  const readout = measure(measurement);
  drawChipAt(ctx, input, (a.xPx + b.xPx) / 2, (a.yPx + b.yPx) / 2, [measureLabel(readout), measureDeltaLabel(readout)], theme.textMid);
};

const drawBubble: Painter = (ctx, input) => {
  const bubble = input.bubble;
  if (bubble === null) return;
  drawChipAt(ctx, input, bubble.xPx, bubble.yPx, bubble.lines, input.theme.canvasAnnotation);
};

const drawReadout: Painter = (ctx, input) => {
  const { theme, readout } = input;
  // Bare mono text at the well's bottom-left corner, not a boxed widget (UI_GUIDE 9.11).
  const heightPx = 22;
  const xPx = OVERLAY_PAD_PX;
  const yPx = input.heightPx - OVERLAY_PAD_PX - heightPx;

  ctx.textBaseline = "middle";
  const midY = Math.round(yPx + heightPx / 2);
  let cursor = xPx;
  const put = (text: string, colour: string, font: string): void => {
    ctx.font = font;
    ctx.fillStyle = colour;
    ctx.fillText(text, Math.round(cursor), midY);
    cursor += ctx.measureText(text).width;
  };
  const mono = `11px ${theme.fontMono}`;
  const label = `11px ${theme.fontUi}`;
  const fixed = (value: number, places: number): string => value.toFixed(places);

  put("x ", theme.textLo, mono);
  put(readout.pointIn === null ? "—" : fixed(readout.pointIn.xIn, 2), theme.textLo, mono);
  put("  y ", theme.textLo, mono);
  put(readout.pointIn === null ? "—" : fixed(readout.pointIn.yIn, 2), theme.textLo, mono);
  put(" in  h ", theme.textLo, mono);
  put(readout.headingRad === null ? "—" : fixed(radToDeg(readout.headingRad), 1), theme.textLo, mono);
  put("°", theme.textLo, mono);
  // text-lo like the rest of the readout: it sits on the well, where the light-field ink's darker
  // annotation blue would not read, and the drag bubble already carries the snap in colour.
  if (readout.snapLabel !== null) put(`  ${readout.snapLabel}`, theme.textLo, label);
};

const drawScaleBar: Painter = (ctx, input) => {
  const { theme, view } = input;
  const inches = scaleBarInches(view.pxPerIn, 140);
  const barPx = Math.round(inches * view.pxPerIn);
  // Bare, like the readout: a 1 px bar and its length in text-lo at the bottom-right corner.
  const heightPx = 22;
  ctx.font = `11px ${theme.fontMono}`;
  const text = `${String(inches)} in`;
  const widthPx = barPx + 8 + ctx.measureText(text).width;
  const xPx = input.widthPx - OVERLAY_PAD_PX - widthPx;
  const yPx = input.heightPx - OVERLAY_PAD_PX - heightPx;

  const barY = crisp(yPx + heightPx / 2);
  const barX = crisp(xPx);
  ctx.strokeStyle = theme.textLo;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(barX, barY - 4);
  ctx.lineTo(barX, barY + 4);
  ctx.moveTo(barX, barY);
  ctx.lineTo(barX + barPx, barY);
  ctx.moveTo(barX + barPx, barY - 4);
  ctx.lineTo(barX + barPx, barY + 4);
  ctx.stroke();

  ctx.textBaseline = "middle";
  ctx.fillStyle = theme.textLo;
  ctx.fillText(text, barX + barPx + 8, barY);
};

/** The field picture's credit, small, above the scale bar. */
const drawCredit: Painter = (ctx, input) => {
  if (input.credit === null) return;
  const { theme } = input;
  ctx.font = `10px ${theme.fontUi}`;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "right";
  ctx.fillStyle = theme.textLo;
  ctx.fillText(input.credit, input.widthPx - OVERLAY_PAD_PX, input.heightPx - OVERLAY_PAD_PX - 22 - 2);
  ctx.textAlign = "left";
};

const PAINTERS: Painter[] = [
  drawFindingGeometry,
  drawBasePaths,
  drawPaths,
  drawTrace,
  drawTransitions,
  drawStartEnd,
  drawRobot,
  drawStepLabels,
  drawMarkers,
  drawHandles,
  drawHeadingHandles,
  drawRubberBand,
  drawSnapFeedback,
  drawMeasurement,
  drawMarquee,
  drawReadout,
  drawScaleBar,
  drawCredit,
  drawBubble,
];

export function drawLive(ctx: CanvasRenderingContext2D, input: LiveLayerInput): void {
  for (const painter of PAINTERS) {
    ctx.save();
    painter(ctx, input);
    ctx.restore();
  }
}

/**
 * The same scene in screen pixels, for hit testing. Every path's endpoints are listed, selected or
 * not, so a press on any step's dot drags it at once; an unselected step's dots are drawn as soon as
 * the pointer is over the step (`revealStepId`), which it always is before it can press one. Control
 * points, heading handles and range boundaries are listed only where they are drawn (the selected
 * step, any step with a selected point, and the step being revealed), because nothing invisible may
 * be grabbable. A `"current"` start is the previous step's end and is never listed on its own.
 */
export function projectHitScene(
  scene: Scene,
  view: View,
  mirror: MirrorMode,
  selection: Selection,
  revealStepId: string | null = null,
): HitScene {
  const handles: HandleEntry[] = [];
  const markers: MarkerEntry[] = [];
  const polylines: PolylineEntry[] = [];
  const headingHandles: HeadingHandleEntry[] = [];
  const boundaries: BoundaryEntry[] = [];
  const withHandles = stepsWithHandles(selection);

  for (const [stepIndex, step] of scene.steps.entries()) {
    const selected = withHandles.has(step.stepId);
    const rank = handleRank(stepIndex, selected);
    const xsPx: number[] = [];
    const ysPx: number[] = [];
    for (const pose of step.poses) {
      const screen = project(view, mirror, pose);
      xsPx.push(screen.xPx);
      ysPx.push(screen.yPx);
    }
    polylines.push({ stepId: step.stepId, xsPx, ysPx, ts: step.ts });

    for (const marker of step.markers) {
      const screen = project(view, mirror, marker.pointIn);
      markers.push({ stepId: step.stepId, markerIndex: marker.markerIndex, xPx: screen.xPx, yPx: screen.yPx });
    }

    for (const handle of step.handles) {
      if (handle.chained) continue;
      const screen = project(view, mirror, handle.poseIn);
      handles.push({ stepId: step.stepId, point: handle.target, xPx: screen.xPx, yPx: screen.yPx, rank });
    }
    if (selected || step.stepId === revealStepId) {
      for (const control of step.controls) {
        const screen = project(view, mirror, control.pointIn);
        handles.push({ stepId: step.stepId, point: control.target, xPx: screen.xPx, yPx: screen.yPx, rank });
      }
    }
    if (!selected) continue;
    headingHandles.push(...projectHeadingHandlesOf(step, view, mirror));
    for (const boundary of rangeBoundariesFor(step, step.heading)) {
      const { at } = boundaryScreen(view, mirror, boundary);
      boundaries.push({ stepId: step.stepId, index: boundary.index, xPx: at.xPx, yPx: at.yPx });
    }
  }

  return { handles, markers, polylines, knobs: [], headingHandles, boundaries };
}

/** One step's heading handles at their grab points: an arrow's tip, or a facing point itself. */
function projectHeadingHandlesOf(step: SceneStep, view: View, mirror: MirrorMode): HeadingHandleEntry[] {
  return headingHandlesFor(step, step.heading).map((handle) => {
    const { tip } = headingHandleScreen(view, mirror, handle);
    return { stepId: step.stepId, key: handle.key, editable: handle.editable, xPx: tip.xPx, yPx: tip.yPx };
  });
}

/** The heading handles of the steps whose handles show, which the heading tool picks from. */
export function projectHeadingHandles(scene: Scene, view: View, mirror: MirrorMode, selection: Selection): HeadingHandleEntry[] {
  const withHandles = stepsWithHandles(selection);
  const out: HeadingHandleEntry[] = [];
  for (const step of scene.steps) {
    if (withHandles.has(step.stepId)) out.push(...projectHeadingHandlesOf(step, view, mirror));
  }
  return out;
}

/**
 * What a marquee can select: every path endpoint on the field (not only the selected step's, so a
 * box can gather points across steps) and the control points of the steps whose handles show.
 */
export function projectMarqueeCandidates(scene: Scene, view: View, mirror: MirrorMode, selection: Selection): MarqueeCandidate[] {
  const withHandles = stepsWithHandles(selection);
  const out: MarqueeCandidate[] = [];
  for (const step of scene.steps) {
    for (const handle of step.handles) {
      if (handle.chained) continue;
      const screen = project(view, mirror, handle.poseIn);
      out.push({ stepId: step.stepId, point: handle.target, xPx: screen.xPx, yPx: screen.yPx });
    }
    if (!withHandles.has(step.stepId)) continue;
    for (const control of step.controls) {
      const screen = project(view, mirror, control.pointIn);
      out.push({ stepId: step.stepId, point: control.target, xPx: screen.xPx, yPx: screen.yPx });
    }
  }
  return out;
}
