/**
 * The live layer: everything that moves. Drawn over the cached static field once per animation
 * frame while the pointer is down, and once per prop change otherwise.
 *
 * The look is a CAD tool's, not a dashboard's (site/docs/editor.md): 1 px
 * hairlines, hollow handles that fill when selected, square corner nodes and round smooth nodes,
 * no gradients, glows or heavy fills, and names only on hover or once zoomed in far enough to read
 * them without crowding. The only robot outline is the one at the playback time or under the
 * cursor (section 1: the footprint ghosts are gone), except the clip ghosts: the robot in red at the
 * worst place a PERIMETER, STRUCTURE or KEEPOUT finding found, which a person can hide, and the one
 * clip ghost of an infeasible Optimize path result. The outline moves onto the Optimize card's
 * proposed route while it is hovered, which is never a second outline.
 *
 * The alliance mirror lives here and nowhere else: when the file is viewed as the other alliance,
 * `mirror` is not `"none"` and every world point is put through that kind of `field.json`'s
 * `frame.mirror` on its way to the screen, and the pointer goes back through the same function on
 * its way out, so the shell only ever sees poses in the file's own alliance frame (finding 22:
 * `mirrorVec`/`mirrorHeadingRad` are `@horizon36596/zenith-core`'s, the same ones `render` uses, not a
 * second hardcoded copy).
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
import type { Robot, Waypoints } from "@horizon36596/zenith-schema";
import { isPoseReset } from "../project/desktopTrace.js";
import { effectiveNodeKind, type NodeKind } from "./bezier.js";
import {
  headingHandlesFor,
  linkedKeys,
  rangeBoundariesFor,
  type HeadingHandle,
  type RangeBoundary,
} from "./headingHandles.js";
import { isCornerHandle, type RectGrab } from "../lib/envelopeRect.js";
import { projectEnvelopeBody, projectEnvelopeHandles } from "./envelopeDrag.js";
import { grownOutlineIn } from "./clearanceOutline.js";
import type { GhostToDraw } from "./clipGhosts.js";
import type { CandidateDrawing } from "./candidate.js";
import { drawFieldCounts, type CountLabel } from "./fieldCounts.js";
import type { LedgerLocation } from "@horizon36596/zenith-core";
import { handleRank, PIN_STEM_PX, type BoundaryEntry, type HandleEntry, type HeadingHandleEntry, type HitScene, type MarkerEntry, type PinEntry, type PolylineEntry } from "./hit.js";
import { pinLabelBoxes, WAYPOINT_LABEL_DX_PX, WAYPOINT_LABEL_DY_PX } from "./staticLayer.js";
import { measure, measureDeltaLabel, measureLabel, type Measurement } from "./measure.js";
import { pointOnRay } from "./modifiers.js";
import type { Scene, SceneStep } from "./scene.js";
import { poseAtT, pointsOnStart } from "./scene.js";
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
/**
 * How far the start's heading knob reaches from the start's centre, in CSS pixels. Twice the hit
 * radius, so the knob's target meets the start mark's own and the pointer can travel from the mark
 * to the knob without the knob disappearing on the way.
 */
export const START_KNOB_PX = 20;
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
  /**
   * `"none"` while the file is viewed as its own alliance; otherwise the field's own `frame.mirror`
   * kind, while it is viewed as the other one.
   */
  mirror: MirrorMode;
  /**
   * The same for review mode's base version, which is in its own file's frame: not the head's when
   * the change flipped the file's alliance. Absent means `mirror`.
   */
  baseMirror?: MirrorMode;
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
  robotPose: {
    poseIn: Pose;
    emphasis: "playback" | "hover";
    label?: string | null;
    /**
     * True while nobody can predict where the robot is (`unknownPosition.ts`, issue #481): it is
     * drawn as a ghost in `--canvas-unknown`, in the partner style, and its label says so.
     */
    unknown?: boolean;
  } | null;
  /**
   * The step whose envelope is drawn in `--canvas-unknown`, hatched in the partner style, because
   * the robot's position is a guess and the envelope's window is open at the playback time. Every
   * other envelope keeps the annotation look. Absent or null: none.
   */
  unknownEnvelopeStepId?: string | null;
  /**
   * The robot's clearance from field elements, in inches, when `display.clearanceOutline` is on
   * (owner ruling D8): the robot outline then also draws its footprint grown by it, faint and
   * dashed. Absent, null or 0 draws nothing.
   */
  clearanceOutlineIn?: number | null;
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
  /** No longer read: envelopes are edited as rectangles (`activeEnvelopeHandle`). */
  activeEnvelopeCorner?: { stepId: string; cornerIndex: number } | null;
  /** The envelope handle being dragged, which draws as hovered for the whole drag. */
  activeEnvelopeHandle?: { stepId: string; grab: RectGrab } | null;
  /**
   * The start's heading knob, drawn on the start mark while the start is a pose of its own and is
   * hovered or selected; `active` while the knob is hovered or being turned. Absent, no knob.
   */
  startKnob?: { active: boolean } | null;
  /**
   * The clip ghosts this frame draws (`clipGhosts.ts` `ghostsToDraw`): the robot where a path
   * leaves the field or runs into a structure or keep-out zone. Absent or empty draws nothing.
   */
  clipGhosts?: readonly GhostToDraw[];
  /**
   * The Optimize card's preview (`candidate.ts`): the proposed route, its joints, the margin round
   * nearby structures, and an infeasible run's clip ghost. Never hit-tested. Absent or null draws
   * nothing.
   */
  candidate?: CandidateDrawing | null;
  /**
   * The ledger's counts at the playback time (`ledgerBadges.ts`), drawn by `fieldCounts.ts`: a chip
   * beside each place that holds pieces, one riding with the robot outline, and a line at the top
   * right for the rest, each split by piece. Absent or empty draws nothing.
   */
  ledgerBadges?: readonly LedgerLocation[];
  /** The routine's alliance, so the count chips list its own nectar before the other's. */
  alliance?: "RED" | "BLUE";
  /** Told the count chips drawn this frame, so the canvas can publish them for tests. */
  onFieldCounts?: (labels: readonly CountLabel[]) => void;
  /**
   * The waypoint pin hovered, selected or being dragged (issue #134), drawn over the static pin in
   * the handle colour, with its heading and its name at any zoom. In `waypoints.json`'s own frame,
   * never mirrored, as the static layer draws the pins. Absent or null draws nothing. `hidden` marks
   * a pin this person hid (issue #236), which is drawn faint and dashed.
   */
  activePin?: { name: string; pose: { xIn: number; yIn: number; headingRad: number }; selected: boolean; hidden?: boolean } | null;
}

/**
 * The waypoint pins in screen pixels for the hit test (issue #134): each spot, and the box of its
 * name where the zoom draws names. `selected` names the selected pin, which takes the press. The
 * boxes are the ones the static layer draws, after it drops names that would overlap (issue #235).
 * A hidden pin (issue #236) is left out, so nothing hovers, presses or right-clicks it, except the
 * selected one, which is still drawn and can still be dragged.
 */
export function projectPins(
  waypoints: Waypoints | null | undefined,
  view: View,
  selected: string | undefined,
  hidden?: ReadonlySet<string>,
): PinEntry[] {
  const labels = pinLabelBoxes(waypoints, view, selected, hidden);
  return Object.entries(waypoints?.waypoints ?? {})
    .filter(([name]) => name === selected || hidden?.has(name) !== true)
    .map(([name, waypoint]) => {
      const at = worldToScreen(view, waypoint);
      return { name, xPx: at.xPx, yPx: at.yPx, label: labels.get(name) ?? null, ...(name === selected ? { selected: true } : {}) };
    });
}

/** The hovered, selected or dragged pin: a ring and stem in the handle colour, a heading tick and its name. */
const drawActivePin: Painter = (ctx, input) => {
  const pin = input.activePin ?? null;
  if (pin === null) return;
  const { view, theme } = input;
  const at = worldToScreen(view, pin.pose);
  const angle = headingToScreenAngle(view, pin.pose.headingRad);
  const radiusPx = pin.selected ? 5 : 4;
  const hidden = pin.hidden === true;
  ctx.save();
  // A hidden pin that is selected or dragged is still drawn, faint and dashed, so it can be found.
  if (hidden) {
    ctx.globalAlpha = HIDDEN_PIN_ALPHA;
    ctx.setLineDash(HIDDEN_PIN_DASH);
  }
  ctx.strokeStyle = theme.handleEndpoint;
  ctx.lineWidth = pin.selected ? 2 : 1.5;
  ctx.beginPath();
  ctx.arc(at.xPx, at.yPx, radiusPx, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(at.xPx, at.yPx - radiusPx);
  ctx.lineTo(at.xPx, at.yPx - PIN_STEM_PX - 2);
  ctx.moveTo(at.xPx + Math.cos(angle) * radiusPx, at.yPx + Math.sin(angle) * radiusPx);
  ctx.lineTo(at.xPx + Math.cos(angle) * (radiusPx + 8), at.yPx + Math.sin(angle) * (radiusPx + 8));
  ctx.stroke();
  ctx.font = `11px ${theme.fontMono}`;
  ctx.textBaseline = "middle";
  ctx.fillStyle = theme.textHi;
  ctx.fillText(pin.name, at.xPx + WAYPOINT_LABEL_DX_PX, at.yPx - WAYPOINT_LABEL_DY_PX);
  ctx.restore();
};

/** How a hidden pin that is selected or dragged is drawn (issue #236): faint, with a short dash. */
const HIDDEN_PIN_ALPHA = 0.5;
const HIDDEN_PIN_DASH = [2, 2];

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
  addPolygon(ctx, view, mirror, corners);
}

/** A closed polygon added to the current path, so many can be filled or stroked in one call. */
function addPolygon(ctx: CanvasRenderingContext2D, view: View, mirror: MirrorMode, corners: readonly Vec2[]): void {
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

/**
 * Every finding's geometry, drawn faintly under everything: the legal-approach band included.
 * START_ILLEGAL's outline is the exception, drawn over the robot by `drawStartIllegal`.
 */
const drawFindingGeometry: Painter = (ctx, input) => {
  const { view, mirror, theme } = input;
  for (const finding of input.findings) {
    const geometry = finding.geometry;
    if (geometry === undefined || finding.code === "START_ILLEGAL") continue;
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

/** The gap between an envelope's hatch lines, in screen pixels, at any zoom. */
const ENVELOPE_HATCH_PX = 8;

/**
 * Envelopes (spec 13 section 10), under the paths: a faint fill, 45 degree hatching clipped to the
 * polygon, and a dashed 1 px edge, all in `--canvas-annotation` because an envelope is authored
 * geometry and not field furniture. The selected step's envelope is drawn with a solid edge and a
 * little more ink, so the one being edited in the inspector is the one that stands out.
 */
export const drawEnvelopes: Painter = (ctx, input) => {
  const envelopes = input.scene.envelopes ?? [];
  if (envelopes.length === 0) return;
  const { view, mirror, theme } = input;
  for (const envelope of envelopes) {
    if (envelope.polygonIn.length < 3) continue;
    if (envelope.stepId === input.unknownEnvelopeStepId) {
      drawUnknownEnvelope(ctx, input, envelope.polygonIn);
      continue;
    }
    const selected = input.selection.stepId === envelope.stepId;
    const screen = envelope.polygonIn.map((corner) => project(view, mirror, corner));
    const minX = Math.min(...screen.map((point) => point.xPx));
    const maxX = Math.max(...screen.map((point) => point.xPx));
    const minY = Math.min(...screen.map((point) => point.yPx));
    const maxY = Math.max(...screen.map((point) => point.yPx));

    ctx.save();
    tracePolygon(ctx, view, mirror, envelope.polygonIn);
    ctx.fillStyle = theme.canvasAnnotation;
    ctx.globalAlpha = selected ? 0.1 : 0.05;
    ctx.fill();
    ctx.clip();
    ctx.beginPath();
    const heightPx = maxY - minY;
    for (let offset = 0; offset <= maxX - minX + heightPx; offset += ENVELOPE_HATCH_PX) {
      ctx.moveTo(minX + offset, minY);
      ctx.lineTo(minX + offset - heightPx, maxY);
    }
    ctx.strokeStyle = theme.canvasAnnotation;
    ctx.lineWidth = 1;
    ctx.globalAlpha = selected ? 0.45 : 0.25;
    ctx.stroke();
    ctx.restore();

    tracePolygon(ctx, view, mirror, envelope.polygonIn);
    ctx.strokeStyle = theme.canvasAnnotation;
    ctx.lineWidth = 1;
    ctx.globalAlpha = selected ? 0.9 : 0.6;
    if (!selected) ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
};

/**
 * The envelope of a step whose position is a guess, while its window is open (issue #481): the
 * partner look (`partnerLayer.ts`), a faint fill, hatching and a dashed edge, in `--canvas-unknown`,
 * so your own robot's "somewhere in here" reads the way a partner's does.
 */
function drawUnknownEnvelope(ctx: CanvasRenderingContext2D, input: LiveLayerInput, polygon: readonly Vec2[]): void {
  const { view, mirror, theme } = input;
  const ink = theme.canvasUnknown;
  const screen = polygon.map((corner) => project(view, mirror, corner));
  const minX = Math.min(...screen.map((point) => point.xPx));
  const maxX = Math.max(...screen.map((point) => point.xPx));
  const minY = Math.min(...screen.map((point) => point.yPx));
  const maxY = Math.max(...screen.map((point) => point.yPx));
  ctx.save();
  tracePolygon(ctx, view, mirror, polygon);
  ctx.fillStyle = ink;
  ctx.globalAlpha = 0.06;
  ctx.fill();
  ctx.clip();
  ctx.beginPath();
  const heightPx = maxY - minY;
  for (let offset = 0; offset <= maxX - minX + heightPx; offset += ENVELOPE_HATCH_PX) {
    ctx.moveTo(minX + offset, minY);
    ctx.lineTo(minX + offset - heightPx, maxY);
  }
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.35;
  ctx.stroke();
  ctx.restore();
  tracePolygon(ctx, view, mirror, polygon);
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.7;
  ctx.setLineDash([4, 3]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

/** An envelope corner handle's size, in CSS pixels, at rest and under the pointer. */
const ENVELOPE_CORNER_PX = 9;
const ENVELOPE_CORNER_HOVER_PX = 12;
/** An envelope side handle: a bar along its side, this long and this thick, at rest and hovered. */
const ENVELOPE_SIDE_LONG_PX = 14;
const ENVELOPE_SIDE_SHORT_PX = 5;
const ENVELOPE_SIDE_HOVER_SCALE = 1.3;
/** The `--bg-canvas` keyline round every envelope handle, so it reads on the field picture in either theme. */
const ENVELOPE_HANDLE_KEYLINE_PX = 3;

/**
 * The selected step's envelope handles, in the annotation colour so they never read as a path's
 * square or round dots: a diamond at each corner and a bar across the middle of each side. Each has
 * a `--bg-canvas` keyline so it stands out on the field picture in Night and Day. Drawn after the
 * step labels, so a label never covers one, and under the path handles, which win a press where the
 * two overlap (`hit.ts`). The handle under the pointer, or being dragged, is drawn larger and
 * filled; dragging the whole envelope fills all of them.
 */
export const drawEnvelopeHandles: Painter = (ctx, input) => {
  const { view, mirror, theme, hover } = input;
  const handles = projectEnvelopeHandles(input.scene, view, mirror, input.selection);
  if (handles.length === 0) return;
  const active = input.activeEnvelopeHandle ?? null;
  const corners = handles.filter((entry) => isCornerHandle(entry.handle));
  const centreX = corners.reduce((sum, entry) => sum + entry.xPx, 0) / corners.length;
  const centreY = corners.reduce((sum, entry) => sum + entry.yPx, 0) / corners.length;
  for (const entry of handles) {
    const hovered =
      (hover?.stepId === entry.stepId && hover.envelopeHandle === entry.handle) ||
      (active?.stepId === entry.stepId && (active.grab === entry.handle || active.grab === "move"));
    ctx.beginPath();
    if (isCornerHandle(entry.handle)) {
      const half = (hovered ? ENVELOPE_CORNER_HOVER_PX : ENVELOPE_CORNER_PX) / 2;
      ctx.moveTo(entry.xPx, entry.yPx - half);
      ctx.lineTo(entry.xPx + half, entry.yPx);
      ctx.lineTo(entry.xPx, entry.yPx + half);
      ctx.lineTo(entry.xPx - half, entry.yPx);
      ctx.closePath();
    } else {
      // A side handle lies along its side: across the screen's x for a side above or below the
      // centre, across its y for one to the left or right, whichever way the view is turned.
      const scale = hovered ? ENVELOPE_SIDE_HOVER_SCALE : 1;
      const along = ENVELOPE_SIDE_LONG_PX * scale;
      const across = ENVELOPE_SIDE_SHORT_PX * scale;
      const horizontal = Math.abs(entry.yPx - centreY) >= Math.abs(entry.xPx - centreX);
      const w = horizontal ? along : across;
      const h = horizontal ? across : along;
      ctx.rect(entry.xPx - w / 2, entry.yPx - h / 2, w, h);
    }
    ctx.globalAlpha = 1;
    ctx.lineWidth = ENVELOPE_HANDLE_KEYLINE_PX;
    ctx.strokeStyle = theme.bgCanvas;
    ctx.stroke();
    ctx.fillStyle = hovered ? theme.canvasAnnotation : theme.bgCanvas;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = theme.canvasAnnotation;
    ctx.stroke();
  }
  ctx.lineWidth = 1;
};
/**
 * The clip ghosts (`clipGhosts.ts`): a translucent robot in the finding's severity colour (red for
 * PERIMETER and STRUCTURE) at the worst pose along the path, with the polygon that actually clips
 * drawn heavier and a tick from the centre to the front edge. Drawn under the paths so the path
 * stays legible through it. Every ghost of a severity goes into one path, filled once and stroked
 * once, so forty ghosts cost a handful of canvas calls; the hovered one is drawn again on top.
 */
export function drawClipGhosts(ctx: CanvasRenderingContext2D, input: LiveLayerInput): void {
  const ghosts = input.clipGhosts;
  if (ghosts === undefined || ghosts.length === 0) return;
  const { view, mirror, theme } = input;
  ctx.lineJoin = "miter";
  ctx.lineCap = "butt";

  const pass = (entries: readonly GhostToDraw[], hovered: boolean): void => {
    for (const severity of ["error", "warning", "info"] as const) {
      const mine = entries.filter((entry) => entry.ghost.severity === severity);
      if (mine.length === 0) continue;
      const colour = severity === "error" ? theme.sevError : theme.sevWarn;
      ctx.fillStyle = colour;
      ctx.strokeStyle = colour;

      ctx.beginPath();
      for (const { ghost } of mine) {
        for (const polygon of ghost.polygonsIn) addPolygon(ctx, view, mirror, polygon);
      }
      ctx.globalAlpha = hovered ? 0.32 : 0.14;
      ctx.fill();
      ctx.globalAlpha = hovered ? 0.9 : 0.55;
      ctx.lineWidth = 1;
      ctx.setLineDash(hovered ? [] : [4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);

      // The offending polygon and the heading tick, solid.
      ctx.beginPath();
      for (const { ghost } of mine) {
        const worst = ghost.polygonsIn[ghost.worstIndex];
        if (worst !== undefined) addPolygon(ctx, view, mirror, worst);
        const body = ghost.polygonsIn[0];
        const a = body?.[0];
        const b = body?.[3];
        if (a === undefined || b === undefined) continue;
        const centre = project(view, mirror, ghost.poseIn);
        const front = project(view, mirror, { xIn: (a.xIn + b.xIn) / 2, yIn: (a.yIn + b.yIn) / 2 });
        ctx.moveTo(centre.xPx, centre.yPx);
        ctx.lineTo(front.xPx, front.yPx);
      }
      ctx.globalAlpha = hovered ? 1 : 0.85;
      ctx.lineWidth = hovered ? 2.5 : 1.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  };

  pass(ghosts.filter((entry) => !entry.hovered), false);
  const hovered = ghosts.filter((entry) => entry.hovered);
  if (hovered.length > 0) pass(hovered, true);

  // The hovered STRUCTURE finding's obstacle, outlined (issue #152): a 1 in bar is a thin line on
  // the field, and the message's name alone does not show which one.
  for (const { ghost } of hovered) {
    if (ghost.obstacle === undefined) continue;
    tracePolygon(ctx, view, mirror, ghost.obstacle.cornersIn);
    const colour = ghost.severity === "error" ? theme.sevError : theme.sevWarn;
    ctx.fillStyle = colour;
    ctx.globalAlpha = 0.25;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = colour;
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.stroke();
  }
  ctx.lineWidth = 1;
}

/**
 * Review mode's base version (06 section 4): the same polylines as the head, in `--path-ghost`,
 * dashed 4 4 and never interactive, so "what it was" sits under "what it becomes".
 */
const drawBasePaths: Painter = (ctx, input) => {
  const base = input.baseScene;
  if (base === null || base === undefined) return;
  const { view, theme } = input;
  const mirror = input.baseMirror ?? input.mirror;
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
function poseMark(ctx: CanvasRenderingContext2D, input: LiveLayerInput, poseIn: Pose, dot: boolean, radiusPx = 4): void {
  const { view, mirror } = input;
  const pose = projectPose(view, mirror, poseIn);
  const centre = worldToScreen(view, pose);
  const angle = headingToScreenAngle(view, pose.headingRad);
  ctx.beginPath();
  ctx.arc(centre.xPx, centre.yPx, radiusPx, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(centre.xPx + Math.cos(angle) * radiusPx, centre.yPx + Math.sin(angle) * radiusPx);
  ctx.lineTo(centre.xPx + Math.cos(angle) * (radiusPx + 7), centre.yPx + Math.sin(angle) * (radiusPx + 7));
  ctx.stroke();
  if (dot) {
    ctx.beginPath();
    ctx.arc(centre.xPx, centre.yPx, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** The START_ILLEGAL finding among `findings`, while the start breaks the season's start rule. */
const startIllegalFinding = (findings: readonly Finding[]): Finding | undefined =>
  findings.find((finding) => finding.code === "START_ILLEGAL");

/**
 * How the start mark is drawn: `"error"`, in the error colour, while START_ILLEGAL stands, and
 * `"normal"` otherwise. The canvas publishes it as `data-start-mark` for tests and bug reports.
 */
export const startMarkTone = (findings: readonly Finding[]): "error" | "normal" =>
  startIllegalFinding(findings) === undefined ? "normal" : "error";

/**
 * The routine's start and end, as small clean marks: no footprint of their own. The start mark can
 * be dragged, so it grows and takes the handle colour while hovered or selected, as a dot does.
 * While START_ILLEGAL stands it is stroked in the error colour instead, hovered or not (issue #155).
 */
const drawStartEnd: Painter = (ctx, input) => {
  const { theme } = input;
  const active = input.hover?.start === true || input.selection.start === true;
  const knob = input.startKnob ?? null;
  const illegal = startMarkTone(input.findings) === "error";
  ctx.strokeStyle = illegal ? theme.sevError : active ? theme.handleEndpoint : theme.fieldWaypoint;
  ctx.lineWidth = 1;
  if (knob === null) poseMark(ctx, input, input.scene.startPose, false, active ? 5 : 4);
  else {
    // The knob replaces the mark's tick: an arrow along the start's heading, in the heading colour
    // and drawn as an editable heading handle is, so it reads as the thing that turns it.
    const radiusPx = active ? 5 : 4;
    const { base, tip, angle } = startKnobScreen(input.view, input.mirror, input.scene.startPose);
    ctx.beginPath();
    ctx.arc(base.xPx, base.yPx, radiusPx, 0, Math.PI * 2);
    ctx.stroke();
    const head = knob.active ? ARROW_HEAD_HOVER_PX : ARROW_HEAD_PX;
    ctx.strokeStyle = theme.handleHeading;
    ctx.fillStyle = theme.handleHeading;
    ctx.lineWidth = knob.active ? 2 : 1.5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(base.xPx + Math.cos(angle) * radiusPx, base.yPx + Math.sin(angle) * radiusPx);
    ctx.lineTo(tip.xPx - Math.cos(angle) * head * 0.8, tip.yPx - Math.sin(angle) * head * 0.8);
    ctx.stroke();
    arrowHead(ctx, tip, angle, head);
    ctx.fill();
  }
  ctx.lineWidth = 1;
  ctx.strokeStyle = theme.fieldWaypoint;
  ctx.fillStyle = theme.fieldWaypoint;
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

/** Where the start's heading knob is drawn and grabbed: its base on the start, its tip along the heading. */
export function startKnobScreen(view: View, mirror: MirrorMode, startIn: Pose): { base: ScreenVec; tip: ScreenVec; angle: number } {
  const pose = projectPose(view, mirror, startIn);
  const base = worldToScreen(view, pose);
  const angle = headingToScreenAngle(view, pose.headingRad);
  return {
    base,
    tip: { xPx: base.xPx + Math.cos(angle) * START_KNOB_PX, yPx: base.yPx + Math.sin(angle) * START_KNOB_PX },
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

/**
 * The robot while its position is a guess (issue #481): the partner style (`partnerLayer.ts`), a
 * faint fill and a 1.5 px edge with the heading tick, all in `--canvas-unknown`, so the drifting
 * ghost reads as "about here" rather than as the planned pose.
 */
function drawUnknownRobotAt(ctx: CanvasRenderingContext2D, input: LiveLayerInput, poseIn: Pose): void {
  const { view, mirror, theme } = input;
  const ink = theme.canvasUnknown;
  const footprint = footprintAt(poseIn, input.robot, "expandedIn");
  tracePolygon(ctx, view, mirror, footprint.bodyIn);
  ctx.fillStyle = ink;
  ctx.globalAlpha = 0.1;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "miter";
  ctx.stroke();
  const centre = project(view, mirror, poseIn);
  const angle = headingToScreenAngle(view, mirrorHeadingRad(poseIn.headingRad, mirror));
  const screen = footprint.bodyIn.map((corner) => project(view, mirror, corner));
  const reachPx = Math.max(...screen.map((point) => Math.hypot(point.xPx - centre.xPx, point.yPx - centre.yPx)));
  ctx.beginPath();
  ctx.moveTo(centre.xPx, centre.yPx);
  ctx.lineTo(centre.xPx + Math.cos(angle) * reachPx * 0.85, centre.yPx + Math.sin(angle) * reachPx * 0.85);
  ctx.lineWidth = 1.5;
  ctx.lineCap = "butt";
  ctx.stroke();
}

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

/** The footprint at `poseIn` grown by the robot's clearance (`clearanceOutline.ts`), faint and dashed. */
function drawClearanceOutline(ctx: CanvasRenderingContext2D, input: LiveLayerInput, poseIn: Pose, clearanceIn: number): void {
  const outline = grownOutlineIn(footprintAt(poseIn, input.robot, "expandedIn").bodyIn, clearanceIn);
  if (outline.length === 0) return;
  ctx.save();
  ctx.strokeStyle = input.theme.robotOutline;
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  tracePolygon(ctx, input.view, input.mirror, outline);
  ctx.stroke();
  ctx.restore();
}

const drawRobot: Painter = (ctx, input) => {
  const robot = input.robotPose;
  if (robot !== null) {
    const clearanceIn = input.clearanceOutlineIn ?? 0;
    if (clearanceIn > 0) drawClearanceOutline(ctx, input, robot.poseIn, clearanceIn);
    if (robot.unknown === true) drawUnknownRobotAt(ctx, input, robot.poseIn);
    else drawRobotAt(ctx, input, robot.poseIn, 1.5);
    if (robot.label !== undefined && robot.label !== null) {
      drawRobotLabel(ctx, input, robot.poseIn, robot.label, robot.unknown === true ? input.theme.canvasUnknown : undefined);
    }
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

/**
 * START_ILLEGAL's outline, the robot's start footprint, in the error colour over the robot outline.
 * At the start of playback the robot stands exactly there, so drawn under it, as other findings'
 * geometry is, the outline was hidden while the start was being dragged off the wall (issue #155).
 */
const drawStartIllegal: Painter = (ctx, input) => {
  const polygon = startIllegalFinding(input.findings)?.geometry?.polygonIn;
  if (polygon === undefined || polygon.length < 2) return;
  const { view, mirror, theme } = input;
  tracePolygon(ctx, view, mirror, polygon);
  ctx.globalAlpha = 0.07;
  ctx.fillStyle = theme.sevError;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = theme.sevError;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.stroke();
  ctx.setLineDash([]);
};

/** The playback level's name, small, just below the robot outline, so the pose says where it is from. */
function drawRobotLabel(
  ctx: CanvasRenderingContext2D,
  input: LiveLayerInput,
  poseIn: Pose,
  label: string,
  ink: string = input.theme.canvasAnnotation,
): void {
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
  ctx.fillStyle = ink;
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
  if (snap === null) return;
  const { view, mirror, theme, bounds } = input;
  ctx.strokeStyle = theme.snapGuide;
  ctx.lineWidth = 1;
  if (snap.ray !== undefined) {
    // Shift holds a path end to this ray from its anchor: drawn from the anchor right across the
    // field, so the line the point can move along is plain to see (modifiers.ts `constrainToRay`).
    const reachIn = 2 * Math.hypot(bounds.maxXIn - bounds.minXIn, bounds.maxYIn - bounds.minYIn);
    const from = project(view, mirror, snap.ray.anchorIn);
    const to = project(view, mirror, pointOnRay(snap.ray, reachIn));
    ctx.beginPath();
    ctx.moveTo(from.xPx, from.yPx);
    ctx.lineTo(to.xPx, to.yPx);
    ctx.stroke();
  }
  if (snap.kind === "none" || snap.kind === "grid") return;
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

/**
 * The widest the corner readout gets without a snap label: both coordinates and the heading at their
 * longest. The scale bar keeps clear of it, so in a narrow well the two never cross (0.1.2 UX sweep,
 * W1-2), and the room does not change as the pointer moves.
 */
const READOUT_WIDEST = "x -000.00  y -000.00 in  h -180.0°";

const drawScaleBar: Painter = (ctx, input) => {
  const { theme, view } = input;
  ctx.font = `11px ${theme.fontMono}`;
  const room =
    input.widthPx - OVERLAY_PAD_PX * 2 - ctx.measureText(READOUT_WIDEST).width - 16 - 8 - ctx.measureText("144 in").width;
  const inches = scaleBarInches(view.pxPerIn, Math.min(140, room));
  const barPx = Math.round(inches * view.pxPerIn);
  // Too narrow a well for even the shortest bar beside the readout: the bar is left out.
  if (barPx > room) return;
  // Bare, like the readout: a 1 px bar and its length in text-lo at the bottom-right corner.
  const heightPx = 22;
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

/** The proposed route's dash and its joint dots (UI_GUIDE 9.11). */
const CANDIDATE_DASH = [6, 4];
const CANDIDATE_JOINT_R_PX = 3;

/**
 * While the Optimize card is open, the margin round each structure the route passes near: a 1 px
 * `--canvas-annotation` hairline, under the paths.
 */
const drawCandidateMargins: Painter = (ctx, input) => {
  const outlines = input.candidate?.marginOutlinesIn ?? [];
  if (outlines.length === 0) return;
  const { view, mirror, theme } = input;
  ctx.beginPath();
  for (const outline of outlines) addPolygon(ctx, view, mirror, outline);
  ctx.strokeStyle = theme.canvasAnnotation;
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = 1;
  ctx.stroke();
};

/**
 * The route Optimize path proposes (`candidate.ts`): `--path-candidate` at the normal width, dashed
 * 6 4, with its joints as dots and no handles, over the paths; and on an infeasible result the
 * closest attempt's worst pose as a clip ghost. Neither is ever hit-tested.
 */
const drawCandidate: Painter = (ctx, input) => {
  const candidate = input.candidate;
  if (candidate === null || candidate === undefined) return;
  const { view, mirror, theme } = input;
  const step = candidate.step;
  if (step !== null) {
    ctx.lineJoin = "round";
    ctx.lineCap = "butt";
    ctx.strokeStyle = theme.pathCandidate;
    ctx.lineWidth = theme.pathWidthNormalPx;
    ctx.setLineDash(CANDIDATE_DASH);
    tracePolyline(ctx, view, mirror, step);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = theme.pathCandidate;
    ctx.beginPath();
    for (const joint of candidate.jointsIn) {
      const at = project(view, mirror, joint);
      ctx.moveTo(at.xPx + CANDIDATE_JOINT_R_PX, at.yPx);
      ctx.arc(at.xPx, at.yPx, CANDIDATE_JOINT_R_PX, 0, Math.PI * 2);
    }
    ctx.fill();
  }
  const ghost = candidate.ghostPoseIn;
  if (ghost !== null) {
    const footprint = footprintAt(ghost, input.robot, "expandedIn");
    ctx.beginPath();
    for (const polygon of [footprint.bodyIn, ...footprint.mouthsIn]) addPolygon(ctx, view, mirror, polygon);
    ctx.fillStyle = theme.sevError;
    ctx.strokeStyle = theme.sevError;
    ctx.globalAlpha = 0.18;
    ctx.fill();
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
};

const PAINTERS: Painter[] = [
  drawEnvelopes,
  drawFindingGeometry,
  drawClipGhosts,
  drawCandidateMargins,
  drawBasePaths,
  drawPaths,
  drawCandidate,
  drawTrace,
  drawTransitions,
  drawStartEnd,
  drawRobot,
  drawStartIllegal,
  // The ledger's count chips (issue #118), over the robot outline so the one riding with it reads.
  (ctx, input) => {
    drawFieldCounts(ctx, input);
  },
  drawStepLabels,
  drawActivePin,
  drawMarkers,
  drawEnvelopeHandles,
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
 * step, any step with a selected point, and the step being revealed), and envelope handles only for
 * the selected step, because nothing invisible may be grabbable. A `"current"` start is the previous
 * step's end and is never listed on its own. The routine's start mark is listed as `start`, so it can
 * be hovered and dragged, and its heading knob as `startKnob`, only while `showStartKnob` says the
 * knob is drawn. With `startDrags`, the canvas can drag the start, so a path's first point that sits
 * on it is marked `onStart`: the mark takes that press, and the start drag carries the point.
 */
export function projectHitScene(
  scene: Scene,
  view: View,
  mirror: MirrorMode,
  selection: Selection,
  revealStepId: string | null = null,
  showStartKnob = false,
  startDrags = false,
): HitScene {
  const handles: HandleEntry[] = [];
  const markers: MarkerEntry[] = [];
  const polylines: PolylineEntry[] = [];
  const headingHandles: HeadingHandleEntry[] = [];
  const boundaries: BoundaryEntry[] = [];
  const withHandles = stepsWithHandles(selection);
  const onStart = new Set(startDrags ? pointsOnStart(scene).map((entry) => entry.stepId) : []);

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
    // A step's line and markers rank as its dots do, so overlapping steps keep the selected one on top (issue #149).
    polylines.push({ stepId: step.stepId, xsPx, ysPx, ts: step.ts, rank });

    for (const marker of step.markers) {
      const screen = project(view, mirror, marker.pointIn);
      markers.push({ stepId: step.stepId, markerIndex: marker.markerIndex, xPx: screen.xPx, yPx: screen.yPx, rank });
    }

    for (const handle of step.handles) {
      if (handle.chained) continue;
      const screen = project(view, mirror, handle.poseIn);
      const entry: HandleEntry = { stepId: step.stepId, point: handle.target, xPx: screen.xPx, yPx: screen.yPx, rank };
      // `pointsOnStart` lists only a step's first point, so the step id says which dot it is.
      if (handle.target.pointKind === "from" && handle.target.segmentIndex === 0 && onStart.has(step.stepId)) {
        entry.onStart = true;
      }
      handles.push(entry);
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

  const envelopeHandles = projectEnvelopeHandles(scene, view, mirror, selection);
  const envelopeBody = projectEnvelopeBody(scene, view, mirror, selection);
  const start = project(view, mirror, scene.startPose);
  const knob = showStartKnob ? startKnobScreen(view, mirror, scene.startPose).tip : null;
  return {
    handles,
    markers,
    polylines,
    knobs: [],
    headingHandles,
    boundaries,
    envelopeCorners: [],
    envelopeHandles,
    envelopeBody,
    start: { xPx: start.xPx, yPx: start.yPx },
    startKnob: knob === null ? null : { xPx: knob.xPx, yPx: knob.yPx },
  };
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
