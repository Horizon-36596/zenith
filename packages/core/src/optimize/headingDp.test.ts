import { parseAuto, parseField, parseRobot, SCHEMA_ID, type Field, type PathStep, type Robot } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { intakeTimeline, mouthHeadingRad } from "../checks/intake.js";
import { wrapAngle } from "../geometry/angle.js";
import { makePath, type PathGeometry } from "../geometry/path.js";
import type { Vec2 } from "../geometry/vec.js";
import { headingFunction, tangentHeading } from "../heading.js";
import { MIN_RANGE_T, roundRangeT } from "../headingRanges.js";
import { MOUTH_LEADING_TOLERANCE_RAD, robotLimits } from "../kinematics.js";
import { plan } from "../plan.js";
import { resolve } from "../resolve.js";
import { testField, testRobot } from "../testing/fixtures.js";
import { emitStep, rangesHeading, type CandidateRange, type RouteCandidate, type RouteEnds } from "./candidate.js";
import { clearanceWorld } from "./clearance.js";
import {
  constantFamily,
  DP_WORLD_HEADINGS,
  FIT_TOLERANCE_RAD,
  fitPedroModes,
  headingDp,
  headingLattice,
  headingSeeds,
  solveHeadingLattice,
  tangentFamily,
  type HeadingDpInput,
  type HeadingLattice,
} from "./headingDp.js";

/**
 * The heading dynamic program and its fit to Pedro's modes. Every route and every world here is fixed;
 * nothing is random. The lattices the brute force walks are kept small with `worldHeadings` so every
 * heading sequence can be enumerated.
 */

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const square: Robot = parseRobot({
  ...clone(testRobot),
  heightIn: { value: 12, provenance: "PLACEHOLDER: test fixture" },
  footprint: {
    startIn: { lengthIn: 6, widthIn: 6, provenance: "PLACEHOLDER: test fixture" },
    expandedIn: { lengthIn: 6, widthIn: 6, provenance: "PLACEHOLDER: test fixture" },
    centreOfRotationIn: { xIn: 0, yIn: 0 },
  },
});

/** The square robot with a mouth on its back and an intake command the timeline recognises. */
const backIntake: Robot = parseRobot({
  ...clone(square),
  mouths: [
    { id: "back", side: "BACK", offsetIn: { xIn: -3, yIn: 0 }, widthIn: 4, depthIn: 1, provenance: "PLACEHOLDER: test fixture" },
  ],
  commands: [
    {
      name: "setIntake",
      params: {
        side: { type: "enum", values: ["FRONT", "BACK", "BOTH"] },
        state: { type: "enum", values: ["STOP", "FORWARD", "REVERSE"] },
      },
      estimateS: "0",
      requires: ["intake"],
    },
  ],
});

const bar = (id: string, minX: number, maxX: number, minY: number, maxY: number) => ({
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

const fieldWith = (obstacles: unknown[]): Field => parseField({ ...clone(testField), obstacles, zones: [] });

const open = fieldWith([]);

const line = (from: Vec2, to: Vec2): PathGeometry => makePath([[from, to]]);

function input(
  geometry: PathGeometry,
  arrivalHeadingRad: number,
  endHeadingRad: number,
  extra: Partial<HeadingDpInput> = {},
  field: Field = open,
  robot: Robot = square,
): HeadingDpInput {
  const ends: RouteEnds = {
    startIn: geometry.pointAtDistance(0),
    endIn: geometry.pointAtDistance(geometry.lengthIn),
    arrivalHeadingRad,
    endHeadingRad,
  };
  return { geometry, ends, robot, world: clearanceWorld(robot, field), marginIn: 1, speedFraction: 0.8, ...extra };
}

/** The cheapest heading sequence by walking every one of them, left to right, as the DP adds. */
function bruteForce(lattice: HeadingLattice): number {
  const n = lattice.stations.length;
  let best = Infinity;
  const walk = (station: number, previous: number, costS: number): void => {
    if (station === n) {
      if (costS < best) best = costS;
      return;
    }
    const states = lattice.stations[station]?.states ?? [];
    for (let state = 0; state < states.length; state += 1) {
      if (!lattice.edgeAllowed(station - 1, previous, state)) continue;
      walk(station + 1, state, costS + lattice.edgeCostS(station - 1, previous, state));
    }
  };
  walk(1, 0, 0);
  return best;
}

describe("the heading dynamic program", () => {
  it("lays stations every 2 in plus every joint, with the arrival and E's heading pinned at the ends", () => {
    const geometry = makePath([
      [{ xIn: 20, yIn: 30 }, { xIn: 25, yIn: 30 }],
      [{ xIn: 25, yIn: 30 }, { xIn: 25, yIn: 33 }],
    ]);
    const lattice = headingLattice(input(geometry, 0.3, 1.2));
    const stationsIn = lattice.stations.map((station) => station.sIn);
    expect(stationsIn).toHaveLength(6);
    [0, 2, 4, 5, 6, 8].forEach((sIn, i) => expect(stationsIn[i]).toBeCloseTo(sIn, 9));
    expect(lattice.stations[0]?.states.map((state) => state.headingRad)).toEqual([0.3]);
    expect(lattice.stations[5]?.states.map((state) => state.headingRad)).toEqual([1.2]);
    // An interior station: 32 world headings, then the tangent family, E's heading and the arrival,
    // with repeats dropped. Along +x the tangent family repeats four world headings.
    const interior = lattice.stations[1]?.states.map((state) => state.headingRad) ?? [];
    expect(DP_WORLD_HEADINGS).toBe(32);
    expect(interior).toHaveLength(32 + 2);
    expect(interior.slice(-2)).toEqual([1.2, 0.3]);
  });

  const smallCases: { name: string; make: () => HeadingDpInput }[] = [
    {
      name: "a short line that has to turn a quarter",
      make: () => input(line({ xIn: 20, yIn: 30 }, { xIn: 26, yIn: 30 }), Math.PI / 2, 0, { worldHeadings: 4 }),
    },
    {
      name: "a curve with a bar beside it",
      make: () =>
        input(
          makePath([[{ xIn: 20, yIn: 30 }, { xIn: 24, yIn: 34 }, { xIn: 28, yIn: 32 }]]),
          -0.4,
          2.6,
          { worldHeadings: 4 },
          fieldWith([bar("bar", 22, 30, 39, 40)]),
        ),
    },
    {
      name: "a chain of two paths with a corner, slowed to 0.3",
      make: () =>
        input(
          makePath([
            [{ xIn: 20, yIn: 30 }, { xIn: 23, yIn: 30 }],
            [{ xIn: 23, yIn: 30 }, { xIn: 23, yIn: 35 }],
          ]),
          1,
          -2,
          { worldHeadings: 4, speedFraction: 0.3 },
        ),
    },
    {
      name: "a line driven with the back mouth running",
      make: () =>
        input(
          line({ xIn: 20, yIn: 30 }, { xIn: 27, yIn: 30 }),
          0,
          Math.PI,
          { worldHeadings: 4, running: new Map([["back", [{ fromT: 0.2, toT: Number.POSITIVE_INFINITY }]]]) },
          open,
          backIntake,
        ),
    },
  ];

  for (const { name, make } of smallCases) {
    it(`costs the same as enumerating every heading sequence: ${name}`, () => {
      const lattice = headingLattice(make());
      const sequences = lattice.stations.reduce((count, station) => count * station.states.length, 1);
      expect(sequences).toBeLessThan(200_000);
      const result = solveHeadingLattice(lattice);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.costS).toBe(bruteForce(lattice));
      // The cost is the sum of the edges along the sequence it returns, which obeys every edge rule.
      let sum = 0;
      for (let i = 0; i + 1 < result.stateIndices.length; i += 1) {
        const a = result.stateIndices[i] as number;
        const b = result.stateIndices[i + 1] as number;
        expect(lattice.edgeAllowed(i, a, b)).toBe(true);
        sum += lattice.edgeCostS(i, a, b);
      }
      expect(sum).toBe(result.costS);
    });
  }

  it("starts on the arrival heading, ends on E's and turns the short way", () => {
    const result = headingDp(input(line({ xIn: 20, yIn: 30 }, { xIn: 60, yIn: 30 }), 3, -3));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stations[0]?.headingRad).toBe(3);
    expect(result.stations[result.stations.length - 1]?.headingRad).toBe(-3);
    for (let i = 1; i < result.stations.length; i += 1) {
      const step = (result.stations[i]?.unwrappedRad as number) - (result.stations[i - 1]?.unwrappedRad as number);
      expect(Math.abs(step)).toBeLessThanOrEqual(Math.PI);
    }
  });

  it("refuses a turn whose swing between two stations reaches a bar that both stations clear", () => {
    // A 6 in square beside a bar 1.5 in off its face, driving along +y. Square at 0 and at pi/2 has
    // the same 1.5 in clearance, but half way round its corner pokes 1.24 in further out.
    const lattice = headingLattice(
      input(line({ xIn: 20, yIn: 30 }, { xIn: 20, yIn: 34 }), Math.PI / 2, Math.PI / 2, { worldHeadings: 4 }, fieldWith([bar("bar", 24.5, 26, 20, 44)])),
    );
    const states = lattice.stations[1]?.states ?? [];
    const east = states.findIndex((state) => state.headingRad === 0);
    const north = states.findIndex((state) => Math.abs(state.headingRad - Math.PI / 2) < 1e-12);
    expect(east).toBeGreaterThanOrEqual(0);
    expect(north).toBeGreaterThanOrEqual(0);
    expect(lattice.edgeAllowed(0, 0, north)).toBe(true);
    expect(lattice.edgeAllowed(0, 0, east)).toBe(false);
  });

  it("drops a state whose footprint fails the margin, and keeps the arrival when the start sits inside it", () => {
    // The start pose is 0.5 in off a bar: inside the 1 in margin, so the exemption leaving S applies.
    const world = fieldWith([bar("face", 23.5, 25, 20, 44)]);
    const result = headingDp(input(line({ xIn: 20, yIn: 30 }, { xIn: 8, yIn: 30 }), Math.PI, Math.PI, {}, world));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lattice = headingLattice(input(line({ xIn: 20, yIn: 30 }, { xIn: 8, yIn: 30 }), Math.PI, Math.PI, {}, world));
    const clearances = result.stateIndices.map(
      (state, i) => lattice.stations[i]?.states[state]?.structureClearancesIn[0] as number,
    );
    // Leaving S, the clearance never falls while it is under the margin, and the margin holds after.
    let leftRun = false;
    for (let i = 1; i < clearances.length; i += 1) {
      const now = clearances[i] as number;
      const before = clearances[i - 1] as number;
      if (before >= 1) leftRun = true;
      if (leftRun) expect(now).toBeGreaterThanOrEqual(1);
      else expect(now).toBeGreaterThanOrEqual(before);
    }
    // Away from the ends every kept state clears the margin.
    for (const station of lattice.stations.slice(3)) {
      for (const state of station.states) expect(state.structureClearancesIn[0]).toBeGreaterThanOrEqual(1);
    }
  });

  it("is infeasible, with the reason, when the step's own end overlaps a structure", () => {
    const result = headingDp(input(line({ xIn: 20, yIn: 30 }, { xIn: 40, yIn: 30 }), 0, 0, {}, fieldWith([bar("post", 18, 19, 29, 31)])));
    expect(result).toEqual({ ok: false, reason: "The step's own end overlaps post." });
  });

  it("names a running mouth in the reason only when one is live where no heading clears", () => {
    // A bar across the whole route empties a station for clearance alone; no intake runs.
    const geometry = line({ xIn: -60, yIn: 0 }, { xIn: 40, yIn: 0 });
    const blocked = headingDp(input(geometry, 0, 0, {}, fieldWith([bar("wall", -10, -9, -10, 10)])));
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.reason).toMatch(/^No heading at [\d.]+ in along the route keeps the footprint clear\.$/);

    // The same bar with the back intake running from the start does name the mouth.
    const running = new Map([["back", [{ fromT: 0, toT: Number.POSITIVE_INFINITY }]]]);
    const led = headingDp(input(geometry, Math.PI, Math.PI, { running }, fieldWith([bar("wall", -10, -9, -10, 10)]), backIntake));
    expect(led.ok).toBe(false);
    if (led.ok) return;
    expect(led.reason).toMatch(/^No heading at [\d.]+ in along the route keeps the footprint clear, with a running mouth leading\.$/);
  });

  it("keeps the running mouth within MOUTH_LEADING's tolerance over the intake stretch", () => {
    // An auto that starts the back intake a quarter of the way along a 40 in leg driven nose first.
    const auto = parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 1,
      name: "intake-fixture",
      alliance: "RED",
      start: { pose: { xIn: 20, yIn: 30, headingRad: 0 } },
      steps: [
        {
          id: "sweep",
          kind: "path",
          segments: [{ kind: "line", from: "current", to: { xIn: 60, yIn: 30 } }],
          heading: { mode: "tangent" },
          markers: [{ at: { t: 0.25 }, command: { name: "setIntake", args: { side: "BACK", state: "FORWARD" } } }],
        },
      ],
    });
    const planned = plan(resolve(auto), backIntake, open);
    const step = planned.steps[0];
    const running = intakeTimeline(planned.steps, backIntake).byStepId.get("sweep");
    expect(running?.get("back")).toEqual([{ fromT: 0.25, toT: Number.POSITIVE_INFINITY }]);
    const geometry = step?.geometry as PathGeometry;
    const dpInput = input(geometry, 0, 0, { running }, open, backIntake);
    const mouth = backIntake.mouths?.[0];
    if (mouth === undefined) throw new Error("The fixture robot has a back mouth.");
    const deviation = (headingRad: number, sIn: number): number => {
      const tangent = geometry.tangentAtDistance(sIn);
      return Math.abs(wrapAngle(mouthHeadingRad(mouth, headingRad) - Math.atan2(tangent.yIn, tangent.xIn)));
    };

    const lattice = headingLattice(dpInput);
    const interior = lattice.stations.slice(1, -1);
    const over = interior.filter((station) => station.t >= 0.25);
    expect(over.length).toBeGreaterThan(5);
    for (const station of over) {
      expect(station.states.length).toBeGreaterThan(0);
      for (const state of station.states) {
        expect(deviation(state.headingRad, station.sIn)).toBeLessThanOrEqual(MOUTH_LEADING_TOLERANCE_RAD + 1e-12);
      }
    }
    // Before the intake starts the robot may face any way.
    expect(interior.find((station) => station.t < 0.25)?.states).toHaveLength(32);

    const result = solveHeadingLattice(lattice);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const [i, station] of result.stations.entries()) {
      if (i === 0 || i === result.stations.length - 1 || station.t < 0.25) continue;
      expect(deviation(station.headingRad, station.sIn)).toBeLessThanOrEqual(MOUTH_LEADING_TOLERANCE_RAD + 1e-12);
    }
  });
});

/** A one-path candidate with the given heading ranges on a line or a curve between the geometry's ends. */
function candidateOn(polygon: readonly Vec2[], ends: RouteEnds, ranges: readonly CandidateRange[]): RouteCandidate {
  const first = polygon[0] as Vec2;
  const second = polygon[1] as Vec2;
  const last = polygon[polygon.length - 1] as Vec2;
  const beforeLast = polygon[polygon.length - 2] as Vec2;
  const isLine = polygon.length === 2;
  return {
    ends,
    jointsIn: [],
    tangentsRad: [
      Math.atan2(second.yIn - first.yIn, second.xIn - first.xIn),
      Math.atan2(last.yIn - beforeLast.yIn, last.xIn - beforeLast.xIn),
    ],
    paths: [
      isLine
        ? { kind: "line" }
        : {
            kind: "cubic",
            startHandleIn: Math.hypot(second.xIn - first.xIn, second.yIn - first.yIn),
            endHandleIn: Math.hypot(last.xIn - beforeLast.xIn, last.yIn - beforeLast.yIn),
          },
    ],
    heading: { mode: "ranges", ranges },
  };
}

const original = (polygon: readonly Vec2[]): PathStep => {
  const first = polygon[0] as Vec2;
  const last = polygon[polygon.length - 1] as Vec2;
  return {
    id: "leg",
    kind: "path",
    segments: [
      polygon.length === 2
        ? { kind: "line", from: { ...first }, to: { ...last } }
        : { kind: "bezier", from: { ...first }, control: polygon.slice(1, -1).map((point) => ({ ...point })), to: { ...last } },
    ],
    heading: { mode: "tangent" },
  };
};

/** Every rule a fitted heading must obey, through the emitter that writes it. */
function expectValidRanges(ranges: readonly CandidateRange[], polygon: readonly Vec2[], ends: RouteEnds): void {
  expect(ranges.length).toBeGreaterThan(0);
  expect(ranges[ranges.length - 1]?.endT).toBe(1);
  let startT = 0;
  for (const range of ranges) {
    const endT = range.endT === 1 ? 1 : roundRangeT(range.endT);
    expect(endT - startT).toBeGreaterThanOrEqual(MIN_RANGE_T - 1e-12);
    startT = endT;
  }
  const emitted = emitStep(candidateOn(polygon, ends, ranges), original(polygon));
  expect(emitted).toMatchObject({ ok: true });
  if (!emitted.ok) return;
  const heading = emitted.step.heading;
  if (heading?.mode === "piecewise") {
    expect(heading.ranges[0]?.startT).toBe(0);
    expect(heading.ranges[heading.ranges.length - 1]?.endT).toBe(1);
    for (const range of heading.ranges) {
      if (range.heading.mode === "linear") {
        expect(Math.abs(range.heading.toRad - range.heading.fromRad)).toBeLessThanOrEqual(Math.PI + 1e-3);
      }
    }
  }
}

const endsOf = (geometry: PathGeometry, arrivalHeadingRad: number, endHeadingRad: number): RouteEnds => ({
  startIn: geometry.pointAtDistance(0),
  endIn: geometry.pointAtDistance(geometry.lengthIn),
  arrivalHeadingRad,
  endHeadingRad,
});

describe("fitting the dynamic program's headings to Pedro's modes", () => {
  it("returns a plain tangent for a straight route that starts and ends along it", () => {
    const geometry = line({ xIn: 20, yIn: 30 }, { xIn: 60, yIn: 40 });
    const along = tangentHeading(geometry, 0);
    const result = headingDp(input(geometry, along, along));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fitPedroModes(geometry, endsOf(geometry, along, along), result.stations).ranges).toEqual([
      { mode: "tangent", endT: 1 },
    ]);
  });

  it("returns a plain tangent for a gentle curve whose optimum is to drive nose first", () => {
    // A wide curve: its curvature cap is above the velocity cap everywhere, so any heading off the
    // tangent only slows the robot.
    const polygon: Vec2[] = [
      { xIn: -40, yIn: 20 },
      { xIn: -10, yIn: 20 },
      { xIn: 20, yIn: 30 },
      { xIn: 40, yIn: 50 },
    ];
    const geometry = makePath([polygon]);
    const ends = endsOf(geometry, tangentHeading(geometry, 0), tangentHeading(geometry, 1));
    const result = headingDp(input(geometry, ends.arrivalHeadingRad, ends.endHeadingRad));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fit = fitPedroModes(geometry, ends, result.stations);
    expect(fit.ranges).toEqual([{ mode: "tangent", endT: 1 }]);
    expect(fit.maxDeviationRad).toBeLessThanOrEqual(FIT_TOLERANCE_RAD);
  });

  it("fits piecewise ranges that obey the minimum width, the half-turn limit and the exact ends", () => {
    for (const [lengthIn, arrival, end] of [
      [120, Math.PI / 2, Math.PI / 2],
      [60, -Math.PI / 2, 2.5],
      [130, 3, -2],
    ] as const) {
      // Past 100 in, the 2 in between stations is narrower than the narrowest range.
      const polygon: Vec2[] = [
        { xIn: -65, yIn: 0 },
        { xIn: -65 + lengthIn, yIn: 0 },
      ];
      const geometry = line(polygon[0] as Vec2, polygon[1] as Vec2);
      const result = headingDp(input(geometry, arrival, end));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const ends = endsOf(geometry, arrival, end);
      const fit = fitPedroModes(geometry, ends, result.stations);
      expect(fit.ranges.length).toBeGreaterThan(1);
      expectValidRanges(fit.ranges, polygon, ends);
    }
  });

  it("snaps a range end to a joint within 0.02 of it", () => {
    // A chain of two lines meeting at s = 41 of 80 in. The headings hold one way and turn at s = 40,
    // so a boundary falls at t 0.5, within 0.02 of the joint at t 0.5125.
    const geometry = makePath([
      [{ xIn: -40, yIn: 0 }, { xIn: 1, yIn: 0 }],
      [{ xIn: 1, yIn: 0 }, { xIn: 40, yIn: 0 }],
    ]);
    const stations = [0, 10, 20, 30, 40, 41, 50, 60, 70, 80].map((sIn) => ({
      t: sIn / 80,
      headingRad: sIn <= 40 ? 1 : 1.5,
    }));
    const ends = endsOf(geometry, 1, 1.5);
    const fit = fitPedroModes(geometry, ends, stations);
    expect(fit.ranges.length).toBeGreaterThan(1);
    expect(fit.ranges[0]?.endT).toBe(0.5125);
  });

  it("keeps a linear range within the tolerance when the tangent range after it pins its end", () => {
    // The program's answer here starts with a stretch the fit writes as linear and then turns onto
    // the reversed tangent. The linear range's own best turn ends near the tangent but not on it,
    // and pinning its end there strayed 0.121 rad at t 0.0927 before the fit tested the pinned turn.
    const polygon: Vec2[] = [
      { xIn: -0.139, yIn: 13.672 },
      { xIn: 7.016, yIn: -38.481 },
      { xIn: 30.931, yIn: -6.284 },
      { xIn: 13.949, yIn: 12.354 },
    ];
    const geometry = makePath([polygon]);
    const dp = input(geometry, 2.2347, 0.8213, {}, testField, testRobot);
    const result = headingDp(dp);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fit = fitPedroModes(geometry, dp.ends, result.stations);
    expect(fit.ranges.length).toBeGreaterThan(1);
    expect(fit.maxDeviationRad).toBeLessThanOrEqual(FIT_TOLERANCE_RAD + 1e-9);
    expectValidRanges(fit.ranges, polygon, dp.ends);
  });

  it("holds every station of every fitted piecewise heading to the tolerance wherever the widths allow it", () => {
    // Random cubics from a fixed linear congruential sequence, so the routes are the same on every
    // run. Only routes of at most 100 in are held to it: there every 2 in between stations is at
    // least MIN_RANGE_T, so a range may end on any station but those within MIN_RANGE_T of t 1,
    // which no range may end on and which are therefore the only ones exempt.
    let seed = 20261010;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const coordinate = (): number => -40 + 80 * next();
    let piecewise = 0;
    let tangentAfterLinear = 0;
    for (let k = 0; k < 120; k += 1) {
      const polygon: Vec2[] = [0, 1, 2, 3].map(() => ({ xIn: coordinate(), yIn: coordinate() }));
      const arrival = wrapAngle(2 * Math.PI * next());
      const end = wrapAngle(2 * Math.PI * next());
      const geometry = makePath([polygon]);
      if (geometry.lengthIn > 100) continue;
      const dp = input(geometry, arrival, end, {}, testField, testRobot);
      const result = headingDp(dp);
      if (!result.ok) continue;
      const fit = fitPedroModes(geometry, dp.ends, result.stations);
      if (fit.ranges.length === 1) continue;
      piecewise += 1;
      for (const [i, range] of fit.ranges.entries()) {
        if (i > 0 && fit.ranges[i - 1]?.mode === "linear" && (range.mode === "tangent" || range.mode === "tangentReversed")) {
          tangentAfterLinear += 1;
        }
      }
      const heading = rangesHeading(fit.ranges, geometry, dp.ends);
      expect(typeof heading).not.toBe("string");
      if (typeof heading === "string") return;
      const at = headingFunction(heading, geometry);
      for (const station of result.stations) {
        if (station.t > 1 - MIN_RANGE_T && station.t < 1) continue;
        const deviation = Math.abs(wrapAngle(at(station.t) - station.headingRad));
        expect(deviation, `route ${String(k)} at t ${station.t.toFixed(4)}`).toBeLessThanOrEqual(FIT_TOLERANCE_RAD + 1e-9);
      }
      expectValidRanges(fit.ranges, polygon, dp.ends);
    }
    // The sweep fits enough piecewise headings, and a tangent range after a linear one among them.
    expect(piecewise).toBeGreaterThanOrEqual(20);
    expect(tangentAfterLinear).toBeGreaterThan(0);
  });

  it("returns one mode when ranges are not allowed", () => {
    const geometry = line({ xIn: -60, yIn: 0 }, { xIn: 60, yIn: 0 });
    const result = headingDp(input(geometry, Math.PI / 2, Math.PI / 2));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fit = fitPedroModes(geometry, endsOf(geometry, Math.PI / 2, Math.PI / 2), result.stations, { allowRanges: false });
    expect(fit.ranges).toHaveLength(1);
    expect(fit.ranges[0]?.endT).toBe(1);
  });
});

describe("the heading families", () => {
  const polygon: Vec2[] = [
    { xIn: -60, yIn: 0 },
    { xIn: 40, yIn: 0 },
  ];
  const geometry = line(polygon[0] as Vec2, polygon[1] as Vec2);
  const arrival = Math.PI / 2;
  const end = -2.5;
  const dpInput = input(geometry, arrival, end);
  const ends = dpInput.ends;

  it("come in the spec's order, H-default first and H-dp second, and every one emits", () => {
    const seeds = headingSeeds(dpInput, { defaultHeadingMode: "constant" });
    expect(seeds.map((seed) => seed.family)).toEqual(["default", "dp", "tangent", "reversed", "linear"]);
    for (const seed of seeds) expectValidRanges(seed.ranges, polygon, ends);
  });

  it("build H-tan as tangent with a linear range only where an end is off the tangent", () => {
    const seeds = headingSeeds(dpInput, { defaultHeadingMode: "constant" });
    const tangent = seeds.find((seed) => seed.family === "tangent")?.ranges ?? [];
    expect(tangent.map((range) => range.mode)).toEqual(["linear", "tangent", "linear"]);
    const reversed = seeds.find((seed) => seed.family === "reversed")?.ranges ?? [];
    expect(reversed.map((range) => range.mode)).toEqual(["linear", "tangentReversed", "linear"]);
    expect(seeds.find((seed) => seed.family === "linear")?.ranges).toEqual([{ mode: "linear", endT: 1 }]);
    const constant = seeds.find((seed) => seed.family === "default")?.ranges ?? [];
    expect(constant.map((range) => range.mode)).toEqual(["constant", "linear"]);

    const limits = robotLimits(square);
    expect(tangentFamily(geometry, endsOf(geometry, 0, 0), limits, 0.8, false)).toEqual([{ mode: "tangent", endT: 1 }]);
    // Driven along the tangent, H-dp fits a plain tangent first, so H-tan repeats it and is left out.
    const along = headingSeeds(input(geometry, 0, 0), { defaultHeadingMode: "constant" });
    expect(along.map((seed) => seed.family)).toEqual(["default", "dp", "reversed", "linear"]);
    expect(along[1]?.ranges).toEqual([{ mode: "tangent", endT: 1 }]);
  });

  it("make H-default the person's D6 mode, Linear unless set, and leave out a repeat of a later family", () => {
    const linear = headingSeeds(dpInput, {});
    expect(linear[0]).toEqual({ family: "default", ranges: [{ mode: "linear", endT: 1 }] });
    expect(linear.map((seed) => seed.family)).toEqual(["default", "dp", "tangent", "reversed"]);
    const tangent = headingSeeds(dpInput, { defaultHeadingMode: "tangent" });
    expect(tangent.map((seed) => seed.family)).toEqual(["default", "dp", "reversed", "linear"]);
  });

  it("leave out a family that needs a turn when ranges are not allowed, and give every other one mode", () => {
    const limits = robotLimits(square);
    // Both ends are off the tangent and face different ways, so H-tan, H-rev and the constant need a turn.
    expect(tangentFamily(geometry, ends, limits, 0.8, false, false)).toBeNull();
    expect(tangentFamily(geometry, ends, limits, 0.8, true, false)).toBeNull();
    expect(constantFamily(geometry, ends, limits, 0.8, false)).toBeNull();
    // With ranges allowed the same families are built, so it is the option that leaves them out.
    expect(tangentFamily(geometry, ends, limits, 0.8, false, true)).not.toBeNull();
    expect(constantFamily(geometry, ends, limits, 0.8, true)).not.toBeNull();

    const seeds = headingSeeds(dpInput, { defaultHeadingMode: "constant", allowRanges: false });
    const families = seeds.map((seed) => seed.family);
    expect(families).not.toContain("default");
    expect(families).not.toContain("tangent");
    expect(families).not.toContain("reversed");
    expect(seeds.length).toBeGreaterThan(0);
    for (const seed of seeds) {
      expect(seed.ranges).toHaveLength(1);
      expect(seed.ranges[0]?.endT).toBe(1);
      expectValidRanges(seed.ranges, polygon, ends);
    }

    // Where no turn is needed the families are still built with ranges off, as one mode each.
    const along = endsOf(geometry, 0, 0);
    expect(tangentFamily(geometry, along, limits, 0.8, false, false)).toEqual([{ mode: "tangent", endT: 1 }]);
    expect(constantFamily(geometry, along, limits, 0.8, false)).toEqual([{ mode: "constant", endT: 1 }]);
  });

  it("leave out H-dp when the dynamic program finds no heading that clears", () => {
    const blocked = input(geometry, arrival, end, {}, fieldWith([bar("wall", -10, -9, -10, 10)]));
    const seeds = headingSeeds(blocked, {});
    expect(seeds.map((seed) => seed.family)).not.toContain("dp");
  });

  it("keep every linear range within half a turn when the ends face nearly opposite ways", () => {
    for (const seed of headingSeeds(input(geometry, 3, -3), {})) {
      expectValidRanges(seed.ranges, polygon, endsOf(geometry, 3, -3));
    }
  });
});
