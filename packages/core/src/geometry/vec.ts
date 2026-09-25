/**
 * Points and poses in the field frame. Units are inches and radians throughout core, and every key
 * names its unit, the same as the files do (CLAUDE.md rule 3).
 */
export interface Vec2 {
  xIn: number;
  yIn: number;
}

export interface Pose extends Vec2 {
  headingRad: number;
}

export const vec = (xIn: number, yIn: number): Vec2 => ({ xIn, yIn });

export const pose = (xIn: number, yIn: number, headingRad: number): Pose => ({
  xIn,
  yIn,
  headingRad,
});

export const add = (a: Vec2, b: Vec2): Vec2 => ({ xIn: a.xIn + b.xIn, yIn: a.yIn + b.yIn });

export const sub = (a: Vec2, b: Vec2): Vec2 => ({ xIn: a.xIn - b.xIn, yIn: a.yIn - b.yIn });

export const scale = (a: Vec2, k: number): Vec2 => ({ xIn: a.xIn * k, yIn: a.yIn * k });

export const dot = (a: Vec2, b: Vec2): number => a.xIn * b.xIn + a.yIn * b.yIn;

/** The 2-D cross product's z component; positive when b is counter-clockwise from a. */
export const cross = (a: Vec2, b: Vec2): number => a.xIn * b.yIn - a.yIn * b.xIn;

export const length = (a: Vec2): number => Math.hypot(a.xIn, a.yIn);

export const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.xIn - b.xIn, a.yIn - b.yIn);

export function normalize(a: Vec2): Vec2 {
  const len = length(a);
  return len === 0 ? { xIn: 0, yIn: 0 } : { xIn: a.xIn / len, yIn: a.yIn / len };
}

/** Rotates about the origin by `rad`, counter-clockwise, which is the field's positive direction. */
export function rotate(a: Vec2, rad: number): Vec2 {
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { xIn: a.xIn * cos - a.yIn * sin, yIn: a.xIn * sin + a.yIn * cos };
}

/** Straight-line interpolation. Headings are interpolated by lerpAngle, not by this. */
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  xIn: a.xIn + (b.xIn - a.xIn) * t,
  yIn: a.yIn + (b.yIn - a.yIn) * t,
});
