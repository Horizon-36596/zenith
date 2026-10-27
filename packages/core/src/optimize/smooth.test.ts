import { describe, expect, it } from "vitest";
import { angleDelta } from "../geometry/angle.js";
import { makeCurve } from "../geometry/curve.js";
import type { Vec2 } from "../geometry/vec.js";
import { MIN_CANDIDATE_LENGTH_IN } from "./candidate.js";
import {
  controlPolygonBoundIn,
  FILLET_ALLOWANCE_IN,
  hullDeviationBoundIn,
  polylineDistanceIn,
  smoothPolyline,
  type ChainPiece,
  type SmoothedChain,
} from "./smooth.js";

/**
 * Fillet smoothing on a fixed grid of polylines: single corners, corners whose fillets touch, an S
 * curve, a U-turn, a sharp V and a zigzag, each at several path limits. Nothing is random.
 */

const polyline = (...points: [number, number][]): Vec2[] => points.map(([xIn, yIn]) => ({ xIn, yIn }));

/** The size of a full-allowance fillet on a right angle. */
const RIGHT_ANGLE_FILLET_IN = (2 * (FILLET_ALLOWANCE_IN - MIN_CANDIDATE_LENGTH_IN / 2)) / Math.sin(Math.PI / 4);

const GRID: Vec2[][] = [
  polyline([0, 0], [30, 0], [30, 30]),
  polyline([0, 0], [30, 0], [30, 30], [60, 30]),
  polyline([0, 0], [40, 0], [80, 8], [120, 8]),
  polyline([0, 0], [40, 0], [80, 6], [120, 0]),
  polyline([0, 0], [40, 0], [77.588, 13.681], [108.229, 39.393]),
  polyline([0, 0], [30, 0], [30, 6], [0, 6]),
  polyline([0, 0], [30, 0], [0, 3]),
  polyline([0, 0], [40, 4], [80, 0], [120, 4]),
  polyline([0, 0], [10, 0], [17, 7], [17, 17], [10, 24], [0, 24]),
  polyline([-40, 0], [-11, 11], [11, 11], [40, 0]),
  polyline([-40, 11], [-11, -11], [11, -11], [40, 0]),
  // Right angles whose fillets fall short of each other, or of both ends, by less than the
  // canonical resolution, so each is stretched to meet.
  polyline([0, 0], [30, 0], [30, 2 * RIGHT_ANGLE_FILLET_IN + 0.0005], [60, 2 * RIGHT_ANGLE_FILLET_IN + 0.0005]),
  polyline([0, 0], [RIGHT_ANGLE_FILLET_IN + 0.0004, 0], [RIGHT_ANGLE_FILLET_IN + 0.0004, RIGHT_ANGLE_FILLET_IN + 0.0004]),
];

const smooth = (points: readonly Vec2[], maxPaths: number) => smoothPolyline(points, { allowanceIn: FILLET_ALLOWANCE_IN, maxPaths });

const kinds = (chain: SmoothedChain): string[] => chain.pieces.map((piece) => piece.kind);

const startDirection = (piece: ChainPiece): number => {
  const [a, b] = piece.pointsIn as [Vec2, Vec2];
  return Math.atan2(b.yIn - a.yIn, b.xIn - a.xIn);
};
const endDirection = (piece: ChainPiece): number => {
  const a = piece.pointsIn[piece.pointsIn.length - 2] as Vec2;
  const b = piece.pointsIn[piece.pointsIn.length - 1] as Vec2;
  return Math.atan2(b.yIn - a.yIn, b.xIn - a.xIn);
};

describe("smoothPolyline", () => {
  it("keeps every piece within its closed-form bound of the polyline, and every bound within the allowance", () => {
    let smoothed = 0;
    let refused = 0;
    for (const points of GRID) {
      for (const maxPaths of [1, 2, 3, 4, 8]) {
        const result = smooth(points, maxPaths);
        if (!result.ok) {
          refused += 1;
          continue;
        }
        smoothed += 1;
        for (const piece of result.chain.pieces) {
          expect(piece.deviationBoundIn).toBeLessThanOrEqual(FILLET_ALLOWANCE_IN);
          // A fillet's bound is the closed form |A - 2P + B| / 4 (Nairn, Peters and Lutterkort).
          if (piece.kind === "quadratic") expect(piece.deviationBoundIn).toBe(controlPolygonBoundIn(piece.pointsIn));
          if (piece.kind === "line") expect(piece.deviationBoundIn).toBe(0);
          const curve = makeCurve(piece.pointsIn);
          for (let i = 0; i <= 400; i += 1) {
            expect(polylineDistanceIn(curve.pointAt(i / 400), points)).toBeLessThanOrEqual(piece.deviationBoundIn + 1e-9);
          }
        }
      }
    }
    // The grid exercises both outcomes.
    expect(smoothed).toBeGreaterThan(20);
    expect(refused).toBeGreaterThan(10);
  });

  it("joins every piece to the next G1, from the polyline's start to its end", () => {
    for (const points of GRID) {
      for (const maxPaths of [3, 4, 8]) {
        const result = smooth(points, maxPaths);
        if (!result.ok) continue;
        const { pieces } = result.chain;
        expect(pieces[0]?.pointsIn[0]).toEqual(points[0]);
        expect(pieces[pieces.length - 1]?.pointsIn.at(-1)).toEqual(points[points.length - 1]);
        for (let k = 0; k + 1 < pieces.length; k += 1) {
          const before = pieces[k] as ChainPiece;
          const after = pieces[k + 1] as ChainPiece;
          expect(after.pointsIn[0]).toEqual(before.pointsIn[before.pointsIn.length - 1]);
          expect(Math.abs(angleDelta(endDirection(before), startDirection(after)))).toBeLessThan(1e-9);
        }
        // The geometry says the same as the pieces.
        const { geometry } = result.chain;
        expect(geometry.paths.map((path) => path.kind)).toEqual(kinds(result.chain));
        expect(geometry.jointsIn).toEqual(pieces.slice(1).map((piece) => piece.pointsIn[0]));
        expect(geometry.tangentsRad.length).toBe(pieces.length + 1);
        pieces.forEach((piece, k) => expect(geometry.tangentsRad[k]).toBeCloseTo(startDirection(piece), 12));
      }
    }
  });

  it("never returns more paths than maxPaths, and says why when it cannot fit", () => {
    for (const points of GRID) {
      for (const maxPaths of [1, 2, 3, 4, 5, 8]) {
        const result = smooth(points, maxPaths);
        if (result.ok) expect(result.chain.pieces.length).toBeLessThanOrEqual(maxPaths);
        else expect(result.reason).toMatch(/^The route needs \d+ paths to stay within 1\.5 in of its corners, more than the \d+ allowed\.$/);
      }
    }
  });

  it("prefers quadratic fillets, and makes a cubic only of fillets that touch or to fit maxPaths", () => {
    // Two right angles 30 in apart: two quadratics with a line between them, never a cubic.
    expect(kinds((smooth(GRID[1] as Vec2[], 8) as { chain: SmoothedChain }).chain)).toEqual([
      "line",
      "quadratic",
      "line",
      "quadratic",
      "line",
    ]);
    // A lone corner.
    expect(kinds((smooth(GRID[0] as Vec2[], 8) as { chain: SmoothedChain }).chain)).toEqual(["line", "quadratic", "line"]);
    // Two gentle turns the same way, 40 in apart: quadratics while five paths are allowed, one cubic
    // across the line between them when only four are.
    expect(kinds((smooth(GRID[4] as Vec2[], 8) as { chain: SmoothedChain }).chain)).toEqual([
      "line",
      "quadratic",
      "line",
      "quadratic",
      "line",
    ]);
    expect(kinds((smooth(GRID[4] as Vec2[], 4) as { chain: SmoothedChain }).chain)).toEqual(["line", "cubic", "line"]);
    // Two fillets that touch on an S bend merge into one cubic.
    expect(kinds((smooth(GRID[2] as Vec2[], 8) as { chain: SmoothedChain }).chain)).toEqual(["line", "cubic", "line"]);
    // Touching fillets whose cubic would stray past the allowance stay two quadratics.
    expect(kinds((smooth(GRID[3] as Vec2[], 8) as { chain: SmoothedChain }).chain)).toEqual([
      "line",
      "quadratic",
      "quadratic",
      "line",
    ]);
  });

  it("drops repeated points and straight-through corners, and refuses a route that turns back on itself", () => {
    const result = smooth(polyline([0, 0], [0, 0], [10, 0], [20, 0], [20, 0.0004], [30, 0]), 4);
    expect(result.ok && result.chain.polylineIn).toEqual(polyline([0, 0], [30, 0]));
    expect(result.ok && kinds(result.chain)).toEqual(["line"]);
    expect(smooth(polyline([0, 0], [30, 0], [10, 0]), 4)).toEqual({ ok: false, reason: "The route turns back on itself at corner 1." });
    expect(smooth(polyline([5, 5], [5, 5]), 4)).toEqual({ ok: false, reason: "The route's start and end are the same point." });
  });

  it("refuses a polyline with no start and end, and two corners too close to fillet", () => {
    expect(smooth([], 4)).toEqual({ ok: false, reason: "A route needs a start and an end." });
    expect(smooth(polyline([5, 5]), 4)).toEqual({ ok: false, reason: "A route needs a start and an end." });
    // Two right angles joined by a leg of 1.5 times the canonical resolution: the two fillets share
    // it, so each gets less than the resolution.
    const step = 1.5 * MIN_CANDIDATE_LENGTH_IN;
    expect(smooth(polyline([0, 0], [10, 0], [10, step], [20, step]), 4)).toEqual({
      ok: false,
      reason: "Corner 1 of the route is too close to the next one to be filleted.",
    });
  });

  it("throws for a path limit or an allowance it cannot work with", () => {
    const route = polyline([0, 0], [30, 0], [30, 30]);
    expect(() => smoothPolyline(route, { allowanceIn: FILLET_ALLOWANCE_IN, maxPaths: 0 })).toThrow(/maxPaths/);
    expect(() => smoothPolyline(route, { allowanceIn: FILLET_ALLOWANCE_IN, maxPaths: 2.5 })).toThrow(/maxPaths/);
    expect(() => smoothPolyline(route, { allowanceIn: MIN_CANDIDATE_LENGTH_IN / 2, maxPaths: 4 })).toThrow(/allowance/);
    expect(() => smoothPolyline(route, { allowanceIn: Number.NaN, maxPaths: 4 })).toThrow(/allowance/);
    expect(smoothPolyline(route, { allowanceIn: MIN_CANDIDATE_LENGTH_IN, maxPaths: 4 }).ok).toBe(true);
  });

  it("gives deep-equal chains on two runs", () => {
    for (const points of GRID) {
      for (const maxPaths of [1, 4, 8]) expect(smooth(points, maxPaths)).toStrictEqual(smooth(points, maxPaths));
    }
  });
});

describe("hullDeviationBoundIn", () => {
  it("never reads below the sampled distance, and is sharp to the canonical inch resolution", () => {
    const curves: Vec2[][] = [
      polyline([0, 0], [40, 0], [40, 40], [80, 40]),
      polyline([0, 0], [60, 30], [0, 30], [60, 0]),
      polyline([0, 0], [10, 20], [30, -20], [40, 0]),
    ];
    const target = polyline([0, 0], [40, 0], [40, 40], [80, 40]);
    for (const points of curves) {
      const curve = makeCurve(points);
      let sampled = 0;
      for (let i = 0; i <= 20000; i += 1) sampled = Math.max(sampled, polylineDistanceIn(curve.pointAt(i / 20000), target));
      const bound = hullDeviationBoundIn(points, target);
      expect(bound).toBeGreaterThanOrEqual(sampled - 1e-9);
      // The samples are a few thousandths of an inch apart, so they may miss the furthest point by a little.
      expect(bound - sampled).toBeLessThanOrEqual(2 * MIN_CANDIDATE_LENGTH_IN);
    }
  });
});
