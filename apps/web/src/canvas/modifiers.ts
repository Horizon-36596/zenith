/**
 * What the held modifier keys mean during a drag (site/docs/editor.md). Three keys, three
 * orthogonal effects:
 *
 * - **Ctrl** (Cmd on macOS) inverts the snap toggle for as long as it is held: `snap XOR ctrl`, the
 *   PathPlanner rule, so the same key means "snap now" with the toolbar off and "do not snap" with it
 *   on. With snapping off every rule is off: waypoint, grid, wall and heading increments.
 * - **Alt** turns off only the quantising snaps, the half-inch grid and the 15 degree heading, and
 *   leaves the waypoint and wall rules alone: "keep my number, but still let it kiss the wall".
 * - **Shift** is a constraint, not a snap, so it works whatever the toggle says: a path end or node
 *   keeps to a ray from its anchor (`constrainToRay`), any other point moves along whichever field
 *   axis the pointer has travelled further on since the press, a heading turns in 45 degree steps,
 *   and a Bezier handle drag stops mirroring its opposite handle.
 *
 * Pure, so the whole table is unit-tested without a pointer.
 */
import type { Vec2 } from "@horizon36596/zenith-core";

export interface HeldKeys {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export interface DragModifiers {
  /** Whether any snap rule runs at all: the toolbar toggle, flipped while Ctrl is held. */
  snap: boolean;
  /** Whether the grid and the 15 degree heading increments run. Alt turns them off. */
  quantise: boolean;
  /** Shift: constrain a point to one field axis, or a path end to a ray from its anchor. */
  constrainAxis: boolean;
  /** Shift: turn a heading in 45 degree steps, snap or no snap. */
  coarseHeading: boolean;
  /** Shift: move only the grabbed Bezier handle, not its mirrored opposite. */
  breakMirror: boolean;
  /** Ctrl flipped the toggle, for the readout: "snap off (Ctrl)" says why nothing snapped. */
  inverted: boolean;
}

export const NO_KEYS: HeldKeys = { ctrl: false, alt: false, shift: false };

/** The held keys of a pointer or keyboard event; Cmd counts as Ctrl so macOS reads the same. */
export const heldKeys = (event: {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): HeldKeys => ({ ctrl: event.ctrlKey || event.metaKey, alt: event.altKey, shift: event.shiftKey });

export function resolveModifiers(snapToggle: boolean, keys: HeldKeys): DragModifiers {
  const snap = snapToggle !== keys.ctrl;
  return {
    snap,
    quantise: snap && !keys.alt,
    constrainAxis: keys.shift,
    coarseHeading: keys.shift,
    breakMirror: keys.shift,
    inverted: keys.ctrl,
  };
}

export type Axis = "x" | "y";

/**
 * The axis a Shift-constrained drag runs along: whichever the pointer has moved further on since the
 * press. A tie goes to x, so a drag that has not moved yet still has an answer.
 */
export const dominantAxis = (fromIn: Vec2, toIn: Vec2): Axis =>
  Math.abs(toIn.xIn - fromIn.xIn) >= Math.abs(toIn.yIn - fromIn.yIn) ? "x" : "y";

/** `toIn` with its off-axis coordinate put back to where the drag started. */
export function constrainToAxis(fromIn: Vec2, toIn: Vec2, axis: Axis = dominantAxis(fromIn, toIn)): Vec2 {
  return axis === "x" ? { xIn: toIn.xIn, yIn: fromIn.yIn } : { xIn: fromIn.xIn, yIn: toIn.yIn };
}

/** The steps of Shift's ray: the field's eight compass bearings, 45 degrees apart. */
export const RAY_STEP_DEG = 45;

/** A line a Shift-constrained path end keeps to: from an anchor, along a bearing. */
export interface Ray {
  anchorIn: Vec2;
  bearingRad: number;
}

export interface RayPoint extends Ray {
  /** The point on the ray the pointer projects to. */
  pointIn: Vec2;
  /** How far along the ray it is, never below zero. */
  lengthIn: number;
}

const TWO_PI = Math.PI * 2;

/** The smallest angle between two bearings, 0 to pi. */
const angleBetween = (a: number, b: number): number => {
  const turn = Math.abs(a - b) % TWO_PI;
  return turn > Math.PI ? TWO_PI - turn : turn;
};

/** The point `lengthIn` along a ray. */
export const pointOnRay = (ray: Ray, lengthIn: number): Vec2 => ({
  xIn: ray.anchorIn.xIn + Math.cos(ray.bearingRad) * lengthIn,
  yIn: ray.anchorIn.yIn + Math.sin(ray.bearingRad) * lengthIn,
});

/**
 * Shift on a path end: the point stays on a ray from its anchor, the other end of its segment, and
 * goes to the pointer's projection onto that ray. The ray's bearing is whichever of the eight 45
 * degree multiples and the line's own bearing at the press (`pressBearingRad`, when it has one) is
 * nearest the pointer's bearing from the anchor, the press bearing winning a tie. Because the line's
 * own bearing is a candidate, a line off the 45 degree steps keeps its own bearing for as long as
 * the pointer is nearer it than any step, and because the point is the projection, never an axis
 * value copied from the press, it can come as close to the anchor as the pointer does: the length is
 * clamped at the anchor and has no floor above that.
 *
 * With the pointer on the anchor there is no bearing to read, so the press bearing (else 0) is used.
 */
export function constrainToRay(anchorIn: Vec2, pointerIn: Vec2, pressBearingRad?: number): RayPoint {
  const dx = pointerIn.xIn - anchorIn.xIn;
  const dy = pointerIn.yIn - anchorIn.yIn;
  let bearingRad = pressBearingRad ?? 0;
  if (Math.hypot(dx, dy) > 1e-9) {
    const wanted = Math.atan2(dy, dx);
    const candidates: number[] = pressBearingRad === undefined ? [] : [pressBearingRad];
    for (let step = -3; step <= 4; step += 1) candidates.push((step * RAY_STEP_DEG * Math.PI) / 180);
    let best = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      const off = angleBetween(wanted, candidate);
      if (off < best - 1e-12) {
        best = off;
        bearingRad = candidate;
      }
    }
  }
  const lengthIn = Math.max(0, dx * Math.cos(bearingRad) + dy * Math.sin(bearingRad));
  const ray: Ray = { anchorIn: { xIn: anchorIn.xIn, yIn: anchorIn.yIn }, bearingRad };
  return { ...ray, pointIn: pointOnRay(ray, lengthIn), lengthIn };
}

/** A ray's bearing for the bubble, in degrees from the field's +x axis, to a tenth, in (-180, 180]. */
export const rayBearingLabel = (bearingRad: number): string => {
  let deg = Math.round(((bearingRad * 180) / Math.PI) * 10) / 10;
  if (deg <= -180) deg += 360;
  if (deg > 180) deg -= 360;
  return `${String(deg === 0 ? 0 : deg)}°`;
};
