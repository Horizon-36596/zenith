/**
 * When the playback robot is a guess (issue #481): the spans of a command that drives the robot by
 * itself, on the ideal clock and on a trace's, and the envelope window that is open in them.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { estimate, idealTrajectory, loadField, loadRobot, plan, resolve, simulate } from "@horizon36596/zenith-core";
import { parseAuto, SCHEMA_ID } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { openUnknownEnvelope, unknownLabel, unknownSpanAt, unknownSpans, unknownSteps } from "./unknownPosition.js";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const json = (name: string): unknown => JSON.parse(readFileSync(`${examples}${name}`, "utf8"));
const starter = loadRobot(json("robot.json"));
const field = loadField(json("field/biobuzz.field.json"));
const robot = loadRobot({
  ...(JSON.parse(JSON.stringify(starter)) as Record<string, unknown>),
  commands: [...starter.commands, { name: "visionCollect", estimateS: "unknown", movesRobot: true }],
});

const SQUARE = [
  { xIn: -60, yIn: -60 },
  { xIn: -30, yIn: -60 },
  { xIn: -30, yIn: -30 },
  { xIn: -60, yIn: -30 },
];

const auto = (actualDurationS?: number) =>
  parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 4,
    name: "unknown-position",
    alliance: "RED",
    start: { pose: { xIn: -40, yIn: -40, headingRad: 0 } },
    steps: [
      {
        id: "hunt",
        kind: "command",
        name: "visionCollect",
        envelope: {
          polygon: SQUARE,
          maxDurationS: 3,
          ...(actualDurationS === undefined ? {} : { actualDurationS }),
          provenance: "SET BY HAND: test fixture",
        },
      },
      {
        id: "back",
        kind: "path",
        rejoinFrom: { xIn: -50, yIn: -50, headingRad: 0 },
        segments: [{ kind: "line", from: "current", to: { xIn: -20, yIn: -50 } }],
        heading: { mode: "constant", headingRad: 0 },
      },
    ],
  });

const planOf = (actualDurationS?: number) => plan(resolve(auto(actualDurationS), undefined, robot), robot, field);

describe("where the playback robot is a guess", () => {
  it("is every movesRobot command, with its envelope's window", () => {
    expect([...unknownSteps(planOf(), robot)]).toEqual([["hunt", 3]]);
    expect([...unknownSteps(planOf(1.5), robot)]).toEqual([["hunt", 1.5]]);
    expect(unknownSteps(planOf(), starter).size).toBe(0);
  });

  it("covers the command's own span on the ideal clock, up to but not at its end", () => {
    const planned = planOf();
    const spans = unknownSpans(unknownSteps(planned, robot), { ideal: idealTrajectory(planned, estimate(planned, robot)) });
    expect(spans).toEqual([{ stepId: "hunt", startS: 0, endS: 3, windowEndS: 3 }]);
    expect(unknownSpanAt(spans, 0)?.stepId).toBe("hunt");
    expect(unknownSpanAt(spans, 2.9)?.stepId).toBe("hunt");
    expect(unknownSpanAt(spans, 3)).toBeNull();
    expect(openUnknownEnvelope(spans, 1.5)).toBe("hunt");
    expect(openUnknownEnvelope(spans, 3.5)).toBeNull();
  });

  it("reads the instant sim's step times at the Instant level", () => {
    const planned = planOf(1.5);
    const trace = simulate(planned, robot, field);
    const spans = unknownSpans(unknownSteps(planned, robot), { trace });
    expect(spans).toHaveLength(1);
    expect((spans[0]?.endS ?? 0) - (spans[0]?.startS ?? 0)).toBeCloseTo(1.5, 6);
    expect((spans[0]?.windowEndS ?? 0) - (spans[0]?.startS ?? 0)).toBeCloseTo(1.5, 6);
  });

  it("labels the robot as a guess", () => {
    expect(unknownLabel("Ideal")).toBe("Ideal · position unknown");
  });
});
