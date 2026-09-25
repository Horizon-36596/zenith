import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseAuto, parseRobot, SCHEMA_ID, type Robot } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { check } from "./check.js";
import { fieldBounds, footprintBoundsIn } from "./footprint.js";
import { loadAuto, loadField, loadRobot, loadWaypoints } from "./load.js";
import { plan } from "./plan.js";
import { resolve } from "./resolve.js";
import { testField, testRobot } from "./testing/fixtures.js";

/** Item 3: the footprint's bounds are the union of the body and every mouth, the set PERIMETER tests. */

const withMouth = (offsetXIn: number, depthIn: number): Robot =>
  parseRobot({
    ...testRobot,
    mouths: [
      {
        id: "front",
        side: "FRONT",
        offsetIn: { xIn: offsetXIn, yIn: 0 },
        widthIn: 10,
        depthIn,
        provenance: "PLACEHOLDER: test fixture",
      },
    ],
  });

describe("footprintBoundsIn", () => {
  it("is the body's box when the mouth sits inside it", () => {
    const bounds = footprintBoundsIn({ xIn: 0, yIn: 0, headingRad: 0 }, withMouth(7, 4));
    expect(bounds.maxXIn).toBeCloseTo(9, 9);
    expect(bounds.minXIn).toBeCloseTo(-9, 9);
    expect(bounds.maxYIn).toBeCloseTo(7, 9);
  });

  it("reaches out to a mouth that sticks out past the body", () => {
    const bounds = footprintBoundsIn({ xIn: 0, yIn: 0, headingRad: 0 }, withMouth(10, 4));
    expect(bounds.maxXIn).toBeCloseTo(12, 9);
    expect(bounds.minXIn).toBeCloseTo(-9, 9);
  });

  it("turns with the robot", () => {
    const bounds = footprintBoundsIn({ xIn: 0, yIn: 0, headingRad: Math.PI / 2 }, withMouth(10, 4));
    expect(bounds.maxYIn).toBeCloseTo(12, 9);
    expect(bounds.maxXIn).toBeCloseTo(7, 9);
  });

  it("means a pose shifted flush to a wall by these bounds reports no PERIMETER", () => {
    const robot = withMouth(10, 4);
    const wall = fieldBounds(testField).minYIn;
    for (const headingRad of [0, 0.4, -Math.PI / 2, 2.2, Math.PI]) {
      const probe = footprintBoundsIn({ xIn: 0, yIn: 0, headingRad }, robot);
      const yIn = wall - probe.minYIn;
      const auto = parseAuto({
        $schema: SCHEMA_ID.auto,
        formatVersion: 2,
        name: "flush",
        alliance: "RED",
        start: { pose: { xIn: 0, yIn, headingRad } },
        steps: [{ id: "hold", kind: "wait", seconds: 1 }],
      });
      const findings = check(plan(resolve(auto), robot, testField), null, robot, testField);
      expect(findings.filter((finding) => finding.code === "PERIMETER"), String(headingRad)).toEqual([]);
    }
  });
});

const examples = fileURLToPath(new URL("../../../examples/starter/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

describe("the starter robot's mouth", () => {
  it("sits inside the 18 in body, outer edge flush, still labelled PLACEHOLDER", () => {
    const robot = loadRobot(read("autos/robot.json"));
    const half = robot.footprint.expandedIn.lengthIn / 2;
    expect(robot.mouths).toHaveLength(1);
    for (const mouth of robot.mouths ?? []) {
      expect(Math.abs(mouth.offsetIn.xIn) + mouth.depthIn / 2).toBeCloseTo(half, 9);
      expect(mouth.provenance).toMatch(/^PLACEHOLDER/);
    }
    const bounds = footprintBoundsIn({ xIn: 0, yIn: 0, headingRad: 0 }, robot);
    expect(bounds.maxXIn).toBeCloseTo(half, 9);
  });

  it("leaves the first-auto start pose flush with the south wall, with no PERIMETER finding", () => {
    const robot = loadRobot(read("autos/robot.json"));
    const field = loadField(read("autos/field/biobuzz.field.json"));
    const waypoints = loadWaypoints(read("autos/waypoints.json"));
    const auto = loadAuto(read("autos/first-auto.auto.json"));
    const planned = plan(resolve(auto, waypoints), robot, field);
    expect(footprintBoundsIn(planned.startPose, robot).minYIn).toBeCloseTo(fieldBounds(field).minYIn, 3);
    const findings = check(planned, null, robot, field);
    expect(findings.filter((finding) => finding.code === "PERIMETER")).toEqual([]);
  });
});
