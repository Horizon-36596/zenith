import { parseField, parseRobot, type Field, type Robot } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { PERIMETER_TOLERANCE_IN } from "../check.js";
import { footprintAt } from "../footprint.js";
import { polygonBoxClearance } from "../geometry/sat.js";
import type { Pose } from "../geometry/vec.js";
import type { OwnSide } from "../season.js";
import { testField, testRobot } from "../testing/fixtures.js";
import type { PlanSample } from "../types.js";
import {
  CENTRE_LINE_KEEPOUT_ID,
  clearancePenalty,
  clearanceWorld,
  keepOutWords,
  measureClearances,
  requiredClearanceIn,
  sweptClearanceCheck,
} from "./clearance.js";

/**
 * The hand-built worlds here are small on purpose: a 6 in square robot, one bar or one zone, and
 * poses on exact binary fractions so that a clearance of "exactly the margin" is exact. Every grid
 * is fixed; nothing is random.
 */

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const robot: Robot = parseRobot({
  ...clone(testRobot),
  heightIn: { value: 12, provenance: "PLACEHOLDER: test fixture" },
  footprint: {
    startIn: { lengthIn: 6, widthIn: 6, provenance: "PLACEHOLDER: test fixture" },
    expandedIn: { lengthIn: 6, widthIn: 6, provenance: "PLACEHOLDER: test fixture" },
    centreOfRotationIn: { xIn: 0, yIn: 0 },
  },
});

const withMouth: Robot = parseRobot({
  ...clone(robot),
  mouths: [
    { id: "front", side: "FRONT", offsetIn: { xIn: 3, yIn: 0 }, widthIn: 4, depthIn: 4, provenance: "PLACEHOLDER: test fixture" },
  ],
});

function fieldWith(obstacles: unknown[], zones: unknown[] = []): Field {
  return parseField({ ...clone(testField), obstacles, zones });
}

const bar = (id: string, minX: number, maxX: number, minY: number, maxY: number, extra: object = {}) => ({
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
  ...extra,
});

function sampleAt(pose: Pose, which: Robot = robot): PlanSample {
  const footprint = footprintAt(pose, which);
  return { sIn: 0, t: 0, pose, footprintIn: footprint.bodyIn, mouthsIn: footprint.mouthsIn };
}

/** Samples on the line y = `yIn`, each with its arc length: the distance driven to it, back and forth included. */
const along = (xs: readonly number[], yIn = 0, headingRad = 0): PlanSample[] => {
  let sIn = 0;
  return xs.map((xIn, i) => {
    if (i > 0) sIn += Math.abs(xIn - (xs[i - 1] as number));
    return { ...sampleAt({ xIn, yIn, headingRad }), sIn };
  });
};

describe("requiredClearanceIn", () => {
  it("is the margin everywhere when both ends are clear", () => {
    const { requiredIn, exempt } = requiredClearanceIn([3, 2.5, 2, 1.5, 2, 3], 1);
    expect(requiredIn).toEqual([1, 1, 1, 1, 1, 1]);
    expect(exempt.every((flag) => !flag)).toBe(true);
  });

  it("asks only for no penetration and no decrease while leaving a start inside the margin", () => {
    const { requiredIn, exempt } = requiredClearanceIn([0, 0.5, 0.75, 1.5, 2], 1);
    expect(exempt).toEqual([true, true, true, false, false]);
    expect(requiredIn).toEqual([0, 0, 0.5, 1, 1]);
  });

  it("asks for the same in reverse at an end inside the margin", () => {
    const { requiredIn, exempt } = requiredClearanceIn([2, 1.5, 0.75, 0.5, 0], 1);
    expect(exempt).toEqual([false, false, true, true, true]);
    expect(requiredIn).toEqual([1, 1, 0.5, 0, 0]);
  });

  it("fails a route that moves back toward the structure inside the run", () => {
    const clearances = [0, 0.5, 0.25, 1.5, 2];
    const { requiredIn } = requiredClearanceIn(clearances, 1);
    const falls = clearances.map((c, i) => c < (requiredIn[i] as number));
    expect(falls).toEqual([false, false, true, false, false]);
  });

  it("applies the full margin once the run is over", () => {
    // It leaves the structure, reaches the margin, then comes back toward it.
    const clearances = [0, 0.5, 1, 0.75, 1.5];
    const { requiredIn, exempt } = requiredClearanceIn(clearances, 1);
    expect(exempt).toEqual([true, true, false, false, false]);
    expect(clearances[3] as number).toBeLessThan(requiredIn[3] as number);
  });

  it("holds a requirement above 0 only as far as the margin, and 0 after a penetration", () => {
    expect(requiredClearanceIn([0.25, -0.5, 0.5, 2], 1).requiredIn).toEqual([0, 0.25, 0, 1]);
    expect(requiredClearanceIn([0.5], 1).requiredIn).toEqual([0]);
  });
});

describe("the centre line keep-out", () => {
  const side: OwnSide = { axis: "x", lineIn: 0, ownSign: -1, toleranceIn: 0.05, rule: "Test rule." };
  const zone = (id: string) => ({ id, kind: "rect", minXIn: -40, maxXIn: -30, minYIn: -5, maxYIn: 5, appliesInAuto: true });

  it("has an id no field zone can have, because the schema asks a zone's id to be at least one character", () => {
    expect(CENTRE_LINE_KEEPOUT_ID).toBe("");
    expect(() => fieldWith([], [zone("")])).toThrow();
  });

  it("is told apart in the world and in a sentence from a field zone named centreLine", () => {
    const world = clearanceWorld(robot, fieldWith([], [zone("centreLine")]), side);
    expect(world.keepOuts.map((keepOut) => keepOut.id)).toEqual(["centreLine", CENTRE_LINE_KEEPOUT_ID]);
    expect(keepOutWords("centreLine")).toBe('the keep-out "centreLine"');
    expect(keepOutWords(CENTRE_LINE_KEEPOUT_ID)).toBe("the centre line");
  });

  it("names the zone, not the line, when the robot is in the zone and the line is clear", () => {
    const world = clearanceWorld(robot, fieldWith([], [zone("centreLine")]), side);
    const result = sweptClearanceCheck(world, along([-35]), 1);
    expect(result.ok).toBe(false);
    expect(result.worst).toMatchObject({ kind: "keepOut", id: "centreLine" });
    expect(keepOutWords(result.worst?.id ?? null)).toBe('the keep-out "centreLine"');
  });
});

describe("clearanceWorld", () => {
  it("leaves out a bar above the robot's height and an obstacle that is not solid", () => {
    const world = clearanceWorld(
      robot,
      fieldWith([
        bar("low", 10, 12, -5, 5),
        bar("overhead", 20, 22, -5, 5, { minZIn: 20, maxZIn: 30 }),
        bar("ghost", 30, 32, -5, 5, { solidToRobot: false }),
      ]),
    );
    expect(world.structures.map((s) => s.id)).toEqual(["low"]);
  });

  it("lets the robot drive under an overhead bar with no penalty and a passing swept test", () => {
    const field = fieldWith([bar("overhead", 10, 12, -5, 5, { minZIn: 20, maxZIn: 30 })]);
    const samples = along([0, 0.5, 1, 1.5, 2, 6, 6.5, 7, 7.5, 8, 9, 10, 11, 12, 13]);
    const world = clearanceWorld(robot, field);
    expect(clearancePenalty(world, samples, 1)).toEqual({ penalty: 0, worst: null });
    expect(sweptClearanceCheck(world, samples, 1).ok).toBe(true);
  });

  it("reads only the zones that apply in autonomous as keep-outs", () => {
    const zones = [
      { id: "soft", kind: "rect", minXIn: 10, maxXIn: 20, minYIn: -5, maxYIn: 5, appliesInAuto: false },
      { id: "unset", kind: "rect", minXIn: 20, maxXIn: 30, minYIn: -5, maxYIn: 5 },
      { id: "hard", kind: "rect", minXIn: 30, maxXIn: 40, minYIn: -5, maxYIn: 5, appliesInAuto: true },
    ];
    const world = clearanceWorld(robot, fieldWith([], zones));
    expect(world.keepOuts.map((z) => z.id)).toEqual(["hard"]);
    // Drive straight through the two zones that do not apply.
    const samples = along([0, 0.5, 1, 1.5, 2, 6, 10, 14, 18, 22, 26]);
    expect(sweptClearanceCheck(world, samples, 1).ok).toBe(true);
    expect(clearancePenalty(world, samples, 1).penalty).toBe(0);
  });

  it("measures a strut by its slanted shadow, not its box", () => {
    // A level strut at z 1 in along x from (0, 10) to (20, 20), radius 1 in: its shadow is a
    // rectangle along the diagonal, much thinner than the box around it.
    const strut = {
      id: "brace",
      kind: "strut",
      fromIn: { xIn: 0, yIn: 10, zIn: 1 },
      toIn: { xIn: 20, yIn: 20, zIn: 1 },
      radiusIn: 1,
    };
    const world = clearanceWorld(robot, fieldWith([strut]));
    expect(world.structures).toHaveLength(1);
    expect(world.structures[0]?.isBox).toBe(false);
    // The robot at (15, 11) sits in the corner of the strut's box that its shadow does not reach.
    const [near] = measureClearances(world, along([15], 11)).structuresIn[0] as number[];
    const boxClearance = polygonBoxClearance(
      footprintAt({ xIn: 15, yIn: 11, headingRad: 0 }, robot).bodyIn,
      world.structures[0]!.boxIn,
    );
    expect(boxClearance).toBeLessThan(0);
    expect(near).toBeGreaterThan(0);
  });
});

describe("clearancePenalty", () => {
  const world = clearanceWorld(robot, fieldWith([bar("post", 10, 14, -10, 10)]));

  it("is 0 when everything clears the margin", () => {
    // The robot's nose is at x + 3; at x = 6 it is 1 in from the post, exactly the margin.
    expect(clearancePenalty(world, along([0, 2, 4, 6]), 1)).toEqual({ penalty: 0, worst: null });
  });

  it("is the square of the shortfall, summed over the samples", () => {
    // Clearances 0.5 and 0.25 against a margin of 1, in the middle of a route that starts and
    // ends well clear (so no exemption applies): shortfalls 0.5 and 0.75.
    const result = clearancePenalty(world, along([0, 4, 6.5, 6.75, 4, 0]), 1);
    expect(result.penalty).toBeCloseTo(0.5 ** 2 + 0.75 ** 2, 12);
    expect(result.worst).toEqual({ kind: "structure", id: "post", sampleIndex: 3, shortfallIn: 0.75 });
  });

  it("is a penetration's depth plus the margin, squared", () => {
    // At x = 9 the nose is 2 in into the post: clearance -2, shortfall 3 against the margin.
    expect(clearancePenalty(world, along([0, 4, 9, 4, 0]), 1).penalty).toBeCloseTo(9, 12);
  });

  it("charges a wall with no margin, past the slack check() gives the walls", () => {
    const wallWorld = clearanceWorld(robot, fieldWith([]));
    // The robot's nose at 72 is the wall: flush is free, 1 in out costs (1 - 0.05)^2.
    expect(clearancePenalty(wallWorld, along([69]), 1).penalty).toBe(0);
    expect(clearancePenalty(wallWorld, along([70]), 1).penalty).toBeCloseTo((1 - PERIMETER_TOLERANCE_IN) ** 2, 12);
    expect(clearancePenalty(wallWorld, along([70]), 1).worst).toMatchObject({ kind: "wall", id: null });
    // A nose 1/32 in past the wall is inside the slack, as it is for check() and the swept test.
    expect(clearancePenalty(wallWorld, along([69.03125]), 1)).toEqual({ penalty: 0, worst: null });
    expect(sweptClearanceCheck(wallWorld, along([69.03125]), 1).ok).toBe(true);
  });

  it("charges a keep-out with no margin", () => {
    const zoneWorld = clearanceWorld(
      robot,
      fieldWith([], [{ id: "hard", kind: "rect", minXIn: 10, maxXIn: 20, minYIn: -5, maxYIn: 5, appliesInAuto: true }]),
    );
    // Half an inch short of the zone's edge is clear, even with a margin of 3.
    expect(clearancePenalty(zoneWorld, along([6.5]), 3).penalty).toBe(0);
    expect(clearancePenalty(zoneWorld, along([8]), 3).penalty).toBeCloseTo(1, 12);
  });

  it("counts a mouth, which sticks out past the body", () => {
    const mouthWorld = clearanceWorld(withMouth, fieldWith([bar("post", 10, 14, -10, 10)]));
    // The mouth is 4 in deep and centred 3 in ahead of the pose, so it reaches x = 8 where the
    // body reaches 6.
    const samples = [sampleAt({ xIn: 3, yIn: 0, headingRad: 0 }, withMouth)];
    expect(measureClearances(mouthWorld, samples).structuresIn[0]?.[0]).toBeCloseTo(10 - 8, 12);
  });

  it("lets a pose that starts against a structure leave it, and not turn back", () => {
    const against = clearanceWorld(robot, fieldWith([bar("wall", 3, 5, -10, 10)]));
    expect(clearancePenalty(against, along([0, -0.5, -1, -1.5, -2]), 1)).toEqual({ penalty: 0, worst: null });
    const back = clearancePenalty(against, along([0, -0.5, -0.25, -1.5, -2]), 1);
    expect(back.penalty).toBeCloseTo(0.25 ** 2, 12);
    expect(back.worst).toEqual({ kind: "structure", id: "wall", sampleIndex: 2, shortfallIn: 0.25 });
  });
});

describe("sweptClearanceCheck", () => {
  // A 6 in square turning a quarter turn over a 2 in step. Its corners reach 4.24 in from the
  // centre, so halfway through the turn a corner is at y = 4.24, above both end footprints (which
  // stop at y = 3). A 1 in bar from 3.5 to 4.5 sits in that gap.
  const bars = clearanceWorld(robot, fieldWith([bar("bar", -1, 3, 3.5, 4.5)]));
  const turning = [sampleAt({ xIn: 0, yIn: 0, headingRad: 0 }), sampleAt({ xIn: 2, yIn: 0, headingRad: Math.PI / 2 })];

  it("catches a 1 in bar between two samples of a fast-turning footprint", () => {
    // Plain sampling at these two poses sees nothing wrong: both are 0.5 in from the bar.
    for (const sample of turning) {
      expect(polygonBoxClearance(sample.footprintIn, world0(bars).boxIn)).toBeCloseTo(0.5, 12);
    }
    expect(clearancePenalty(bars, turning, 0)).toEqual({ penalty: 0, worst: null });

    // The motion between them does hit it: a corner is inside the bar halfway through.
    let hit = false;
    for (let i = 0; i <= 64; i += 1) {
      const u = i / 64;
      const pose = { xIn: 2 * u, yIn: 0, headingRad: (Math.PI / 2) * u };
      hit ||= polygonBoxClearance(footprintAt(pose, robot).bodyIn, world0(bars).boxIn) < 0;
    }
    expect(hit).toBe(true);

    const result = sweptClearanceCheck(bars, turning, 0);
    expect(result.ok).toBe(false);
    expect(result.worst).toMatchObject({ kind: "structure", id: "bar", sampleIndex: 0 });
    expect(result.worst?.shortfallIn).toBeGreaterThan(0.5);
  });

  it("passes the same bar when the footprint does not turn", () => {
    const straight = [sampleAt({ xIn: 0, yIn: 0, headingRad: 0 }), sampleAt({ xIn: 2, yIn: 0, headingRad: 0 })];
    expect(sweptClearanceCheck(bars, straight, 0).ok).toBe(true);
  });

  it("passes a gentle turn whose bulge fits in the gap", () => {
    const gentle = [sampleAt({ xIn: 0, yIn: 0, headingRad: 0 }), sampleAt({ xIn: 2, yIn: 0, headingRad: 0.1 })];
    expect(sweptClearanceCheck(bars, gentle, 0).ok).toBe(true);
  });

  it("grows the bar by the margin as well as the bulge", () => {
    // A route that passes the bar 0.5 in away, with both ends well clear of it (an end inside the
    // margin would be exempt): a margin of 0.5 passes, 0.75 does not.
    const straight = along([-12, -10, 0, 2, 12, 14]);
    expect(sweptClearanceCheck(bars, straight, 0.5).ok).toBe(true);
    const short = sweptClearanceCheck(bars, straight, 0.75);
    expect(short.ok).toBe(false);
    expect(short.worst?.shortfallIn).toBeCloseTo(0.25, 12);
  });

  it("tests a single sample alone", () => {
    expect(sweptClearanceCheck(bars, [sampleAt({ xIn: 0, yIn: 0, headingRad: 0 })], 0.5).ok).toBe(true);
    expect(sweptClearanceCheck(bars, [sampleAt({ xIn: 0, yIn: 1, headingRad: 0 })], 0.5).ok).toBe(false);
  });

  it("holds the walls and keep-outs to the bulge too, with no margin", () => {
    const zoned = clearanceWorld(
      robot,
      fieldWith([], [{ id: "hard", kind: "rect", minXIn: -1, maxXIn: 3, minYIn: 3.5, maxYIn: 4.5, appliesInAuto: true }]),
    );
    const result = sweptClearanceCheck(zoned, turning, 5);
    expect(result.ok).toBe(false);
    expect(result.worst).toMatchObject({ kind: "keepOut", id: "hard" });
    expect(sweptClearanceCheck(clearanceWorld(robot, fieldWith([])), along([67, 68, 69]), 1).ok).toBe(true);
    expect(sweptClearanceCheck(clearanceWorld(robot, fieldWith([])), along([69, 70, 71]), 1).worst).toMatchObject({
      kind: "wall",
    });
  });

  it("sweeps each mouth's hull, so a mouth cannot pass through a bar between samples", () => {
    // The robot faces +x and slides along y. Its body stops at x = 3, 1 in short of the bar, but
    // its mouth reaches x = 5 and passes through the bar between the samples at y = -5 and 5.
    const mouthBar = clearanceWorld(withMouth, fieldWith([bar("bar", 4, 4.5, -1, 1)]));
    const sliding = [-10, -5, 5, 10].map((yIn, i) => ({ ...sampleAt({ xIn: 0, yIn, headingRad: 0 }, withMouth), sIn: i }));
    // Every sample on its own clears the bar by more than the margin, mouth and all.
    expect(clearancePenalty(mouthBar, sliding, 0.5)).toEqual({ penalty: 0, worst: null });
    // The body alone, swept, clears it too: only the mouth's hull hits it.
    const bodyOnly = sliding.map((sample) => ({ ...sample, mouthsIn: [] }));
    expect(sweptClearanceCheck(mouthBar, bodyOnly, 0.5).ok).toBe(true);
    const result = sweptClearanceCheck(mouthBar, sliding, 0.5);
    expect(result.ok).toBe(false);
    expect(result.worst).toMatchObject({ kind: "structure", id: "bar", sampleIndex: 1 });
  });

  it("shrinks the walls by the rotation bulge", () => {
    const open = clearanceWorld(robot, fieldWith([]));
    // A quarter turn on the spot with the nose 1 in from the wall: both end footprints are inside,
    // but halfway through the turn a corner, 4.24 in from the centre, is past the wall.
    const near = [sampleAt({ xIn: 68, yIn: 0, headingRad: 0 }), sampleAt({ xIn: 68, yIn: 0, headingRad: Math.PI / 2 })];
    const halfway = footprintAt({ xIn: 68, yIn: 0, headingRad: Math.PI / 4 }, robot).bodyIn;
    expect(Math.max(...halfway.map((p) => p.xIn))).toBeGreaterThan(72 + PERIMETER_TOLERANCE_IN);
    const result = sweptClearanceCheck(open, near, 1);
    expect(result.ok).toBe(false);
    expect(result.worst).toMatchObject({ kind: "wall", id: null, sampleIndex: 0 });
    // One inch further in, the corner's arc stays inside, and so does the bulge.
    const clear = [sampleAt({ xIn: 67, yIn: 0, headingRad: 0 }), sampleAt({ xIn: 67, yIn: 0, headingRad: Math.PI / 2 })];
    expect(sweptClearanceCheck(open, clear, 1).ok).toBe(true);
  });

  it("lets the walls be passed by the slack check() gives them, and no more", () => {
    const open = clearanceWorld(robot, fieldWith([]));
    // The nose ends 1/32 in past the wall, inside the 0.05 in slack; then 1/16 in, outside it.
    expect(sweptClearanceCheck(open, along([68, 68.5, 69.03125]), 1)).toEqual({ ok: true, worst: null });
    const out = sweptClearanceCheck(open, along([68, 68.5, 69.0625]), 1);
    expect(out.ok).toBe(false);
    expect(out.worst?.shortfallIn).toBeCloseTo(0.0625 - PERIMETER_TOLERANCE_IN, 12);
  });

  it("grows the boxes by how far a curved path can leave the chord between two samples", () => {
    // Two samples 10 in apart on a half circle of radius 5 round (0, 0), heading kept: the path
    // between them reaches y = 5, where the robot's top is at y = 8, through a bar at 7.5 to 8.
    // The hull of the two end footprints stops at y = 3 and misses it.
    const high = clearanceWorld(robot, fieldWith([bar("bar", -1, 1, 7.5, 8)]));
    const arc = [
      { ...sampleAt({ xIn: -5, yIn: 0, headingRad: 0 }), sIn: 0 },
      { ...sampleAt({ xIn: 5, yIn: 0, headingRad: 0 }), sIn: 5 * Math.PI },
    ];
    const top = footprintAt({ xIn: 0, yIn: 5, headingRad: 0 }, robot).bodyIn;
    expect(polygonBoxClearance(top, world0(high).boxIn)).toBeLessThan(0);
    const result = sweptClearanceCheck(high, arc, 0);
    expect(result.ok).toBe(false);
    expect(result.worst).toMatchObject({ kind: "structure", id: "bar", sampleIndex: 0 });
    // The same two samples on a straight line, whose length is the chord, pass.
    expect(sweptClearanceCheck(high, [arc[0] as PlanSample, { ...(arc[1] as PlanSample), sIn: 10 }], 0).ok).toBe(true);
    // The walls and keep-outs take the same growth.
    const zoned = clearanceWorld(
      robot,
      fieldWith([], [{ id: "hard", kind: "rect", minXIn: -1, maxXIn: 1, minYIn: 7.5, maxYIn: 8, appliesInAuto: true }]),
    );
    expect(sweptClearanceCheck(zoned, arc, 0).worst).toMatchObject({ kind: "keepOut", id: "hard" });
    // The same half circle under the north wall at y = 72: the end footprints stop at 67.5 and the
    // straight line passes, but the arc lifts the robot's top to 72.5, past the wall's slack.
    const open = clearanceWorld(robot, fieldWith([]));
    const underWall = [
      { ...sampleAt({ xIn: -5, yIn: 64.5, headingRad: 0 }), sIn: 0 },
      { ...sampleAt({ xIn: 5, yIn: 64.5, headingRad: 0 }), sIn: 5 * Math.PI },
    ];
    expect(sweptClearanceCheck(open, [underWall[0] as PlanSample, { ...(underWall[1] as PlanSample), sIn: 10 }], 0).ok).toBe(true);
    const wall = sweptClearanceCheck(open, underWall, 0);
    expect(wall.ok).toBe(false);
    expect(wall.worst).toMatchObject({ kind: "wall", id: null, sampleIndex: 0 });
  });

  it("refuses an empty list of samples rather than passing it", () => {
    expect(() => sweptClearanceCheck(bars, [], 1)).toThrow(/at least one sample/);
  });

  describe("the end exemption", () => {
    const flush = clearanceWorld(robot, fieldWith([bar("face", 3, 5, -10, 10)]));

    it("lets a pose flush against a structure leave it when the clearance never decreases", () => {
      const leaving = along([0, -0.5, -1, -1.5, -2, -2.5]);
      expect(sweptClearanceCheck(flush, leaving, 1)).toEqual({ ok: true, worst: null });
      expect(clearancePenalty(flush, leaving, 1).penalty).toBe(0);
    });

    it("rejects a route that moves back toward the structure inside the run", () => {
      const back = along([0, -0.5, -0.25, -1, -2, -2.5]);
      const result = sweptClearanceCheck(flush, back, 1);
      expect(result.ok).toBe(false);
      expect(result.worst).toMatchObject({ kind: "structure", id: "face", sampleIndex: 2 });
    });

    it("rejects a route that starts by driving into it", () => {
      const into = along([0, 0.5, 1, -1, -2]);
      expect(sweptClearanceCheck(flush, into, 1).ok).toBe(false);
    });

    it("lets a route arrive flush at E, and applies the full margin before the run", () => {
      expect(sweptClearanceCheck(flush, along([-4, -3, -2, -1, -0.5, 0]), 1).ok).toBe(true);
      // Reaches 0.5 in from the face, goes back out, and comes in again: the second approach is
      // inside the run, so it is allowed only if it never closes in then backs off.
      const hesitating = along([-4, -3, -2, -1, -0.5, -1, 0]);
      expect(sweptClearanceCheck(flush, hesitating, 1).ok).toBe(false);
    });

    it("still applies the full margin to a structure the ends are not near", () => {
      const both = clearanceWorld(robot, fieldWith([bar("face", 3, 5, -10, 10), bar("other", -20, -18, -10, 10)]));
      // Leaving the face is exempt, but passing 0.5 in from the other bar, mid-route, is not.
      const result = sweptClearanceCheck(both, along([0, -0.5, -1, -1.5, -2, -8, -14, -14.5, -10, -4]), 1);
      expect(result.ok).toBe(false);
      expect(result.worst).toMatchObject({ id: "other" });
    });

    it("keeps the rotation bulge for a pair the exemption covers, and drops only the margin", () => {
      // A 6 in square 0.25 in from a face, turning a quarter turn on the spot: both end footprints
      // are the same square, so the clearance never decreases, but halfway through the turn a
      // corner, 4.24 in from the centre, is 1 in into the face.
      const near = clearanceWorld(robot, fieldWith([bar("face", 3.25, 5, -10, 10)]));
      const spin = [sampleAt({ xIn: 0, yIn: 0, headingRad: 0 }), sampleAt({ xIn: 0, yIn: 0, headingRad: Math.PI / 2 })];
      const halfway = footprintAt({ xIn: 0, yIn: 0, headingRad: Math.PI / 4 }, robot).bodyIn;
      expect(polygonBoxClearance(halfway, world0(near).boxIn)).toBeLessThan(0);
      const result = sweptClearanceCheck(near, spin, 1);
      expect(result.ok).toBe(false);
      expect(result.worst).toMatchObject({ kind: "structure", id: "face", sampleIndex: 0 });
      // Backing straight out, with no turn, the exempt pairs are held only to no penetration, as before.
      expect(sweptClearanceCheck(near, along([0, -0.5, -1, -1.5]), 1).ok).toBe(true);
    });

    it("leaves a start overlapping a structure reported, for the optimizer to call infeasible", () => {
      const result = sweptClearanceCheck(flush, along([1, 1.5, 2]), 1);
      expect(result.ok).toBe(false);
      expect(result.worst).toMatchObject({ kind: "structure", id: "face" });
      expect(measureClearances(flush, along([1, 1.5, 2])).structuresIn[0]?.[0]).toBeCloseTo(-1, 12);
    });
  });
});

/** The only structure of a one-obstacle world, for the tests that measure it directly. */
function world0(world: ReturnType<typeof clearanceWorld>) {
  return world.structures[0] as NonNullable<(typeof world.structures)[number]>;
}
