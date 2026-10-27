import { parseAuto, parseWaypoints, SCHEMA_ID, type Auto, type Heading, type PathStep, type Segment } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../canonicalize.js";
import { check } from "../check.js";
import { continuityGaps } from "../continuity.js";
import { applyFix } from "../fix.js";
import { makePath } from "../geometry/path.js";
import { plan } from "../plan.js";
import { resolve } from "../resolve.js";
import { testField, testRobot } from "../testing/fixtures.js";
import { appendPath, joinAt, joinSteps, joinStepsProblem, removeControl, removePath, stepAfter } from "./chain.js";
import { EditError } from "./errors.js";
import {
  addMarker,
  addSegment,
  jointTwin,
  removeMarker,
  removeSegment,
  setHeadingMode,
  setMarkerAt,
  setPose,
  setRoute,
  setSpeed,
  type PoseTarget,
} from "./path.js";
import { canonicalRoundTrip, testAuto } from "./testing.js";

describe("setPose", () => {
  it("sets a segment's to pose", () => {
    const result = setPose(testAuto(), "leg1", { segmentIndex: 0, pointKind: "to" }, { xIn: 10, yIn: 20 });
    const updated = result.steps.find((s) => s.id === "leg1");
    if (updated?.kind !== "path") throw new Error("expected path");
    const segment = updated.segments[0];
    if (segment === undefined) throw new Error("expected segment");
    expect(segment.to).toEqual({ xIn: 10, yIn: 20 });
    canonicalRoundTrip(result);
  });

  it("sets a Bezier control point", () => {
    let auto = testAuto();
    auto = addSegment(auto, "leg1", {
      kind: "bezier",
      from: "current",
      control: [{ xIn: 1, yIn: 1 }],
      to: { xIn: 5, yIn: 5 },
    });
    const result = setPose(
      auto,
      "leg1",
      { segmentIndex: 1, pointKind: "control", controlIndex: 0 },
      { xIn: 2, yIn: 3 },
    );
    const step = result.steps.find((s) => s.id === "leg1");
    if (step?.kind !== "path") throw new Error("expected path");
    const segment = step.segments[1];
    if (segment?.kind !== "bezier") throw new Error("expected bezier");
    expect(segment.control[0]).toEqual({ xIn: 2, yIn: 3 });
    canonicalRoundTrip(result);
  });

  it("rejects a control target on a line segment", () => {
    expect(() =>
      setPose(testAuto(), "leg1", { segmentIndex: 0, pointKind: "control", controlIndex: 0 }, { xIn: 1, yIn: 1 }),
    ).toThrow(EditError);
  });

  it("rejects a segment index out of range", () => {
    expect(() => setPose(testAuto(), "leg1", { segmentIndex: 5, pointKind: "to" }, { xIn: 1, yIn: 1 })).toThrow(
      EditError,
    );
  });

  it("rejects a non-path step", () => {
    expect(() => setPose(testAuto(), "shoot", { segmentIndex: 0, pointKind: "to" }, { xIn: 1, yIn: 1 })).toThrow(
      EditError,
    );
  });
});

describe("setHeadingMode", () => {
  it("replaces the heading mode", () => {
    const result = setHeadingMode(testAuto(), "leg1", { mode: "constant", headingRad: 1.5 });
    const step = result.steps.find((s) => s.id === "leg1");
    if (step?.kind !== "path") throw new Error("expected path");
    expect(step.heading).toEqual({ mode: "constant", headingRad: 1.5 });
    canonicalRoundTrip(result);
  });
});

describe("setSpeed", () => {
  it("sets speedFraction", () => {
    const result = setSpeed(testAuto(), "leg1", 0.3);
    const step = result.steps.find((s) => s.id === "leg1");
    if (step?.kind !== "path") throw new Error("expected path");
    expect(step.speedFraction).toBe(0.3);
    canonicalRoundTrip(result);
  });

  it("rejects an out-of-range fraction via the schema", () => {
    expect(() => setSpeed(testAuto(), "leg1", 2)).toThrow(EditError);
  });

  it("removes speedFraction with undefined, so the path drives at the robot's default again", () => {
    expect(canonicalRoundTrip(testAuto())).toContain('"speedFraction"');
    const result = setSpeed(testAuto(), "leg1", undefined);
    const step = result.steps.find((s) => s.id === "leg1");
    if (step?.kind !== "path") throw new Error("expected path");
    expect("speedFraction" in step).toBe(false);
    expect(canonicalRoundTrip(result)).not.toContain('"speedFraction"');
  });
});

describe("addSegment / removeSegment", () => {
  it("appends a segment", () => {
    const result = addSegment(testAuto(), "leg1", { kind: "line", from: "current", to: { xIn: 30, yIn: 30 } });
    const step = result.steps.find((s) => s.id === "leg1");
    if (step?.kind !== "path") throw new Error("expected path");
    expect(step.segments).toHaveLength(2);
    canonicalRoundTrip(result);
  });

  it("removes a segment", () => {
    let auto = testAuto();
    auto = addSegment(auto, "leg1", { kind: "line", from: "current", to: { xIn: 30, yIn: 30 } });
    const result = removeSegment(auto, "leg1", 0);
    const step = result.steps.find((s) => s.id === "leg1");
    if (step?.kind !== "path") throw new Error("expected path");
    expect(step.segments).toHaveLength(1);
    canonicalRoundTrip(result);
  });

  it("refuses to remove the last segment", () => {
    expect(() => removeSegment(testAuto(), "leg1", 0)).toThrow(EditError);
  });

  it("throws on an out-of-range segment index", () => {
    expect(() => removeSegment(testAuto(), "leg1", 3)).toThrow(EditError);
  });
});

describe("addMarker / removeMarker / setMarkerAt", () => {
  it("adds a marker", () => {
    const result = addMarker(testAuto(), "leg1", {
      at: { t: 0.9 },
      command: { name: "setIntake", args: { side: "FRONT", state: "STOP" } },
    });
    const step = result.steps.find((s) => s.id === "leg1");
    if (step?.kind !== "path") throw new Error("expected path");
    expect(step.markers).toHaveLength(2);
    canonicalRoundTrip(result);
  });

  it("removes a marker", () => {
    const result = removeMarker(testAuto(), "leg1", 0);
    const step = result.steps.find((s) => s.id === "leg1");
    if (step?.kind !== "path") throw new Error("expected path");
    expect(step.markers ?? []).toHaveLength(0);
    canonicalRoundTrip(result);
  });

  it("moves a marker's at", () => {
    const result = setMarkerAt(testAuto(), "leg1", 0, { distanceIn: 12 });
    const step = result.steps.find((s) => s.id === "leg1");
    if (step?.kind !== "path") throw new Error("expected path");
    expect(step.markers?.[0]?.at).toEqual({ distanceIn: 12 });
    canonicalRoundTrip(result);
  });

  it("throws on an out-of-range marker index", () => {
    expect(() => removeMarker(testAuto(), "leg1", 5)).toThrow(EditError);
    expect(() => setMarkerAt(testAuto(), "leg1", 5, { distanceIn: 1 })).toThrow(EditError);
  });
});

/**
 * The starter examples' driveOut, as the editor's split leaves it (issue #146): the two halves of
 * a straight line north from (-12, -63) to (-12, -36), meeting at a pose written twice.
 */
const splitDriveOut = (): Auto => {
  const whole = parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "split-drive-out",
    alliance: "RED",
    start: { pose: { xIn: -12, yIn: -63, headingRad: 1.5708 } },
    steps: [
      {
        id: "driveOut",
        kind: "path",
        segments: [
          {
            kind: "line",
            from: { xIn: -12, yIn: -63, headingRad: 1.5708 },
            to: { xIn: -12, yIn: -36, headingRad: 1.5708 },
          },
        ],
        heading: { mode: "tangent" },
      },
    ],
  });
  return applyFix(whole, { kind: "splitSegment", stepId: "driveOut", label: "Split here", params: { segmentIndex: 0 } });
};

const segmentsOf = (auto: Auto, id = "driveOut"): Segment[] => {
  const step = auto.steps.find((candidate) => candidate.id === id);
  if (step?.kind !== "path") throw new Error(`expected the path ${id}`);
  return step.segments;
};

const gapsIn = (auto: Auto) => {
  const resolved = resolve(auto);
  return continuityGaps(resolved.steps, resolved.startPose);
};

describe("a path's interior joint (issue #146)", () => {
  it("moves segment 0's to of a split driveOut and segment 1's from together, and one undo restores both", () => {
    const split = splitDriveOut();
    expect(segmentsOf(split)).toHaveLength(2);
    const undo = [canonicalize("auto", split)];

    const moved = setPose(
      split,
      "driveOut",
      { segmentIndex: 0, pointKind: "to" },
      { xIn: 12, yIn: -49.5, headingRad: 1.5708, provenance: "SET FROM EDITOR" },
      { joint: true },
    );
    const [first, second] = segmentsOf(moved);
    expect(first?.to).toEqual({ xIn: 12, yIn: -49.5, headingRad: 1.5708, provenance: "SET FROM EDITOR" });
    expect(second?.from).toEqual(first?.to);
    expect(gapsIn(moved)).toEqual([]);
    canonicalRoundTrip(moved);

    // The editor's undo stack is a stack of canonical strings: one entry takes back both ends.
    const restored = parseAuto(JSON.parse(undo.pop() ?? "") as unknown);
    const [before, after] = segmentsOf(restored);
    expect(before?.to).toMatchObject({ xIn: -12, yIn: -49.5 });
    expect(after?.from).toMatchObject({ xIn: -12, yIn: -49.5 });
  });

  it("moves the joint from either end, and leaves the other end alone without the joint option", () => {
    const fromSecond = setPose(
      splitDriveOut(),
      "driveOut",
      { segmentIndex: 1, pointKind: "from" },
      { xIn: 0, yIn: -50 },
      { joint: true },
    );
    expect(segmentsOf(fromSecond)[0]?.to).toEqual({ xIn: 0, yIn: -50 });

    const alone = setPose(splitDriveOut(), "driveOut", { segmentIndex: 0, pointKind: "to" }, { xIn: 0, yIn: -50 });
    expect(segmentsOf(alone)[1]?.from).toMatchObject({ xIn: -12, yIn: -49.5 });
    expect(gapsIn(alone)).toHaveLength(1);
  });

  it("treats two ends within the CONTINUITY tolerance, or on one waypoint, as one joint", () => {
    const path = (segments: Segment[]): PathStep => ({ id: "p", kind: "path", segments, heading: { mode: "tangent" } });
    const to: PoseTarget = { segmentIndex: 0, pointKind: "to" };
    const twin: PoseTarget = { segmentIndex: 1, pointKind: "from" };
    const near = path([
      { kind: "line", from: { xIn: 0, yIn: 0 }, to: { xIn: 10, yIn: 0 } },
      { kind: "line", from: { xIn: 10.4, yIn: 0 }, to: { xIn: 20, yIn: 0 } },
    ]);
    expect(jointTwin(near, to)).toEqual(twin);
    expect(jointTwin(near, twin)).toEqual(to);

    const far = path([
      { kind: "line", from: { xIn: 0, yIn: 0 }, to: { xIn: 10, yIn: 0 } },
      { kind: "line", from: { xIn: 11, yIn: 0 }, to: { xIn: 20, yIn: 0 } },
    ]);
    expect(jointTwin(far, to)).toBeNull();

    const sameWaypoint = path([
      { kind: "line", from: { xIn: 0, yIn: 0 }, to: { ref: "middle" } },
      { kind: "line", from: { ref: "middle" }, to: { xIn: 20, yIn: 0 } },
    ]);
    expect(jointTwin(sameWaypoint, to)).toEqual(twin);

    const waypointAndPose = path([
      { kind: "line", from: { xIn: 0, yIn: 0 }, to: { ref: "middle" } },
      { kind: "line", from: { xIn: 10, yIn: 0.2 }, to: { xIn: 20, yIn: 0 } },
    ]);
    // A waypoint can only be measured against a pose with the waypoints in hand.
    expect(jointTwin(waypointAndPose, to)).toBeNull();
    const waypoints = parseWaypoints({
      $schema: SCHEMA_ID.waypoints,
      formatVersion: 1,
      waypoints: { middle: { xIn: 10, yIn: 0, headingRad: 0 } },
    });
    expect(jointTwin(waypointAndPose, to, waypoints)).toEqual(twin);

    // A segment written to start from "current" already follows the end before it.
    const chained = path([
      { kind: "line", from: { xIn: 0, yIn: 0 }, to: { xIn: 10, yIn: 0 } },
      { kind: "line", from: "current", to: { xIn: 20, yIn: 0 } },
    ]);
    expect(jointTwin(chained, to)).toBeNull();

    // The path's own two ends are not joints.
    expect(jointTwin(near, { segmentIndex: 0, pointKind: "from" })).toBeNull();
    expect(jointTwin(near, { segmentIndex: 1, pointKind: "to" })).toBeNull();
  });

  it("never writes a heading on a Bezier control point", () => {
    let auto = testAuto();
    auto = addSegment(auto, "leg1", {
      kind: "bezier",
      from: "current",
      control: [{ xIn: 1, yIn: 1 }],
      to: { xIn: 5, yIn: 5 },
    });
    const result = setPose(
      auto,
      "leg1",
      { segmentIndex: 1, pointKind: "control", controlIndex: 0 },
      { xIn: 2, yIn: 3, headingRad: 1.5708, provenance: "SET FROM EDITOR" },
      { joint: true },
    );
    const segment = segmentsOf(result, "leg1")[1];
    if (segment?.kind !== "bezier") throw new Error("expected bezier");
    expect(segment.control[0]).toEqual({ xIn: 2, yIn: 3, provenance: "SET FROM EDITOR" });
  });
});

/**
 * A path chain's paths added, removed and joined so the chain stays joined (issue #185, decision
 * D5). driveOut runs north from (-12, -63) to (-12, -36), 27 in, with a marker halfway along it.
 */
const headingOf = (auto: Auto): Heading | undefined => {
  const step = auto.steps[0];
  return step?.kind === "path" ? step.heading : undefined;
};

const driveOut = (segments?: Segment[], extra: Partial<PathStep> = {}): Auto =>
  parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "chain-edit",
    alliance: "RED",
    start: { pose: { xIn: -12, yIn: -63, headingRad: 1.5708 } },
    steps: [
      {
        id: "driveOut",
        kind: "path",
        segments: segments ?? [
          { kind: "line", from: { xIn: -12, yIn: -63, headingRad: 1.5708 }, to: { xIn: -12, yIn: -36 } },
        ],
        heading: { mode: "tangent" },
        markers: [{ at: { t: 0.5 }, command: { name: "shootAll" } }],
        ...extra,
      },
      {
        id: "park",
        kind: "path",
        segments: [{ kind: "line", from: "current", to: { xIn: 12, yIn: -36 } }],
        heading: { mode: "tangent" },
      },
    ],
  });

/** How far along driveOut, in inches from its start, marker `index` fires. */
const markerDistanceIn = (auto: Auto, index = 0): number => {
  const resolved = resolve(auto).steps.find((step) => step.id === "driveOut");
  const step = auto.steps.find((candidate) => candidate.id === "driveOut");
  if (resolved?.segments === undefined || step?.kind !== "path") throw new Error("expected driveOut");
  const lengthIn = makePath(resolved.segments.map((segment) => segment.pointsIn)).lengthIn;
  const at = step.markers?.[index]?.at;
  if (at === undefined) throw new Error("expected a marker");
  if ("t" in at) return at.t * lengthIn;
  if ("distanceIn" in at) return at.distanceIn;
  return lengthIn - at.distanceFromEndIn;
};

const continuityFindings = (auto: Auto) =>
  check(plan(resolve(auto), testRobot, testField), null, testRobot, testField).filter(
    (finding) => finding.code === "CONTINUITY",
  );

describe("appendPath / removePath / joinAt (issue #185)", () => {
  it("appendPath on driveOut adds a line from current, and a t-placed marker keeps its distance from the start", () => {
    const before = driveOut();
    expect(markerDistanceIn(before)).toBeCloseTo(13.5, 6);
    const result = appendPath(before, "driveOut");
    const segments = segmentsOf(result.auto);
    expect(segments).toHaveLength(2);
    const added = segments[1];
    expect(added?.kind).toBe("line");
    expect(added?.from).toBe("current");
    // 24 in along the way the chain ends facing, north, with the editor's provenance.
    expect(added?.to).toEqual({ xIn: -12, yIn: -12, provenance: "SET FROM EDITOR" });
    expect(Math.abs(markerDistanceIn(result.auto) - 13.5)).toBeLessThanOrEqual(0.1);
    expect(result.movedMarkers).toBe(1);
    expect(continuityFindings(result.auto)).toEqual([]);
    canonicalRoundTrip(result.auto);
  });

  it("appendPath with keepEndHeading turns up to where the chain ended and holds there (issue #435)", () => {
    const turning = setHeadingMode(driveOut(), "driveOut", { mode: "linear", fromRad: 0, toRad: 1 });
    const plain = appendPath(turning, "driveOut");
    expect(headingOf(plain.auto)).toEqual({ mode: "linear", fromRad: 0, toRad: 1 });

    const kept = appendPath(turning, "driveOut", { keepEndHeading: true });
    const heading = headingOf(kept.auto);
    if (heading?.mode !== "piecewise") throw new Error("expected the turn to be kept to the old part");
    expect(heading.ranges).toHaveLength(2);
    expect(heading.ranges[0]?.heading).toEqual({ mode: "linear", fromRad: 0, toRad: 1 });
    expect(heading.ranges[1]?.heading).toEqual({ mode: "linear", fromRad: 1, toRad: 1 });
    // The old 27 in of the 51 in chain, so the turn ends there.
    expect(heading.ranges[0]?.endT).toBeCloseTo(27 / 51, 3);
    expect(heading.ranges[1]?.startT).toBe(heading.ranges[0]?.endT);
    expect(heading.ranges[1]?.endT).toBe(1);
    canonicalRoundTrip(kept.auto);

    // A Linear heading that does not turn stays one plain heading, however often the chain grows,
    // rather than becoming ranges that all hold the same heading (W2-17).
    let held = setHeadingMode(driveOut(), "driveOut", { mode: "linear", fromRad: 1.5708, toRad: 1.5708 });
    for (let grow = 0; grow < 3; grow += 1) {
      const grown = appendPath(held, "driveOut", { keepEndHeading: true });
      expect(headingOf(grown.auto)).toEqual({ mode: "linear", fromRad: 1.5708, toRad: 1.5708 });
      expect(grown.movedRanges).toBe(0);
      held = grown.auto;
    }

    // Ranges that hold the same angle in different modes, Constant and a Linear that does not turn,
    // are not one plain heading: the chain keeps them as ranges.
    const mixedModes = driveOut(undefined, {
      heading: {
        mode: "piecewise",
        ranges: [
          { startT: 0, endT: 0.5, heading: { mode: "constant", headingRad: 1.5708 } },
          { startT: 0.5, endT: 1, heading: { mode: "linear", fromRad: 1.5708, toRad: 1.5708 } },
        ],
      },
    });
    const keptRanges = appendPath(mixedModes, "driveOut", { keepEndHeading: true });
    expect(headingOf(keptRanges.auto)?.mode).toBe("piecewise");

    // Tangent and Constant already hold or follow the path, so they are left alone.
    for (const other of [{ mode: "tangent" }, { mode: "constant", headingRad: 1 }] as const) {
      const done = appendPath(setHeadingMode(driveOut(), "driveOut", other), "driveOut", { keepEndHeading: true });
      expect(headingOf(done.auto)).toEqual(other);
    }
  });

  it("appendPath stops where the robot would touch the wall, given the robot and the field", () => {
    const nearWall = driveOut([
      { kind: "line", from: { xIn: -12, yIn: -63, headingRad: 1.5708 }, to: { xIn: -12, yIn: 50 } },
    ]);
    // The test robot is 18 in long, so facing north its centre stops 9 in short of the wall at 72.
    const result = appendPath(nearWall, "driveOut", { robot: testRobot, field: testField });
    expect(segmentsOf(result.auto)[1]?.to).toEqual({ xIn: -12, yIn: 63, provenance: "SET FROM EDITOR" });
  });

  it("appendPath keeps a piecewise heading's boundaries where they were and stretches the last range", () => {
    const before = driveOut(undefined, {
      heading: {
        mode: "piecewise",
        ranges: [
          { startT: 0, endT: 0.5, heading: { mode: "tangent" } },
          { startT: 0.5, endT: 1, heading: { mode: "constant", headingRad: 0 } },
        ],
      },
    });
    const result = appendPath(before, "driveOut");
    const step = result.auto.steps.find((candidate) => candidate.id === "driveOut");
    if (step?.kind !== "path" || step.heading?.mode !== "piecewise") throw new Error("expected a piecewise path");
    const boundary = Math.round((13.5 / (27 + 24)) * 10000) / 10000;
    expect(step.heading.ranges.map((range) => [range.startT, range.endT])).toEqual([
      [0, boundary],
      [boundary, 1],
    ]);
    expect(result.movedRanges).toBe(2);
  });

  it("removePath of an interior path starts the next one from current and leaves zero CONTINUITY findings", () => {
    const three = driveOut([
      { kind: "line", from: { xIn: -12, yIn: -63, headingRad: 1.5708 }, to: { xIn: -12, yIn: -50 } },
      { kind: "line", from: { xIn: -12, yIn: -50 }, to: { xIn: 0, yIn: -50 } },
      { kind: "line", from: { xIn: 0, yIn: -50 }, to: { xIn: 0, yIn: -36 } },
    ]);
    // Without the rewrite, the third path would start 12 in from where the first one ends.
    expect(continuityFindings(removeSegment(three, "driveOut", 1))).toHaveLength(1);

    const result = removePath(three, "driveOut", 1);
    const segments = segmentsOf(result.auto);
    expect(segments).toHaveLength(2);
    expect(segments[1]?.from).toBe("current");
    expect(segments[1]?.to).toEqual({ xIn: 0, yIn: -36 });
    expect(continuityFindings(result.auto)).toEqual([]);
    canonicalRoundTrip(result.auto);
  });

  it("removePath of the first path keeps where the chain starts, and of the last path drops it", () => {
    const two = splitDriveOut();
    expect(segmentsOf(removePath(two, "driveOut", 0).auto)).toEqual([
      {
        kind: "line",
        from: { xIn: -12, yIn: -63, headingRad: 1.5708 },
        to: { xIn: -12, yIn: -36, headingRad: 1.5708 },
      },
    ]);
    const last = segmentsOf(removePath(two, "driveOut", 1).auto);
    expect(last).toHaveLength(1);
    expect(last[0]?.to).toMatchObject({ xIn: -12, yIn: -49.5 });
  });

  it("removePath refuses a one-path chain, and both edits name a waypoint the chain no longer follows", () => {
    expect(() => removePath(driveOut(), "driveOut", 0)).toThrow(EditError);
    const viaWaypoint = driveOut([
      { kind: "line", from: { xIn: -12, yIn: -63, headingRad: 1.5708 }, to: { ref: "middle" } },
      { kind: "line", from: { ref: "middle" }, to: { xIn: -12, yIn: -36 } },
    ]);
    // The last path goes, and the first still ends on the waypoint.
    expect(removePath(viaWaypoint, "driveOut", 1).droppedWaypoints).toEqual([]);
    expect(removePath(viaWaypoint, "driveOut", 0).droppedWaypoints).toEqual(["middle"]);
    expect(joinAt(viaWaypoint, "driveOut", 1).droppedWaypoints).toEqual(["middle"]);
  });

  it("joinAt merges the split halves of driveOut back into one line", () => {
    const result = joinAt(splitDriveOut(), "driveOut", 1);
    expect(segmentsOf(result.auto)).toEqual([
      {
        kind: "line",
        from: { xIn: -12, yIn: -63, headingRad: 1.5708 },
        to: { xIn: -12, yIn: -36, headingRad: 1.5708 },
      },
    ]);
    expect(continuityFindings(result.auto)).toEqual([]);
    canonicalRoundTrip(result.auto);
  });

  it("joinAt makes a curve that keeps the outer controls, at most three", () => {
    const curves = driveOut([
      { kind: "bezier", from: { xIn: 0, yIn: 0 }, control: [{ xIn: 1, yIn: 5 }, { xIn: 2, yIn: 6 }], to: { xIn: 5, yIn: 5 } },
      { kind: "bezier", from: { xIn: 5, yIn: 5 }, control: [{ xIn: 7, yIn: 4 }, { xIn: 9, yIn: 2 }], to: { xIn: 10, yIn: 0 } },
    ]);
    const [merged] = segmentsOf(joinAt(curves, "driveOut", 1).auto);
    expect(merged).toEqual({
      kind: "bezier",
      from: { xIn: 0, yIn: 0 },
      control: [{ xIn: 1, yIn: 5 }, { xIn: 2, yIn: 6 }, { xIn: 9, yIn: 2 }],
      to: { xIn: 10, yIn: 0 },
    });

    const lineThenCurve = driveOut([
      { kind: "line", from: { xIn: 0, yIn: 0 }, to: { xIn: 5, yIn: 5 } },
      { kind: "bezier", from: "current", control: [{ xIn: 8, yIn: 5 }], to: { xIn: 10, yIn: 0 } },
    ]);
    expect(segmentsOf(joinAt(lineThenCurve, "driveOut", 1).auto)).toEqual([
      { kind: "bezier", from: { xIn: 0, yIn: 0 }, control: [{ xIn: 8, yIn: 5 }], to: { xIn: 10, yIn: 0 } },
    ]);
  });

  it("joinAt refuses a point that is not where two paths meet", () => {
    expect(() => joinAt(splitDriveOut(), "driveOut", 0)).toThrow(EditError);
    expect(() => joinAt(splitDriveOut(), "driveOut", 2)).toThrow(EditError);
    expect(() => joinAt(splitDriveOut(), "nothing", 1)).toThrow(EditError);
  });

  it("removeControl takes one control point away, and the last one makes the path a line", () => {
    const curve = driveOut([
      { kind: "bezier", from: { xIn: 0, yIn: 0 }, control: [{ xIn: 1, yIn: 5 }, { xIn: 9, yIn: 5 }], to: { xIn: 10, yIn: 0 } },
    ]);
    const one = removeControl(curve, "driveOut", 0, 0);
    expect(segmentsOf(one.auto)[0]).toEqual({ kind: "bezier", from: { xIn: 0, yIn: 0 }, control: [{ xIn: 9, yIn: 5 }], to: { xIn: 10, yIn: 0 } });
    const none = removeControl(one.auto, "driveOut", 0, 0);
    expect(segmentsOf(none.auto)[0]).toEqual({ kind: "line", from: { xIn: 0, yIn: 0 }, to: { xIn: 10, yIn: 0 } });
    expect(() => removeControl(none.auto, "driveOut", 0, 0)).toThrow(EditError);
  });
});

/**
 * Two path steps that follow each other become one chain (issue #204, the rest of decision D5).
 * driveOut runs 27 in north from (-12, -63) and park 24 in east from where it ends, to (12, -36).
 */
const twoSteps = (driveOutExtra: Partial<PathStep> = {}, parkExtra: Partial<PathStep> = {}, between: unknown[] = []): Auto =>
  parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "join-steps",
    alliance: "RED",
    start: { pose: { xIn: -12, yIn: -63, headingRad: 1.5708 } },
    steps: [
      {
        id: "driveOut",
        kind: "path",
        segments: [{ kind: "line", from: { xIn: -12, yIn: -63, headingRad: 1.5708 }, to: { xIn: -12, yIn: -36 } }],
        heading: { mode: "tangent" },
        markers: [{ at: { t: 0.5 }, command: { name: "shootAll" } }],
        ...driveOutExtra,
      },
      ...between,
      {
        id: "park",
        kind: "path",
        segments: [{ kind: "line", from: "current", to: { xIn: 12, yIn: -36 } }],
        heading: { mode: "constant", headingRad: 0 },
        markers: [{ at: { t: 0.5 }, command: { name: "intake" } }],
        ...parkExtra,
      },
    ],
  });

/** How far along driveOut, from its start, each of its markers fires, in inches. */
const markerDistancesIn = (auto: Auto): number[] => {
  const step = auto.steps.find((candidate) => candidate.id === "driveOut");
  if (step?.kind !== "path") throw new Error("expected driveOut");
  return (step.markers ?? []).map((_, index) => markerDistanceIn(auto, index));
};

describe("joinSteps (issue #204)", () => {
  const box = (maxDurationS: number): Partial<PathStep> => ({
    envelope: {
      polygon: [
        { xIn: -20, yIn: -70 },
        { xIn: 20, yIn: -70 },
        { xIn: 0, yIn: -30 },
      ],
      maxDurationS,
      provenance: "SET BY HAND: test fixture",
    },
  });
  const joinedStep = (auto: Auto): PathStep => {
    const step = auto.steps[0];
    if (step?.kind !== "path") throw new Error("expected a path");
    return step;
  };

  it("takes the second step's envelope and expect when the first has none, and joins the notes", () => {
    const result = joinSteps(
      twoSteps({ notes: "first" }, { notes: "second", expect: { count: 2 }, ...box(4) }),
      "driveOut",
      "park",
    );
    const joined = joinedStep(result.auto);
    expect(joined.envelope?.maxDurationS).toBe(4);
    expect(joined.expect).toEqual({ count: 2 });
    expect(joined.notes).toBe("first\n\nsecond");
  });

  it("keeps the first step's envelope and expect when both have the same one", () => {
    const joined = joinedStep(joinSteps(twoSteps({ ...box(4), expect: { count: 1 } }, { ...box(4), expect: { count: 1 } }), "driveOut", "park").auto);
    expect(joined.envelope?.maxDurationS).toBe(4);
    expect(joined.expect).toEqual({ count: 1 });
  });

  it("refuses two different envelopes or expects, and says both steps have one", () => {
    expect(joinStepsProblem(twoSteps(box(4), box(6)), "driveOut", "park")).toMatch(/envelope \(both have one\)/);
    expect(joinStepsProblem(twoSteps({ expect: { count: 1 } }, { expect: { count: 2 } }), "driveOut", "park")).toMatch(
      /expect \(both have one\)/,
    );
    expect(() => joinSteps(twoSteps(box(4), box(6)), "driveOut", "park")).toThrow(EditError);
  });

  it("joins two line steps with different heading modes into one chain with a two-range piecewise heading", () => {
    const result = joinSteps(twoSteps(), "driveOut", "park");
    expect(result.auto.steps.map((step) => step.id)).toEqual(["driveOut"]);
    const segments = segmentsOf(result.auto);
    expect(segments).toHaveLength(2);
    expect(segments[1]).toEqual({ kind: "line", from: "current", to: { xIn: 12, yIn: -36 } });

    const step = result.auto.steps[0];
    if (step?.kind !== "path" || step.heading?.mode !== "piecewise") throw new Error("expected a piecewise path");
    // The joint sits 27 in along a chain 51 in long.
    const joint = Math.round((27 / 51) * 10000) / 10000;
    expect(step.heading.ranges).toEqual([
      { startT: 0, endT: joint, heading: { mode: "tangent" } },
      { startT: joint, endT: 1, heading: { mode: "constant", headingRad: 0 } },
    ]);

    // driveOut's marker stays 13.5 in from the start; park's stays 12 in from where park started.
    const [own, moved] = markerDistancesIn(result.auto);
    expect(Math.abs((own ?? 0) - 13.5)).toBeLessThanOrEqual(0.1);
    expect(Math.abs((moved ?? 0) - 27 - 12)).toBeLessThanOrEqual(0.1);
    expect(result.movedMarkers).toBe(2);
    expect(continuityFindings(result.auto)).toEqual([]);
    canonicalRoundTrip(result.auto);
  });

  it("keeps one heading mode when both steps have the same heading", () => {
    const result = joinSteps(twoSteps({}, { heading: { mode: "tangent" } }), "driveOut", "park");
    const step = result.auto.steps[0];
    if (step?.kind !== "path") throw new Error("expected a path");
    expect(step.heading).toEqual({ mode: "tangent" });
    expect(result.movedRanges).toBe(0);
  });

  it("keeps both steps' ranges when the two have the same piecewise heading", () => {
    const piecewise: Partial<PathStep> = {
      heading: {
        mode: "piecewise",
        ranges: [
          { startT: 0, endT: 0.5, heading: { mode: "tangent" } },
          { startT: 0.5, endT: 1, heading: { mode: "constant", headingRad: 0 } },
        ],
      },
    };
    const result = joinSteps(twoSteps(piecewise, piecewise), "driveOut", "park");
    const step = result.auto.steps[0];
    if (step?.kind !== "path" || step.heading?.mode !== "piecewise") throw new Error("expected a piecewise path");
    // driveOut's boundary stays 13.5 in along, park's 12 in after the joint at 27 in.
    const t = (sIn: number) => Math.round((sIn / 51) * 10000) / 10000;
    expect(step.heading.ranges).toEqual([
      { startT: 0, endT: t(13.5), heading: { mode: "tangent" } },
      { startT: t(13.5), endT: t(27), heading: { mode: "constant", headingRad: 0 } },
      { startT: t(27), endT: t(39), heading: { mode: "tangent" } },
      { startT: t(39), endT: 1, heading: { mode: "constant", headingRad: 0 } },
    ]);
    expect(result.movedRanges).toBe(4);
    canonicalRoundTrip(result.auto);
  });

  it("gives each step its own range when the two have the same linear heading", () => {
    const linear: Partial<PathStep> = { heading: { mode: "linear", fromRad: 0, toRad: 1.5 } };
    const result = joinSteps(twoSteps(linear, linear), "driveOut", "park");
    const step = result.auto.steps[0];
    if (step?.kind !== "path" || step.heading?.mode !== "piecewise") throw new Error("expected a piecewise path");
    // The robot still sweeps from 0 to 1.5 rad in each part, not once across the whole chain.
    const joint = Math.round((27 / 51) * 10000) / 10000;
    expect(step.heading.ranges).toEqual([
      { startT: 0, endT: joint, heading: { mode: "linear", fromRad: 0, toRad: 1.5 } },
      { startT: joint, endT: 1, heading: { mode: "linear", fromRad: 0, toRad: 1.5 } },
    ]);
    expect(result.movedRanges).toBe(0);
  });

  it("keeps the ranges of a step that is already piecewise, rescaled into its part", () => {
    const piecewise: Partial<PathStep> = {
      heading: {
        mode: "piecewise",
        ranges: [
          { startT: 0, endT: 0.5, heading: { mode: "tangent" } },
          { startT: 0.5, endT: 1, heading: { mode: "constant", headingRad: 1.5708 } },
        ],
      },
    };
    const result = joinSteps(twoSteps(piecewise), "driveOut", "park");
    const step = result.auto.steps[0];
    if (step?.kind !== "path" || step.heading?.mode !== "piecewise") throw new Error("expected a piecewise path");
    const t = (sIn: number) => Math.round((sIn / 51) * 10000) / 10000;
    expect(step.heading.ranges.map((range) => [range.startT, range.endT])).toEqual([
      [0, t(13.5)],
      [t(13.5), t(27)],
      [t(27), 1],
    ]);
    expect(step.heading.ranges[2]?.heading).toEqual({ mode: "constant", headingRad: 0 });
    expect(result.movedRanges).toBe(2);
  });

  it("refuses when speedFraction, endCondition or timeoutS differ, and names which", () => {
    expect(() => joinSteps(twoSteps({ speedFraction: 0.5 }), "driveOut", "park")).toThrow(/speedFraction/);
    expect(() => joinSteps(twoSteps({}, { endCondition: { condition: "hasPiece" } }), "driveOut", "park")).toThrow(
      /endCondition/,
    );
    expect(() => joinSteps(twoSteps({ timeoutS: 3 }, { timeoutS: 2 }), "driveOut", "park")).toThrow(/timeoutS/);
    const all = joinStepsProblem(
      twoSteps({ speedFraction: 0.5, timeoutS: 3 }, { endCondition: { condition: "hasPiece" } }),
      "driveOut",
      "park",
    );
    expect(all).toMatch(/speedFraction/);
    expect(all).toMatch(/endCondition/);
    expect(all).toMatch(/timeoutS/);
    expect(joinStepsProblem(twoSteps({ timeoutS: 3 }, { timeoutS: 3 }), "driveOut", "park")).toBeNull();
  });

  it("refuses steps that are not one after the other, or a second step that starts somewhere else", () => {
    const apart = twoSteps({}, {}, [{ id: "shoot", kind: "command", name: "shootAll" }]);
    expect(joinStepsProblem(apart, "driveOut", "park")).toMatch(/straight after/);
    expect(() => joinSteps(apart, "driveOut", "shoot")).toThrow(EditError);
    const jumps = twoSteps({}, { segments: [{ kind: "line", from: { xIn: 0, yIn: -36 }, to: { xIn: 12, yIn: -36 } }] });
    expect(joinStepsProblem(jumps, "driveOut", "park")).toMatch(/starts 12\.00 in from where driveOut ends/);
    // Within the CONTINUITY tolerance, the second path starts from "current" once joined.
    const near = twoSteps({}, { segments: [{ kind: "line", from: { xIn: -12, yIn: -35.8 }, to: { xIn: 12, yIn: -36 } }] });
    expect(segmentsOf(joinSteps(near, "driveOut", "park").auto)[1]?.from).toBe("current");
  });

  it("refuses two steps of a parallel group, which run side by side", () => {
    const side = parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 1,
      name: "join-parallel",
      alliance: "RED",
      start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
      steps: [
        {
          id: "group",
          kind: "parallel",
          mode: "all",
          steps: [
            { id: "a", kind: "path", segments: [{ kind: "line", from: "current", to: { xIn: 12, yIn: 0 } }] },
            { id: "b", kind: "path", segments: [{ kind: "line", from: "current", to: { xIn: 24, yIn: 0 } }] },
          ],
        },
      ],
    });
    expect(stepAfter(side, "a")).toBe("b");
    expect(joinStepsProblem(side, "a", "b")).toMatch(/side by side/);
  });
});

describe("appendPath to a given end (issue #204)", () => {
  it("adds a line from current to the end it is given, and keeps the markers' distance from the start", () => {
    const to = { xIn: 0, yIn: -36, provenance: "SET FROM EDITOR" };
    const result = appendPath(driveOut(), "driveOut", {}, to);
    expect(segmentsOf(result.auto)[1]).toEqual({ kind: "line", from: "current", to });
    expect(Math.abs(markerDistanceIn(result.auto) - 13.5)).toBeLessThanOrEqual(0.1);
    expect(result.movedMarkers).toBe(1);
  });

  it("refuses an end where the chain already ends, which would add a path with no length", () => {
    // driveOut ends at (-12, -36), so a click that snapped onto that point or onto a waypoint there
    // would put a zero-length path in the middle of the chain.
    expect(() => appendPath(driveOut(), "driveOut", {}, { xIn: -12, yIn: -36, provenance: "SET FROM EDITOR" })).toThrow(EditError);
    const waypoints = parseWaypoints({
      $schema: SCHEMA_ID.waypoints,
      formatVersion: 1,
      waypoints: { hereToo: { xIn: -12, yIn: -36, headingRad: 0 } },
    });
    expect(() => appendPath(driveOut(), "driveOut", { waypoints }, { ref: "hereToo" })).toThrow(/no length|already ends/);
  });
});

describe("setRoute", () => {
  /** A path with every keep-list field set, followed by a command and a second path. */
  const routed = (): Auto =>
    parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 1,
      name: "route-fixture",
      title: "Route fixture",
      alliance: "RED",
      start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
      steps: [
        {
          id: "drive",
          kind: "path",
          timeoutS: 5,
          segments: [
            {
              kind: "bezier",
              from: { xIn: 0, yIn: 0, headingRad: 0 },
              control: [{ xIn: 10, yIn: 20 }],
              to: { xIn: 30, yIn: 30, headingRad: 1.5708 },
            },
          ],
          heading: { mode: "linear", fromRad: 0, toRad: 1.5708 },
          speedFraction: 0.7,
          markers: [{ at: { distanceIn: 12 }, command: { name: "shootAll", args: { count: 3 } } }],
          notes: "keep me",
        },
        { id: "shoot", kind: "command", name: "shootAll", timeoutS: 2 },
        {
          id: "back",
          kind: "path",
          segments: [{ kind: "line", from: "current", to: { xIn: 0, yIn: 0, headingRad: 0 } }],
          heading: { mode: "tangent" },
        },
      ],
    });

  const newRoute: Segment[] = [
    { kind: "line", from: { xIn: 0, yIn: 0, headingRad: 0 }, to: { xIn: 12, yIn: 5 } },
    { kind: "bezier", from: "current", control: [{ xIn: 20, yIn: 10 }, { xIn: 26, yIn: 20 }], to: { xIn: 30, yIn: 30, headingRad: 1.5708 } },
  ];
  const newHeading: Heading = { mode: "piecewise", ranges: [
    { startT: 0, endT: 0.5, heading: { mode: "tangent" } },
    { startT: 0.5, endT: 1, heading: { mode: "linear", fromRad: 0.3, toRad: 1.5708 } },
  ] };

  const pathOf = (auto: Auto, id: string): PathStep => {
    const step = auto.steps.find((candidate) => candidate.id === id);
    if (step?.kind !== "path") throw new Error("expected a path");
    return step;
  };

  it("replaces only the segments and the heading", () => {
    const before = routed();
    const after = setRoute(before, "drive", newRoute, newHeading);
    const step = pathOf(after, "drive");
    expect(step.segments).toEqual(newRoute);
    expect(step.heading).toEqual(newHeading);
    const { segments: _s, heading: _h, ...keepAfter } = step;
    const { segments: _s0, heading: _h0, ...keepBefore } = pathOf(before, "drive");
    expect(JSON.stringify(keepAfter)).toBe(JSON.stringify(keepBefore));
    expect(keepAfter).toMatchObject({ speedFraction: 0.7, timeoutS: 5, notes: "keep me" });
    canonicalRoundTrip(after);
  });

  it("leaves every other step byte-identical after canonicalize", () => {
    const before = routed();
    const after = setRoute(before, "drive", newRoute, newHeading);
    for (const id of ["shoot", "back"]) {
      expect(JSON.stringify(after.steps.find((s) => s.id === id))).toBe(JSON.stringify(before.steps.find((s) => s.id === id)));
    }
    // Put the old route back: the whole document is the one it began as.
    const old = pathOf(before, "drive");
    if (old.heading === undefined) throw new Error("expected a heading");
    const restored = setRoute(after, "drive", old.segments, old.heading);
    expect(canonicalize("auto", restored)).toBe(canonicalize("auto", before));
  });

  it("finds a path inside a parallel group", () => {
    const after = setRoute(testAuto(), "drive", [{ kind: "line", from: "current", to: { xIn: 12, yIn: 24, headingRad: 0 } }], {
      mode: "constant",
      headingRad: 0.5,
    });
    const group = after.steps.find((s) => s.kind === "parallel");
    const inner = group?.kind === "parallel" ? group.steps.find((s) => s.id === "drive") : undefined;
    expect(inner?.kind === "path" && inner.heading).toEqual({ mode: "constant", headingRad: 0.5 });
  });

  it("refuses a moved first from", () => {
    const moved: Segment[] = [{ ...(newRoute[0] as Segment), from: { xIn: 1, yIn: 0, headingRad: 0 } }, newRoute[1] as Segment];
    expect(() => setRoute(routed(), "drive", moved, newHeading)).toThrow(EditError);
    const current: Segment[] = [{ ...(newRoute[0] as Segment), from: "current" }, newRoute[1] as Segment];
    expect(() => setRoute(routed(), "drive", current, newHeading)).toThrow(/starts/);
  });

  it("refuses a moved last to, a dropped heading on it, and a waypoint in place of the inline pose", () => {
    const last = newRoute[1] as Segment;
    expect(() => setRoute(routed(), "drive", [newRoute[0] as Segment, { ...last, to: { xIn: 30, yIn: 31, headingRad: 1.5708 } }], newHeading)).toThrow(EditError);
    expect(() => setRoute(routed(), "drive", [newRoute[0] as Segment, { ...last, to: { xIn: 30, yIn: 30 } }], newHeading)).toThrow(EditError);
    expect(() => setRoute(routed(), "drive", [newRoute[0] as Segment, { ...last, to: { ref: "somewhere" } }], newHeading)).toThrow(/ends/);
  });

  it("keeps a current start and a waypoint end as written", () => {
    const toDock = parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 1,
      name: "dock-fixture",
      title: "Dock fixture",
      alliance: "RED",
      start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
      steps: [{ id: "toDock", kind: "path", segments: [{ kind: "line", from: "current", to: { ref: "dock" } }], heading: { mode: "tangent" } }],
    });
    const route: Segment[] = [
      { kind: "line", from: "current", to: { xIn: 4, yIn: 4 } },
      { kind: "line", from: "current", to: { ref: "dock" } },
    ];
    expect(pathOf(setRoute(toDock, "toDock", route, { mode: "tangent" }), "toDock").segments).toEqual(route);
  });

  it("refuses a command step and an unknown id", () => {
    expect(() => setRoute(routed(), "shoot", newRoute, newHeading)).toThrow(EditError);
    expect(() => setRoute(routed(), "shoot", newRoute, newHeading)).toThrow(/not a path/);
    expect(() => setRoute(routed(), "nowhere", newRoute, newHeading)).toThrow(/No step with id/);
  });

  it("refuses an empty route, and a route the schema would refuse", () => {
    expect(() => setRoute(routed(), "drive", [], newHeading)).toThrow(EditError);
    const tooManyControls = [
      { ...(newRoute[1] as Segment), from: { xIn: 0, yIn: 0, headingRad: 0 }, control: [{ xIn: 1, yIn: 1 }, { xIn: 2, yIn: 2 }, { xIn: 3, yIn: 3 }, { xIn: 4, yIn: 4 }] },
    ] as unknown as Segment[];
    expect(() => setRoute(routed(), "drive", tooManyControls, newHeading)).toThrow(EditError);
  });

  it("does not mutate the auto it was given", () => {
    const before = routed();
    const snapshot = canonicalize("auto", before);
    setRoute(before, "drive", newRoute, newHeading);
    expect(canonicalize("auto", before)).toBe(snapshot);
  });
});
