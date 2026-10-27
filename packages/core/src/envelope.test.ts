import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseAuto, parseRobot, SCHEMA_ID, type Auto, type Robot } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { canonicalize } from "./canonicalize.js";
import { check } from "./check.js";
import { envelopeShapeProblem } from "./checks/envelope.js";
import { squareEnvelopeAround } from "./envelope.js";
import { estimate } from "./estimate.js";
import { loadAuto, loadField, loadRobot, loadWaypoints } from "./load.js";
import { mirrorAuto } from "./mirror.js";
import { plan } from "./plan.js";
import { resolve } from "./resolve.js";
import { simulate } from "./sim/simulate.js";
import { testField, testRobot, testWaypoints } from "./testing/fixtures.js";
import type { Finding } from "./types.js";

/**
 * Envelopes and rejoin poses (spec 13 section 10, milestone M-C5): the canonical form, the window
 * in the estimate, the shape check and the rejoin in the plan.
 */

/** The test robot plus one command that drives the robot by itself and has no estimate. */
const robot: Robot = parseRobot({
  ...testRobot,
  commands: [
    ...testRobot.commands,
    { name: "collect", estimateS: "unknown", requires: ["drive"], movesRobot: true },
  ],
});

const SQUARE = [
  { xIn: -48, yIn: -48 },
  { xIn: -24, yIn: -48 },
  { xIn: -24, yIn: -24 },
  { xIn: -48, yIn: -24 },
];

const ENVELOPE = { polygon: SQUARE, maxDurationS: 6, provenance: "SET BY HAND: test fixture" };

const auto = (steps: unknown[]): Auto =>
  parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 3,
    name: "envelope-fixture",
    alliance: "RED",
    start: { pose: { xIn: -36, yIn: -36, headingRad: 0 } },
    steps,
  });

const planOf = (doc: Auto, withRobot = true) =>
  plan(resolve(doc, testWaypoints, withRobot ? robot : undefined), robot, testField);

const findingsOf = (doc: Auto): Finding[] => {
  const planned = planOf(doc);
  return check(planned, estimate(planned, robot), robot, testField);
};

const collect = (envelope?: unknown) => ({
  id: "collect",
  kind: "command",
  name: "collect",
  ...(envelope === undefined ? {} : { envelope }),
});

const back = (rejoinFrom?: unknown) => ({
  id: "back",
  kind: "path",
  ...(rejoinFrom === undefined ? {} : { rejoinFrom }),
  segments: [{ kind: "line", from: "current", to: { xIn: -36, yIn: 12, headingRad: 1.5708 } }],
  heading: { mode: "tangent" },
});

/** Written by hand in canonical form, with every new key in the place the schema puts it. */
const CANONICAL = `{
  "$schema": "https://libraries.horizon36596.org/zenith/schema/v1/auto.json",
  "formatVersion": 4,
  "name": "envelope-fixture",
  "alliance": "RED",
  "start": {
    "pose": {
      "xIn": -36,
      "yIn": -36,
      "headingRad": 0
    }
  },
  "steps": [
    {
      "id": "collect",
      "kind": "command",
      "name": "collect",
      "timeoutS": 7,
      "expect": {
        "collectFrom": "garden",
        "count": 2
      },
      "envelope": {
        "polygon": [
          {
            "xIn": -48,
            "yIn": -48.125
          },
          {
            "xIn": -24,
            "yIn": -48
          },
          {
            "xIn": -24,
            "yIn": -24
          }
        ],
        "maxDurationS": 6.5,
        "provenance": "SET BY HAND: vision collect stays in the south-west quarter"
      },
      "notes": "Collect by vision."
    },
    {
      "id": "hold",
      "kind": "wait",
      "until": "hopperFull",
      "timeoutS": 2,
      "envelope": {
        "polygon": [
          {
            "xIn": -48,
            "yIn": -48
          },
          {
            "xIn": -24,
            "yIn": -48
          },
          {
            "xIn": -24,
            "yIn": -24
          }
        ],
        "maxDurationS": 2,
        "provenance": "SET FROM EDITOR"
      }
    },
    {
      "id": "back",
      "kind": "path",
      "timeoutS": 3,
      "rejoinFrom": {
        "xIn": -30,
        "yIn": -30,
        "headingRad": 1.5708,
        "provenance": "SET BY HAND: where the collect usually ends"
      },
      "segments": [
        {
          "kind": "line",
          "from": "current",
          "to": {
            "xIn": -36,
            "yIn": 12,
            "headingRad": 1.5708
          }
        }
      ],
      "heading": {
        "mode": "tangent"
      },
      "expect": {
        "tip": "own"
      },
      "envelope": {
        "polygon": [
          {
            "xIn": -48,
            "yIn": -48
          },
          {
            "xIn": -24,
            "yIn": 24
          },
          {
            "xIn": -48,
            "yIn": 24
          }
        ],
        "maxDurationS": 3,
        "provenance": "SET BY HAND"
      },
      "notes": "Back to the hive."
    }
  ]
}
`;

describe("canonical form with envelopes", () => {
  it("round-trips an auto that has envelopes and a rejoin pose byte for byte", () => {
    expect(canonicalize("auto", parseAuto(JSON.parse(CANONICAL) as unknown))).toBe(CANONICAL);
    expect(canonicalize("auto", JSON.parse(CANONICAL) as unknown)).toBe(CANONICAL);
  });

  it("puts envelope after expect and before notes, and rejoinFrom before segments, whatever order it was given in", () => {
    const shuffled = JSON.parse(CANONICAL) as { steps: Record<string, unknown>[] };
    shuffled.steps = shuffled.steps.map((step) => {
      const { envelope, notes, rejoinFrom, ...rest } = step;
      return {
        ...(notes === undefined ? {} : { notes }),
        ...(envelope === undefined ? {} : { envelope }),
        ...rest,
        ...(rejoinFrom === undefined ? {} : { rejoinFrom }),
      };
    });
    expect(canonicalize("auto", shuffled)).toBe(CANONICAL);
  });

  it("rounds the corners as inches and the window as seconds", () => {
    const rough = JSON.parse(CANONICAL) as { steps: Array<{ envelope?: { polygon: Array<{ yIn: number }>; maxDurationS: number } }> };
    const first = rough.steps[0]?.envelope;
    if (first === undefined) throw new Error("fixture has no envelope");
    (first.polygon[0] as { yIn: number }).yIn = -48.12500001;
    first.maxDurationS = 6.50000004;
    expect(canonicalize("auto", rough)).toBe(CANONICAL);
  });

  it("writes a what-if run time between the window and the provenance, rounded as seconds", () => {
    const withActual = auto([
      collect({ provenance: ENVELOPE.provenance, actualDurationS: 2.50000004, polygon: ENVELOPE.polygon, maxDurationS: ENVELOPE.maxDurationS }),
    ]);
    const text = canonicalize("auto", withActual);
    expect(text).toContain('"maxDurationS": 6,\n        "actualDurationS": 2.5,\n        "provenance"');
    expect(canonicalize("auto", parseAuto(JSON.parse(text) as unknown))).toBe(text);
  });

  it("leaves an auto without envelopes exactly as it was", () => {
    const plain = auto([collect(), back()]);
    const text = canonicalize("auto", plain);
    expect(text).not.toContain('"envelope"');
    expect(text).not.toContain('"rejoinFrom"');
    expect(canonicalize("auto", parseAuto(JSON.parse(text) as unknown))).toBe(text);
  });
});

describe("the estimate of a step with an envelope", () => {
  it("is the envelope's window, not hatched, when the step has no estimate of its own", () => {
    const withEnvelope = estimate(planOf(auto([collect(ENVELOPE)])), robot);
    const row = withEnvelope.byStepId["collect"];
    expect(row?.nominalS).toBe(6);
    expect(row?.unknown).toBe(false);
    expect(row?.fromEnvelope).toBe(true);
    expect(withEnvelope.hasUnknown).toBe(false);
    expect(withEnvelope.nominalS).toBe(6);
    expect(withEnvelope.explain.join(" ")).toContain("maxDurationS");

    const without = estimate(planOf(auto([collect()])), robot);
    expect(without.byStepId["collect"]?.nominalS).toBeNull();
    expect(without.byStepId["collect"]?.unknown).toBe(true);
    expect(without.byStepId["collect"]?.fromEnvelope).toBeUndefined();
    expect(without.explain.join(" ")).not.toContain("maxDurationS");
  });

  it("times a wait on a condition by its window too", () => {
    const row = estimate(planOf(auto([{ id: "hold", kind: "wait", until: "hopperFull", envelope: ENVELOPE }])), robot)
      .byStepId["hold"];
    expect(row?.nominalS).toBe(6);
    expect(row?.unknown).toBe(false);
  });

  it("keeps a step's own estimate when it has one", () => {
    const steps = [{ id: "volley", kind: "command", name: "shootAll", args: { count: 2, cadence: 0.5 }, envelope: ENVELOPE }];
    const row = estimate(planOf(auto(steps)), robot).byStepId["volley"];
    expect(row?.nominalS).toBeCloseTo(1.6, 9);
    expect(row?.fromEnvelope).toBeUndefined();
  });
});

describe("the instant sim of a step with an envelope", () => {
  it("runs a command with no estimate for its envelope's window, and says why", () => {
    const trace = simulate(planOf(auto([collect(ENVELOPE)])), robot, testField);
    const record = trace.steps.find((step) => step.id === "collect");
    expect(record).toBeDefined();
    expect((record?.endS ?? 0) - (record?.startS ?? 0)).toBeCloseTo(6, 3);
    expect(record?.unknownReason).toContain("maxDurationS of 6 s");
  });
});

describe("ENVELOPE_SHAPE", () => {
  const shapeFindings = (polygon: unknown): Finding[] =>
    findingsOf(auto([collect({ ...ENVELOPE, polygon })])).filter((finding) => finding.code === "ENVELOPE_SHAPE");

  it("fires on a bowtie, naming the crossing edges and where they cross", () => {
    const bowtie = [
      { xIn: -48, yIn: -48 },
      { xIn: -24, yIn: -24 },
      { xIn: -24, yIn: -48 },
      { xIn: -48, yIn: -24 },
    ];
    const found = shapeFindings(bowtie);
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("error");
    expect(found[0]?.stepId).toBe("collect");
    expect(found[0]?.message).toContain("Edges 1 and 3");
    expect(found[0]?.geometry?.pointIn?.xIn).toBeCloseTo(-36, 9);
    expect(found[0]?.geometry?.pointIn?.yIn).toBeCloseTo(-36, 9);
    expect(found[0]?.geometry?.polygonIn).toHaveLength(4);
  });

  it("fires when repeated corners leave fewer than three", () => {
    const found = shapeFindings([SQUARE[0], SQUARE[1], SQUARE[1], SQUARE[0]]);
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("2 distinct corners");
  });

  it("fires when the corners lie on one line, or an edge folds back", () => {
    expect(envelopeShapeProblem([{ xIn: 0, yIn: 0 }, { xIn: 1, yIn: 1 }, { xIn: 2, yIn: 2 }])?.message).toContain("one line");
    expect(
      envelopeShapeProblem([
        { xIn: 0, yIn: 0 },
        { xIn: 10, yIn: 0 },
        { xIn: 5, yIn: 0 },
        { xIn: 5, yIn: 5 },
      ])?.message,
    ).toContain("folds over itself");
  });

  it("stays quiet on a square, a triangle and a concave polygon, either way round", () => {
    const concave = [
      { xIn: 0, yIn: 0 },
      { xIn: 20, yIn: 0 },
      { xIn: 20, yIn: 20 },
      { xIn: 10, yIn: 5 },
      { xIn: 0, yIn: 20 },
    ];
    for (const polygon of [SQUARE, SQUARE.slice(0, 3), concave, [...concave].reverse()]) {
      expect(envelopeShapeProblem(polygon)).toBeNull();
    }
    expect(shapeFindings(SQUARE)).toEqual([]);
  });

  it("checks an envelope on a step inside a group", () => {
    const bowtie = [SQUARE[0], SQUARE[2], SQUARE[1], SQUARE[3]];
    const grouped = auto([{ id: "grp", kind: "sequence", steps: [collect({ ...ENVELOPE, polygon: bowtie })] }]);
    expect(findingsOf(grouped).filter((finding) => finding.code === "ENVELOPE_SHAPE").map((finding) => finding.stepId)).toEqual([
      "collect",
    ]);
  });
});

describe("a rejoin pose", () => {
  const REJOIN = { xIn: -30, yIn: -30, headingRad: 1.5708 };

  it("starts the path there after a command that moves the robot, and ends that command there", () => {
    const planned = planOf(auto([collect(ENVELOPE), back(REJOIN)]));
    const [command, path] = planned.steps;
    expect(command?.endPose).toEqual(REJOIN);
    expect(path?.startPose.xIn).toBeCloseTo(-30, 9);
    expect(path?.startPose.yIn).toBeCloseTo(-30, 9);
    expect(path?.segments?.[0]?.fromPose).toEqual(REJOIN);
    const codes = findingsOf(auto([collect(ENVELOPE), back(REJOIN)])).map((finding) => finding.code);
    expect(codes).not.toContain("CONTINUITY");
    expect(codes).not.toContain("MOVES_ROBOT");
  });

  it("rejoins after a sequence that ends in such a command", () => {
    const planned = planOf(auto([{ id: "grp", kind: "sequence", steps: [collect()] }, back(REJOIN)]));
    expect(planned.steps[0]?.endPose).toEqual(REJOIN);
    expect(planned.steps[0]?.children?.[0]?.endPose).toEqual(REJOIN);
    expect(planned.steps[1]?.segments?.[0]?.fromPose).toEqual(REJOIN);
  });

  it("without one, the path starts where the command started, as before", () => {
    const planned = planOf(auto([collect(), back()]));
    expect(planned.steps[1]?.segments?.[0]?.fromPose).toEqual({ xIn: -36, yIn: -36, headingRad: 0 });
  });

  it("is not used after a step whose end is known, and says so", () => {
    const doc = auto([{ id: "hold", kind: "wait", seconds: 1 }, back(REJOIN)]);
    expect(planOf(doc).steps[1]?.segments?.[0]?.fromPose).toEqual({ xIn: -36, yIn: -36, headingRad: 0 });
    const unused = findingsOf(doc).filter((finding) => finding.code === "MOVES_ROBOT");
    expect(unused).toHaveLength(1);
    expect(unused[0]?.severity).toBe("warning");
    expect(unused[0]?.message).toContain("rejoinFrom is not used");
  });

  it("is not used on a path that starts from a fixed pose, and says so", () => {
    const fixed = {
      ...back(REJOIN),
      segments: [{ kind: "line", from: { xIn: -36, yIn: -36, headingRad: 0 }, to: { xIn: -36, yIn: 12 } }],
    };
    const found = findingsOf(auto([collect(ENVELOPE), fixed])).filter((finding) => finding.code === "MOVES_ROBOT");
    expect(found.some((finding) => finding.message.includes('starts from "current"'))).toBe(true);
  });

  it("is not used, and nothing is said, when resolve is not given the robot", () => {
    const resolved = resolve(auto([collect(), back(REJOIN)]), testWaypoints);
    expect(resolved.steps[1]?.segments?.[0]?.fromPose).toEqual({ xIn: -36, yIn: -36, headingRad: 0 });
    expect(resolved.findings).toEqual([]);
  });
});

describe("mirroring an envelope and a rejoin pose", () => {
  it("moves the corners and the rejoin pose with the field, and mirroring twice gives the file back", () => {
    const doc = parseAuto(JSON.parse(CANONICAL) as unknown);
    const mirrored = mirrorAuto(doc, "pointSymmetry");
    const command = mirrored.steps[0] as { envelope?: { polygon: Array<{ xIn: number; yIn: number }>; maxDurationS: number } };
    expect(command.envelope?.polygon[0]).toEqual({ xIn: 48, yIn: 48.125 });
    expect(command.envelope?.maxDurationS).toBe(6.5);
    const path = mirrored.steps[2] as { rejoinFrom?: { xIn: number; yIn: number; headingRad: number; provenance?: string } };
    expect(path.rejoinFrom?.xIn).toBe(30);
    expect(path.rejoinFrom?.yIn).toBe(30);
    expect(path.rejoinFrom?.headingRad).toBeCloseTo(1.5708 - Math.PI, 9);
    expect(path.rejoinFrom?.provenance).toBe("SET BY HAND: where the collect usually ends");
    for (const mode of ["pointSymmetry", "mirrorX", "mirrorY"] as const) {
      expect(canonicalize("auto", mirrorAuto(mirrorAuto(doc, mode), mode)), mode).toBe(CANONICAL);
    }
  });
});

describe("squareEnvelopeAround", () => {
  it("builds a simple square of the given side centred on the pose, with the caller's window and label", () => {
    const envelope = squareEnvelopeAround({ xIn: 10, yIn: -20, headingRad: 1 }, 24, 5, "SET FROM EDITOR");
    expect(envelope.polygon).toEqual([
      { xIn: -2, yIn: -32 },
      { xIn: 22, yIn: -32 },
      { xIn: 22, yIn: -8 },
      { xIn: -2, yIn: -8 },
    ]);
    expect(envelope.maxDurationS).toBe(5);
    expect(envelope.provenance).toBe("SET FROM EDITOR");
    expect(envelopeShapeProblem(envelope.polygon)).toBeNull();
  });
});

describe("the example autos", () => {
  const exampleRoot = (name: string): string => fileURLToPath(new URL(`../../../examples/${name}/`, import.meta.url));
  const read = (root: string, relative: string): unknown => JSON.parse(readFileSync(`${root}${relative}`, "utf8"));
  // Every auto in each example project that is present, read from the folder, so the test names no
  // auto of any one robot and a project that is not checked out is simply not there.
  const autosIn = (root: string): string[] =>
    readdirSync(`${root}autos/`)
      .filter((file) => file.endsWith(".auto.json"))
      .map((file) => file.slice(0, -".auto.json".length))
      .sort();
  const projects = ["starter", "biobuzz"]
    .filter((name) => existsSync(exampleRoot(name)))
    .map((name) => ({ name, autos: autosIn(exampleRoot(name)) }));

  it("plan and check exactly as before when resolve is given the robot", () => {
    for (const project of projects) {
      const root = exampleRoot(project.name);
      const exampleRobot = loadRobot(read(root, "autos/robot.json"));
      const field = loadField(read(root, `autos/field/biobuzz.field.json`));
      const waypoints = loadWaypoints(read(root, "autos/waypoints.json"));
      for (const name of project.autos) {
        const doc = loadAuto(read(root, `autos/${name}.auto.json`));
        const run = (withRobot: boolean): Finding[] => {
          const planned = plan(resolve(doc, waypoints, withRobot ? exampleRobot : undefined), exampleRobot, field);
          return check(planned, estimate(planned, exampleRobot), exampleRobot, field);
        };
        const after = run(true);
        expect(after, `${project.name}/${name}`).toEqual(run(false));
        expect(after.filter((finding) => finding.code === "ENVELOPE_SHAPE"), name).toEqual([]);
      }
    }
  });
});
