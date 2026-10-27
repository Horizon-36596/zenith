import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ImportError } from "../errors.js";
import { trajectoryJsonSchema, trajectoryJsonSchemaText } from "../jsonschema.js";
import { fixtureFiles, fixturePath, readJson, starterField } from "../testSupport.js";
import { importTrajectory, readTrajectory } from "./importTrajectory.js";
import { TRAJECTORY_SCHEMA_ID, trajectoryFileSchema } from "./schema.js";

const field = starterField();

/**
 * The stand-in timeline `robot/meepmeep-export/standin/harness/Harness.java` exported: from
 * (63, -40, pi), a triangular-profile line 30 in along -x in 2 s, 0.5 s still, then a quarter turn
 * counter-clockwise on a trapezoid in 2.5 s. In RoadRunner's frame, inches and radians.
 */
function exactMeepMeepPose(t: number): [number, number, number] {
  const lineS = (u: number): number => (u <= 1 ? 15 * u * u : 30 - 15 * (2 - u) * (2 - u));
  const turnA = (u: number): number => {
    const a = Math.PI / 3;
    if (u <= 1) return 0.5 * a * u * u;
    if (u <= 1.5) return Math.PI / 6 + a * (u - 1);
    return Math.PI / 2 - 0.5 * a * (2.5 - u) * (2.5 - u);
  };
  if (t <= 2) return [63 - lineS(t), -40, Math.PI];
  if (t <= 2.5) return [33, -40, Math.PI];
  return [33, -40, Math.PI + turnA(Math.min(t - 2.5, 2.5))];
}

const angleGap = (a: number, b: number): number => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

describe("importTrajectory: the M-C8 contract for a MeepMeep export", () => {
  const projection = importTrajectory(readJson(fixturePath("trajectory/meepmeep-line-and-turn.trajectory.json")), field);

  it("lands within 0.5 in of every exported sample, in the season's frame", () => {
    expect(projection.trajectory.poses).toHaveLength(51);
    projection.trajectory.poses.forEach(([xIn, yIn, headingRad], k) => {
      const [x, y, h] = exactMeepMeepPose(k / 10);
      // The roadrunner preset: (x, y, h) is (y, -x, h - pi/2) in the field frame.
      expect(Math.hypot(xIn - y, yIn + x), `sample ${String(k)}`).toBeLessThanOrEqual(0.5);
      expect(angleGap(headingRad, h - Math.PI / 2), `sample ${String(k)}`).toBeLessThanOrEqual(Math.PI / 180);
    });
  });

  it("starts at the RED start against the south wall, facing north, and ends facing west", () => {
    expect(projection.startPose).toEqual({ xIn: -40, yIn: -63, headingRad: expect.closeTo(Math.PI / 2, 9) });
    const last = projection.trajectory.poses[projection.trajectory.poses.length - 1];
    expect(last?.[0]).toBe(-40);
    expect(last?.[1]).toBe(-33);
    expect(angleGap(last?.[2] ?? 0, Math.PI)).toBeLessThan(1e-9);
    expect(projection.totalS).toBe(5);
  });

  it("has exactly the projection's shape", () => {
    expect(Object.keys(projection)).toEqual([
      "formatVersion",
      "kind",
      "level",
      "season",
      "alliance",
      "title",
      "startPose",
      "boundingBox",
      "trajectory",
      "phases",
      "claims",
      "envelopes",
      "totalS",
    ]);
    expect(projection).toMatchObject({ formatVersion: 1, kind: "projection", level: "view", season: "biobuzz", alliance: "RED" });
    expect(projection.boundingBox).toEqual({ lengthIn: 18, widthIn: 18, centreOffsetIn: { xIn: 0, yIn: 0 } });
    expect(Object.keys(projection.trajectory)).toEqual(["rateHz", "positionQuantumIn", "headingQuantumRad", "poses"]);
    expect(projection.trajectory.rateHz).toBe(10);
    expect(projection.trajectory.positionQuantumIn).toBe(0.5);
    expect(projection.trajectory.headingQuantumRad).toBeCloseTo(Math.PI / 180, 12);
  });

  it("rounds every position to the half inch", () => {
    for (const [xIn, yIn] of projection.trajectory.poses) {
      expect(Number.isInteger(xIn * 2)).toBe(true);
      expect(Number.isInteger(yIn * 2)).toBe(true);
    }
  });
});

describe("importTrajectory: resampling to 10 Hz", () => {
  it("takes every other sample of a 20 Hz file, and converts phases, claims and envelopes", () => {
    const doc = readJson(fixturePath("trajectory/pedro-20hz.trajectory.json")) as { poses: number[][] };
    const { projection, warnings } = readTrajectory(doc, field, { positionQuantumIn: 0.001, headingQuantumRad: 1e-6 });
    expect(warnings).toEqual([]);
    expect(projection.trajectory.poses).toHaveLength(21);
    projection.trajectory.poses.forEach(([xIn, yIn, headingRad], k) => {
      const [x, y, h] = doc.poses[2 * k] as [number, number, number];
      expect(xIn).toBeCloseTo(x - 70.75, 3);
      expect(yIn).toBeCloseTo(y - 70.75, 3);
      expect(angleGap(headingRad, (h * Math.PI) / 180)).toBeLessThan(1e-5);
    });
    expect(projection.totalS).toBe(2);
    expect(projection.phases).toEqual([
      { startS: 0, endS: 1.5, label: "drive" },
      { startS: 1.5, endS: 2, label: "collect" },
    ]);
    expect(projection.claims).toEqual([{ elementId: "gardenRed0", action: "take", atS: 1.8 }]);
    expect(projection.envelopes[0]?.polygon[0]).toEqual({ xIn: -50, yIn: -43 });
    expect(projection.boundingBox.centreOffsetIn).toEqual({ xIn: 0.5, yIn: 0 });
  });

  it("interpolates between the samples of a slower file, and says it is below 10 Hz", () => {
    const { projection, warnings } = readTrajectory(
      {
        formatVersion: 1,
        kind: "trajectory",
        season: "biobuzz",
        alliance: "BLUE",
        frame: { preset: "zenith" },
        rateHz: 4,
        poses: [
          [0, 0, 0],
          [10, 0, Math.PI / 2],
          [10, 10, Math.PI / 2],
        ],
        boundingBox: { lengthIn: 18, widthIn: 18 },
      },
      field,
      { positionQuantumIn: 0.001, headingQuantumRad: 1e-6 },
    );
    expect(warnings.join("\n")).toMatch(/rateHz is 4, below the 10 Hz/);
    // 0.5 s at 4 Hz: six samples at 10 Hz, 0 to 0.5 s.
    expect(projection.trajectory.poses).toHaveLength(6);
    // 0.1 s is 0.4 of the way to the second sample.
    expect(projection.trajectory.poses[1]?.[0]).toBeCloseTo(4, 9);
    expect(projection.trajectory.poses[1]?.[2]).toBeCloseTo(0.4 * (Math.PI / 2), 5);
    // 0.3 s is 0.2 of the way from the second to the third.
    expect(projection.trajectory.poses[3]?.[1]).toBeCloseTo(2, 9);
    expect(projection.trajectory.poses[5]).toEqual([10, 10, expect.closeTo(Math.PI / 2, 5)]);
  });

  it("reads an explicit millimetre frame", () => {
    const projection = importTrajectory(readJson(fixturePath("trajectory/explicit-millimetres.trajectory.json")), field);
    expect(projection.trajectory.poses.map(([x, y]) => [x, y])).toEqual([
      [-72, -62],
      [-72, -52],
      [-62, -42],
    ]);
    expect(projection.trajectory.poses[0]?.[2]).toBeCloseTo(0, 9);
    expect(projection.trajectory.poses[1]?.[2]).toBeCloseTo(Math.PI / 2, 9);
    expect(projection.alliance).toBe("BLUE");
  });

  it("warns about a claim on an element the field does not have", () => {
    const doc = readJson(fixturePath("trajectory/pedro-20hz.trajectory.json")) as Record<string, unknown>;
    const { warnings } = readTrajectory({ ...doc, claims: [{ elementId: "nectarGold", action: "score", atS: 1 }] }, field);
    expect(warnings.join("\n")).toMatch(/claims\[0\]\.elementId "nectarGold" is not an element/);
  });
});

describe("importTrajectory: broken files name the field that is wrong", () => {
  const cases: [string, string][] = [
    ["axes-not-perpendicular.trajectory.json", "frame.yAxis"],
    ["frame-without-preset-or-keys.trajectory.json", "frame.originIn"],
    ["missing-bounding-box.trajectory.json", "boundingBox"],
    ["phase-ends-before-it-starts.trajectory.json", "phases[0].endS"],
    ["pose-row-too-short.trajectory.json", "poses[1]"],
    ["rate-not-positive.trajectory.json", "rateHz"],
    ["unknown-field.trajectory.json", ""],
    ["wrong-season.trajectory.json", "season"],
  ];

  it("covers every broken fixture", () => {
    expect(cases.map(([name]) => name)).toEqual(fixtureFiles("trajectory/broken", ".json"));
  });

  for (const [name, path] of cases) {
    it(`${name}: ${path === "" ? "the unknown key" : path}`, () => {
      let error: unknown;
      try {
        importTrajectory(readJson(fixturePath(`trajectory/broken/${name}`)), field);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ImportError);
      const issues = (error as ImportError).issues;
      expect(issues.map((issue) => issue.path)).toContain(path);
      if (name === "unknown-field.trajectory.json") expect((error as ImportError).message).toMatch(/speedInPerS/);
    });
  }
});

describe("trajectory.json: the published schema and the fixtures", () => {
  it("accepts every good fixture", () => {
    for (const name of fixtureFiles("trajectory", ".json")) {
      expect(trajectoryFileSchema.safeParse(readJson(fixturePath(`trajectory/${name}`))).success, name).toBe(true);
    }
  });

  it("is published at its served id", () => {
    const schema = trajectoryJsonSchema();
    expect(schema["$id"]).toBe(TRAJECTORY_SCHEMA_ID);
    expect(schema["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema["additionalProperties"]).toBe(false);
  });

  it("matches the file checked into json/", () => {
    const path = fileURLToPath(new URL("../../json/trajectory.json", import.meta.url));
    const onDisk = readFileSync(path, "utf8").split("\r\n").join("\n");
    expect(onDisk, "json/trajectory.json is stale; run pnpm --filter @horizon36596/zenith-import gen:json").toBe(trajectoryJsonSchemaText());
  });
});
