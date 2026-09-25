/**
 * What the held modifier keys mean during a drag (site/docs/editor.md). Three keys, three
 * orthogonal effects:
 *
 * - **Ctrl** (Cmd on macOS) inverts the snap toggle for as long as it is held: `snap XOR ctrl`, the
 *   PathPlanner rule, so the same key means "snap now" with the toolbar off and "do not snap" with it
 *   on. With snapping off every rule is off: waypoint, grid, wall and heading increments.
 * - **Alt** turns off only the quantising snaps, the half-inch grid and the 15 degree heading, and
 *   leaves the waypoint and wall rules alone: "keep my number, but still let it kiss the wall".
 * - **Shift** is a constraint, not a snap, so it works whatever the toggle says: a point drag moves
 *   along whichever field axis the pointer has travelled further on since the press, a heading turns
 *   in 45 degree steps, and a Bezier handle drag stops mirroring its opposite handle.
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
  /** Shift: constrain a point to one field axis. */
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
