import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { detectKind, migrate } from "./migrate.js";
import { parseAuto, parseField, parseRobot, parseWaypoints } from "./parse.js";
import { FORMAT_VERSION, FORMAT_VERSIONS, SCHEMA_ID } from "./ids.js";

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../fixtures/migrate/${name}`, import.meta.url)), "utf8"),
  ) as unknown;

/** A v1 auto, the smallest one that is legal. Fixture for the identity migration. */
const autoV1 = {
  $schema: SCHEMA_ID.auto,
  formatVersion: 1,
  name: "one-line",
  alliance: "RED",
  start: { pose: { xIn: -40, yIn: -63, headingRad: 1.5708 } },
  steps: [
    {
      id: "leg1",
      kind: "path",
      segments: [{ kind: "line", from: "current", to: { xIn: -40, yIn: -40 } }],
      heading: { mode: "tangent" },
    },
  ],
};

describe("format versions 2 and 3: migration", () => {
  it("writes autos at 3, fields at 2 and every other kind at 1", () => {
    expect(FORMAT_VERSIONS).toEqual({ link: 1, robot: 1, field: 2, waypoints: 1, auto: 3 });
    expect(FORMAT_VERSION).toBe(3);
  });

  it("takes the v1 auto fixture through v2 to the v3 fixture: the identity plus the version bumps", () => {
    const result = migrate(fixture("auto.v1.json"));
    expect(result.kind).toBe("auto");
    expect(result.fromVersion).toBe(1);
    expect(result.formatVersion).toBe(3);
    expect(result.data).toEqual(fixture("auto.v3.json"));
  });

  it("takes the v2 auto fixture to the v3 fixture unchanged but for the version", () => {
    const result = migrate(fixture("auto.v2.json"));
    expect(result.fromVersion).toBe(2);
    expect(result.data).toEqual(fixture("auto.v3.json"));
  });

  it("takes the v1 field fixture to the v2 fixture: the identity plus the version bump", () => {
    const result = migrate(fixture("field.v1.json"));
    expect(result.kind).toBe("field");
    expect(result.formatVersion).toBe(2);
    expect(result.data).toEqual(fixture("field.v2.json"));
  });

  it("leaves a v3 file exactly as it is", () => {
    const v3 = fixture("auto.v3.json");
    expect(migrate(v3).data).toEqual(v3);
    expect(migrate(v3).fromVersion).toBe(3);
  });

  it("never mutates the file it migrates", () => {
    const v1 = fixture("auto.v1.json") as Record<string, unknown>;
    migrate(v1);
    expect(v1["formatVersion"]).toBe(1);
  });

  it("parses a v1 or v2 auto as v3, so the loader accepts all three", () => {
    expect(parseAuto(autoV1).formatVersion).toBe(3);
    expect(parseAuto(fixture("auto.v1.json"))).toEqual(parseAuto(fixture("auto.v3.json")));
    expect(parseAuto(fixture("auto.v2.json"))).toEqual(parseAuto(fixture("auto.v3.json")));
    expect(parseField(fixture("field.v1.json")).formatVersion).toBe(2);
  });

  it("keeps robot and waypoints files at 1", () => {
    const waypoints = { formatVersion: 1, waypoints: {} };
    expect(migrate(waypoints).data).toEqual(waypoints);
    expect(() => migrate({ formatVersion: 2, waypoints: {} })).toThrow(
      /formatVersion 2; this build of Zenith knows 1/,
    );
  });

  it("refuses a file from the future by name and number", () => {
    expect(() => migrate({ ...autoV1, formatVersion: 4 })).toThrow(
      /auto file is formatVersion 4; this build of Zenith knows 3/,
    );
  });

  it("refuses a file with no version", () => {
    expect(() => migrate({ ...autoV1, formatVersion: undefined })).toThrow(/integer formatVersion/);
  });

  it("detects the kind from $schema and from the keys", () => {
    expect(detectKind(autoV1)).toBe("auto");
    expect(detectKind({ formatVersion: 1, waypoints: {} })).toBe("waypoints");
    expect(detectKind({ formatVersion: 1, season: "biobuzz" })).toBe("field");
    expect(detectKind({ formatVersion: 1, kinematics: {} })).toBe("robot");
    expect(detectKind({ formatVersion: 1, autosDir: "autos" })).toBe("link");
    expect(detectKind({ formatVersion: 1 })).toBeNull();
  });
});

describe("parse", () => {
  it("rejects a $schema that is not this kind's id", () => {
    expect(() => parseAuto({ ...autoV1, $schema: SCHEMA_ID.robot })).toThrow(/\$schema must be/);
  });

  it("names the failing key", () => {
    expect(() => parseWaypoints({ formatVersion: 1, waypoints: { a: { xIn: 0, yIn: 0 } } })).toThrow(
      /waypoints\.a\.headingRad/,
    );
  });

  it("rejects an estimateS outside the grammar", () => {
    const robot = {
      formatVersion: 1,
      name: "test",
      frame: { forward: "+x", left: "+y", headingZero: "+x", headingPositive: "ccw" },
      footprint: {
        startIn: { lengthIn: 18, widthIn: 14 },
        expandedIn: { lengthIn: 18, widthIn: 14 },
        centreOfRotationIn: { xIn: 0, yIn: 0 },
      },
      kinematics: {
        maxForwardVelInPerS: { value: 72.3456 },
        maxStrafeVelInPerS: { value: 61.2345 },
        forwardDecelInPerS2: { value: 83.4567 },
        strafeDecelInPerS2: { value: 40 },
        accelInPerS2: { value: 90 },
        maxAngularVelRadPerS: { value: 6 },
        defaultPathSpeedFraction: { value: 0.8 },
        follower: { library: "pedro", version: "3.0.0-20260828.185437-17", holdEnd: true },
      },
      commands: [{ name: "shootAll", estimateS: "0.6 + count * cadence" }],
    };
    expect(parseRobot(robot).commands[0]?.name).toBe("shootAll");
    expect(() =>
      parseRobot({ ...robot, commands: [{ name: "bad", estimateS: "2 ** 3" }] }),
    ).toThrow(/estimateS must be an expression/);
  });
});
