/**
 * The structure the hives stand in, drawn over the hives (issue #230): each slanted leg of the hive
 * frame (a `strut` obstacle) as the robot meets it.
 *
 * - The band: the part of a leg below the robot's top, which is the shadow STRUCTURE checks against
 *   (`obstacleShadowIn` in core). It is drawn like any blocking obstacle, filled in the obstacle fill
 *   with an obstacle stroke, and it grows toward the hive's middle as the robot gets taller, so
 *   changing the robot's height in robot settings shows what it blocks. It is never optional: no
 *   blocking obstacle is ever hidden.
 * - The overhead outlines: each whole leg and each hive envelope the robot passes under, dashed, the
 *   style the editor gives structure overhead. They follow the Overhead outlines display option
 *   (`field.overheadOutlines`, on unless the person turned it off); the static layer's crossbar
 *   follows it too.
 *
 * Why a layer of its own: the band of a leg at x 18 to 24.6 in and |y| 10 to 19 in lies under the
 * hive's body, which `hiveLayer.ts` paints over the static layer. So `drawHiveLevel` paints the
 * hives and then this, before anything the live layer draws (the partners, the ghosts, the paths).
 *
 * Planned as issue #200 registry entry `field.overheadOutlines`: a viewer toggle, default on, with
 * Basic off and Essential and Full on.
 *
 * Nothing here touches the DOM, so it is unit-testable like the rest of the draw model.
 */
import { obstacleShadowIn, type Vec2 } from "@horizon36596/zenith-core";
import type { Field, Obstacle, StrutObstacle } from "@horizon36596/zenith-schema";
import { drawHives, type HiveDrawInput } from "./hiveLayer.js";
import { drawingFor } from "./seasonDrawing.js";
import type { CanvasTheme } from "./theme.js";
import { worldToScreen, type View } from "./view.js";

export interface StructureLayerInput {
  field: Field;
  /** The robot's top, from the tiles: what a leg's band reaches up to. */
  robotHeightIn: number;
  view: View;
  theme: CanvasTheme;
  /** Whether to draw the dashed overhead outlines. Absent means drawn. */
  overheadOutlines?: boolean;
}

/** One shape this layer draws: the obstacle's id and its floor plan, in the field frame. */
export interface StructureShape {
  id: string;
  polygonIn: Vec2[];
}

const isStrut = (obstacle: Obstacle): obstacle is StrutObstacle => obstacle.kind === "strut";

/** A strut's whole floor plan: its shadow at a height above its top. */
const wholeStrut = (strut: StrutObstacle): Vec2[] | null =>
  obstacleShadowIn(strut, Math.max(strut.fromIn.zIn, strut.toIn.zIn) + strut.radiusIn);

/** The band of every strut solid to the robot that reaches below its top, in field order. */
export function blockingBands(field: Field, robotHeightIn: number): StructureShape[] {
  const out: StructureShape[] = [];
  for (const obstacle of field.obstacles ?? []) {
    if (!isStrut(obstacle) || !(obstacle.solidToRobot ?? true)) continue;
    const polygonIn = obstacleShadowIn(obstacle, robotHeightIn);
    if (polygonIn !== null) out.push({ id: obstacle.id, polygonIn });
  }
  return out;
}

/**
 * The dashed overhead outlines, in field order: each hive envelope the robot passes under (its
 * underside at or above the robot's top), then every strut whole. An envelope the robot is too tall
 * to pass under is left to the hive's body, which is drawn as an obstacle already.
 */
export function overheadShapes(field: Field, robotHeightIn: number): StructureShape[] {
  const envelopes = new Set(drawingFor(field)?.hives.map((hive) => hive.envelope) ?? []);
  const hives: StructureShape[] = [];
  const struts: StructureShape[] = [];
  for (const obstacle of field.obstacles ?? []) {
    if (isStrut(obstacle)) {
      const polygonIn = wholeStrut(obstacle);
      if (polygonIn !== null) struts.push({ id: obstacle.id, polygonIn });
    } else if (envelopes.has(obstacle.id) && obstacle.minZIn >= robotHeightIn) {
      hives.push({
        id: obstacle.id,
        polygonIn: [
          { xIn: obstacle.minXIn, yIn: obstacle.minYIn },
          { xIn: obstacle.maxXIn, yIn: obstacle.minYIn },
          { xIn: obstacle.maxXIn, yIn: obstacle.maxYIn },
          { xIn: obstacle.minXIn, yIn: obstacle.maxYIn },
        ],
      });
    }
  }
  return [...hives, ...struts];
}

function tracePolygon(ctx: CanvasRenderingContext2D, view: View, polygon: readonly Vec2[]): void {
  ctx.beginPath();
  for (const [index, corner] of polygon.entries()) {
    const screen = worldToScreen(view, corner);
    if (index === 0) ctx.moveTo(screen.xPx, screen.yPx);
    else ctx.lineTo(screen.xPx, screen.yPx);
  }
  ctx.closePath();
}

/** The overhead outlines (when shown), then the bands over them. */
export function drawStructure(ctx: CanvasRenderingContext2D, input: StructureLayerInput): void {
  const { field, view, theme } = input;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;
  ctx.strokeStyle = theme.fieldObstacle;
  if (input.overheadOutlines !== false) {
    ctx.setLineDash([2, 3]);
    for (const shape of overheadShapes(field, input.robotHeightIn)) {
      tracePolygon(ctx, view, shape.polygonIn);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
  ctx.fillStyle = theme.fieldObstacleFill;
  for (const band of blockingBands(field, input.robotHeightIn)) {
    tracePolygon(ctx, view, band.polygonIn);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * The hives at the playback time, then the structure over them: the paint order the canvas uses.
 * Returns `drawHives`'s summary for the canvas to publish.
 */
export function drawHiveLevel(ctx: CanvasRenderingContext2D, hives: HiveDrawInput, structure: StructureLayerInput): string {
  const summary = drawHives(ctx, hives);
  drawStructure(ctx, structure);
  return summary;
}

/** The bands as drawn, for tests and bug reports: `id:x,y x,y ...` in field inches, joined by `;`. */
export const bandSummary = (bands: readonly StructureShape[]): string =>
  bands
    .map((band) => `${band.id}:${band.polygonIn.map((corner) => `${corner.xIn.toFixed(2)},${corner.yIn.toFixed(2)}`).join(" ")}`)
    .join(";");
