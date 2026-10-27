/**
 * Drawing, resizing and moving an envelope on the field (spec 13 section 10, issue #120,
 * site/docs/editor.md).
 *
 * An envelope is edited as an axis-aligned rectangle. The selected step's envelope shows a handle
 * at each corner and at the middle of each side: a corner moves its two sides and keeps the
 * opposite corner where it was, a side handle (or a press anywhere along that side) moves that side
 * alone, and a press inside the rectangle moves all of it. Drawing a new one is a drag from one
 * corner to the opposite. The rectangle math is `lib/envelopeRect.ts`.
 *
 * Every dragged corner or side follows the rules of a Bezier control point, because it is a place
 * on the field and not a robot pose: the waypoint and half-inch grid snaps apply, the wall rule
 * does not, `Ctrl` flips the snap toggle and `Alt` drops the grid. `Shift` keeps a corner's aspect
 * ratio, draws a square, and keeps a move on one axis. Each frame is written through the shell's
 * `onSetEnvelopePolygon` (or `onDrawEnvelope`), inside the canvas's `onDragStart` and `onDragEnd`,
 * so a whole drag is one undo step.
 *
 * An envelope that is not a rectangle (a file written by hand or by an agent) is drawn as it is and
 * has no handles here: the inspector offers to turn it into its bounding rectangle.
 *
 * Pure: the caller projects the scene and supplies the modifiers and the snap context, so the
 * projection, the drag and the readout are unit-tested without a canvas.
 */
import { mirrorVec, type MirrorMode, type Vec2 } from "@horizon36596/zenith-core";
import {
  RECT_HANDLES,
  handlePoint,
  isCornerHandle,
  isRectangle,
  moveRect,
  nearestCorner,
  rectFromCorners,
  rectOfPolygon,
  rectSize,
  resizeRect,
  type Rect,
  type RectGrab,
  type RectHandle,
} from "../lib/envelopeRect.js";
import type { EnvelopeBodyEntry, EnvelopeHandleEntry } from "./hit.js";
import type { DragModifiers } from "./modifiers.js";
import { resolveLeader } from "./pointDrag.js";
import type { Scene, SceneEnvelope } from "./scene.js";
import type { SnapContext, SnapResult } from "./snap.js";
import type { Selection } from "./types.js";
import { worldToScreen, type View } from "./view.js";

/** The envelope a step carries in the scene, or null when it has none. */
export const sceneEnvelopeOf = (scene: Scene, stepId: string): SceneEnvelope | null =>
  scene.envelopes?.find((envelope) => envelope.stepId === stepId) ?? null;

/** A step's envelope as a rectangle, or null when it has none or it is some other polygon. */
export function envelopeRectOf(scene: Scene, stepId: string): Rect | null {
  const envelope = sceneEnvelopeOf(scene, stepId);
  if (envelope === null || !isRectangle(envelope.polygonIn)) return null;
  return rectOfPolygon(envelope.polygonIn);
}

/** The selected step's rectangle envelope, with its step id, or null. */
function selectedRect(scene: Scene, selection: Selection): { stepId: string; rect: Rect } | null {
  const stepId = selection.stepId;
  if (stepId === undefined) return null;
  const rect = envelopeRectOf(scene, stepId);
  return rect === null ? null : { stepId, rect };
}

/**
 * The handles that can be grabbed: the selected step's envelope's four corners and four side
 * midpoints, because an envelope's handles are drawn only while its step is selected and nothing
 * invisible may be grabbable. Mirrored with the routine when it is viewed as the other alliance.
 */
export function projectEnvelopeHandles(
  scene: Scene,
  view: View,
  mirror: MirrorMode,
  selection: Selection,
): EnvelopeHandleEntry[] {
  const selected = selectedRect(scene, selection);
  if (selected === null) return [];
  return RECT_HANDLES.map((handle) => {
    const screen = worldToScreen(view, mirrorVec(handlePoint(selected.rect, handle), mirror));
    return { stepId: selected.stepId, handle, xPx: screen.xPx, yPx: screen.yPx };
  });
}

/**
 * The selected envelope's outline in screen pixels, for a press along a side or inside it. Each
 * side carries the handle that moves it.
 */
export function projectEnvelopeBody(
  scene: Scene,
  view: View,
  mirror: MirrorMode,
  selection: Selection,
): EnvelopeBodyEntry | null {
  const selected = selectedRect(scene, selection);
  if (selected === null) return null;
  const at = (handle: RectHandle) => worldToScreen(view, mirrorVec(handlePoint(selected.rect, handle), mirror));
  const sw = at("sw");
  const se = at("se");
  const ne = at("ne");
  const nw = at("nw");
  return {
    stepId: selected.stepId,
    cornersPx: [sw, se, ne, nw],
    sides: [
      { handle: "s", fromPx: sw, toPx: se },
      { handle: "e", fromPx: se, toPx: ne },
      { handle: "n", fromPx: ne, toPx: nw },
      { handle: "w", fromPx: nw, toPx: sw },
    ],
  };
}

/**
 * The resize cursor for a handle, from the way it faces on screen: the handle's screen position
 * against the rectangle's centre, so a mirrored or rotated view still gets the right arrows.
 */
export function cursorForGrab(grab: RectGrab, handles: readonly EnvelopeHandleEntry[]): string {
  if (grab === "move") return "move";
  const entry = handles.find((candidate) => candidate.handle === grab);
  const corners = handles.filter((candidate) => isCornerHandle(candidate.handle));
  if (entry === undefined || corners.length === 0) return isCornerHandle(grab) ? "nwse-resize" : "ew-resize";
  const centreX = corners.reduce((sum, corner) => sum + corner.xPx, 0) / corners.length;
  const centreY = corners.reduce((sum, corner) => sum + corner.yPx, 0) / corners.length;
  const dx = entry.xPx - centreX;
  const dy = entry.yPx - centreY;
  if (!isCornerHandle(grab)) return Math.abs(dx) >= Math.abs(dy) ? "ew-resize" : "ns-resize";
  // Screen y grows downward: a handle down and to the right (or up and to the left) is nwse.
  return dx * dy >= 0 ? "nwse-resize" : "nesw-resize";
}

export interface EnvelopeRectDrag {
  /** The rectangle this frame, in field inches in the file's own frame. */
  rect: Rect;
  snap: SnapResult | null;
  /** Everything acting on the drag, for the bubble, e.g. "grid 0.5 in · aspect (Shift)". */
  label: string | null;
}

/** The snap context for a corner or side: no robot footprint, so the wall rule never moves one. */
function placeContext(context: SnapContext): SnapContext {
  const out: SnapContext = { ...context, footprintBounds: () => null };
  delete out.bodyBounds;
  return out;
}

/** Shift means something else on an envelope than a point's axis lock, except on a move. */
const withoutAxis = (modifiers: DragModifiers): DragModifiers => ({ ...modifiers, constrainAxis: false });

const join = (...parts: Array<string | null>): string | null => {
  const kept = parts.filter((part): part is string => part !== null);
  return kept.length === 0 ? null : kept.join(" · ");
};

/**
 * One frame of a drag on the selected envelope. `start` is the rectangle at the press, `pressIn`
 * where the press landed and `pointerIn` the pointer now, all in the file's own frame.
 *
 * - A corner or side: the pointer is snapped as a point, then the handle's sides follow it. Shift
 *   keeps a corner's width-to-height ratio.
 * - A move: the rectangle's corner nearest the press is snapped as a point, and the whole
 *   rectangle follows it, so a moved envelope lands on the grid or a waypoint by that corner.
 *   Shift keeps the move on one axis.
 */
export function dragEnvelopeRect(
  start: Rect,
  grab: RectGrab,
  pressIn: Vec2,
  pointerIn: Vec2,
  modifiers: DragModifiers,
  context: SnapContext,
): EnvelopeRectDrag {
  const placed = placeContext(context);
  if (grab === "move") {
    const anchor = nearestCorner(start, pressIn);
    const wanted = { xIn: anchor.xIn + pointerIn.xIn - pressIn.xIn, yIn: anchor.yIn + pointerIn.yIn - pressIn.yIn };
    const result = resolveLeader({ ...anchor, headingRad: 0 }, wanted, modifiers, placed);
    return {
      rect: moveRect(start, result.pose.xIn - anchor.xIn, result.pose.yIn - anchor.yIn),
      snap: result.snap,
      label: result.label,
    };
  }
  const from = handlePoint(start, grab);
  const result = resolveLeader({ ...from, headingRad: 0 }, pointerIn, withoutAxis(modifiers), placed);
  const keepAspect = modifiers.constrainAxis && isCornerHandle(grab);
  return {
    rect: resizeRect(start, grab, result.pose, { keepAspect }),
    snap: result.snap,
    label: join(result.label, keepAspect ? "aspect (Shift)" : null),
  };
}

/**
 * One frame of drawing a new envelope from `fromIn`, the snapped press point, to the pointer: the
 * far corner snaps as a point, and Shift makes it a square.
 */
export function drawEnvelopeRect(
  fromIn: Vec2,
  pointerIn: Vec2,
  modifiers: DragModifiers,
  context: SnapContext,
): EnvelopeRectDrag {
  const result = resolveLeader({ ...fromIn, headingRad: 0 }, pointerIn, withoutAxis(modifiers), placeContext(context));
  let toIn: Vec2 = result.pose;
  if (modifiers.constrainAxis) {
    const dx = toIn.xIn - fromIn.xIn;
    const dy = toIn.yIn - fromIn.yIn;
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    toIn = { xIn: fromIn.xIn + (dx < 0 ? -side : side), yIn: fromIn.yIn + (dy < 0 ? -side : side) };
  }
  return {
    rect: rectFromCorners(fromIn, toIn),
    snap: result.snap,
    label: join(result.label, modifiers.constrainAxis ? "square (Shift)" : null),
  };
}

/** Where a new envelope's first corner goes: the press, snapped as a point. */
export function snapDrawStart(pointerIn: Vec2, modifiers: DragModifiers, context: SnapContext): Vec2 {
  const result = resolveLeader({ ...pointerIn, headingRad: 0 }, pointerIn, withoutAxis(modifiers), placeContext(context));
  return { xIn: result.pose.xIn, yIn: result.pose.yIn };
}

const inches = (value: number): string => value.toFixed(2).replace("-", "−");

const HANDLE_NAME: Readonly<Record<RectHandle, string>> = {
  n: "north side",
  s: "south side",
  e: "east side",
  w: "west side",
  ne: "north-east corner",
  nw: "north-west corner",
  se: "south-east corner",
  sw: "south-west corner",
};

/**
 * The two lines of the bubble beside an envelope handle: the rectangle's corner and size, then
 * which step's envelope and which handle. On hover the second line adds the window and what a drag
 * does; during a drag it says which snap is acting instead, as a point drag's bubble does.
 */
export function envelopeRectLines(
  stepId: string,
  rect: Rect,
  grab: RectGrab | "draw",
  dragging: { label: string | null } | null = null,
  maxDurationS: number | null = null,
): [string, string] {
  const { widthIn, heightIn } = rectSize(rect);
  const position = `x ${inches(rect.minXIn)}  y ${inches(rect.minYIn)}  ${inches(widthIn)} × ${inches(heightIn)} in`;
  const which = `${stepId} · ${grab === "draw" ? "new envelope" : grab === "move" ? "envelope" : `envelope ${HANDLE_NAME[grab]}`}`;
  if (dragging !== null) return [position, `${which} · ${dragging.label ?? "no snap"}`];
  // One decimal, as the inspector shows it: a window taken from an estimate has many more.
  const window = maxDurationS === null ? "" : ` · ${maxDurationS.toFixed(1)} s`;
  return [position, `${which}${window} · drag to ${grab === "move" ? "move" : "resize"}`];
}
