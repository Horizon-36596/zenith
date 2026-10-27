/**
 * The Optimize card's preview on the field (UI_GUIDE 9.11, issue #308): the proposed route is a second
 * scene that is drawn and never hit-tested, so nothing on it can be pressed or dragged. Hovering it
 * moves the one robot outline to the nearest point on it, with its heading tick; there are no stamped
 * ghosts. On an infeasible result there is no route, and the one outline is the closest attempt's clip
 * ghost.
 *
 * DOM-free arithmetic, like the rest of `canvas/`'s geometry, so it is tested in vitest.
 */
import { mirrorVec, type MirrorMode, type Pose, type Vec2 } from "@horizon36596/zenith-core";
import { PATH_HIT_PX } from "./hit.js";
import type { SceneStep } from "./scene.js";
import { worldToScreen, type ScreenVec, type View } from "./view.js";

/** How near the pointer must be to the proposed route to hover it, in CSS pixels: a path's own hit distance. */
export const CANDIDATE_HOVER_PX = PATH_HIT_PX;

/** What the live layer draws for the card (`liveLayer.ts` `drawCandidate`). */
export interface CandidateDrawing {
  /** The proposed route as a scene step, or null when there is none to show. */
  step: SceneStep | null;
  jointsIn: readonly Vec2[];
  /** Each nearby structure's margin, drawn as a 1 px hairline. */
  marginOutlinesIn: readonly (readonly Vec2[])[];
  /** On an infeasible result, the closest attempt's worst pose, drawn as a clip ghost. */
  ghostPoseIn: Pose | null;
}

/**
 * The pose on the proposed route nearest the pointer, when the pointer is within
 * `CANDIDATE_HOVER_PX` of the drawn route; null otherwise. The pose is in the file's own frame, as
 * every pose the canvas hands on is; `mirror` is how the route is drawn.
 */
export function candidateHoverPose(step: SceneStep, pointerPx: ScreenVec | null, view: View, mirror: MirrorMode): Pose | null {
  if (pointerPx === null || step.poses.length === 0) return null;
  const screen = step.poses.map((pose) => worldToScreen(view, mirrorVec(pose, mirror)));
  let best: { distancePx: number; index: number; fraction: number } | null = null;
  for (let index = 0; index < screen.length; index += 1) {
    const a = screen[index] as ScreenVec;
    const b = screen[index + 1] ?? a;
    const dx = b.xPx - a.xPx;
    const dy = b.yPx - a.yPx;
    const lengthSq = dx * dx + dy * dy;
    const fraction = lengthSq === 0 ? 0 : Math.min(1, Math.max(0, ((pointerPx.xPx - a.xPx) * dx + (pointerPx.yPx - a.yPx) * dy) / lengthSq));
    const distancePx = Math.hypot(pointerPx.xPx - (a.xPx + dx * fraction), pointerPx.yPx - (a.yPx + dy * fraction));
    if (best === null || distancePx < best.distancePx) best = { distancePx, index, fraction };
  }
  if (best === null || best.distancePx > CANDIDATE_HOVER_PX) return null;
  const a = step.poses[best.index] as Pose;
  const b = step.poses[best.index + 1] ?? a;
  // The heading of the nearer sample, since a sample's heading is the robot's there and the samples are 2 in apart.
  const nearer = best.fraction < 0.5 ? a : b;
  return {
    xIn: a.xIn + (b.xIn - a.xIn) * best.fraction,
    yIn: a.yIn + (b.yIn - a.yIn) * best.fraction,
    headingRad: nearer.headingRad,
  };
}

/**
 * The robot outlines the canvas draws for the candidate: at most one. An infeasible result has no
 * route to hover, so its clip ghost is the one; otherwise the hovered pose, if any.
 */
export function candidateOutlinePoses(candidate: { hoverPoseIn: Pose | null; ghostPoseIn: Pose | null }): Pose[] {
  if (candidate.ghostPoseIn !== null) return [candidate.ghostPoseIn];
  return candidate.hoverPoseIn === null ? [] : [candidate.hoverPoseIn];
}
