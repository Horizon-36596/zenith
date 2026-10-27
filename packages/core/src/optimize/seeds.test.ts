import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  FORMAT_VERSIONS,
  parseAuto,
  parseField,
  parseRobot,
  SCHEMA_ID,
  type Field,
  type PathStep,
  type Robot,
} from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { angleDelta } from "../geometry/angle.js";
import { makeCurve } from "../geometry/curve.js";
import { distance, type Vec2 } from "../geometry/vec.js";
import { loadAuto, loadField, loadLink, loadRobot, loadWaypoints } from "../load.js";
import { resolve, type ResolvedStep } from "../resolve.js";
import { testField, testRobot } from "../testing/fixtures.js";
import { emitStep, MIN_CANDIDATE_LENGTH_IN, routeEndsOf } from "./candidate.js";
import { clearanceWorld } from "./clearance.js";
import {
  candidateFromSeed,
  FILLET_FALLBACK_ALLOWANCES_IN,
  footprintHalfWidthIn,
  geometrySeeds,
  kShortestRoutes,
  mergeSameSide,
  visibilityGraph,
  YEN_ROUTE_COUNT,
  type GeometrySeed,
  type GeometrySeeds,
  type SeedInput,
} from "./seeds.js";
import { FILLET_ALLOWANCE_IN, smoothPolyline, type ChainPiece } from "./smooth.js";

/**
 * The seed tests use small hand-built worlds: an 18 in square robot, a 2 in post at the field's
 * centre, S 40 in to its left and E 40 in to its right, so the margin (1 in) plus the half-width
 * (9 in) grows the post to a 22 in square with its corners at (+-11, +-11). Every case is a fixed
 * value; nothing is random. The determinism test also runs over every path step of
 * `examples/starter`.
 */

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const robot: Robot = parseRobot({
  ...clone(testRobot),
  heightIn: { value: 12, provenance: "PLACEHOLDER: test fixture" },
  footprint: {
    startIn: { lengthIn: 18, widthIn: 18, provenance: "PLACEHOLDER: test fixture" },
    expandedIn: { lengthIn: 18, widthIn: 18, provenance: "PLACEHOLDER: test fixture" },
    centreOfRotationIn: { xIn: 0, yIn: 0 },
  },
});

const box = (id: string, minX: number, maxX: number, minY: number, maxY: number) => ({
  id,
  kind: "box",
  minXIn: minX,
  maxXIn: maxX,
  minYIn: minY,
  maxYIn: maxY,
  minZIn: 0,
  maxZIn: 10,
  solidToRobot: true,
  provenance: "PLACEHOLDER: test fixture",
});

function fieldWith(obstacles: unknown[], zones: unknown[] = []): Field {
  return parseField({ ...clone(testField), obstacles, zones });
}

const postField = fieldWith([box("post", -1, 1, -1, 1)]);

function resolvedRoute(route: Record<string, unknown>, start = { xIn: -40, yIn: 0, headingRad: 0 }): ResolvedStep {
  const auto = parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: FORMAT_VERSIONS.auto,
    name: "seeds-fixture",
    alliance: "RED",
    start: { pose: start },
    steps: [{ id: "route", kind: "path", ...route }],
  });
  return resolve(auto).steps[0] as ResolvedStep;
}

/** The step the optimizer would be asked to re-route: straight through the post. */
const throughPost = {
  segments: [{ kind: "line", from: "current", to: { xIn: 40, yIn: 0 } }],
  heading: { mode: "constant", headingRad: 0 },
};

const input = (overrides: Partial<SeedInput> = {}): SeedInput => ({
  resolved: resolvedRoute(throughPost),
  robot,
  field: postField,
  marginIn: 1,
  maxPaths: 4,
  ...overrides,
});

/** The distance from a point to a polyline. */
function polylineDistance(point: Vec2, polyline: readonly Vec2[]): number {
  let nearest = Infinity;
  for (let i = 0; i + 1 < polyline.length; i += 1) {
    const a = polyline[i] as Vec2;
    const b = polyline[i + 1] as Vec2;
    const dx = b.xIn - a.xIn;
    const dy = b.yIn - a.yIn;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point.xIn - a.xIn) * dx + (point.yIn - a.yIn) * dy) / lengthSquared));
    nearest = Math.min(nearest, Math.hypot(point.xIn - a.xIn - t * dx, point.yIn - a.yIn - t * dy));
  }
  return nearest;
}

const startDirection = (piece: ChainPiece): number =>
  Math.atan2(
    (piece.pointsIn[1] as Vec2).yIn - (piece.pointsIn[0] as Vec2).yIn,
    (piece.pointsIn[1] as Vec2).xIn - (piece.pointsIn[0] as Vec2).xIn,
  );
const endDirection = (piece: ChainPiece): number => {
  const p = piece.pointsIn;
  const a = p[p.length - 2] as Vec2;
  const b = p[p.length - 1] as Vec2;
  return Math.atan2(b.yIn - a.yIn, b.xIn - a.xIn);
};

/**
 * Every sampled point of every piece lies within the piece's closed-form bound of the polyline, and
 * the bound within the allowance: the fillet allowance, or the fallback the seed was smoothed at.
 */
function expectWithinAllowance(pieces: readonly ChainPiece[], polyline: readonly Vec2[], allowanceIn = FILLET_ALLOWANCE_IN): void {
  for (const piece of pieces) {
    expect(piece.deviationBoundIn).toBeLessThanOrEqual(allowanceIn);
    const curve = makeCurve(piece.pointsIn);
    for (let i = 0; i <= 200; i += 1) {
      expect(polylineDistance(curve.pointAt(i / 200), polyline)).toBeLessThanOrEqual(piece.deviationBoundIn + 1e-9);
    }
  }
}

/** Interior joints are G1: each piece leaves along the direction the one before it arrives on. */
function expectG1(pieces: readonly ChainPiece[]): void {
  for (let k = 0; k + 1 < pieces.length; k += 1) {
    const before = pieces[k] as ChainPiece;
    const after = pieces[k + 1] as ChainPiece;
    expect(distance(before.pointsIn[before.pointsIn.length - 1] as Vec2, after.pointsIn[0] as Vec2)).toBe(0);
    expect(Math.abs(angleDelta(endDirection(before), startDirection(after)))).toBeLessThan(1e-9);
  }
}

const visibilitySeeds = (result: GeometrySeeds): GeometrySeed[] => result.seeds.filter((seed) => seed.family === "visibility");

describe("geometrySeeds on one post between S and E", () => {
  it("returns G0, G1 and a left and a right G2 route, in a fixed order (snapshot)", () => {
    const result = geometrySeeds(input());
    // The straight line is the original here, so it is listed once, as G0.
    expect(result.seeds.map((seed) => seed.family)).toEqual(["original", "endTangentCubic", "visibility", "visibility"]);
    expect(result.skipped).toEqual([{ family: "straight", reason: "It is the same route as the original." }]);
    expect(
      visibilitySeeds(result).map((seed) => ({
        nodes: seed.route?.nodes,
        pointsIn: seed.route?.pointsIn,
        sides: seed.route?.sides,
        paths: seed.geometry.paths.map((path) => path.kind),
      })),
    ).toEqual([
      {
        nodes: [0, 2, 3, 1],
        pointsIn: [
          { xIn: -40, yIn: 0 },
          { xIn: -11, yIn: -11 },
          { xIn: 11, yIn: -11 },
          { xIn: 40, yIn: 0 },
        ],
        sides: [{ kind: "structure", id: "post", side: "left" }],
        paths: ["line", "cubic", "line"],
      },
      {
        nodes: [0, 5, 4, 1],
        pointsIn: [
          { xIn: -40, yIn: 0 },
          { xIn: -11, yIn: 11 },
          { xIn: 11, yIn: 11 },
          { xIn: 40, yIn: 0 },
        ],
        sides: [{ kind: "structure", id: "post", side: "right" }],
        paths: ["line", "cubic", "line"],
      },
    ]);
  });

  it("gives the two routes as mirror images of each other", () => {
    // The first goes round the post's left side and the second its right, as the snapshot above lists them.
    const [left, right] = visibilitySeeds(geometrySeeds(input())) as [GeometrySeed, GeometrySeed];
    expect(left.route?.sides.map((side) => side.side)).toEqual(["left"]);
    expect(right.route?.sides.map((side) => side.side)).toEqual(["right"]);
    expect(left.geometry.paths).toEqual(right.geometry.paths);
    left.geometry.jointsIn.forEach((joint, i) => {
      expect(joint.xIn).toBeCloseTo((right.geometry.jointsIn[i] as Vec2).xIn, 9);
      expect(joint.yIn).toBeCloseTo(-(right.geometry.jointsIn[i] as Vec2).yIn, 9);
    });
    left.geometry.tangentsRad.forEach((tangent, i) => expect(tangent).toBeCloseTo(-(right.geometry.tangentsRad[i] as number), 9));
  });

  it("skips the straight line and the end-tangent cubic for a route whose start and end are the same point", () => {
    const inPlace = resolvedRoute({
      segments: [{ kind: "line", from: "current", to: { xIn: -40, yIn: 0 } }],
      heading: { mode: "constant", headingRad: 0 },
    });
    const result = geometrySeeds(input({ resolved: inPlace }));
    const reasons = (family: string): string[] => result.skipped.filter((skip) => skip.family === family).map((skip) => skip.reason);
    expect(reasons("straight")).toEqual(["The route's start and end are the same point."]);
    expect(reasons("endTangentCubic")).toEqual(["The route's start and end are the same point."]);
    expect(result.seeds.some((seed) => seed.family === "straight" || seed.family === "endTangentCubic")).toBe(false);
  });

  it("throws for a path limit or a margin it cannot work with", () => {
    expect(() => geometrySeeds(input({ maxPaths: 0 }))).toThrow(/maxPaths/);
    expect(() => geometrySeeds(input({ maxPaths: 1.5 }))).toThrow(/maxPaths/);
    expect(() => geometrySeeds(input({ marginIn: -1 }))).toThrow(/margin/);
    expect(() => geometrySeeds(input({ marginIn: Number.NaN }))).toThrow(/margin/);
    expect(() => geometrySeeds(input({ marginIn: Number.POSITIVE_INFINITY }))).toThrow(/margin/);
    expect(geometrySeeds(input({ marginIn: 0 })).seeds.length).toBeGreaterThan(0);
  });

  it("finds three Yen routes and merges the one that passes the post on the same side as a shorter one", () => {
    const resolved = resolvedRoute(throughPost);
    const ends = routeEndsOf(resolved);
    const world = clearanceWorld(robot, postField);
    const graph = visibilityGraph(ends.startIn, ends.endIn, world, { marginIn: 1, halfWidthIn: footprintHalfWidthIn(robot) });
    expect(graph.nodesIn).toEqual([
      { xIn: -40, yIn: 0 },
      { xIn: 40, yIn: 0 },
      { xIn: -11, yIn: -11 },
      { xIn: 11, yIn: -11 },
      { xIn: 11, yIn: 11 },
      { xIn: -11, yIn: 11 },
    ]);
    const routes = kShortestRoutes(graph, YEN_ROUTE_COUNT);
    expect(YEN_ROUTE_COUNT).toBe(3);
    expect(routes.map((route) => route.nodes)).toEqual([
      [0, 2, 3, 1],
      [0, 5, 4, 1],
      // Four routes tie at 106 in; the tie goes by node index.
      [0, 2, 3, 4, 1],
    ]);
    expect(mergeSameSide(routes, graph).map((route) => route.nodes)).toEqual([
      [0, 2, 3, 1],
      [0, 5, 4, 1],
    ]);
  });

  it("starts a route from an end that sits inside the margin, but not through the post itself", () => {
    // S is 0.5 in from the post's face: closer than the 1 in margin, as a scoring pose may be.
    const resolved = resolvedRoute(throughPost, { xIn: -10.5, yIn: 0, headingRad: 0 });
    const seeds = visibilitySeeds(geometrySeeds(input({ resolved })));
    expect(seeds.map((seed) => seed.route?.sides[0]?.side)).toEqual(["left", "right"]);
    for (const seed of seeds) expect(seed.route?.pointsIn[0]).toEqual({ xIn: -10.5, yIn: 0 });
  });

  it("routes round a keep-out grown by the half-width alone, with no margin", () => {
    const field = fieldWith([], [{ id: "keep", kind: "rect", minXIn: -2, maxXIn: 2, minYIn: -2, maxYIn: 2, appliesInAuto: true }]);
    const seeds = visibilitySeeds(geometrySeeds(input({ field })));
    expect(seeds.map((seed) => seed.route?.pointsIn[1])).toEqual([
      { xIn: -11, yIn: -11 },
      { xIn: -11, yIn: 11 },
    ]);
    expect(seeds.map((seed) => seed.route?.sides)).toEqual([
      [{ kind: "keepOut", id: "keep", side: "left" }],
      [{ kind: "keepOut", id: "keep", side: "right" }],
    ]);
  });

  it("leaves out corners outside the field and corners inside another grown obstacle", () => {
    // A wall-hugging post: its lower corners are less than the half-width from the wall.
    const field = fieldWith([box("post", -1, 1, -66, 1), box("inner", 8, 10, 8, 10)]);
    const ends = routeEndsOf(resolvedRoute(throughPost));
    const graph = visibilityGraph(ends.startIn, ends.endIn, clearanceWorld(robot, field), {
      marginIn: 1,
      halfWidthIn: footprintHalfWidthIn(robot),
    });
    const usable = graph.nodesIn.filter((_, i) => graph.usable[i] === true);
    // The post's lower corners are past the wall; its top right corner is inside the grown inner
    // box, and the inner box's bottom left corner is inside the grown post.
    expect(usable).toEqual([
      { xIn: -40, yIn: 0 },
      { xIn: 40, yIn: 0 },
      { xIn: -11, yIn: 11 },
      { xIn: 20, yIn: -2 },
      { xIn: 20, yIn: 20 },
      { xIn: -2, yIn: 20 },
    ]);
  });
});

describe("smoothed seeds", () => {
  it("lie within the fillet allowance of their polylines, with G1 interior joints", () => {
    for (const maxPaths of [1, 2, 3, 4, 8]) {
      for (const field of [postField, fieldWith([box("a", -21, -19, -6, 6), box("b", 19, 21, -6, 6)])]) {
        for (const seed of visibilitySeeds(geometrySeeds(input({ field, maxPaths })))) {
          const pieces = seed.pieces as ChainPiece[];
          expect(pieces.length).toBeLessThanOrEqual(maxPaths);
          expectWithinAllowance(pieces, seed.route?.pointsIn as Vec2[]);
          expectG1(pieces);
        }
      }
    }
  });

  it("round a blocked original, smooth a route that does not fit maxPaths again at a fallback allowance (issue #388)", () => {
    let fallbacks = 0;
    for (const maxPaths of [1, 2, 3]) {
      for (const field of [postField, fieldWith([box("a", -21, -19, -6, 6), box("b", 19, 21, -6, 6)])]) {
        const plain = geometrySeeds(input({ field, maxPaths }));
        const blocked = geometrySeeds(input({ field, maxPaths, fallbackAllowances: true }));
        // The seeds the fillet allowance fits stay as they were; only skipped routes are added.
        expect(blocked.seeds.filter((seed) => seed.allowanceIn === undefined)).toStrictEqual(plain.seeds);
        for (const seed of visibilitySeeds(blocked)) {
          if (seed.allowanceIn === undefined) continue;
          fallbacks += 1;
          const pieces = seed.pieces as ChainPiece[];
          expect(FILLET_FALLBACK_ALLOWANCES_IN).toContain(seed.allowanceIn);
          // Only a route the fillet allowance could not fit to maxPaths is smoothed at a fallback.
          expect(smoothPolyline(seed.route?.pointsIn as Vec2[], { allowanceIn: FILLET_ALLOWANCE_IN, maxPaths }).ok).toBe(false);
          expect(pieces.length).toBeLessThanOrEqual(maxPaths);
          expectWithinAllowance(pieces, seed.route?.pointsIn as Vec2[], seed.allowanceIn);
          expectG1(pieces);
        }
      }
    }
    expect(fallbacks).toBeGreaterThan(0);
  });

  it("emit as routes emitStep accepts, with the chain's own joints and G1 in the saved bytes", () => {
    const resolved = resolvedRoute(throughPost);
    const ends = routeEndsOf(resolved);
    for (const seed of geometrySeeds(input()).seeds) {
      const emitted = emitStep(candidateFromSeed(seed, ends, { mode: "ranges", ranges: [{ mode: "linear", endT: 1 }] }), resolved.step as PathStep);
      expect(emitted.ok).toBe(true);
      if (!emitted.ok) continue;
      expect(emitted.step.segments.length).toBe(seed.geometry.paths.length);
      emitted.step.segments.slice(0, -1).forEach((segment, i) => {
        const joint = seed.geometry.jointsIn[i] as Vec2;
        const to = segment.to as Vec2;
        expect(Math.abs(to.xIn - joint.xIn)).toBeLessThanOrEqual(MIN_CANDIDATE_LENGTH_IN / 2 + 1e-12);
        expect(Math.abs(to.yIn - joint.yIn)).toBeLessThanOrEqual(MIN_CANDIDATE_LENGTH_IN / 2 + 1e-12);
      });
    }
  });
});

describe("maxPaths and the fillet kinds", () => {
  it("never gives a seed with more paths than maxPaths", () => {
    const twoPosts = fieldWith([box("a", -21, -19, -6, 6), box("b", 19, 21, -6, 6)]);
    const zigzag = {
      segments: [
        { kind: "line", from: "current", to: { xIn: -20, yIn: 30 } },
        { kind: "line", from: "current", to: { xIn: 0, yIn: -30 } },
        { kind: "line", from: "current", to: { xIn: 20, yIn: 30 } },
        { kind: "line", from: "current", to: { xIn: 40, yIn: 0 } },
      ],
      heading: { mode: "tangent" },
    };
    for (const maxPaths of [1, 2, 3, 4, 5]) {
      for (const field of [postField, twoPosts, testField]) {
        for (const route of [throughPost, zigzag]) {
          const result = geometrySeeds(input({ field, maxPaths, resolved: resolvedRoute(route) }));
          for (const seed of result.seeds) expect(seed.geometry.paths.length).toBeLessThanOrEqual(maxPaths);
        }
      }
    }
    const tooMany = geometrySeeds(input({ maxPaths: 3, resolved: resolvedRoute(zigzag) }));
    expect(tooMany.seeds.some((seed) => seed.family === "original")).toBe(false);
    expect(tooMany.skipped).toContainEqual({ family: "original", reason: "The original has 4 paths, more than the 3 allowed." });
  });

  it("fillets a lone corner with a quadratic, and makes a cubic only of fillets that touch", () => {
    // S level with the post's grown top edge: the route over the post has one corner, at (11, 11);
    // the route under it has two, 22 in apart, whose fillets touch.
    const resolved = resolvedRoute(throughPost, { xIn: -40, yIn: 11, headingRad: 0 });
    const seeds = visibilitySeeds(geometrySeeds(input({ resolved })));
    expect(
      seeds.map((seed) => ({
        corners: (seed.route?.pointsIn.length ?? 0) - 2,
        side: seed.route?.sides[0]?.side,
        paths: seed.geometry.paths.map((path) => path.kind),
      })),
    ).toEqual([
      { corners: 1, side: "right", paths: ["line", "quadratic", "line"] },
      { corners: 2, side: "left", paths: ["line", "cubic", "line"] },
    ]);
  });
});

describe("G0 and G1", () => {
  it("keeps the original's geometry as G0 when its joints are G1", () => {
    const route = {
      segments: [
        { kind: "bezier", from: "current", control: [{ xIn: -20, yIn: 20 }], to: { xIn: 0, yIn: 20 } },
        { kind: "bezier", from: "current", control: [{ xIn: 10, yIn: 20 }, { xIn: 30, yIn: 10 }], to: { xIn: 40, yIn: 0 } },
      ],
      heading: { mode: "tangent" },
    };
    const result = geometrySeeds(input({ resolved: resolvedRoute(route) }));
    const original = result.seeds[0] as GeometrySeed;
    expect(original.family).toBe("original");
    expect(original.geometry.jointsIn).toEqual([{ xIn: 0, yIn: 20 }]);
    expect(original.geometry.paths).toEqual([{ kind: "quadratic" }, { kind: "cubic", startHandleIn: 10, endHandleIn: Math.hypot(10, 10) }]);
    expect(original.geometry.tangentsRad[1]).toBeCloseTo(0, 12);
  });

  it("leaves G0 out, with a sentence, when the original has a corner between curves", () => {
    const route = {
      segments: [
        { kind: "bezier", from: "current", control: [{ xIn: -20, yIn: 20 }], to: { xIn: 0, yIn: 20 } },
        { kind: "bezier", from: "current", control: [{ xIn: 20, yIn: 30 }], to: { xIn: 40, yIn: 0 } },
      ],
      heading: { mode: "tangent" },
    };
    const result = geometrySeeds(input({ resolved: resolvedRoute(route) }));
    expect(result.seeds.some((seed) => seed.family === "original")).toBe(false);
    expect(result.skipped[0]?.family).toBe("original");
    expect(result.skipped[0]?.reason).toMatch(/^Joint 1 is a corner between curves/);
  });

  it("builds the straight line and the cubic whose end tangents are the S and E headings", () => {
    const route = {
      segments: [{ kind: "bezier", from: "current", control: [{ xIn: 0, yIn: 40 }], to: { xIn: 40, yIn: 0, headingRad: -0.5 } }],
      heading: { mode: "linear", fromRad: 0.5, toRad: -0.5 },
    };
    const resolved = resolvedRoute(route, { xIn: -40, yIn: 0, headingRad: 0.5 });
    const result = geometrySeeds(input({ resolved, field: fieldWith([]) }));
    const straight = result.seeds.find((seed) => seed.family === "straight");
    const cubic = result.seeds.find((seed) => seed.family === "endTangentCubic");
    expect(straight?.geometry).toEqual({ jointsIn: [], tangentsRad: [0, 0], paths: [{ kind: "line" }] });
    expect(cubic?.geometry.jointsIn).toEqual([]);
    expect(cubic?.geometry.tangentsRad).toEqual([0.5, -0.5]);
    const handles = cubic?.geometry.paths[0] as { kind: string; startHandleIn: number; endHandleIn: number };
    expect(handles.kind).toBe("cubic");
    expect(handles.startHandleIn).toBeCloseTo(80 / 3, 12);
    expect(handles.endHandleIn).toBeCloseTo(80 / 3, 12);
    // With nothing in the way, the visibility route is the straight line, which is not listed twice.
    expect(result.seeds.map((seed) => seed.family)).toEqual(["original", "straight", "endTangentCubic"]);
  });
});

describe("determinism", () => {
  const root = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
  const read = (relative: string): unknown => JSON.parse(readFileSync(`${root}${relative}`, "utf8"));

  function starterPathSteps(): { resolved: ResolvedStep; robot: Robot; field: Field }[] {
    const link = loadLink(read("zenith.json"));
    const starterRobot = loadRobot(read(link.robot));
    const field = loadField(read(link.field));
    const waypoints = loadWaypoints(read(link.waypoints ?? "autos/waypoints.json"));
    const out: { resolved: ResolvedStep; robot: Robot; field: Field }[] = [];
    const walk = (steps: readonly ResolvedStep[]): void => {
      for (const step of steps) {
        if (step.kind === "path" && step.segments !== undefined) out.push({ resolved: step, robot: starterRobot, field });
        if (step.children !== undefined) walk(step.children);
      }
    };
    for (const name of ["first-auto", "collect-and-score", "all-step-kinds", "cycle-and-park"]) {
      walk(resolve(loadAuto(read(`autos/${name}.auto.json`)), waypoints, starterRobot).steps);
    }
    return out;
  }

  it("gives deep-equal seeds on two runs, over the fixtures and every starter path step", () => {
    const cases: SeedInput[] = [
      input(),
      input({ maxPaths: 2 }),
      input({ field: testField }),
      ...starterPathSteps().map(({ resolved, robot: starterRobot, field }) => ({
        resolved,
        robot: starterRobot,
        field,
        marginIn: 1,
        maxPaths: 4,
      })),
    ];
    expect(cases.length).toBeGreaterThan(5);
    for (const seedInput of cases) {
      const first = geometrySeeds(seedInput);
      const second = geometrySeeds(seedInput);
      expect(second).toStrictEqual(first);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
      for (const seed of first.seeds) {
        expect(seed.geometry.paths.length).toBeLessThanOrEqual(4);
        if (seed.pieces !== undefined) {
          expectG1(seed.pieces);
          if (seed.route !== undefined) expectWithinAllowance(seed.pieces, seed.route.pointsIn, seed.allowanceIn);
        }
      }
    }
  });
});
