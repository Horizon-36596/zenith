import type { Auto, Envelope, Step } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { EditError } from "./errors.js";
import {
  addEnvelopeCorner,
  removeEnvelopeCorner,
  setEnvelope,
  setEnvelopeCorner,
  setEnvelopeDurations,
  setRejoinFrom,
  setSegmentSource,
} from "./fields.js";
import { canonicalRoundTrip, testAuto } from "./testing.js";

const TRIANGLE: Envelope = {
  polygon: [
    { xIn: 0, yIn: 0 },
    { xIn: 24, yIn: 0 },
    { xIn: 24, yIn: 24 },
  ],
  maxDurationS: 4,
  provenance: "SET FROM EDITOR",
};

const stepOf = (auto: Auto, id: string): Step => {
  const found = auto.steps.find((step) => step.id === id);
  if (found === undefined) throw new Error(`no step ${id}`);
  return found;
};

const envelopeOn = (auto: Auto, id: string): Envelope | undefined => {
  const step = stepOf(auto, id);
  return step.kind === "path" || step.kind === "command" || step.kind === "wait" ? step.envelope : undefined;
};

describe("setEnvelope", () => {
  it("gives a command and a path an envelope, and takes it away again", () => {
    const withOne = setEnvelope(setEnvelope(testAuto(), "shoot", TRIANGLE), "leg1", TRIANGLE);
    expect(envelopeOn(withOne, "shoot")).toEqual(TRIANGLE);
    expect(envelopeOn(withOne, "leg1")).toEqual(TRIANGLE);
    const text = canonicalRoundTrip(withOne);
    expect(text).toContain('"envelope"');

    const removed = setEnvelope(setEnvelope(withOne, "shoot", null), "leg1", null);
    expect(canonicalRoundTrip(removed)).toBe(canonicalRoundTrip(testAuto()));
  });

  it("refuses a group, and a polygon the schema refuses", () => {
    expect(() => setEnvelope(testAuto(), "park", TRIANGLE)).toThrow(/only a path, command or wait/);
    expect(() => setEnvelope(testAuto(), "shoot", { ...TRIANGLE, polygon: TRIANGLE.polygon.slice(0, 2) })).toThrow(
      EditError,
    );
    expect(() => setEnvelope(testAuto(), "shoot", { ...TRIANGLE, maxDurationS: 0 })).toThrow(/maxDurationS/);
  });

  it("does not change the input", () => {
    const before = testAuto();
    const text = canonicalRoundTrip(before);
    setEnvelope(before, "shoot", TRIANGLE);
    expect(canonicalRoundTrip(before)).toBe(text);
  });
});

describe("setEnvelopeDurations", () => {
  const start = (): Auto => setEnvelope(testAuto(), "shoot", TRIANGLE);

  it("sets a what-if run time and clears it again, back to the same file", () => {
    const set = setEnvelopeDurations(start(), "shoot", { actualDurationS: 1.5 });
    expect(envelopeOn(set, "shoot")).toEqual({ ...TRIANGLE, actualDurationS: 1.5 });
    expect(canonicalRoundTrip(set)).toContain('"actualDurationS": 1.5');
    const cleared = setEnvelopeDurations(set, "shoot", { actualDurationS: null });
    expect(canonicalRoundTrip(cleared)).toBe(canonicalRoundTrip(start()));
  });

  it("drops a what-if equal to the window, and refuses one longer than it or not over 0", () => {
    expect(envelopeOn(setEnvelopeDurations(start(), "shoot", { actualDurationS: 4 }), "shoot")).toEqual(TRIANGLE);
    expect(() => setEnvelopeDurations(start(), "shoot", { actualDurationS: 4.5 })).toThrow(/longer than the envelope's Lasts at most/);
    expect(() => setEnvelopeDurations(start(), "shoot", { actualDurationS: 0 })).toThrow(EditError);
  });

  it("keeps a what-if shorter than a new window, and drops one the window shrinks to or under", () => {
    const set = setEnvelopeDurations(start(), "shoot", { actualDurationS: 1.5 });
    expect(envelopeOn(setEnvelopeDurations(set, "shoot", { maxDurationS: 3 }), "shoot")?.actualDurationS).toBe(1.5);
    expect(envelopeOn(setEnvelopeDurations(set, "shoot", { maxDurationS: 1.5 }), "shoot")?.actualDurationS).toBeUndefined();
    expect(envelopeOn(setEnvelopeDurations(set, "shoot", { maxDurationS: 1 }), "shoot")).toEqual({ ...TRIANGLE, maxDurationS: 1 });
  });

  it("needs an envelope to change", () => {
    expect(() => setEnvelopeDurations(testAuto(), "shoot", { actualDurationS: 1 })).toThrow(/has no envelope/);
  });
});

describe("the envelope corner edits", () => {
  const start = (): Auto => setEnvelope(testAuto(), "shoot", TRIANGLE);

  it("moves one corner", () => {
    const moved = setEnvelopeCorner(start(), "shoot", 1, { xIn: 30, yIn: -6 });
    expect(envelopeOn(moved, "shoot")?.polygon).toEqual([
      { xIn: 0, yIn: 0 },
      { xIn: 30, yIn: -6 },
      { xIn: 24, yIn: 24 },
    ]);
  });

  it("adds a corner at the middle of an edge, including the closing edge", () => {
    expect(envelopeOn(addEnvelopeCorner(start(), "shoot", 0), "shoot")?.polygon[1]).toEqual({ xIn: 12, yIn: 0 });
    const closing = envelopeOn(addEnvelopeCorner(start(), "shoot", 2), "shoot")?.polygon;
    expect(closing).toHaveLength(4);
    expect(closing?.[3]).toEqual({ xIn: 12, yIn: 12 });
  });

  it("removes a corner, but never below three", () => {
    const four = addEnvelopeCorner(start(), "shoot", 0);
    expect(envelopeOn(removeEnvelopeCorner(four, "shoot", 1), "shoot")).toEqual(TRIANGLE);
    expect(() => removeEnvelopeCorner(start(), "shoot", 0)).toThrow(EditError);
  });

  it("names a missing envelope or corner", () => {
    expect(() => setEnvelopeCorner(testAuto(), "shoot", 0, { xIn: 0, yIn: 0 })).toThrow(/has no envelope/);
    expect(() => setEnvelopeCorner(start(), "shoot", 9, { xIn: 0, yIn: 0 })).toThrow(/no corner at index 9/);
    expect(() => addEnvelopeCorner(start(), "shoot", 9)).toThrow(/no corner/);
  });
});

describe("setRejoinFrom", () => {
  const pose = { xIn: 6, yIn: 12, headingRad: 1.5708, provenance: "SET BY HAND" };

  it("sets and clears the rejoin pose of a path that starts from current", () => {
    const set = setRejoinFrom(testAuto(), "leg1", pose);
    const leg = stepOf(set, "leg1");
    expect(leg.kind === "path" ? leg.rejoinFrom : undefined).toEqual(pose);
    expect(canonicalRoundTrip(setRejoinFrom(set, "leg1", null))).toBe(canonicalRoundTrip(testAuto()));
  });

  it("refuses a path that starts from a fixed pose, and a step that is not a path", () => {
    const fixed = setSegmentSource(testAuto(), "leg1", 0, "from", { xIn: 0, yIn: 0, headingRad: 0 });
    expect(() => setRejoinFrom(fixed, "leg1", pose)).toThrow(/starts from a fixed pose/);
    expect(() => setRejoinFrom(testAuto(), "shoot", pose)).toThrow(/not a path/);
  });
});
