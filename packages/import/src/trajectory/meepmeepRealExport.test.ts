import { describe, expect, it } from "vitest";
import { fixturePath, readJson, starterField } from "../testSupport.js";
import { readTrajectory } from "./importTrajectory.js";

const field = starterField();
const FIXTURE = "trajectory/meepmeep-line-wait-spline-turn.trajectory.json";

/**
 * What MeepMeep 0.1.7 itself showed for the bot `robot/meepmeep-export/real-check` runs: from
 * (63, -40, pi), `lineToX(45)`, `waitSeconds(0.5)`, `splineTo((36, 0), pi / 2)`, `turn(pi / 2)`,
 * with constraints 60 in/s, 60 in/s^2, 180 deg/s, 180 deg/s^2 and track width 15. Each row is
 * `[t, x, y, heading]` in RoadRunner's frame (seconds, inches, radians), read from MeepMeep's own
 * `RoadRunnerBotEntity.update` (the pose it draws) on 2026-09-28, against MeepMeep 0.1.7 and
 * RoadRunner 1.0.1 built from their source at their release tags. MeepMeep laid the action out as
 * the line from 0 to 1.095445 s, the wait to 1.595445 s, the spline to 3.595444 s and the turn to
 * 5.009658 s.
 */
const MEEPMEEP_SHOWED: [number, number, number, number][] = [
  [0.0, 63.0, -40.0, 3.141592654],
  [0.6, 52.36397586, -40.0, 3.141592654],
  [1.0, 45.273293099, -40.0, 3.141592654],
  [1.3, 45.0, -40.0, 3.141592654],
  [1.7, 44.667692784, -39.9998756, 3.140473086],
  [2.0, 40.132734737, -39.611423887, 2.896877252],
  [2.3, 35.81321984, -36.434583367, 2.099278852],
  [2.7, 34.205648592, -23.66511194, 1.510731953],
  [3.0, 35.488542397, -10.537066067, 1.472892933],
  [3.4, 35.998667639, -1.097535261, 1.567240829],
  [3.8, 36.0, 0.0, 1.63652325],
  [4.3, 36.0, 0.0, 2.350537767],
  [4.7, 36.0, 0.0, 2.990972206],
  [5.0, 36.0, 0.0, 3.14144614],
];

const angleGap = (a: number, b: number): number => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

/** The roadrunner preset: a RoadRunner pose (x, y, h) is (y, -x, h - pi / 2) in the season's frame. */
const toSeason = (x: number, y: number, h: number): [number, number, number] => [y, -x, h - Math.PI / 2];

describe("importTrajectory: a real MeepMeep 0.1.7 export with a line, a wait, a spline and a turn", () => {
  const doc = readJson(fixturePath(FIXTURE)) as { poses: [number, number, number][] };
  const { projection, warnings } = readTrajectory(doc, field);

  it("reads with no warnings, 52 samples and the file's 5.1 s", () => {
    expect(warnings).toEqual([]);
    expect(doc.poses).toHaveLength(52);
    expect(projection.trajectory.poses).toHaveLength(52);
    // MeepMeep's action ends at 5.01 s; the file's last sample holds the final pose to the next 0.1 s.
    expect(projection.totalS).toBe(5.1);
    expect(projection.title).toBe("MeepMeep line, wait, spline and turn");
    expect(projection.boundingBox).toEqual({ lengthIn: 18, widthIn: 18, centreOffsetIn: { xIn: 0, yIn: 0 } });
  });

  it("turns every exported sample a quarter turn into the season's frame", () => {
    const exact = readTrajectory(doc, field, { positionQuantumIn: 1e-6, headingQuantumRad: 1e-9 }).projection;
    exact.trajectory.poses.forEach(([xIn, yIn, headingRad], k) => {
      const [x, y, h] = toSeason(...(doc.poses[k] as [number, number, number]));
      expect(xIn, `sample ${String(k)}`).toBeCloseTo(x, 5);
      expect(yIn, `sample ${String(k)}`).toBeCloseTo(y, 5);
      expect(angleGap(headingRad, h), `sample ${String(k)}`).toBeLessThan(1e-6);
    });
  });

  it("lands within the view's rounding of what MeepMeep showed at the same times", () => {
    for (const [t, x, y, h] of MEEPMEEP_SHOWED) {
      const [xIn, yIn, headingRad] = projection.trajectory.poses[Math.round(t * 10)] as [number, number, number];
      const [ex, ey, eh] = toSeason(x, y, h);
      // Half an inch on each axis rounds to at most a quarter inch; one degree to at most half a degree.
      expect(Math.abs(xIn - ex), `x at ${String(t)} s`).toBeLessThanOrEqual(0.25 + 1e-4);
      expect(Math.abs(yIn - ey), `y at ${String(t)} s`).toBeLessThanOrEqual(0.25 + 1e-4);
      expect(angleGap(headingRad, eh), `heading at ${String(t)} s`).toBeLessThanOrEqual(Math.PI / 360 + 1e-6);
    }
  });

  it("starts at the RED start against the south wall facing north, and holds still through the wait", () => {
    expect(projection.startPose).toEqual({ xIn: -40, yIn: -63, headingRad: expect.closeTo(Math.PI / 2, 9) });
    // The line ends at 1.095 s and the spline starts at 1.595 s: 1.1 to 1.5 s all sit at its end.
    for (let k = 11; k <= 15; k += 1) {
      const [xIn, yIn, headingRad] = projection.trajectory.poses[k] as [number, number, number];
      expect([xIn, yIn], `sample ${String(k)}`).toEqual([-40, -45]);
      expect(angleGap(headingRad, Math.PI / 2), `sample ${String(k)}`).toBeLessThan(1e-9);
    }
  });

  it("ends the spline at (0, -36) facing east, and the turn brings it round to face north", () => {
    // The spline ends at 3.595 s facing RoadRunner's +y, the season's +x (east). The quarter turn
    // ends facing RoadRunner's -x, the season's +y (north).
    const [splineEndX, splineEndY, splineEndHeading] = projection.trajectory.poses[36] as [number, number, number];
    expect([splineEndX, splineEndY]).toEqual([0, -36]);
    expect(angleGap(splineEndHeading, 0)).toBeLessThanOrEqual(Math.PI / 180);
    for (const k of [50, 51]) {
      const [xIn, yIn, headingRad] = projection.trajectory.poses[k] as [number, number, number];
      expect([xIn, yIn], `sample ${String(k)}`).toEqual([0, -36]);
      expect(angleGap(headingRad, Math.PI / 2), `sample ${String(k)}`).toBeLessThan(1e-9);
    }
  });
});
