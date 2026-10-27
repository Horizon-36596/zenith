/**
 * A path's interior joint is one point to a drag (issue #146): where segment k-1 ends and segment
 * k starts, the two copies move together, and a selection that holds both moves the joint once.
 * And a Bezier handle carries no heading (N82): the runtime and Pedro ignore one, so the carried
 * handles, the smooth swing and making a node smooth write only x and y.
 */
import type { Vec2 } from "@horizon36596/zenith-core";
import { describe, expect, it } from "vitest";
import type { NodeKind } from "./bezier.js";
import { NO_KEYS, resolveModifiers } from "./modifiers.js";
import {
  placeAddPoint,
  planPointDrag,
  pointKey,
  resolveLeader,
  smoothNodeMoves,
  type PointDragInput,
  type StartPoint,
} from "./pointDrag.js";
import type { SnapContext } from "./snap.js";
import type { PointTarget } from "./types.js";

const to = (segmentIndex: number): PointTarget => ({ segmentIndex, pointKind: "to" });
const from = (segmentIndex: number): PointTarget => ({ segmentIndex, pointKind: "from" });
const control = (segmentIndex: number, controlIndex: number): PointTarget => ({
  segmentIndex,
  pointKind: "control",
  controlIndex,
});
const at = (target: PointTarget, pointIn: Vec2, headingRad = 1.5708): StartPoint => ({
  stepId: "driveOut",
  point: target,
  pose: { ...pointIn, headingRad },
});

/** driveOut split at its middle: (-12, -63) to (-12, -49.5), then on to (-12, -36). */
const splitLine: Vec2[][] = [
  [
    { xIn: -12, yIn: -63 },
    { xIn: -12, yIn: -49.5 },
  ],
  [
    { xIn: -12, yIn: -49.5 },
    { xIn: -12, yIn: -36 },
  ],
];

/** Every interior joint of the split line is joined: segment 0's to and segment 1's from. */
const twinOf = (_stepId: string, target: PointTarget): PointTarget | null => {
  if (target.pointKind === "to" && target.segmentIndex === 0) return from(1);
  if (target.pointKind === "from" && target.segmentIndex === 1) return to(0);
  return null;
};

const input = (overrides: Partial<PointDragInput>): PointDragInput => ({
  leader: at(to(0), { xIn: -12, yIn: -49.5 }),
  leaderPose: { xIn: 12, yIn: -49.5, headingRad: 1.5708 },
  followers: [],
  polygonsOf: () => splitLine,
  nodeKinds: new Map<string, NodeKind>(),
  breakMirror: false,
  twinOf,
  ...overrides,
});

const byKey = (moves: ReturnType<typeof planPointDrag>) =>
  new Map(moves.map((move) => [pointKey(move.stepId, move.target), move.pose]));

describe("planPointDrag on a joint", () => {
  it("moves the copy of the joint the canvas does not draw with the one it does", () => {
    const moves = planPointDrag(input({}));
    expect(moves.map((move) => move.target)).toEqual([to(0), from(1)]);
    expect(moves[1]?.pose).toEqual(moves[0]?.pose);
  });

  it("moves a joint in a marquee by exactly one drag delta, whether it holds one copy or both", () => {
    // A marquee round the joint and the path's end, dragged by the end 24 in east.
    const leader = at(to(1), { xIn: -12, yIn: -36 });
    const leaderPose = { xIn: 12, yIn: -36, headingRad: 1.5708 };
    const expectMoved = (moves: ReturnType<typeof planPointDrag>): void => {
      // Each copy is written once, 24 in east of where it was: never left behind, never 48 in.
      expect(moves).toHaveLength(3);
      const poses = byKey(moves);
      expect(poses.get(pointKey("driveOut", to(0)))).toMatchObject({ xIn: 12, yIn: -49.5 });
      expect(poses.get(pointKey("driveOut", from(1)))).toMatchObject({ xIn: 12, yIn: -49.5 });
      expect(poses.get(pointKey("driveOut", to(1)))).toMatchObject({ xIn: 12, yIn: -36 });
    };
    // The canvas draws the joint as segment 0's end, so that is the copy a marquee picks up.
    expectMoved(planPointDrag(input({ leader, leaderPose, followers: [at(to(0), { xIn: -12, yIn: -49.5 })] })));
    expectMoved(
      planPointDrag(
        input({
          leader,
          leaderPose,
          followers: [at(to(0), { xIn: -12, yIn: -49.5 }), at(from(1), { xIn: -12, yIn: -49.5 })],
        }),
      ),
    );
  });

  it("puts the copy the leader owns at the leader's snapped pose, not a follower's", () => {
    const moves = planPointDrag(
      input({
        leader: at(to(0), { xIn: -12, yIn: -49.5 }),
        leaderPose: { xIn: 12, yIn: -49.5, headingRad: 1.5708 },
        // The other copy sits 0.3 in off, inside the CONTINUITY tolerance.
        followers: [at(from(1), { xIn: -11.7, yIn: -49.5 })],
      }),
    );
    expect(moves).toHaveLength(2);
    expect(byKey(moves).get(pointKey("driveOut", from(1)))).toMatchObject({ xIn: 12, yIn: -49.5 });
  });

  it("moves no other point when the drag is given no joints", () => {
    const moves = planPointDrag(input({ twinOf: undefined }));
    expect(moves.map((move) => move.target)).toEqual([to(0)]);
  });
});

describe("a Bezier handle carries no heading (N82)", () => {
  // Two cubics meeting at (30, 10), with a smooth node there.
  const curves: Vec2[][] = [
    [
      { xIn: 0, yIn: 0 },
      { xIn: 10, yIn: 0 },
      { xIn: 20, yIn: 10 },
      { xIn: 30, yIn: 10 },
    ],
    [
      { xIn: 30, yIn: 10 },
      { xIn: 40, yIn: 10 },
      { xIn: 50, yIn: 0 },
      { xIn: 60, yIn: 0 },
    ],
  ];
  const curveInput = (overrides: Partial<PointDragInput>): PointDragInput =>
    input({ polygonsOf: () => curves, twinOf: () => null, ...overrides });

  it("carries an endpoint's handles without a heading", () => {
    const moves = planPointDrag(
      curveInput({ leader: at(to(0), { xIn: 30, yIn: 10 }), leaderPose: { xIn: 35, yIn: 12, headingRad: 0.4 } }),
    );
    const handles = moves.filter((move) => move.target.pointKind === "control");
    expect(handles.map((move) => move.target)).toEqual([control(0, 1), control(1, 0)]);
    for (const handle of handles) expect(handle.pose).not.toHaveProperty("headingRad");
  });

  it("swings the opposite handle of a smooth node without a heading", () => {
    const moves = planPointDrag(
      curveInput({ leader: at(control(0, 1), { xIn: 20, yIn: 10 }, 0), leaderPose: { xIn: 20, yIn: 14, headingRad: 0 } }),
    );
    expect(moves.map((move) => move.target)).toEqual([control(0, 1), control(1, 0)]);
    expect(moves[1]?.pose).not.toHaveProperty("headingRad");
  });

  it("makes a node smooth without a heading", () => {
    const kinked = curves.map((polygon) => polygon.map((point) => ({ ...point })));
    (kinked[1] as Vec2[])[1] = { xIn: 30, yIn: 20 };
    const [move] = smoothNodeMoves("driveOut", kinked, 1);
    expect(move?.target).toEqual(control(1, 0));
    expect(move?.pose).not.toHaveProperty("headingRad");
  });
});

describe("a leader snapped onto a waypoint names it (issue #150)", () => {
  it("names the waypoint on the leader's move and on the other end of its joint, not on a follower's", () => {
    const moves = planPointDrag(
      input({
        leaderPose: { xIn: -12, yIn: -36, headingRad: 1.5708 },
        leaderWaypoint: "scoreSouth",
        followers: [at(to(1), { xIn: -12, yIn: -36 })],
      }),
    );
    const named = new Map(moves.map((move) => [pointKey(move.stepId, move.target), move.waypoint]));
    expect(named.get(pointKey("driveOut", to(0)))).toBe("scoreSouth");
    expect(named.get(pointKey("driveOut", from(1)))).toBe("scoreSouth");
    expect(named.get(pointKey("driveOut", to(1)))).toBeUndefined();
  });

  it("names no waypoint when the leader did not snap onto one", () => {
    for (const move of planPointDrag(input({}))) expect(move).not.toHaveProperty("waypoint");
  });
});

describe("Alt keeps its meaning (issue #150)", () => {
  it("still snaps a dragged point onto a waypoint, and turns off only the grid", () => {
    const context: SnapContext = {
      enabled: true,
      altHeld: false,
      pxPerIn: 4,
      waypoints: [{ name: "scoreSouth", xIn: -12, yIn: -36 }],
      bounds: { minXIn: -72, maxXIn: 72, minYIn: -72, maxYIn: 72 },
      footprintBounds: () => null,
    };
    const start = { xIn: 0, yIn: 0, headingRad: 0 };
    const withAlt = resolveModifiers(true, { ...NO_KEYS, alt: true });
    const onPin = resolveLeader(start, { xIn: -12.6, yIn: -35.7 }, withAlt, context);
    expect(onPin.snap).toMatchObject({ kind: "waypoint", waypoint: "scoreSouth", pose: { xIn: -12, yIn: -36 } });
    const offPin = resolveLeader(start, { xIn: 10.13, yIn: 5.27 }, withAlt, context);
    expect(offPin.pose).toMatchObject({ xIn: 10.13, yIn: 5.27 });
  });
});

describe("where an add-path or add-command click puts its point (issue #150)", () => {
  /** A 20 in by 10 in robot, so its box depends on which way it faces. */
  const footprint = (pose: { xIn: number; yIn: number; headingRad?: number }) => {
    const h = pose.headingRad ?? 0;
    const halfX = 10 * Math.abs(Math.cos(h)) + 5 * Math.abs(Math.sin(h));
    const halfY = 10 * Math.abs(Math.sin(h)) + 5 * Math.abs(Math.cos(h));
    return { minXIn: pose.xIn - halfX, maxXIn: pose.xIn + halfX, minYIn: pose.yIn - halfY, maxYIn: pose.yIn + halfY };
  };
  const context: SnapContext = {
    enabled: true,
    altHeld: false,
    pxPerIn: 4,
    waypoints: [{ name: "gardenApproach", xIn: -61, yIn: -44 }],
    bounds: { minXIn: -72, maxXIn: 72, minYIn: -72, maxYIn: 72 },
    footprintBounds: footprint,
  };
  const from = { xIn: 0, yIn: -40, headingRad: 0 };
  const snapOn = resolveModifiers(true, NO_KEYS);

  it("aims along the bearing from the pose it continues from, and rests that footprint on the wall", () => {
    const placed = placeAddPoint({ pointerIn: { xIn: 0, yIn: -70 }, from, adding: "path", modifiers: snapOn, context });
    expect(placed?.kind).toBe("wall");
    expect(placed?.pose.headingRad).toBeCloseTo(-Math.PI / 2, 12);
    // Facing south, the robot is 20 in long on y, so its centre rests 10 in off the south wall.
    expect(placed?.pose.xIn).toBeCloseTo(0, 9);
    expect(placed?.pose.yIn).toBeCloseTo(-62, 9);
  });

  it("keeps the heading it continues from when the new path keeps the previous end heading (issue #435)", () => {
    const facing = { xIn: 0, yIn: -40, headingRad: 0.7 };
    const input = { pointerIn: { xIn: 0, yIn: -70 }, from: facing, adding: "path" as const, modifiers: snapOn, context, keepHeading: true };
    expect(placeAddPoint(input)?.pose.headingRad).toBe(0.7);
    // Shift's 45 degree ray keeps it too, and a command always did.
    const shift = resolveModifiers(true, { ...NO_KEYS, shift: true });
    expect(placeAddPoint({ ...input, modifiers: shift })?.pose.headingRad).toBe(0.7);
    expect(placeAddPoint({ ...input, keepHeading: false })?.pose.headingRad).toBeCloseTo(-Math.PI / 2, 12);
  });

  it("lands on a waypoint inside the pixel tolerance and names it", () => {
    const placed = placeAddPoint({ pointerIn: { xIn: -60.4, yIn: -44.6 }, from, adding: "path", modifiers: snapOn, context });
    expect(placed).toMatchObject({ kind: "waypoint", waypoint: "gardenApproach", pose: { xIn: -61, yIn: -44 } });
  });

  it("adds no path point this close to the pose it continues from, but a command still goes there", () => {
    const near = { xIn: 0.4, yIn: -40.3 };
    expect(placeAddPoint({ pointerIn: near, from, adding: "path", modifiers: snapOn, context })).toBeNull();
    expect(placeAddPoint({ pointerIn: near, from, adding: "command", modifiers: snapOn, context })).not.toBeNull();
  });

  it("keeps the heading it continues from for a command", () => {
    const placed = placeAddPoint({ pointerIn: { xIn: 20, yIn: 0 }, from, adding: "command", modifiers: snapOn, context });
    expect(placed?.pose).toMatchObject({ xIn: 20, yIn: 0, headingRad: 0 });
  });

  it("with Shift puts a 40 degree pointer on the 45 degree ray, facing along it, and keeps the length", () => {
    const shift = resolveModifiers(true, { ...NO_KEYS, shift: true });
    const pointerIn = { xIn: 30 * Math.cos((40 * Math.PI) / 180), yIn: -40 + 30 * Math.sin((40 * Math.PI) / 180) };
    const placed = placeAddPoint({ pointerIn, from, adding: "path", modifiers: shift, context });
    expect(placed?.pose.headingRad).toBeCloseTo(Math.PI / 4, 12);
    const dx = (placed?.pose.xIn ?? NaN) - from.xIn;
    const dy = (placed?.pose.yIn ?? NaN) - from.yIn;
    expect(dy).toBeCloseTo(dx, 9);
    expect(Math.hypot(dx, dy)).toBeCloseTo(30, 0);
    expect(placed?.ray).toEqual({ anchorIn: { xIn: 0, yIn: -40 }, bearingRad: Math.PI / 4 });
  });

  it("with Shift still adds nothing this close to the pose it continues from, and a command has no line to hold", () => {
    const shift = resolveModifiers(true, { ...NO_KEYS, shift: true });
    expect(placeAddPoint({ pointerIn: { xIn: 0.4, yIn: -40.3 }, from, adding: "path", modifiers: shift, context })).toBeNull();
    expect(placeAddPoint({ pointerIn: { xIn: 20, yIn: -35 }, from, adding: "command", modifiers: shift, context })?.pose).toMatchObject({
      xIn: 20,
      yIn: -35,
    });
  });

  it("adds nothing when the snap pulls the point back onto the waypoint the path ends on (issue #402)", () => {
    // 1 in past the end is far enough on its own, but inside the 6 px pin tolerance (1.5 in at 4 px/in).
    const onPin = { xIn: -61, yIn: -44, headingRad: 0 };
    const pointerIn = { xIn: -60, yIn: -44 };
    expect(placeAddPoint({ pointerIn, from: onPin, adding: "path", modifiers: snapOn, context })).toBeNull();
    const shift = resolveModifiers(true, { ...NO_KEYS, shift: true });
    expect(placeAddPoint({ pointerIn, from: onPin, adding: "path", modifiers: shift, context })).toBeNull();
    // Ctrl places it where the pointer is, which is far enough, and a command may sit on the pin.
    const ctrl = resolveModifiers(true, { ...NO_KEYS, ctrl: true });
    expect(placeAddPoint({ pointerIn, from: onPin, adding: "path", modifiers: ctrl, context })?.pose).toMatchObject(pointerIn);
    expect(placeAddPoint({ pointerIn, from: onPin, adding: "command", modifiers: snapOn, context })).not.toBeNull();
  });

  it("leaves the pointer where it is with Ctrl held, and turns off only the grid with Alt held", () => {
    const pointerIn = { xIn: 12.13, yIn: -20.27 };
    const ctrl = resolveModifiers(true, { ...NO_KEYS, ctrl: true });
    expect(placeAddPoint({ pointerIn, from, adding: "path", modifiers: ctrl, context })).toMatchObject({ kind: "none", pose: pointerIn });
    const alt = resolveModifiers(true, { ...NO_KEYS, alt: true });
    expect(placeAddPoint({ pointerIn, from, adding: "path", modifiers: alt, context })?.pose).toMatchObject(pointerIn);
    expect(placeAddPoint({ pointerIn, from, adding: "path", modifiers: snapOn, context })).toMatchObject({
      kind: "grid",
      pose: { xIn: 12, yIn: -20.5 },
    });
  });
});
