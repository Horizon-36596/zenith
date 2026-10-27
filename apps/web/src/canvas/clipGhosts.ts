/**
 * Clip ghosts: a red outline of the robot at the place along a path where it leaves the field,
 * runs into a structure or a keep-out zone, or crosses the centre line into the other alliance's side
 * (OPPONENT_SIDE, issue #365), the worst place the check found.
 *
 * A path can look fine from its start and end and still clip in the middle, and the problems panel
 * only names the step, so the canvas draws the robot where it clips. The pose and polygons come
 * from the finding itself (`core`'s `geometry.poseIn` and `geometry.footprintIn`), so the ghost is
 * exactly what the check measured, whichever footprint the plan used.
 *
 * They are on by default and hidden with the toggle in the problems panel's header or the palette's
 * "Clip ghosts" (the `clipGhosts` preference). Hovering a row in the problems panel draws that
 * finding's ghost emphasised, and draws it even while the others are hidden.
 *
 * Nothing here touches the DOM, so it is unit-testable like the rest of the draw model.
 */
import {
  boxCorners,
  obstacleShadowIn,
  type Finding,
  type FindingCode,
  type Pose,
  type Severity,
  type Vec2,
} from "@horizon36596/zenith-core";
import type { Field, Obstacle } from "@horizon36596/zenith-schema";

/** The finding codes that are about the robot's footprint along a path, and so have a ghost. */
export const CLIP_GHOST_CODES: ReadonlySet<FindingCode> = new Set<FindingCode>(["PERIMETER", "STRUCTURE", "KEEPOUT", "OPPONENT_SIDE"]);

/**
 * The most ghosts drawn at once. A routine with more clipping findings than this is broken
 * everywhere, and past it the ghosts are clutter rather than help; the hovered one always draws.
 */
export const MAX_CLIP_GHOSTS = 48;

export interface ClipGhost {
  /** `findingKey` of the finding, which is how a hovered row names its ghost. */
  key: string;
  code: FindingCode;
  severity: Severity;
  stepId: string;
  poseIn: Pose;
  /** Body first, then one polygon per mouth, in the file's own alliance frame. */
  polygonsIn: Vec2[][];
  /** Which of `polygonsIn` went out the farthest or in the deepest, drawn heavier. */
  worstIndex: number;
  /**
   * For STRUCTURE, the obstacle the robot runs into: its id and the corners of what it blocks in
   * the file's own frame, outlined while the finding's row is hovered (issue #152), because a thin
   * bar is hard to pick out on the field by its name alone. That is the obstacle's shadow at the
   * robot's height (`obstacleShadowIn`): a box's own box, and for a slanted leg the band below the
   * robot's top (issue #230). Absent when the field file has no such obstacle.
   */
  obstacle?: { id: string; cornersIn: Vec2[] };
}

/**
 * A finding's identity for hover: stable while an edit elsewhere recomputes the findings, because
 * the finding objects themselves are new on every check.
 */
export const findingKey = (finding: Finding): string =>
  [
    finding.code,
    finding.stepId,
    finding.t === undefined ? "" : String(finding.t),
    finding.geometry?.obstacleId ?? finding.geometry?.zoneId ?? "",
  ].join("|");

/**
 * What a STRUCTURE ghost outlines for `obstacle`: its shadow at the robot's height. Without the
 * height a box still outlines as its own box, and a strut, whose band depends on it, as nothing.
 */
function outlineIn(obstacle: Obstacle, robotHeightIn: number | undefined): Vec2[] | null {
  if (robotHeightIn !== undefined) return obstacleShadowIn(obstacle, robotHeightIn);
  return obstacle.kind === "box" ? boxCorners(obstacle) : null;
}

/**
 * The ghosts of every footprint finding that carries its worst pose. With `field`, a STRUCTURE
 * ghost also carries the outline of the obstacle it names, for the hover outline, at
 * `robotHeightIn`, the robot's height the check used.
 */
export function clipGhosts(findings: readonly Finding[], field?: Field, robotHeightIn?: number): ClipGhost[] {
  const out: ClipGhost[] = [];
  for (const finding of findings) {
    if (!CLIP_GHOST_CODES.has(finding.code)) continue;
    const geometry = finding.geometry;
    const poseIn = geometry?.poseIn;
    const polygonsIn = geometry?.footprintIn;
    if (poseIn === undefined || polygonsIn === undefined || polygonsIn.length === 0) continue;
    const worst = geometry?.worstPolygonIndex ?? 0;
    const obstacle =
      finding.code === "STRUCTURE" ? field?.obstacles?.find((candidate) => candidate.id === geometry?.obstacleId) : undefined;
    const cornersIn = obstacle === undefined ? null : outlineIn(obstacle, robotHeightIn);
    out.push({
      key: findingKey(finding),
      code: finding.code,
      severity: finding.severity,
      stepId: finding.stepId,
      poseIn,
      polygonsIn,
      worstIndex: worst >= 0 && worst < polygonsIn.length ? worst : 0,
      ...(obstacle === undefined || cornersIn === null ? {} : { obstacle: { id: obstacle.id, cornersIn } }),
    });
  }
  return out;
}

/** The obstacle a frame outlines: the hovered ghost's, when it names one. */
export const outlinedObstacle = (drawn: readonly GhostToDraw[]): string | null =>
  drawn.find((entry) => entry.hovered && entry.ghost.obstacle !== undefined)?.ghost.obstacle?.id ?? null;

export interface GhostToDraw {
  ghost: ClipGhost;
  hovered: boolean;
}

/**
 * Which ghosts a frame draws: all of them (up to `MAX_CLIP_GHOSTS`) while ghosts are shown, and the
 * hovered one whether or not they are, so a person who hid them can still see one on demand.
 *
 * Issue #412: while a step whose finding has a ghost is selected (`selectedStepId`), which is what
 * makes that finding's Problems row the selected one, only that finding's ghosts draw, so its
 * outlines are not lost among every other finding's. The hovered one still draws as well.
 */
export function ghostsToDraw(
  ghosts: readonly ClipGhost[],
  show: boolean,
  hoveredKey: string | null,
  selectedStepId: string | null = null,
): GhostToDraw[] {
  const out: GhostToDraw[] = [];
  let hoveredSeen = false;
  const focused = selectedStepId !== null && ghosts.some((ghost) => ghost.stepId === selectedStepId);
  for (const ghost of ghosts) {
    if (focused && ghost.stepId !== selectedStepId && ghost.key !== hoveredKey) continue;
    const hovered = hoveredKey !== null && ghost.key === hoveredKey;
    if (hovered) {
      if (hoveredSeen) continue;
      hoveredSeen = true;
      out.push({ ghost, hovered });
      continue;
    }
    if (show && out.length < MAX_CLIP_GHOSTS) out.push({ ghost, hovered });
  }
  return out;
}
