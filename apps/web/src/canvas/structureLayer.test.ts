/**
 * Issue #230: the hive frame's legs on the field (`structureLayer.ts`). The part of each leg below
 * the robot's top is drawn as a blocking obstacle, exactly the shadow STRUCTURE checks against, and
 * it grows with the robot's height. It is painted after the hives, so a band that lies under a
 * hive's body is still seen. The full legs, the crossbar and an overhead hive envelope are dashed
 * outlines behind the Overhead outlines display option; turning that off never hides a band.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadField, obstacleShadowIn, type Vec2 } from "@horizon36596/zenith-core";
import type { Obstacle } from "@horizon36596/zenith-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { actionById } from "../app/actions";
import { DEFAULT_PREFS, loadPrefs } from "../state/prefs";
import { getState, initPrefs, toggleOverheadOutlines } from "../state/store";
import { drawStatic } from "./staticLayer";
import { blockingBands, drawHiveLevel, drawStructure, overheadShapes, type StructureLayerInput } from "./structureLayer";
import { fallbackTheme } from "./theme";
import { fitView, orientationFor, screenToWorld, type View } from "./view";

const read = (relative: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")) as unknown;

const field = loadField(read("../../../../examples/starter/autos/field/biobuzz.field.json"));
const theme = fallbackTheme();
const view: View = fitView({ minXIn: -72, minYIn: -72, maxXIn: 72, maxYIn: 72 }, 1440, 900, 24, orientationFor("bottom"));
const LEGS = ["frameLegNorthEast", "frameLegSouthEast", "frameLegNorthWest", "frameLegSouthWest"];

/** One painted shape: the path as it stood when it was filled or stroked, and the ink in force. */
interface Painted {
  op: "fill" | "stroke";
  points: Vec2[];
  rounded: boolean;
  fillStyle: string;
  strokeStyle: string;
  dashed: boolean;
}

/** A 2D context that records every fill and stroke with the path it painted, in field inches. */
function recordingContext(): { ctx: CanvasRenderingContext2D; painted: Painted[] } {
  const painted: Painted[] = [];
  let points: Vec2[] = [];
  let rounded = false;
  let dash: number[] = [];
  const state: Record<string, unknown> = { strokeStyle: "", fillStyle: "", globalAlpha: 1, lineWidth: 1 };
  const methods: Record<string, (...args: number[]) => void> = {
    beginPath: () => {
      points = [];
      rounded = false;
    },
    moveTo: (x, y) => points.push(screenToWorld(view, { xPx: x ?? 0, yPx: y ?? 0 })),
    lineTo: (x, y) => points.push(screenToWorld(view, { xPx: x ?? 0, yPx: y ?? 0 })),
    roundRect: () => {
      rounded = true;
    },
    fill: () => painted.push({ op: "fill", points: [...points], rounded, fillStyle: String(state["fillStyle"]), strokeStyle: String(state["strokeStyle"]), dashed: dash.length > 0 }),
    stroke: () => painted.push({ op: "stroke", points: [...points], rounded, fillStyle: String(state["fillStyle"]), strokeStyle: String(state["strokeStyle"]), dashed: dash.length > 0 }),
  };
  const ctx = new Proxy(state, {
    get(target, key: string) {
      if (key === "setLineDash") return (segments: number[]) => (dash = [...segments]);
      if (key in methods) return methods[key];
      if (key in target) return target[key];
      return () => undefined;
    },
    set(target, key: string, value: unknown) {
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, painted };
}

/** The shoelace area of a polygon, in square inches. */
const area = (polygon: readonly Vec2[]): number => {
  let twice = 0;
  for (const [index, a] of polygon.entries()) {
    const b = polygon[(index + 1) % polygon.length] as Vec2;
    twice += a.xIn * b.yIn - b.xIn * a.yIn;
  }
  return Math.abs(twice) / 2;
};

const input = (robotHeightIn: number, overheadOutlines?: boolean): StructureLayerInput => ({
  field,
  robotHeightIn,
  view,
  theme,
  ...(overheadOutlines === undefined ? {} : { overheadOutlines }),
});

const leg = (id: string): Obstacle => (field.obstacles ?? []).find((obstacle) => obstacle.id === id) as Obstacle;

/** The filled bands drawn at a height: each fill in the obstacle fill with four corners. */
function bandsAt(robotHeightIn: number, overheadOutlines?: boolean): { bands: Painted[]; painted: Painted[] } {
  const { ctx, painted } = recordingContext();
  drawStructure(ctx, input(robotHeightIn, overheadOutlines));
  const bands = painted.filter((shape) => shape.op === "fill" && shape.fillStyle === theme.fieldObstacleFill && !shape.rounded);
  return { bands, painted };
}

const near = (a: readonly Vec2[], b: readonly Vec2[]): void => {
  expect(a).toHaveLength(b.length);
  for (const [index, point] of a.entries()) {
    expect(point.xIn).toBeCloseTo(b[index]?.xIn ?? NaN, 6);
    expect(point.yIn).toBeCloseTo(b[index]?.yIn ?? NaN, 6);
  }
};

describe("issue #230: the blocking band of each hive frame leg", () => {
  it("is each leg's shadow at the robot's height, and larger at 18 in than at 6 in", () => {
    for (const heightIn of [6, 18]) {
      const { bands } = bandsAt(heightIn);
      expect(bands, `at ${String(heightIn)} in`).toHaveLength(LEGS.length);
      for (const [index, id] of LEGS.entries()) {
        const shadow = obstacleShadowIn(leg(id), heightIn) as Vec2[];
        near(bands[index]?.points ?? [], shadow);
        expect(area(bands[index]?.points ?? [])).toBeCloseTo(area(shadow), 6);
      }
    }
    const low = bandsAt(6).bands;
    const high = bandsAt(18).bands;
    for (const index of LEGS.keys()) expect(area(high[index]?.points ?? [])).toBeGreaterThan(area(low[index]?.points ?? []));
  });

  it("is filled like any blocking obstacle and stroked in the obstacle ink", () => {
    const { painted } = bandsAt(18);
    const solid = painted.filter((shape) => !shape.dashed);
    expect(solid.filter((shape) => shape.op === "fill").every((shape) => shape.fillStyle === theme.fieldObstacleFill)).toBe(true);
    expect(solid.filter((shape) => shape.op === "stroke")).toHaveLength(LEGS.length);
    expect(solid.every((shape) => shape.strokeStyle === theme.fieldObstacle)).toBe(true);
  });

  it("names the four legs, in field order, and nothing that is not a strut", () => {
    expect(blockingBands(field, 18).map((band) => band.id)).toEqual(LEGS);
  });

  it("is painted after the hive bodies", () => {
    const { ctx, painted } = recordingContext();
    drawHiveLevel(
      ctx,
      { ledger: null, trace: null, field, timeS: 0, view, mirror: "none", theme },
      input(18),
    );
    const lastHive = painted.map((shape) => shape.rounded).lastIndexOf(true);
    const firstBand = painted.findIndex((shape) => shape.op === "fill" && !shape.rounded && shape.fillStyle === theme.fieldObstacleFill);
    expect(lastHive).toBeGreaterThanOrEqual(0);
    expect(firstBand).toBeGreaterThan(lastHive);
  });

  it("is not drawn by the static layer, which leaves it to the layer above the hives", () => {
    const { ctx, painted } = recordingContext();
    drawStatic(ctx, { field, waypoints: null, robotHeightIn: 18, view, theme, widthPx: 1440, heightPx: 900 });
    const shadows = LEGS.map((id) => obstacleShadowIn(leg(id), 18) as Vec2[]);
    const drawsBand = painted.some((shape) =>
      shadows.some((shadow) => shape.points.length === 4 && shape.points.every((point, index) => Math.abs(point.xIn - (shadow[index]?.xIn ?? NaN)) < 1e-6)),
    );
    expect(drawsBand).toBe(false);
  });
});

describe("issue #230: the overhead outlines display option", () => {
  it("draws each full leg and the overhead hive envelopes dashed when on, and on is the default", () => {
    const shapes = overheadShapes(field, 18);
    expect(shapes.map((shape) => shape.id)).toEqual(["hiveRedPivotBar", "hiveBluePivotBar", ...LEGS]);
    // A full leg is its shadow at a height above its top.
    const full = obstacleShadowIn(leg("frameLegNorthEast"), 100) as Vec2[];
    near(shapes.find((shape) => shape.id === "frameLegNorthEast")?.polygonIn ?? [], full);

    for (const option of [undefined, true]) {
      const dashed = bandsAt(18, option).painted.filter((shape) => shape.dashed && shape.op === "stroke");
      expect(dashed, String(option)).toHaveLength(shapes.length);
    }
  });

  it("leaves an envelope the robot is too tall to pass under to the hive body", () => {
    expect(overheadShapes(field, 26).map((shape) => shape.id)).toEqual(LEGS);
  });

  it("turned off removes the dashed outlines but not the bands", () => {
    const off = bandsAt(18, false);
    expect(off.painted.filter((shape) => shape.dashed)).toEqual([]);
    expect(off.bands).toHaveLength(LEGS.length);
  });

  it("turned off also leaves the crossbar out of the static layer", () => {
    const dashedIn = (overheadOutlines: boolean | undefined): number => {
      const { ctx, painted } = recordingContext();
      drawStatic(ctx, {
        field,
        waypoints: null,
        robotHeightIn: 18,
        view,
        theme,
        widthPx: 1440,
        heightPx: 900,
        ...(overheadOutlines === undefined ? {} : { overheadOutlines }),
      });
      return painted.filter((shape) => shape.dashed && shape.strokeStyle === theme.fieldObstacle).length;
    };
    expect(dashedIn(undefined)).toBeGreaterThan(0);
    expect(dashedIn(true)).toBe(dashedIn(undefined));
    expect(dashedIn(false)).toBe(0);
  });
});

describe("issue #230: the overhead outlines preference", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
      },
    };
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("loads as on when it is unset, including from prefs saved before it existed", () => {
    expect(DEFAULT_PREFS.overheadOutlines).toBe(true);
    expect(loadPrefs().overheadOutlines).toBe(true);
    store.set("zenith.ui", JSON.stringify({ version: 1, theme: "light" }));
    expect(loadPrefs().overheadOutlines).toBe(true);
  });

  it("round-trips false, and the action shows and toggles it", () => {
    store.set("zenith.ui", JSON.stringify({ ...DEFAULT_PREFS, overheadOutlines: false }));
    expect(loadPrefs().overheadOutlines).toBe(false);
    // `initPrefs` applies the theme to the document, which a node test does not have.
    (globalThis as { document?: unknown }).document = { documentElement: { dataset: {} } };
    try {
      initPrefs();
      const action = actionById("view.overheadOutlines");
      expect(action?.active?.(getState())).toBe(false);
      toggleOverheadOutlines();
      expect(getState().prefs.overheadOutlines).toBe(true);
      expect(JSON.parse(store.get("zenith.ui") ?? "{}").overheadOutlines).toBe(true);
      expect(action?.active?.(getState())).toBe(true);
      toggleOverheadOutlines();
      expect(loadPrefs().overheadOutlines).toBe(false);
      expect((action?.does ?? "").length).toBeLessThanOrEqual(100);
    } finally {
      delete (globalThis as { document?: unknown }).document;
    }
  });
});
