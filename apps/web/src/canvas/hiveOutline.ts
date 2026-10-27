/**
 * A hive in the static layer, for a season the canvas has no hive drawing for: its pivot and a tick
 * toward the side whose cell is up. A BIOBUZZ hive is not drawn here at all: `hiveLayer.ts` draws its
 * body, cells, swing and pieces at the playback time, over the static field.
 */
import type { Vec2 } from "@horizon36596/zenith-core";
import type { FieldElement } from "@horizon36596/zenith-schema";
import type { CanvasTheme } from "./theme.js";
import { worldToScreen, type View } from "./view.js";

const UP_SIDE_DIRECTION: Readonly<Record<string, Vec2>> = {
  NORTH: { xIn: 0, yIn: 1 },
  SOUTH: { xIn: 0, yIn: -1 },
  EAST: { xIn: 1, yIn: 0 },
  WEST: { xIn: -1, yIn: 0 },
};

/** The hive's pivot, from `pivotIn`, or its own `xIn`/`yIn`. */
export function hivePivot(hive: FieldElement): Vec2 | null {
  const pivot = (hive as unknown as Record<string, unknown>)["pivotIn"];
  if (typeof pivot === "object" && pivot !== null) {
    const record = pivot as Record<string, unknown>;
    if (typeof record["xIn"] === "number" && typeof record["yIn"] === "number") {
      return { xIn: record["xIn"], yIn: record["yIn"] };
    }
  }
  return hive.xIn !== undefined && hive.yIn !== undefined ? { xIn: hive.xIn, yIn: hive.yIn } : null;
}

/** The pivot and a tick toward the up side. */
export function drawHivePivot(ctx: CanvasRenderingContext2D, view: View, theme: CanvasTheme, hive: FieldElement): void {
  const pivot = hivePivot(hive);
  if (pivot === null) return;
  const screen = worldToScreen(view, pivot);
  const radiusPx = Math.max(4, 3 * view.pxPerIn);
  ctx.strokeStyle = theme.fieldTarget;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(screen.xPx, screen.yPx, radiusPx, 0, Math.PI * 2);
  ctx.moveTo(screen.xPx - 3, screen.yPx);
  ctx.lineTo(screen.xPx + 3, screen.yPx);
  ctx.moveTo(screen.xPx, screen.yPx - 3);
  ctx.lineTo(screen.xPx, screen.yPx + 3);
  ctx.stroke();
  const up = UP_SIDE_DIRECTION[String((hive as unknown as Record<string, unknown>)["upSide"])];
  if (up === undefined) return;
  const tip = worldToScreen(view, { xIn: pivot.xIn + up.xIn * 9, yIn: pivot.yIn + up.yIn * 9 });
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(screen.xPx, screen.yPx);
  ctx.lineTo(tip.xPx, tip.yPx);
  ctx.stroke();
  ctx.lineWidth = 1;
}
