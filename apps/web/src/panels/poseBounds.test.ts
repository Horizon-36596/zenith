/**
 * Issue #502: a typed pose is held to the field and the robot's half-diagonal past each wall, so an
 * x of 99999 is refused with the range while a pose with the robot half off the field is kept.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadField, loadRobot } from "@horizon36596/zenith-core";
import type { Field } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { robotReachIn } from "../canvas/footprintBounds";
import { poseBounds } from "./poseBounds";

const starter = (path: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../examples/starter/autos/${path}`, import.meta.url)), "utf8"));

const field = loadField(starter("field/biobuzz.field.json"));
const robot = loadRobot(starter("robot.json"));

describe("poseBounds", () => {
  it("runs from wall to wall plus the robot's reach, rounded out to a whole inch", () => {
    const reach = robotReachIn(robot);
    const bounds = poseBounds(field, robot);
    const half = field.sizeIn.xIn / 2;
    expect(bounds.x.min).toBe(Math.floor(-half - reach));
    expect(bounds.x.max).toBe(Math.ceil(half + reach));
    expect(bounds.x.max).toBeLessThan(99999);
    expect(bounds.x.max).toBeGreaterThan(half);
  });

  it("starts at the corner for a field whose origin is a corner", () => {
    const corner = { ...field, frame: { ...field.frame, origin: "corner" } } as Field;
    const bounds = poseBounds(corner, null);
    expect(bounds.y).toEqual({ min: 0, max: corner.sizeIn.yIn });
  });

  it("holds nothing before a field is open", () => {
    expect(poseBounds(null, robot)).toEqual({ x: {}, y: {} });
  });
});
