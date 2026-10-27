import type { Obstacle } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { obstacleShadowIn } from "./obstacle.js";
import type { Vec2 } from "./vec.js";

const box: Obstacle = {
  id: "bar",
  kind: "box",
  minXIn: -25,
  maxXIn: -24,
  minYIn: -19.4,
  maxYIn: 19.4,
  minZIn: 2,
  maxZIn: 4,
};

/** One hive-frame leg as issue #228 measures it: 45.7 in long, rising at about 62 degrees. */
const leg: Obstacle = {
  id: "frameLegNorthEast",
  kind: "strut",
  fromIn: { xIn: 23.81, yIn: 18.56, zIn: 0.53 },
  toIn: { xIn: 12.74, yIn: 0.51, zIn: 41.09 },
  radiusIn: 0.78,
};

const xs = (polygon: readonly Vec2[] | null): number[] => (polygon ?? []).map((point) => point.xIn);

describe("obstacleShadowIn: the plan shadow of the part below the robot's top", () => {
  it("is a box's four corners when its underside is below the robot's top", () => {
    expect(obstacleShadowIn(box, 18)).toEqual([
      { xIn: -25, yIn: -19.4 },
      { xIn: -24, yIn: -19.4 },
      { xIn: -24, yIn: 19.4 },
      { xIn: -25, yIn: 19.4 },
    ]);
  });

  it("is null for a box the robot passes under, its underside level with the top or above it", () => {
    expect(obstacleShadowIn(box, 2)).toBeNull();
    expect(obstacleShadowIn(box, 1.5)).toBeNull();
  });

  it("grows toward a leg's top as the robot gets taller", () => {
    const at6 = obstacleShadowIn(leg, 6);
    const at18 = obstacleShadowIn(leg, 18);
    expect(at6).toHaveLength(4);
    expect(at18).toHaveLength(4);
    // The foot end, extended by the radius past the foot, is the same at any height.
    expect(Math.max(...xs(at6))).toBeCloseTo(Math.max(...xs(at18)), 9);
    // The clipped end moves inward: about 21.1 in at 6 in and 17.9 in at 18 in, which is the
    // exact hull's 21.75 and 18.48 less at most the 0.6 in the round envelope adds.
    expect(Math.min(...xs(at6))).toBeCloseTo(21.145, 2);
    expect(Math.min(...xs(at18))).toBeCloseTo(17.871, 2);
  });

  it("is a rectangle twice the radius wide around the clipped centreline", () => {
    const shadow = obstacleShadowIn(leg, 18) as Vec2[];
    const side = (a: number, b: number): number =>
      Math.hypot((shadow[b] as Vec2).xIn - (shadow[a] as Vec2).xIn, (shadow[b] as Vec2).yIn - (shadow[a] as Vec2).yIn);
    expect(side(1, 2)).toBeCloseTo(1.56, 9);
    expect(side(3, 0)).toBeCloseTo(1.56, 9);
    expect(side(0, 1)).toBeCloseTo(side(2, 3), 9);
  });

  it("is null for a strut whose whole envelope is above the robot", () => {
    const crossbar: Obstacle = { ...leg, fromIn: { xIn: -12, yIn: 0, zIn: 41 }, toIn: { xIn: 12, yIn: 0, zIn: 41 }, radiusIn: 0.5 };
    expect(obstacleShadowIn(crossbar, 18)).toBeNull();
    expect(obstacleShadowIn(crossbar, 40.5)).toBeNull();
    expect(obstacleShadowIn(crossbar, 40.6)).toHaveLength(4);
    const high: Obstacle = { ...leg, fromIn: { ...leg.fromIn, zIn: 30 }, toIn: { ...leg.toIn, zIn: 45 } };
    expect(obstacleShadowIn(high, 18)).toBeNull();
  });

  it("is a square twice the radius across for an upright post", () => {
    const post: Obstacle = { ...leg, fromIn: { xIn: 5, yIn: 6, zIn: 0 }, toIn: { xIn: 5, yIn: 6, zIn: 30 }, radiusIn: 1 };
    const shadow = obstacleShadowIn(post, 18) as Vec2[];
    expect(Math.min(...xs(shadow))).toBeCloseTo(4, 9);
    expect(Math.max(...xs(shadow))).toBeCloseTo(6, 9);
    expect(Math.min(...shadow.map((point) => point.yIn))).toBeCloseTo(5, 9);
    expect(Math.max(...shadow.map((point) => point.yIn))).toBeCloseTo(7, 9);
  });

  it("is the same shape whichever end the strut is written from", () => {
    const reversed: Obstacle = { ...leg, fromIn: leg.toIn, toIn: leg.fromIn };
    const sorted = (polygon: Vec2[] | null): number[] => xs(polygon).sort((a, b) => a - b);
    const forward = sorted(obstacleShadowIn(leg, 18));
    const backward = sorted(obstacleShadowIn(reversed, 18));
    for (const [index, x] of forward.entries()) expect(backward[index]).toBeCloseTo(x, 9);
  });

  it("is a 1 in square for a strut of no length at 0.3 in with radius 0.5", () => {
    const ball: Obstacle = { ...leg, fromIn: { xIn: 3, yIn: 4, zIn: 0.3 }, toIn: { xIn: 3, yIn: 4, zIn: 0.3 }, radiusIn: 0.5 };
    const shadow = obstacleShadowIn(ball, 18) as Vec2[];
    expect(shadow).toHaveLength(4);
    expect(Math.min(...xs(shadow))).toBeCloseTo(2.5, 9);
    expect(Math.max(...xs(shadow))).toBeCloseTo(3.5, 9);
    expect(Math.min(...shadow.map((point) => point.yIn))).toBeCloseTo(3.5, 9);
    expect(Math.max(...shadow.map((point) => point.yIn))).toBeCloseTo(4.5, 9);
  });

  it("is null for a strut of no length above the reach of its radius", () => {
    const ball: Obstacle = { ...leg, fromIn: { xIn: 3, yIn: 4, zIn: 19 }, toIn: { xIn: 3, yIn: 4, zIn: 19 }, radiusIn: 0.5 };
    expect(obstacleShadowIn(ball, 18)).toBeNull();
  });

  it("decides a level strut at the band edges h + r and -r", () => {
    const level = (zIn: number): Obstacle => ({
      ...leg,
      fromIn: { xIn: 0, yIn: 0, zIn },
      toIn: { xIn: 10, yIn: 0, zIn },
      radiusIn: 0.5,
    });
    // The robot's top is 18 in, so a level tube reaches it up to a centreline at 18.5 in.
    expect(obstacleShadowIn(level(18.5 - 0.01), 18)).not.toBeNull();
    expect(obstacleShadowIn(level(18.5 + 0.01), 18)).toBeNull();
    expect(obstacleShadowIn(level(-0.5 + 0.01), 18)).not.toBeNull();
    expect(obstacleShadowIn(level(-0.5 - 0.01), 18)).toBeNull();
  });
});
