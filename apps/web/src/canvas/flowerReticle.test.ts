/**
 * The static layer draws each flower as a single ring (issue #227). The aqua scoring reticle that
 * used to sit on top of it, two rings and four ticks, is gone; the field file's `targets` stay as
 * data, and the hive pivot marks and the projection preview still use the aqua ink.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadField } from "@horizon36596/zenith-core";
import { describe, expect, it } from "vitest";
import { drawStatic } from "./staticLayer";
import { fallbackTheme } from "./theme";
import { fitView, orientationFor, worldToScreen } from "./view";

const read = (relative: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")) as unknown;

const field = loadField(read("../../../../examples/starter/autos/field/biobuzz.field.json"));

interface Call {
  op: string;
  args: number[];
  stroke: string;
  fill: string;
}

/** A 2D context that records every path call and the stroke colour in force when it was made. */
function recordingContext(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  const state: Record<string, unknown> = { strokeStyle: "", fillStyle: "" };
  const ctx = new Proxy(state, {
    get(target, key: string) {
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        calls.push({ op: key, args: args.filter((arg): arg is number => typeof arg === "number"), stroke: String(target["strokeStyle"]), fill: String(target["fillStyle"]) });
      };
    },
    set(target, key: string, value: unknown) {
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const WIDTH_PX = 1440;
const HEIGHT_PX = 900;
const view = fitView({ minXIn: -72, minYIn: -72, maxXIn: 72, maxYIn: 72 }, WIDTH_PX, HEIGHT_PX, 24, orientationFor("bottom"));
const theme = fallbackTheme();

describe("the flowers on the field", () => {
  const { ctx, calls } = recordingContext();
  drawStatic(ctx, { field, waypoints: null, robotHeightIn: 14, view, theme, widthPx: WIDTH_PX, heightPx: HEIGHT_PX });

  const flowers = (field.elements ?? []).filter((element) => /^flower\d$/.test(element.id));
  const holes = new Map((field.targets ?? []).map((target) => [(target as { element?: string }).element, target] as const));

  it("finds the four flowers and the top target each one names", () => {
    expect(flowers).toHaveLength(4);
    for (const flower of flowers) expect(holes.has(flower.id), flower.id).toBe(true);
  });

  it("draws one ring on each flower, sized from the hole radius, and no other arc on it", () => {
    for (const flower of flowers) {
      const centre = worldToScreen(view, { xIn: flower.xIn ?? 0, yIn: flower.yIn ?? 0 });
      const radiusIn = (holes.get(flower.id) as unknown as { radiusIn: number }).radiusIn;
      const arcs = calls.filter(
        (call) =>
          call.op === "arc" && Math.abs((call.args[0] ?? 0) - centre.xPx) < 0.01 && Math.abs((call.args[1] ?? 0) - centre.yPx) < 0.01,
      );
      expect(arcs, flower.id).toHaveLength(1);
      expect(arcs[0]?.args[2]).toBeCloseTo(Math.max(3, radiusIn * view.pxPerIn), 6);
    }
  });

  it("draws no tick or line within a reticle's reach of a flower", () => {
    // Each flower stands on the wall at a tile seam, so the floor's tabbed seam (issue #428) runs
    // under it, in the seams' own ink; that is the floor, not a reticle.
    for (const flower of flowers) {
      const centre = worldToScreen(view, { xIn: flower.xIn ?? 0, yIn: flower.yIn ?? 0 });
      const near = calls.filter(
        (call) =>
          (call.op === "moveTo" || call.op === "lineTo") &&
          call.stroke !== theme.gridMajor &&
          Math.hypot((call.args[0] ?? 1e9) - centre.xPx, (call.args[1] ?? 1e9) - centre.yPx) < 14,
      );
      expect(near, flower.id).toEqual([]);
    }
  });

  it("paints nothing at a flower in the aqua ink, by stroke or by fill", () => {
    for (const flower of flowers) {
      const centre = worldToScreen(view, { xIn: flower.xIn ?? 0, yIn: flower.yIn ?? 0 });
      const atFlower = (call: Call): boolean =>
        call.args.length >= 2 &&
        Math.hypot((call.args[0] ?? 1e9) - centre.xPx, (call.args[1] ?? 1e9) - centre.yPx) < 14;
      // A path call at the flower, then the stroke or fill that follows it, takes the colour in force.
      const pathOps = new Set(["arc", "moveTo", "lineTo", "rect"]);
      const aquaPath = calls.filter(
        (call) => pathOps.has(call.op) && atFlower(call) && (call.stroke === theme.fieldTarget || call.fill === theme.fieldTarget),
      );
      expect(aquaPath, flower.id).toEqual([]);
    }
  });

  it("paints nothing anywhere in the static layer in the aqua ink", () => {
    // The hive pivot marks and the projection preview draw aqua elsewhere, not in this layer.
    const aqua = calls.filter(
      (call) => (call.op === "stroke" && call.stroke === theme.fieldTarget) || (call.op === "fill" && call.fill === theme.fieldTarget),
    );
    expect(aqua).toEqual([]);
  });
});
