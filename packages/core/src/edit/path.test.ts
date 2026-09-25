import { describe, expect, it } from "vitest";
import { EditError } from "./errors.js";
import {
  addMarker,
  addSegment,
  removeMarker,
  removeSegment,
  setHeadingMode,
  setMarkerAt,
  setPose,
  setSpeed,
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
