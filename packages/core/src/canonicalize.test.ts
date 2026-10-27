import { LEGACY_SCHEMA_ID, parseAuto, parseField, parseRobot, parseWaypoints, SCHEMA_ID } from "@horizon36596/zenith-schema";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalize } from "./canonicalize.js";
import { testField, testRobot, testWaypoints } from "./testing/fixtures.js";

/** Written by hand in canonical form. The round trip must give back these exact bytes. */
const CANONICAL_AUTO = `{
  "$schema": "https://libraries.horizon36596.org/zenith/schema/v1/auto.json",
  "formatVersion": 4,
  "name": "collect-and-score",
  "title": "Collect and score",
  "robot": "autos/robot.json",
  "alliance": "RED",
  "authors": [
    "example-user"
  ],
  "created": "2026-09-22",
  "start": {
    "pose": {
      "ref": "start"
    },
    "holds": {
      "pollen": 4
    }
  },
  "steps": [
    {
      "id": "scorePreload",
      "kind": "command",
      "name": "score",
      "args": {
        "count": 4
      },
      "timeoutS": 4
    },
    {
      "id": "sweepGarden",
      "kind": "path",
      "timeoutS": 3,
      "segments": [
        {
          "kind": "line",
          "from": {
            "ref": "start"
          },
          "to": {
            "xIn": -61,
            "yIn": -62,
            "headingRad": -1.5708
          }
        }
      ],
      "heading": {
        "mode": "constant",
        "headingRad": -1.5708
      },
      "speedFraction": 0.3,
      "markers": [
        {
          "at": {
            "t": 0.6
          },
          "command": {
            "name": "intakeOn",
            "args": {
              "state": "ON"
            }
          }
        }
      ],
      "notes": "The front intake leads onto the garden row."
    },
    {
      "id": "driveBack",
      "kind": "path",
      "segments": [
        {
          "kind": "bezier",
          "from": "current",
          "control": [
            {
              "xIn": -61,
              "yIn": -24
            }
          ],
          "to": {
            "xIn": -12,
            "yIn": -36,
            "headingRad": 1.5708
          }
        }
      ],
      "heading": {
        "mode": "tangentReversed"
      }
    }
  ]
}
`;

describe("canonicalize", () => {
  it("round-trips an auto byte for byte", () => {
    const parsed = parseAuto(JSON.parse(CANONICAL_AUTO) as unknown);
    expect(canonicalize("auto", parsed)).toBe(CANONICAL_AUTO);
  });

  it("format version 4: writes a v1 auto as v4 and changes nothing else", () => {
    const v1 = CANONICAL_AUTO.replace('"formatVersion": 4,', '"formatVersion": 1,');
    expect(canonicalize("auto", JSON.parse(v1) as unknown)).toBe(CANONICAL_AUTO);
    expect(canonicalize("auto", parseAuto(JSON.parse(v1) as unknown))).toBe(CANONICAL_AUTO);
  });

  it("is idempotent for every kind", () => {
    const cases = [
      ["robot", testRobot],
      ["field", testField],
      ["waypoints", testWaypoints],
    ] as const;
    for (const [kind, doc] of cases) {
      const once = canonicalize(kind, doc);
      const parse = { robot: parseRobot, field: parseField, waypoints: parseWaypoints }[kind];
      expect(canonicalize(kind, parse(JSON.parse(once) as unknown)), kind).toBe(once);
    }
  });

  it("writes keys in schema declaration order, not alphabetical order", () => {
    const text = canonicalize("auto", parseAuto(JSON.parse(CANONICAL_AUTO) as unknown));
    expect(text.indexOf('"name"')).toBeLessThan(text.indexOf('"steps"'));
    expect(text.indexOf('"formatVersion"')).toBeLessThan(text.indexOf('"alliance"'));
    const step = text.slice(text.indexOf('"id": "sweepGarden"'));
    expect(step.indexOf('"segments"')).toBeLessThan(step.indexOf('"heading"'));
    expect(step.indexOf('"heading"')).toBeLessThan(step.indexOf('"markers"'));
  });

  it("rounds by the unit each key names", () => {
    const text = canonicalize(
      "auto",
      parseAuto({
        formatVersion: 1,
        name: "rounding",
        alliance: "RED",
        start: { pose: { xIn: 1.23456789, yIn: -0.0000001, headingRad: 3.14159265 } },
        steps: [
          {
            id: "leg",
            kind: "path",
            timeoutS: 1.23456,
            segments: [{ kind: "line", from: "current", to: { xIn: 2.0005, yIn: 0 } }],
            heading: { mode: "constant", headingRad: 1.57079632679 },
            speedFraction: 0.8333333,
          },
        ],
      }),
    );
    expect(text).toContain('"xIn": 1.235');
    expect(text).toContain('"yIn": 0');
    expect(text).toContain('"headingRad": 3.1416');
    expect(text).toContain('"headingRad": 1.5708');
    expect(text).toContain('"timeoutS": 1.235');
    // No unit in the name, so the number is left exactly as it was written.
    expect(text).toContain('"speedFraction": 0.8333333');
  });

  it("finding 28: keeps a wrapped value's full precision instead of the parent key's unit", () => {
    const text = canonicalize("robot", testRobot);
    // MEASURED to four decimals, and the canonical form must not throw one away.
    expect(text).toContain('"value": 72.3456');
    expect(text).toContain('"value": 61.2345');
    expect(text).toContain('"value": 83.4567');
    expect(text).toContain('"value": 0.8');
  });

  it("finding 28: rounds a bare in/s² key like the other units", () => {
    const text = canonicalize(
      "robot",
      parseRobot({
        ...(JSON.parse(JSON.stringify(testRobot)) as Record<string, unknown>),
        shooter: { kind: "turret", spinUpInPerS2: 12.34567 },
      }),
    );
    expect(text).toContain('"spinUpInPerS2": 12.346');
  });

  it("ends in a single newline and uses LF only", () => {
    const text = canonicalize("field", testField);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).not.toContain("\r");
    expect(text.split("\n\n")).toHaveLength(1);
  });

  it("keeps the $schema id the files declare", () => {
    expect(canonicalize("waypoints", testWaypoints)).toContain(SCHEMA_ID.waypoints);
  });

  it("writes the current id for a file that names the legacy alias, and nothing else changes", () => {
    const legacyText = CANONICAL_AUTO.replace(SCHEMA_ID.auto, LEGACY_SCHEMA_ID.auto);
    expect(legacyText).not.toBe(CANONICAL_AUTO);
    expect(canonicalize("auto", JSON.parse(legacyText) as unknown)).toBe(CANONICAL_AUTO);
  });

  it("issue #377: writes the current $schema id first for a file that has none, and nothing else changes", () => {
    const parsed = JSON.parse(CANONICAL_AUTO) as Record<string, unknown>;
    delete parsed["$schema"];
    expect(canonicalize("auto", parsed)).toBe(CANONICAL_AUTO);
    expect(canonicalize("auto", parseAuto(parsed))).toBe(CANONICAL_AUTO);
  });

  it("issue #377: a positive timeout that would round to 0 is written as the smallest step, so it loads again", () => {
    const parsed = JSON.parse(CANONICAL_AUTO) as { steps: Record<string, unknown>[] };
    parsed.steps[0] = { ...parsed.steps[0], timeoutS: 0.0004 };
    const text = canonicalize("auto", parseAuto(parsed));
    expect(text).toContain('"timeoutS": 0.001');
    expect(() => parseAuto(JSON.parse(text) as unknown)).not.toThrow();
    expect(canonicalize("auto", parseAuto(JSON.parse(text) as unknown))).toBe(text);
    // A key that may be 0 still rounds to 0, as before.
    expect(canonicalize("auto", { ...parseAuto(parsed), start: { pose: { xIn: 0.0004, yIn: 0, headingRad: 0 } } })).toContain(
      '"xIn": 0,',
    );
  });
});

describe("a strut in canonical form (issue #228)", () => {
  /** Written by hand in canonical form: the keys in the order the format names them. */
  const CANONICAL_STRUT = `    {
      "id": "frameLegNorthEast",
      "kind": "strut",
      "fromIn": {
        "xIn": 23.81,
        "yIn": 18.56,
        "zIn": 0.53
      },
      "toIn": {
        "xIn": 12.74,
        "yIn": 0.51,
        "zIn": 41.09
      },
      "radiusIn": 0.78,
      "solidToRobot": true,
      "provenance": "PLACEHOLDER: test fixture"
    }`;

  it("writes id, kind, fromIn, toIn, radiusIn, solidToRobot and provenance in that order, and reads back the same", () => {
    const scrambled = {
      provenance: "PLACEHOLDER: test fixture",
      radiusIn: 0.78,
      solidToRobot: true,
      toIn: { zIn: 41.09, yIn: 0.51, xIn: 12.74 },
      fromIn: { zIn: 0.53, xIn: 23.81, yIn: 18.56 },
      kind: "strut",
      id: "frameLegNorthEast",
    };
    const text = canonicalize("field", { ...testField, formatVersion: 3, obstacles: [scrambled] });
    expect(text).toContain(CANONICAL_STRUT);
    expect(text).toContain('"formatVersion": 3');
    const again = canonicalize("field", parseField(JSON.parse(text) as unknown));
    expect(again).toBe(text);
  });

  it("rounds a strut's inches to three decimals like every other key that names inches", () => {
    const strut = {
      id: "leg",
      kind: "strut",
      fromIn: { xIn: 1.23456, yIn: 0, zIn: 0 },
      toIn: { xIn: 0, yIn: 0, zIn: 10 },
      radiusIn: 0.77777,
    };
    const text = canonicalize("field", { ...testField, formatVersion: 3, obstacles: [strut] });
    expect(text).toContain('"xIn": 1.235');
    expect(text).toContain('"radiusIn": 0.778');
  });
});

/**
 * Owner ruling D8: `footprint.clearanceIn` is the last key of `footprint`, after `heightIn`, as
 * site/docs/file-format.md lists it. The fixture is written by hand in canonical form.
 */
describe("footprint.clearanceIn in canonical form (D8)", () => {
  const fixture = readFileSync(
    fileURLToPath(new URL("../../schema/fixtures/canonical/robot.clearance.json", import.meta.url)),
    "utf8",
  ).replace(/\r\n/g, "\n");

  it("round-trips the fixture byte for byte", () => {
    expect(canonicalize("robot", parseRobot(JSON.parse(fixture) as unknown))).toBe(fixture);
  });

  it("puts the key last in footprint, after heightIn, wherever it was written", () => {
    const parsed = JSON.parse(fixture) as { footprint: Record<string, unknown> };
    const { clearanceIn, ...rest } = parsed.footprint;
    const scrambled = { ...parsed, footprint: { clearanceIn, ...rest } };
    const text = canonicalize("robot", parseRobot(scrambled));
    expect(text).toBe(fixture);
    const footprint = text.slice(text.indexOf('"footprint"'), text.indexOf('"kinematics"'));
    expect(footprint.indexOf('"heightIn"')).toBeLessThan(footprint.indexOf('"clearanceIn"'));
    expect(footprint.indexOf('"centreOfRotationIn"')).toBeLessThan(footprint.indexOf('"clearanceIn"'));
  });

  it("leaves a robot without the key unchanged: nothing is added on save", () => {
    expect(canonicalize("robot", testRobot)).not.toContain("clearanceIn");
  });
});
