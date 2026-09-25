import { describe, expect, it } from "vitest";
import { SCHEMA_ID } from "./ids.js";
import { parseAuto } from "./parse.js";

const autoWith = (step: Record<string, unknown>): unknown => ({
  $schema: SCHEMA_ID.auto,
  formatVersion: 1,
  name: "wait-fixture",
  alliance: "RED",
  start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
  steps: [step],
});

describe("a wait step", () => {
  it("finding 9: accepts seconds on its own", () => {
    expect(() => parseAuto(autoWith({ id: "w", kind: "wait", seconds: 7 }))).not.toThrow();
  });

  it("finding 9: accepts until on its own", () => {
    expect(() =>
      parseAuto(autoWith({ id: "w", kind: "wait", until: "hopperFull" })),
    ).not.toThrow();
  });

  it("finding 9: refuses both seconds and until, naming the step", () => {
    let message = "";
    try {
      parseAuto(autoWith({ id: "w", kind: "wait", seconds: 7, until: "hopperFull" }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('"w"');
    expect(message).toContain("not both");
  });

  it("finding 9: still refuses neither", () => {
    expect(() => parseAuto(autoWith({ id: "w", kind: "wait" }))).toThrow(/seconds or until/);
  });
});

const pathWith = (heading: unknown): unknown => ({
  $schema: SCHEMA_ID.auto,
  formatVersion: 3,
  name: "piecewise-fixture",
  alliance: "RED",
  start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
  steps: [
    {
      id: "p",
      kind: "path",
      segments: [{ kind: "line", from: "current", to: { xIn: 24, yIn: 0 } }],
      heading,
    },
  ],
});

describe("a piecewise heading", () => {
  it("accepts ranges holding any of the other five modes", () => {
    const parsed = parseAuto(
      pathWith({
        mode: "piecewise",
        ranges: [
          { startT: 0, endT: 0.2, heading: { mode: "tangent" } },
          { startT: 0.2, endT: 0.4, heading: { mode: "tangentReversed" } },
          { startT: 0.4, endT: 0.6, heading: { mode: "constant", headingRad: 1 } },
          { startT: 0.6, endT: 0.8, heading: { mode: "linear", fromRad: 1, toRad: 2 } },
          { startT: 0.8, endT: 1, heading: { mode: "facePoint", xIn: 0, yIn: 0 } },
        ],
      }),
    );
    const step = parsed.steps[0];
    expect(step?.kind === "path" && step.heading?.mode).toBe("piecewise");
  });

  it("refuses a piecewise range inside a piecewise range", () => {
    expect(() =>
      parseAuto(
        pathWith({
          mode: "piecewise",
          ranges: [{ startT: 0, endT: 1, heading: { mode: "piecewise", ranges: [] } }],
        }),
      ),
    ).toThrow();
  });

  it("refuses no ranges and a t outside 0 to 1", () => {
    expect(() => parseAuto(pathWith({ mode: "piecewise", ranges: [] }))).toThrow();
    expect(() =>
      parseAuto(pathWith({ mode: "piecewise", ranges: [{ startT: 0, endT: 1.5, heading: { mode: "tangent" } }] })),
    ).toThrow();
  });

  it("leaves the coverage check to the planner, so a hand-edited gap still loads and is reported", () => {
    expect(() =>
      parseAuto(
        pathWith({
          mode: "piecewise",
          ranges: [
            { startT: 0, endT: 0.4, heading: { mode: "tangent" } },
            { startT: 0.5, endT: 1, heading: { mode: "tangent" } },
          ],
        }),
      ),
    ).not.toThrow();
  });
});