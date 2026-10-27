import { parseAuto, parseField, parseRobot, SCHEMA_ID, type Auto, type Field, type PathStep, type Robot } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { testField, testRobot } from "../testing/fixtures.js";
import type { Vec2 } from "../geometry/vec.js";
import { canonicalAuto, routeEndsOf, stepGeometry } from "./candidate.js";
import { clearanceWorld } from "./clearance.js";
import { createFinalCheck, MAX_ALTERNATIVES } from "./final.js";
import { routeAngles, routeClassOf, sameRouteClass } from "./homotopy.js";
import { runOptimize } from "./index.js";
import { createObjective, type ObjectiveInput } from "./objective.js";
import { resolve } from "../resolve.js";

/**
 * The alternatives Optimize path offers beside its pick (issue #310): up to `MAX_ALTERNATIVES` more
 * routes, each of which passed the hard final check, with the routes that go round the obstacles
 * another way listed first. A route's way round is its homotopy class: the side it passes each
 * structure and keep-out on, read from the angle it sweeps as seen from the obstacle's middle, the rule
 * the visibility seeds already merge by.
 */

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const robot: Robot = parseRobot({ ...clone(testRobot), heightIn: { value: 12, provenance: "PLACEHOLDER: test fixture" } });

const fieldWith = (obstacles: unknown[]): Field => parseField({ ...clone(testField), obstacles, zones: [] });

const post = (minX: number, maxX: number, minY: number, maxY: number): Record<string, unknown> => ({
  id: "post",
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

const autoOf = (start: { xIn: number; yIn: number; headingRad: number }, route: Record<string, unknown>): Auto =>
  canonicalAuto(
    parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 4,
      name: "alternatives",
      alliance: "RED",
      start: { pose: start },
      steps: [{ id: "route", kind: "path", ...route }],
    }),
  ).auto;

describe("a route's way round the obstacles", () => {
  const world = clearanceWorld(robot, fieldWith([post(-4, 4, -3, 3)]));
  const north: Vec2[] = [
    { xIn: -48, yIn: 0 },
    { xIn: 0, yIn: 20 },
    { xIn: 48, yIn: 0 },
  ];
  const farNorth: Vec2[] = [
    { xIn: -48, yIn: 0 },
    { xIn: -10, yIn: 40 },
    { xIn: 10, yIn: 30 },
    { xIn: 48, yIn: 0 },
  ];
  const south: Vec2[] = north.map((point) => ({ xIn: point.xIn, yIn: -point.yIn }));

  it("is the same for two routes that pass every obstacle on the same side", () => {
    expect(sameRouteClass(routeAngles(world, north), routeAngles(world, farNorth))).toBe(true);
  });

  it("differs for two routes that pass an obstacle on different sides", () => {
    expect(sameRouteClass(routeAngles(world, north), routeAngles(world, south))).toBe(false);
  });

  it("reads a path step's own geometry, so an emitted route can be compared before it is checked", () => {
    const auto = autoOf(
      { xIn: -48, yIn: 0, headingRad: 0 },
      {
        segments: [{ kind: "bezier", from: "current", control: [{ xIn: 0, yIn: 30 }], to: { xIn: 48, yIn: 0 } }],
        heading: { mode: "tangent" },
      },
    );
    const resolved = resolve(auto, undefined, robot).steps[0];
    if (resolved === undefined) throw new Error("expected the route");
    const ends = routeEndsOf(resolved);
    const step = auto.steps[0] as PathStep;
    expect(typeof stepGeometry(step, ends)).not.toBe("string");
    const angles = routeClassOf(world, step, ends);
    expect(angles).not.toBeNull();
    expect(sameRouteClass(angles ?? [], routeAngles(world, north))).toBe(true);
  });
});

describe("the alternatives beside the pick", () => {
  // A straight line, the fastest route there is, drives through a post that reaches further north
  // than south, so every start of the search goes round its south side and the way round its north
  // side is left to a seed.
  const auto = autoOf(
    { xIn: -48, yIn: 0, headingRad: 0 },
    { segments: [{ kind: "line", from: "current", to: { xIn: 48, yIn: 0 } }], heading: { mode: "constant", headingRad: 0 } },
  );
  const field = fieldWith([post(-4, 4, -3, 12)]);
  const input: ObjectiveInput = { auto, robot, field, stepId: "route" };
  const result = runOptimize(input, { budget: 120, scorer: "estimate", routeAround: true });
  const world = clearanceWorld(robot, field);
  const resolved = resolve(auto, undefined, robot).steps[0];
  if (resolved === undefined) throw new Error("expected the route");
  const ends = routeEndsOf(resolved);

  it("offers the pick and up to two alternatives, and one goes round the other side of the post", () => {
    expect(result.status).toBe("improved");
    const pick = result.pick;
    if (pick === null) throw new Error("expected a route around the post");
    expect(result.alternatives.length).toBeGreaterThan(0);
    expect(result.alternatives.length).toBeLessThanOrEqual(MAX_ALTERNATIVES);
    const pickClass = routeClassOf(world, pick.step, ends) ?? [];
    const first = result.alternatives[0];
    if (first === undefined) throw new Error("expected an alternative");
    expect(sameRouteClass(pickClass, routeClassOf(world, first.step, ends) ?? [])).toBe(false);
  }, 120_000);

  it("offers only routes that pass the hard final check on their own", () => {
    const check = createFinalCheck(input, createObjective(input, { marginIn: result.marginIn, scorer: result.scorer }), { routeAround: true });
    for (const route of [result.pick, ...result.alternatives]) {
      if (route === null) continue;
      expect(check.verify(route.step).ok, JSON.stringify(route.step.segments)).toBe(true);
    }
  }, 120_000);

  it("never offers two routes that are the same step", () => {
    const keys = [result.pick, ...result.alternatives].filter((route) => route !== null).map((route) => JSON.stringify(route?.step));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
