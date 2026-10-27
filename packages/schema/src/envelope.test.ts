import { describe, expect, it } from "vitest";
import { ENVELOPE_MAX_POINTS } from "./auto.js";
import { SCHEMA_ID } from "./ids.js";
import { parseAuto, validateKind } from "./parse.js";

const SQUARE = [
  { xIn: -72, yIn: -48 },
  { xIn: -36, yIn: -48 },
  { xIn: -36, yIn: -12 },
  { xIn: -72, yIn: -12 },
];

const ENVELOPE = {
  polygon: SQUARE,
  maxDurationS: 6,
  provenance: "SET BY HAND: vision collect stays in the south-west quarter",
};

const autoWith = (...steps: Record<string, unknown>[]): unknown => ({
  $schema: SCHEMA_ID.auto,
  formatVersion: 3,
  name: "envelope-fixture",
  alliance: "RED",
  start: { pose: { xIn: -60, yIn: -36, headingRad: 0 } },
  steps,
});

const collect = (envelope: unknown): Record<string, unknown> => ({
  id: "collect",
  kind: "command",
  name: "collectNearestPollen",
  envelope,
});

const issues = (json: unknown): string[] => {
  const result = validateKind("auto", json);
  return result.ok ? [] : result.issues;
};

describe("an envelope", () => {
  it("is accepted on a command, a wait and a path step, and kept by the parser", () => {
    const parsed = parseAuto(
      autoWith(
        collect(ENVELOPE),
        { id: "hold", kind: "wait", until: "hopperFull", envelope: ENVELOPE },
        {
          id: "drive",
          kind: "path",
          segments: [{ kind: "line", from: "current", to: { xIn: -40, yIn: -20 } }],
          heading: { mode: "tangent" },
          envelope: ENVELOPE,
        },
      ),
    );
    for (const step of parsed.steps) {
      expect("envelope" in step ? step.envelope : undefined).toEqual(ENVELOPE);
    }
  });

  it("is optional: a step without one parses exactly as before", () => {
    const parsed = parseAuto(autoWith({ id: "collect", kind: "command", name: "collectNearestPollen" }));
    expect("envelope" in (parsed.steps[0] as object)).toBe(false);
  });

  it("needs at least three corners and at most the limit", () => {
    expect(issues(autoWith(collect({ ...ENVELOPE, polygon: SQUARE.slice(0, 2) })))).not.toEqual([]);
    const many = Array.from({ length: ENVELOPE_MAX_POINTS + 1 }, (_, index) => ({
      xIn: Math.cos(index),
      yIn: Math.sin(index),
    }));
    expect(issues(autoWith(collect({ ...ENVELOPE, polygon: many })))).not.toEqual([]);
    expect(issues(autoWith(collect({ ...ENVELOPE, polygon: many.slice(0, ENVELOPE_MAX_POINTS) })))).toEqual([]);
  });

  it("needs a window over zero and no longer than the autonomous period", () => {
    expect(issues(autoWith(collect({ ...ENVELOPE, maxDurationS: 0 })))).not.toEqual([]);
    expect(issues(autoWith(collect({ ...ENVELOPE, maxDurationS: -1 })))).not.toEqual([]);
    expect(issues(autoWith(collect({ ...ENVELOPE, maxDurationS: 30.5 })))).not.toEqual([]);
    expect(issues(autoWith(collect({ ...ENVELOPE, maxDurationS: 30 })))).toEqual([]);
  });

  it("needs a provenance, because its polygon and window are numbers someone chose", () => {
    const { provenance: _dropped, ...unlabelled } = ENVELOPE;
    expect(issues(autoWith(collect(unlabelled)))).not.toEqual([]);
    expect(issues(autoWith(collect({ ...ENVELOPE, provenance: "" })))).not.toEqual([]);
  });

  it("takes a what-if run time over zero and at most the window, and says so when it is longer", () => {
    expect(issues(autoWith(collect({ ...ENVELOPE, actualDurationS: 2.5 })))).toEqual([]);
    expect(issues(autoWith(collect({ ...ENVELOPE, actualDurationS: 6 })))).toEqual([]);
    expect(issues(autoWith(collect({ ...ENVELOPE, actualDurationS: 0 })))).not.toEqual([]);
    expect(issues(autoWith(collect({ ...ENVELOPE, actualDurationS: -1 })))).not.toEqual([]);
    const over = issues(autoWith(collect({ ...ENVELOPE, actualDurationS: 6.5 }))).join("\n");
    expect(over).toContain("steps.0.envelope.actualDurationS");
    expect(over).toContain("longer than its maxDurationS (6 s)");
    const parsed = parseAuto(autoWith(collect({ ...ENVELOPE, actualDurationS: 2.5 })));
    expect((parsed.steps[0] as { envelope?: { actualDurationS?: number } }).envelope?.actualDurationS).toBe(2.5);
  });

  it("names the key that is wrong", () => {
    const found = issues(autoWith(collect({ ...ENVELOPE, maxDurationS: 0 })));
    expect(found.join("\n")).toContain("steps.0.envelope.maxDurationS");
  });
});

describe("a rejoin pose", () => {
  const rejoinPath = (rejoinFrom: unknown): Record<string, unknown> => ({
    id: "back",
    kind: "path",
    rejoinFrom,
    segments: [{ kind: "line", from: "current", to: { xIn: -40, yIn: 40, headingRad: 0 } }],
    heading: { mode: "tangent" },
  });

  it("is accepted on a path step, with or without a provenance", () => {
    const parsed = parseAuto(
      autoWith(collect(ENVELOPE), rejoinPath({ xIn: -50, yIn: -30, headingRad: 1.5708, provenance: "SET BY HAND" })),
    );
    const back = parsed.steps[1] as { rejoinFrom?: unknown };
    expect(back.rejoinFrom).toEqual({ xIn: -50, yIn: -30, headingRad: 1.5708, provenance: "SET BY HAND" });
    expect(issues(autoWith(collect(ENVELOPE), rejoinPath({ xIn: -50, yIn: -30, headingRad: 0 })))).toEqual([]);
  });

  it("needs a heading, because the path after it starts from that pose", () => {
    expect(issues(autoWith(collect(ENVELOPE), rejoinPath({ xIn: -50, yIn: -30 })))).not.toEqual([]);
  });
});
