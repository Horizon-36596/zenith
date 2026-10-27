import type { Box2, Pose, Vec2 } from "@horizon36596/zenith-core";
import { describe, expect, it } from "vitest";
import { bezierNodes, carriedHandles, inferNodeKind, mirroredOpposite, nodeKey, type NodeKind } from "./bezier.js";
import { emptyHitScene, hitTest } from "./hit.js";
import { NO_KEYS, resolveModifiers, type HeldKeys } from "./modifiers.js";
import { headingDrag, planPointDrag, rayAnchorOf, resolveLeader, smoothNodeMoves, type StartPoint } from "./pointDrag.js";
import { snapLabel, type SnapContext } from "./snap.js";
import type { PointTarget } from "./types.js";

const BOUNDS: Box2 = { minXIn: -72, maxXIn: 72, minYIn: -72, maxYIn: 72 };
const square = (pose: Pose): Box2 => ({
  minXIn: pose.xIn - 9,
  maxXIn: pose.xIn + 9,
  minYIn: pose.yIn - 9,
  maxYIn: pose.yIn + 9,
});

const context = (overrides: Partial<SnapContext> = {}): SnapContext => ({
  enabled: true,
  altHeld: false,
  pxPerIn: 4,
  waypoints: [],
  bounds: BOUNDS,
  footprintBounds: square,
  ...overrides,
});

const keys = (held: Partial<HeldKeys> = {}): HeldKeys => ({ ...NO_KEYS, ...held });
const start: Pose = { xIn: 0, yIn: 0, headingRad: 0.3 };

describe("resolveLeader: the point under the pointer", () => {
  it("snaps to the half-inch grid by default and says so", () => {
    const result = resolveLeader(start, { xIn: 10.23, yIn: 5.77 }, resolveModifiers(true, keys()), context());
    expect(result.pose).toMatchObject({ xIn: 10, yIn: 6 });
    expect(result.label).toBe("grid 0.5 in");
  });

  it("goes exactly where the pointer is with Ctrl held over snap on", () => {
    const result = resolveLeader(start, { xIn: 10.23, yIn: 5.77 }, resolveModifiers(true, keys({ ctrl: true })), context());
    expect(result.pose).toMatchObject({ xIn: 10.23, yIn: 5.77 });
    expect(result.label).toBe("snap off (Ctrl)");
  });

  it("snaps with Ctrl held while the toggle is off", () => {
    const result = resolveLeader(start, { xIn: 10.23, yIn: 5.77 }, resolveModifiers(false, keys({ ctrl: true })), context());
    expect(result.pose).toMatchObject({ xIn: 10, yIn: 6 });
  });

  it("lets Alt skip the grid but keeps the wall snap", () => {
    const free = resolveLeader(start, { xIn: 10.23, yIn: 5.77 }, resolveModifiers(true, keys({ alt: true })), context());
    expect(free.pose).toMatchObject({ xIn: 10.23, yIn: 5.77 });
    expect(free.label).toBe("free (Alt)");
    const wall = resolveLeader(start, { xIn: 62.6, yIn: 0.13 }, resolveModifiers(true, keys({ alt: true })), context());
    expect(wall.snap.kind).toBe("wall");
    expect(wall.pose.xIn).toBeCloseTo(63, 9);
    expect(wall.pose.yIn).toBe(0.13);
  });

  it("keeps the heading the point had at the press", () => {
    const result = resolveLeader(start, { xIn: 30, yIn: 30 }, resolveModifiers(true, keys()), context());
    expect(result.pose.headingRad).toBe(0.3);
  });

  it("locks the off-axis coordinate with Shift, and a nearby waypoint cannot pull it off", () => {
    const withWaypoint = context({ waypoints: [{ name: "beside", xIn: 20, yIn: 1 }] });
    const result = resolveLeader(start, { xIn: 20.1, yIn: 3 }, resolveModifiers(true, keys({ shift: true })), withWaypoint);
    expect(result.pose.yIn).toBe(0);
    expect(result.pose.xIn).toBe(20);
    expect(result.label).toBe("grid 0.5 in · axis x (Shift)");
  });

  it("takes a waypoint that sits on the locked axis", () => {
    const onAxis = context({ waypoints: [{ name: "ahead", xIn: 20, yIn: 0 }] });
    const result = resolveLeader(start, { xIn: 20.6, yIn: 4 }, resolveModifiers(true, keys({ shift: true })), onAxis);
    expect(result.snap.kind).toBe("waypoint");
    expect(result.label).toBe("waypoint ahead · axis x (Shift)");
  });
});

describe("resolveLeader with Shift on a path end: a ray from the anchor", () => {
  const anchor: Vec2 = { xIn: -12, yIn: -63 };
  /** driveOut made diagonal: (-12, -63) to (8, -43), 28.28 in at 45 degrees. */
  const diagonalEnd: Pose = { xIn: 8, yIn: -43, headingRad: 0.3 };
  const shift = resolveModifiers(true, keys({ shift: true }));
  const length = (pose: Pose): number => Math.hypot(pose.xIn - anchor.xIn, pose.yIn - anchor.yIn);

  it("lets the line come as short as the pointer does, not as short as its axis offset", () => {
    const pointer = { xIn: anchor.xIn + 1.27, yIn: anchor.yIn + 1.27 };
    const result = resolveLeader(diagonalEnd, pointer, shift, context(), anchor);
    expect(length(result.pose)).toBeLessThanOrEqual(2);
    expect(result.pose.xIn - anchor.xIn).toBeCloseTo(result.pose.yIn - anchor.yIn, 9);
  });

  it("moves the end by about the pointer's own move when the pointer crosses the diagonal", () => {
    const along = { xIn: anchor.xIn + 14, yIn: anchor.yIn + 14 };
    const before = resolveLeader(diagonalEnd, along, shift, context(), anchor).pose;
    const across = resolveLeader(diagonalEnd, { xIn: along.xIn + 0.5, yIn: along.yIn - 0.5 }, shift, context(), anchor).pose;
    expect(Math.hypot(across.xIn - before.xIn, across.yIn - before.yIn)).toBeLessThanOrEqual(1.5);
  });

  it("rounds the length, not the coordinates, to a half inch with quantise on", () => {
    const pointer = { xIn: anchor.xIn + 10.1, yIn: anchor.yIn + 10.3 };
    const result = resolveLeader(diagonalEnd, pointer, shift, context(), anchor);
    expect(length(result.pose) / 0.5).toBeCloseTo(Math.round(length(result.pose) / 0.5), 9);
    expect(result.pose.xIn - anchor.xIn).toBeCloseTo(result.pose.yIn - anchor.yIn, 9);
    expect(result.label).toBe("grid 0.5 in · line 45° · length (Shift)");
    expect(result.snap.ray).toEqual({ anchorIn: anchor, bearingRad: Math.PI / 4 });
    const altShift = resolveModifiers(true, keys({ shift: true, alt: true }));
    const free = resolveLeader(diagonalEnd, pointer, altShift, context(), anchor);
    expect(length(free.pose)).toBeCloseTo(Math.hypot(10.2, 10.2), 9);
    expect(free.label).toBe("free (Alt) · line 45° · length (Shift)");
  });

  it("takes a waypoint only when it is within the tolerance of the ray", () => {
    const on = context({ waypoints: [{ name: "onRay", xIn: anchor.xIn + 10, yIn: anchor.yIn + 10.5 }] });
    const taken = resolveLeader(diagonalEnd, { xIn: anchor.xIn + 10.2, yIn: anchor.yIn + 10.3 }, shift, on, anchor);
    expect(taken.snap).toMatchObject({ kind: "waypoint", waypoint: "onRay" });
    // 5 in off the ray: 20 px at 4 px/in, far past the 6 px tolerance.
    const off = context({ waypoints: [{ name: "beside", xIn: anchor.xIn + 20, yIn: anchor.yIn + 10 }] });
    const refused = resolveLeader(diagonalEnd, { xIn: anchor.xIn + 20, yIn: anchor.yIn + 10 }, shift, off, anchor);
    expect(refused.snap.kind).not.toBe("waypoint");
    expect(refused.pose.xIn - anchor.xIn).toBeCloseTo(refused.pose.yIn - anchor.yIn, 9);
  });

  it("moves the point along the ray to rest the footprint on a wall", () => {
    const origin: Vec2 = { xIn: 0, yIn: 0 };
    // The square footprint is 9 in either side, so it is flush with the 72 in walls at x = y = 63.
    const press: Pose = { xIn: 20, yIn: 20, headingRad: 0 };
    const result = resolveLeader(press, { xIn: 62.7, yIn: 62.7 }, shift, context(), origin);
    expect(result.snap.kind).toBe("wall");
    expect(result.pose.xIn).toBeCloseTo(63, 6);
    expect(result.pose.yIn).toBeCloseTo(63, 6);
    expect(result.label).toBe("wall · line 45° · length (Shift)");
  });

  it("keeps the axis rule when there is no anchor, as for a control point", () => {
    const result = resolveLeader(start, { xIn: 20.1, yIn: 3 }, shift, context());
    expect(result.pose).toMatchObject({ xIn: 20, yIn: 0 });
    expect(result.label).toBe("grid 0.5 in · axis x (Shift)");
  });

  it("does nothing different without Shift", () => {
    const result = resolveLeader(diagonalEnd, { xIn: 3.3, yIn: -50.2 }, resolveModifiers(true, keys()), context(), anchor);
    expect(result.pose).toMatchObject({ xIn: 3.5, yIn: -50 });
    expect(result.snap.ray).toBeUndefined();
  });
});

describe("rayAnchorOf: where a path end's ray starts", () => {
  const polygons: Vec2[][] = [
    [{ xIn: 0, yIn: 0 }, { xIn: 5, yIn: 5 }, { xIn: 10, yIn: 0 }],
    [{ xIn: 10, yIn: 0 }, { xIn: 20, yIn: 10 }],
    [{ xIn: 20, yIn: 10 }, { xIn: 30, yIn: 10 }],
  ];
  const target = (segmentIndex: number, pointKind: PointTarget["pointKind"]): PointTarget => ({ segmentIndex, pointKind });

  it("is the segment's own start for an end, even one with controls", () => {
    expect(rayAnchorOf(polygons, target(0, "to"))).toEqual({ xIn: 0, yIn: 0 });
    expect(rayAnchorOf(polygons, target(2, "to"))).toEqual({ xIn: 20, yIn: 10 });
  });

  it("is the incoming segment's start for the node that joins two segments, whichever copy is grabbed", () => {
    expect(rayAnchorOf(polygons, target(1, "to"))).toEqual({ xIn: 10, yIn: 0 });
    expect(rayAnchorOf(polygons, target(2, "from"))).toEqual({ xIn: 10, yIn: 0 });
  });

  it("is the first segment's far end for the path's first point, and none for a control", () => {
    expect(rayAnchorOf(polygons, target(0, "from"))).toEqual({ xIn: 10, yIn: 0 });
    expect(rayAnchorOf(polygons, { segmentIndex: 0, pointKind: "control", controlIndex: 0 })).toBeNull();
    expect(rayAnchorOf([], target(0, "to"))).toBeNull();
  });
});

describe("headingDrag: the heading handle", () => {
  const anchor: Pose = { xIn: 10, yIn: 20, headingRad: 0 };
  const at = (deg: number): Vec2 => ({
    xIn: anchor.xIn + Math.cos((deg * Math.PI) / 180) * 12,
    yIn: anchor.yIn + Math.sin((deg * Math.PI) / 180) * 12,
  });
  const deg = (rad: number): number => (rad * 180) / Math.PI;

  it("never moves the point: the pose it writes has the press-time position", () => {
    for (const held of [keys(), keys({ shift: true }), keys({ alt: true }), keys({ ctrl: true })]) {
      const result = headingDrag(anchor, at(34), resolveModifiers(true, held), context());
      expect(result.pose.xIn).toBe(10);
      expect(result.pose.yIn).toBe(20);
      expect(result.pose.headingRad).toBe(result.headingRad);
    }
  });

  it("turns in 15 degree steps by default, 45 with Shift, and freely with Alt or Ctrl", () => {
    expect(deg(headingDrag(anchor, at(34), resolveModifiers(true, keys()), context()).headingRad)).toBeCloseTo(30, 9);
    const shift = headingDrag(anchor, at(34), resolveModifiers(true, keys({ shift: true })), context());
    expect(deg(shift.headingRad)).toBeCloseTo(45, 9);
    expect(shift.label).toBe("45° (Shift)");
    const alt = headingDrag(anchor, at(34), resolveModifiers(true, keys({ alt: true })), context());
    expect(deg(alt.headingRad)).toBeCloseTo(34, 6);
    expect(alt.label).toBe("free (Alt)");
    const ctrl = headingDrag(anchor, at(34), resolveModifiers(true, keys({ ctrl: true })), context());
    expect(deg(ctrl.headingRad)).toBeCloseTo(34, 6);
    expect(ctrl.label).toBe("snap off (Ctrl)");
  });

  it("steps by 45 with Shift even when snapping is off", () => {
    const result = headingDrag(anchor, at(34), resolveModifiers(false, keys({ shift: true })), context());
    expect(deg(result.headingRad)).toBeCloseTo(45, 9);
  });
});

describe("hit testing a heading handle and a range boundary", () => {
  const point: PointTarget = { segmentIndex: 0, pointKind: "to" };
  const scene = {
    ...emptyHitScene(),
    handles: [{ stepId: "s", point, xPx: 100, yPx: 100 }],
    headingHandles: [{ stepId: "s", key: "all:end", editable: true, xPx: 120, yPx: 100 }],
    boundaries: [{ stepId: "s", index: 0, xPx: 100, yPx: 112 }],
    polylines: [{ stepId: "s", xsPx: [0, 200], ysPx: [112, 112], ts: [0, 1] }],
  };

  it("grabs the arrow when the pointer is nearer the arrow than the point", () => {
    expect(hitTest(scene, 118, 100)).toEqual({ stepId: "s", headingHandle: "all:end" });
  });

  it("grabs the point when the pointer is nearer the point", () => {
    expect(hitTest(scene, 104, 100)).toEqual({ stepId: "s", point });
  });

  it("grabs a boundary over the path it sits on", () => {
    expect(hitTest(scene, 100, 111)).toEqual({ stepId: "s", rangeBoundary: 0 });
    expect(hitTest(scene, 160, 112)).toMatchObject({ stepId: "s", t: 0.8 });
  });
});

/** Two cubics that meet smoothly at (30, 10). */
const polygons: Vec2[][] = [
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
const control = (segmentIndex: number, controlIndex: number): PointTarget => ({
  segmentIndex,
  pointKind: "control",
  controlIndex,
});
const point = (target: PointTarget, pointIn: Vec2): StartPoint => ({ stepId: "s", point: target, pose: { ...pointIn, headingRad: 0 } });

describe("Bezier nodes", () => {
  it("infers a node as smooth when its handles are collinear, and corner when they are not", () => {
    const nodes = bezierNodes(polygons);
    const middle = nodes.find((node) => node.index === 1);
    expect(middle?.incoming?.target).toEqual(control(0, 1));
    expect(middle?.outgoing?.target).toEqual(control(1, 0));
    expect(middle === undefined ? null : inferNodeKind(middle)).toBe("smooth");
    const kinked = polygons.map((polygon) => polygon.map((p) => ({ ...p })));
    (kinked[1] as Vec2[])[1] = { xIn: 40, yIn: 20 };
    const kinkedMiddle = bezierNodes(kinked).find((node) => node.index === 1);
    expect(kinkedMiddle === undefined ? null : inferNodeKind(kinkedMiddle)).toBe("corner");
  });

  it("mirrors the opposite handle through the node, keeping its own length", () => {
    const opposite = mirroredOpposite({ xIn: 0, yIn: 0 }, { xIn: -3, yIn: 4 }, { xIn: 10, yIn: 0 });
    expect(opposite.xIn).toBeCloseTo(6, 9);
    expect(opposite.yIn).toBeCloseTo(-8, 9);
  });

  it("carries both handles an endpoint owns", () => {
    expect(carriedHandles(polygons, { segmentIndex: 0, pointKind: "to" }).map((handle) => handle.target)).toEqual([
      control(0, 1),
      control(1, 0),
    ]);
  });

  it("makes a corner node smooth by swinging the outgoing handle opposite the incoming one", () => {
    const kinked = polygons.map((polygon) => polygon.map((p) => ({ ...p })));
    (kinked[1] as Vec2[])[1] = { xIn: 30, yIn: 20 };
    const moves = smoothNodeMoves("s", kinked, 1);
    expect(moves).toHaveLength(1);
    expect(moves[0]?.target).toEqual(control(1, 0));
    // Incoming runs (-10, 0) from the node, so the outgoing handle (length 10) goes to (+10, 0).
    expect(moves[0]?.pose.xIn).toBeCloseTo(40, 9);
    expect(moves[0]?.pose.yIn).toBeCloseTo(10, 9);
  });
});

describe("planPointDrag", () => {
  const input = (overrides: Partial<Parameters<typeof planPointDrag>[0]> = {}): Parameters<typeof planPointDrag>[0] => ({
    leader: point(control(0, 1), { xIn: 20, yIn: 10 }),
    leaderPose: { xIn: 20, yIn: 14, headingRad: 0 },
    followers: [],
    polygonsOf: () => polygons,
    nodeKinds: new Map<string, NodeKind>(),
    breakMirror: false,
    ...overrides,
  });

  it("swings the mirrored handle of a smooth node", () => {
    const moves = planPointDrag(input());
    expect(moves.map((move) => move.target)).toEqual([control(0, 1), control(1, 0)]);
    const mirrored = moves[1]?.pose as Pose;
    // The two handles stay collinear through the node.
    const a = Math.atan2(14 - 10, 20 - 30);
    const b = Math.atan2(mirrored.yIn - 10, mirrored.xIn - 30);
    expect(Math.abs(Math.abs(a - b) - Math.PI)).toBeLessThan(1e-9);
    expect(Math.hypot(mirrored.xIn - 30, mirrored.yIn - 10)).toBeCloseTo(10, 9);
  });

  it("moves only the grabbed handle with Shift, or on a corner node", () => {
    expect(planPointDrag(input({ breakMirror: true }))).toHaveLength(1);
    const corner = new Map<string, NodeKind>([[nodeKey("s", 1), "corner"]]);
    expect(planPointDrag(input({ nodeKinds: corner }))).toHaveLength(1);
  });

  it("carries an endpoint's handles by the same delta, and writes each point once", () => {
    const endpoint: PointTarget = { segmentIndex: 0, pointKind: "to" };
    const moves = planPointDrag(
      input({
        leader: point(endpoint, { xIn: 30, yIn: 10 }),
        leaderPose: { xIn: 35, yIn: 12, headingRad: 0 },
        followers: [point(control(1, 0), { xIn: 40, yIn: 10 })],
      }),
    );
    expect(moves).toHaveLength(3);
    const byKind = new Map(moves.map((move) => [`${String(move.target.segmentIndex)}${move.target.pointKind}${String(move.target.controlIndex ?? "")}`, move.pose]));
    expect(byKind.get("0control1")).toMatchObject({ xIn: 25, yIn: 12 });
    expect(byKind.get("1control0")).toMatchObject({ xIn: 45, yIn: 12 });
  });

  it("moves a group by the leader's snapped delta, followers unsnapped", () => {
    const moves = planPointDrag(
      input({
        leader: point({ segmentIndex: 0, pointKind: "from" }, { xIn: 0, yIn: 0 }),
        leaderPose: { xIn: 2, yIn: -1, headingRad: 0 },
        followers: [point(control(1, 1), { xIn: 50.3, yIn: 0.2 })],
        polygonsOf: () => null,
      }),
    );
    expect(moves[1]?.pose).toMatchObject({ xIn: 52.3, yIn: -0.8 });
  });
});

describe("snapLabel", () => {
  it("names a wall snap a mouth drove", () => {
    expect(snapLabel({ pose: start, kind: "wall", walls: [], mouth: true })).toBe("wall (mouth)");
    expect(snapLabel({ pose: start, kind: "wall", walls: [] })).toBe("wall");
    expect(snapLabel({ pose: start, kind: "none" })).toBeNull();
  });
});
