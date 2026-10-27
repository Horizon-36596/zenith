/**
 * The outline of one tile seam (issue #428): the interlocking tab edge two FTC soft tiles meet
 * along, from one seam crossing to the next, rebuilt from the season drawing's `TileSeamProfile`.
 * Pure arithmetic in the profile's own inches; `staticLayer.ts` scales it onto the field's tiles and
 * strokes it.
 *
 * Measured along the edge from its middle, the sides of the tabs cross the seam's centre line every
 * half pitch. Each side runs from the end of one tab to the root of the next and leans back by the
 * tab's width less half the pitch, which is what makes a tab wider at its end than at its root. The
 * side that would cross at the middle is replaced by a 45 degree step, and each end joins its
 * crossing by a 45 degree half step, as in FIRST's BIOBUZZ field CAD (the profile's provenance).
 */
import type { TileSeamProfile } from "./seasonDrawing.js";

/** One corner of the outline, before its fillet rounds it. */
export interface SeamCorner {
  /** Along the seam from its first crossing, in the profile's inches. */
  readonly alongIn: number;
  /** Across the seam, to the left of the way it runs: a corner on the left is a tab from the tile on the right. */
  readonly acrossIn: number;
  /** The radius the corner is rounded to, in the profile's inches; 0 for a sharp corner. */
  readonly filletIn: number;
}

/**
 * The outline's corners in order, from the first crossing (along 0) to the next (along `edgeIn`),
 * both on the seam's centre line. Its first half is the second half turned about the middle, so the
 * outline is the same run either way: a seam drawn from either end, with the left of that way as
 * `acrossIn`, is the same line.
 */
export function tileSeamOutline(profile: TileSeamProfile): SeamCorner[] {
  const half = profile.edgeIn / 2;
  const halfDepth = profile.depthIn / 2;
  const halfPitch = profile.pitchIn / 2;
  const lean = profile.tabWidthIn - halfPitch;
  const fillet = profile.filletRadiusIn;
  // The half past the middle, measured from the middle: the step's end on the right, then each tab
  // side from the end it starts on to the root it reaches, then the last flat and the half step.
  const second: { at: number; across: number; fillet: number }[] = [{ at: halfDepth, across: -halfDepth, fillet: 0 }];
  let side = -halfDepth;
  for (let k = 1; k * halfPitch + lean / 2 <= half - halfDepth; k += 1) {
    second.push({ at: k * halfPitch + lean / 2, across: side, fillet }, { at: k * halfPitch - lean / 2, across: -side, fillet });
    side = -side;
  }
  second.push({ at: half - halfDepth, across: side, fillet: 0 }, { at: half, across: 0, fillet: 0 });
  const first = [...second].reverse().map((corner) => ({ ...corner, at: -corner.at, across: -corner.across }));
  return [...first, ...second].map((corner) => ({
    alongIn: corner.at + half,
    acrossIn: corner.across === 0 ? 0 : corner.across,
    filletIn: corner.fillet,
  }));
}
