/**
 * Hit testing for the field canvas, in screen space.
 *
 * Priority is heading handles, then point handles, then range boundaries, then envelope handles,
 * then markers, then the path itself, then the selected envelope's sides and inside, because the
 * small thing you are aiming at always sits on top of the big thing it belongs to: a control point
 * drawn on a path must be grabbable without the path stealing the press.
 * Within one tier the nearest wins, and a heading handle or a boundary only beats a point handle
 * when the pointer is nearer to it.
 *
 * Point handles are the one exception to "nearest wins": every path's dots can be grabbed, not
 * only the selected step's, so where dots of two steps overlap the one on top wins, whichever is
 * nearer. On top means the selected step first, then the step drawn last (`HandleEntry.rank`).
 *
 * Markers and path lines are one tier, ranked by the same `handleRank` (issue #149): the selected
 * step's markers, then its line, then other steps' markers, then their lines. Among markers the later
 * step wins, then the nearer; among lines the nearer wins, then the later step, so a later line never
 * beats a nearer earlier one. Where steps share a line, a click keeps the selected step, and Alt+click
 * (`nextStepUnder`) reaches the steps underneath it, in the order a click with no step selected ranks
 * them (`stepsUnder`). It does so only from a press this tier won (`isMarkerOrLineHit`): everything
 * that ranks above the tier keeps the press from Alt+click as it does from a plain click.
 *
 * The routine's start mark sits in the point tier too. A `"current"` start has no dot of its own, so
 * the mark is what the user sees and grabs there; where a dot does sit on it, the dot keeps the
 * press unless the pointer is strictly nearer to the mark, or the dot is a path's first point on the
 * start itself (`HandleEntry.onStart`), which the start drag carries. The start's heading knob,
 * while it is drawn, is in the heading-handle tier, so it wins over the mark where the two targets
 * meet.
 *
 * Waypoint pins (issue #134) are listed only where the shell can move them. A dot or the start mark
 * drawn on a pin keeps the press, as do a heading handle, an envelope handle and a marker: a pin is
 * reached where nothing else sits, on its ring, its stem or its name, and comes just before the path
 * line, so a pin on a path wins over the line: where the marker-and-line tier's winner is a line, a
 * pin under the pointer takes the press from it. The one exception is the selected pin, which takes
 * the press wherever it is drawn, ahead of everything: a pin covered by a dot is selected from the
 * inspector's list of waypoints and then dragged on the field.
 *
 * Pure: the caller projects the scene into screen pixels and this decides what was hit, so the
 * priority order and the polyline projection are unit-tested without a canvas.
 */
import type { RectHandle } from "../lib/envelopeRect.js";
import type { CanvasHit, PointTarget } from "./types.js";

/** Pointer tolerances, in CSS pixels. UI_GUIDE section 8.8 sizes the handle target at 14 px. */
export const HANDLE_HIT_PX = 10;
export const MARKER_HIT_PX = 10;
export const PATH_HIT_PX = 6;
/** How near a side of the selected envelope a press still grabs that side. */
export const ENVELOPE_SIDE_HIT_PX = 6;

export interface HandleEntry {
  stepId: string;
  point: PointTarget;
  xPx: number;
  yPx: number;
  /**
   * Which step's dot is on top where dots overlap: higher wins, and within one rank the nearest
   * wins. `handleRank` gives it; absent counts as 0, so a scene without ranks is nearest-wins.
   */
  rank?: number;
  /**
   * A path's first point that sits on the routine's start, listed only where the start can be
   * dragged (`pointsOnStart` in `scene.ts`). The start mark takes the press from this dot, and a start
   * drag carries the point with it (issue #133).
   */
  onStart?: boolean;
}

/** What `handleRank` adds for a selected step: more than any step index. */
const SELECTED_RANK = 1_000_000;

/**
 * The rank of a step's dots, markers and line: selected steps above all others, then later steps
 * above earlier.
 */
export const handleRank = (stepIndex: number, selected: boolean): number => (selected ? SELECTED_RANK : 0) + stepIndex;

/** The dot on top under the pointer, within the hit radius: the highest rank, then the nearest. */
export function topHandle(entries: readonly HandleEntry[], xPx: number, yPx: number, tolerancePx: number): HandleEntry | null {
  let best: HandleEntry | null = null;
  let bestRank = -Infinity;
  let bestPx = Infinity;
  for (const entry of entries) {
    const distancePx = Math.hypot(entry.xPx - xPx, entry.yPx - yPx);
    if (distancePx > tolerancePx) continue;
    const rank = entry.rank ?? 0;
    if (rank > bestRank || (rank === bestRank && distancePx < bestPx)) {
      best = entry;
      bestRank = rank;
      bestPx = distancePx;
    }
  }
  return best;
}

export interface MarkerEntry {
  stepId: string;
  markerIndex: number;
  xPx: number;
  yPx: number;
  /** The step's `handleRank` (issue #149); absent counts as 0, so a scene without ranks is nearest-wins. */
  rank?: number;
}

/** One path step's drawn polyline, with the arc-length t of every vertex alongside it. */
export interface PolylineEntry {
  stepId: string;
  xsPx: number[];
  ysPx: number[];
  ts: number[];
  /** The step's `handleRank` (issue #149); absent counts as 0, so a scene without ranks is nearest-wins. */
  rank?: number;
}

export interface HitScene {
  handles: HandleEntry[];
  markers: MarkerEntry[];
  polylines: PolylineEntry[];
  /** No longer filled or tested: the per-point heading knob is gone (spec 11 section 3). */
  knobs?: HandleEntry[];
  /** The heading handles (`headingHandles.ts`) of the steps whose handles show, at their grab points. */
  headingHandles?: HeadingHandleEntry[];
  /** The boundaries between piecewise heading ranges, on the path. */
  boundaries?: BoundaryEntry[];
  /** No longer filled or tested: envelopes are edited as rectangles (`envelopeHandles`, issue #120). */
  envelopeCorners?: EnvelopeCornerEntry[];
  /** The selected step's envelope's corner and side handles (`envelopeDrag.ts`). */
  envelopeHandles?: EnvelopeHandleEntry[];
  /** The selected step's envelope's outline, for a press along a side or inside it. */
  envelopeBody?: EnvelopeBodyEntry | null;
  /** The routine's start mark, where `drawStartEnd` paints it. Absent or null, nothing hits it. */
  start?: StartEntry | null;
  /** The tip of the start's heading knob, only while the knob is drawn. */
  startKnob?: StartEntry | null;
  /** The waypoint pins, where `drawWaypoints` paints them, only where the shell can move them. */
  pins?: PinEntry[];
}

/** How far above its spot a pin's stem reaches, in CSS pixels, as `drawWaypoints` draws it. */
export const PIN_STEM_PX = 9;
/** How near a pin's ring or stem a press still grabs the pin. */
export const PIN_HIT_PX = 6;

/** One waypoint pin on screen: the ring on its spot, the stem above it, and its name when drawn. */
export interface PinEntry {
  name: string;
  /** The waypoint's spot, the centre of the ring. */
  xPx: number;
  yPx: number;
  /** The name's box beside the stem, when the zoom draws names; null or absent otherwise. */
  label?: { x0Px: number; y0Px: number; x1Px: number; y1Px: number } | null;
  /** The selected pin, which takes the press wherever it is drawn. */
  selected?: boolean;
}

/** How far the pointer is from a pin: 0 on its name, else the distance to its ring and stem. */
export function pinDistancePx(pin: PinEntry, xPx: number, yPx: number): number {
  const label = pin.label ?? null;
  if (label !== null && xPx >= label.x0Px && xPx <= label.x1Px && yPx >= label.y0Px && yPx <= label.y1Px) return 0;
  return distanceToSegment({ xPx: pin.xPx, yPx: pin.yPx }, { xPx: pin.xPx, yPx: pin.yPx - PIN_STEM_PX }, xPx, yPx);
}

/**
 * The names of every pin within reach of the pointer, nearest first, wherever a dot or the start
 * mark sits on it. The right-click menu of that dot offers to select each (issue #233), which is the
 * way to a pin nothing follows, covered by a dot of a point one inch away.
 */
export function pinsNear(scene: HitScene, xPx: number, yPx: number): string[] {
  return (scene.pins ?? [])
    .map((pin) => ({ name: pin.name, distancePx: pinDistancePx(pin, xPx, yPx) }))
    .filter((entry) => entry.distancePx <= PIN_HIT_PX)
    .sort((a, b) => a.distancePx - b.distancePx)
    .map((entry) => entry.name);
}

/** The pin under the pointer, the nearest within `tolerancePx`, or null. */
function pinAt(pins: readonly PinEntry[], xPx: number, yPx: number, tolerancePx: number): PinEntry | null {
  let best: PinEntry | null = null;
  let bestPx = tolerancePx;
  for (const pin of pins) {
    const distancePx = pinDistancePx(pin, xPx, yPx);
    if (distancePx <= bestPx) {
      best = pin;
      bestPx = distancePx;
    }
  }
  return best;
}

/** One corner handle of the selected step's envelope, in screen pixels. */
export interface EnvelopeCornerEntry {
  stepId: string;
  /** The corner's 0-based index in the envelope's `polygon`. */
  cornerIndex: number;
  xPx: number;
  yPx: number;
}

/** One resize handle of the selected step's envelope, in screen pixels. */
export interface EnvelopeHandleEntry {
  stepId: string;
  handle: RectHandle;
  xPx: number;
  yPx: number;
}

/** The selected step's envelope in screen pixels: its corners in order and its four sides. */
export interface EnvelopeBodyEntry {
  stepId: string;
  cornersPx: ScreenPoint[];
  sides: Array<{ handle: RectHandle; fromPx: ScreenPoint; toPx: ScreenPoint }>;
}

interface ScreenPoint {
  xPx: number;
  yPx: number;
}

export interface StartEntry {
  xPx: number;
  yPx: number;
}

export interface HeadingHandleEntry {
  stepId: string;
  key: string;
  editable: boolean;
  xPx: number;
  yPx: number;
}

export interface BoundaryEntry {
  stepId: string;
  index: number;
  xPx: number;
  yPx: number;
}

export const emptyHitScene = (): HitScene => ({
  handles: [],
  markers: [],
  polylines: [],
  knobs: [],
  headingHandles: [],
  boundaries: [],
  envelopeCorners: [],
  envelopeHandles: [],
  envelopeBody: null,
  start: null,
  startKnob: null,
  pins: [],
});

export interface Projection {
  /** Arc-length parameter over the whole step, in [0, 1]. */
  t: number;
  xPx: number;
  yPx: number;
  distancePx: number;
}

/** The closest point of a polyline to a screen point, with the t that belongs to it. */
export function projectOntoPolyline(entry: PolylineEntry, xPx: number, yPx: number): Projection | null {
  const count = Math.min(entry.xsPx.length, entry.ysPx.length, entry.ts.length);
  if (count === 0) return null;
  if (count === 1) {
    const x = entry.xsPx[0] as number;
    const y = entry.ysPx[0] as number;
    return { t: entry.ts[0] as number, xPx: x, yPx: y, distancePx: Math.hypot(xPx - x, yPx - y) };
  }

  let best: Projection | null = null;
  for (let i = 0; i + 1 < count; i += 1) {
    const ax = entry.xsPx[i] as number;
    const ay = entry.ysPx[i] as number;
    const bx = entry.xsPx[i + 1] as number;
    const by = entry.ysPx[i + 1] as number;
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    const u = lengthSq === 0 ? 0 : Math.min(1, Math.max(0, ((xPx - ax) * dx + (yPx - ay) * dy) / lengthSq));
    const px = ax + dx * u;
    const py = ay + dy * u;
    const distancePx = Math.hypot(xPx - px, yPx - py);
    if (best === null || distancePx < best.distancePx) {
      const ta = entry.ts[i] as number;
      const tb = entry.ts[i + 1] as number;
      best = { t: ta + (tb - ta) * u, xPx: px, yPx: py, distancePx };
    }
  }
  return best;
}

export const nearest = <T extends { xPx: number; yPx: number }>(
  entries: readonly T[],
  xPx: number,
  yPx: number,
  tolerancePx: number,
): T | null => {
  let best: T | null = null;
  let bestPx = tolerancePx;
  for (const entry of entries) {
    const distancePx = Math.hypot(entry.xPx - xPx, entry.yPx - yPx);
    if (distancePx <= bestPx) {
      best = entry;
      bestPx = distancePx;
    }
  }
  return best;
};

/** What is under the pointer, or null for empty field. */
export function hitTest(scene: HitScene, xPx: number, yPx: number): CanvasHit | null {
  // The selected pin first: selecting it is how a pin under a dot or the start mark is reached.
  const pins = scene.pins ?? [];
  const selectedPin = pinAt(pins.filter((pin) => pin.selected === true), xPx, yPx, HANDLE_HIT_PX);
  if (selectedPin !== null) return { stepId: "", waypoint: selectedPin.name };

  const handle = topHandle(scene.handles, xPx, yPx, HANDLE_HIT_PX);
  const handlePx = handle === null ? Infinity : Math.hypot(handle.xPx - xPx, handle.yPx - yPx);
  const start = scene.start ?? null;
  const startDistancePx = start === null ? Infinity : Math.hypot(start.xPx - xPx, start.yPx - yPx);
  const startPx = startDistancePx <= HANDLE_HIT_PX ? startDistancePx : Infinity;
  // The start mark is a point handle of its own, in the same tier: nearest of the two wins.
  const pointPx = Math.min(handlePx, startPx);

  const heading = nearest(scene.headingHandles ?? [], xPx, yPx, HANDLE_HIT_PX);
  const headingPx = heading === null ? Infinity : Math.hypot(heading.xPx - xPx, heading.yPx - yPx);
  // The start's heading knob is a heading handle too: it beats the start mark and any dot where it
  // is at least as near, as a step's arrow does, and the nearer of it and a step's arrow wins.
  const knob = scene.startKnob ?? null;
  const knobDistancePx = knob === null ? Infinity : Math.hypot(knob.xPx - xPx, knob.yPx - yPx);
  const knobPx = knobDistancePx <= HANDLE_HIT_PX ? knobDistancePx : Infinity;
  if (knobPx <= pointPx && knobPx < headingPx) return { stepId: "", startKnob: true };
  if (heading !== null && headingPx <= pointPx) {
    return { stepId: heading.stepId, headingHandle: heading.key };
  }

  const boundary = nearest(scene.boundaries ?? [], xPx, yPx, HANDLE_HIT_PX);
  if (boundary !== null && Math.hypot(boundary.xPx - xPx, boundary.yPx - yPx) < pointPx) {
    return { stepId: boundary.stepId, rangeBoundary: boundary.index };
  }

  // A path dot drawn on the start mark keeps the press (it is what is drawn on top); the start wins
  // only when the pointer is strictly nearer to it than to any dot, or when the dot is a path's first
  // point sitting on the start, which the start drag carries along.
  if (startPx < handlePx || (handle?.onStart === true && startPx !== Infinity)) return { stepId: "", start: true };
  if (handle !== null) return { stepId: handle.stepId, point: handle.point };

  // An envelope handle sits under the path's own dots: where one lands on a path point, the point
  // wins, because the path is what the step is and the envelope is a note about it. Corners are
  // listed first, so a corner wins a tie with a side handle on a tiny rectangle.
  const envelopeHandle = nearest(scene.envelopeHandles ?? [], xPx, yPx, HANDLE_HIT_PX);
  if (envelopeHandle !== null) return { stepId: envelopeHandle.stepId, envelopeHandle: envelopeHandle.handle };

  // Markers and lines are one tier, ranked by step (issue #149). A marker that wins it keeps the
  // press from a pin; a line that wins it gives the press to a pin under the pointer.
  let top: TierCandidate | null = null;
  for (const candidate of tierCandidates(scene, xPx, yPx, true)) {
    if (top === null || outranks(candidate, top)) top = candidate;
  }
  if (top?.markerIndex !== undefined) return { stepId: top.stepId, markerIndex: top.markerIndex };

  // A pin where nothing above sits: its ring, its stem or its name. It wins over the path line.
  const pin = pinAt(pins, xPx, yPx, PIN_HIT_PX);
  if (pin !== null) return { stepId: "", waypoint: pin.name };

  if (top !== null) return { stepId: top.stepId, t: top.t ?? 0 };
  return envelopeBodyHit(scene.envelopeBody ?? null, xPx, yPx);
}

/** One marker or line under the pointer, with what ranks it in the marker-and-line tier. */
interface TierCandidate {
  stepId: string;
  /** Set for a marker. */
  markerIndex?: number;
  /** Set for a line: the t of the point pressed. */
  t?: number;
  /** 3 for the selected step's markers, 2 for its line, 1 for other steps' markers, 0 for their lines. */
  group: number;
  /** The step's place in the routine: a later step is higher. */
  stepOrder: number;
  distancePx: number;
  /** The entry's place in its list, so that a full tie still goes to the one listed last. */
  listed: number;
}

/**
 * Every marker and line within its hit radius. With `boostSelected` false the selected step ranks as
 * any other does, which is the order Alt+click walks, so it visits every step whatever is selected.
 */
function tierCandidates(scene: HitScene, xPx: number, yPx: number, boostSelected: boolean): TierCandidate[] {
  const out: TierCandidate[] = [];
  const placeOf = (rank: number | undefined): { selected: boolean; stepOrder: number } => {
    const value = rank ?? 0;
    const selected = value >= SELECTED_RANK;
    return { selected: boostSelected && selected, stepOrder: selected ? value - SELECTED_RANK : value };
  };
  for (const [listed, marker] of scene.markers.entries()) {
    const distancePx = Math.hypot(marker.xPx - xPx, marker.yPx - yPx);
    if (distancePx > MARKER_HIT_PX) continue;
    const { selected, stepOrder } = placeOf(marker.rank);
    out.push({ stepId: marker.stepId, markerIndex: marker.markerIndex, group: selected ? 3 : 1, stepOrder, distancePx, listed });
  }
  for (const [listed, polyline] of scene.polylines.entries()) {
    const projection = projectOntoPolyline(polyline, xPx, yPx);
    if (projection === null || projection.distancePx > PATH_HIT_PX) continue;
    const { selected, stepOrder } = placeOf(polyline.rank);
    out.push({ stepId: polyline.stepId, t: projection.t, group: selected ? 2 : 0, stepOrder, distancePx: projection.distancePx, listed });
  }
  return out;
}

/**
 * Whether `a` takes the press from `b`: the higher group wins; among markers the later step and then
 * the nearer, and among lines the nearer and then the later step. A full tie goes to the one listed
 * last, as it did before the tier was ranked.
 */
function outranks(a: TierCandidate, b: TierCandidate): boolean {
  if (a.group !== b.group) return a.group > b.group;
  if (a.markerIndex !== undefined && a.stepOrder !== b.stepOrder) return a.stepOrder > b.stepOrder;
  if (a.distancePx !== b.distancePx) return a.distancePx < b.distancePx;
  if (a.stepOrder !== b.stepOrder) return a.stepOrder > b.stepOrder;
  return a.listed > b.listed;
}

/**
 * The steps whose markers or lines are under the pointer, each once, in the order a click ranks them
 * with no step selected. A step is named at its marker when one of its markers is what ranks it, and
 * otherwise on its line.
 */
export function stepsUnder(scene: HitScene, xPx: number, yPx: number): CanvasHit[] {
  const ranked = tierCandidates(scene, xPx, yPx, false).sort((a, b) => (outranks(a, b) ? -1 : outranks(b, a) ? 1 : 0));
  const seen = new Set<string>();
  const out: CanvasHit[] = [];
  for (const candidate of ranked) {
    if (seen.has(candidate.stepId)) continue;
    seen.add(candidate.stepId);
    out.push(
      candidate.markerIndex !== undefined
        ? { stepId: candidate.stepId, markerIndex: candidate.markerIndex }
        : { stepId: candidate.stepId, t: candidate.t ?? 0 },
    );
  }
  return out;
}

/**
 * Whether a hit is in the marker-and-line tier, the one place Alt+click walks the steps under the
 * pointer. A dot, the start mark, a pin, a heading handle, a range boundary and an envelope handle
 * rank above that tier and keep the press, so an Alt+click on one of them does what a plain click
 * does, overlap or not.
 */
export const isMarkerOrLineHit = (hit: CanvasHit | null): boolean => hit?.t !== undefined || hit?.markerIndex !== undefined;

/**
 * What Alt+click with the select tool picks (issue #149): the step after `currentStepId` in
 * `stepsUnder`, going round to the first after the last, or the first when the current step is not
 * under the pointer. Null where no step is.
 */
export function nextStepUnder(scene: HitScene, xPx: number, yPx: number, currentStepId: string | undefined): CanvasHit | null {
  const steps = stepsUnder(scene, xPx, yPx);
  const index = steps.findIndex((hit) => hit.stepId === currentStepId);
  return steps[(index + 1) % Math.max(steps.length, 1)] ?? null;
}

/** A press along a side of the selected envelope grabs that side; one inside it grabs it all. */
function envelopeBodyHit(body: EnvelopeBodyEntry | null, xPx: number, yPx: number): CanvasHit | null {
  if (body === null) return null;
  let side: RectHandle | null = null;
  let sidePx = ENVELOPE_SIDE_HIT_PX;
  for (const entry of body.sides) {
    const distancePx = distanceToSegment(entry.fromPx, entry.toPx, xPx, yPx);
    if (distancePx <= sidePx) {
      side = entry.handle;
      sidePx = distancePx;
    }
  }
  if (side !== null) return { stepId: body.stepId, envelopeHandle: side };
  return insidePolygon(body.cornersPx, xPx, yPx) ? { stepId: body.stepId, envelopeHandle: "move" } : null;
}

function distanceToSegment(a: ScreenPoint, b: ScreenPoint, xPx: number, yPx: number): number {
  const dx = b.xPx - a.xPx;
  const dy = b.yPx - a.yPx;
  const lengthSq = dx * dx + dy * dy;
  const u = lengthSq === 0 ? 0 : Math.min(1, Math.max(0, ((xPx - a.xPx) * dx + (yPx - a.yPx) * dy) / lengthSq));
  return Math.hypot(xPx - (a.xPx + dx * u), yPx - (a.yPx + dy * u));
}

/** Even-odd point-in-polygon, in screen pixels. */
function insidePolygon(corners: readonly ScreenPoint[], xPx: number, yPx: number): boolean {
  let inside = false;
  for (let i = 0, j = corners.length - 1; i < corners.length; j = i, i += 1) {
    const a = corners[i] as ScreenPoint;
    const b = corners[j] as ScreenPoint;
    if (a.yPx > yPx !== b.yPx > yPx && xPx < ((b.xPx - a.xPx) * (yPx - a.yPx)) / (b.yPx - a.yPx) + a.xPx) inside = !inside;
  }
  return inside;
}

/** The point target a hit names, for the drag handlers. */
export const hitPoint = (hit: CanvasHit | null): PointTarget | null => hit?.point ?? null;
