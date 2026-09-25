import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { check, fieldBounds, flattenSteps, loadField, loadRobot, plan, resolve, setPose, type Pose } from "@horizon36596/zenith-core";
import { parseAuto, parseRobot, SCHEMA_ID, type Auto, type Robot } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { bodyBoundsIn, draggedFootprintBounds, footprintBoundsIn } from "./footprintBounds.js";
import { NO_KEYS, resolveModifiers } from "./modifiers.js";
import { resolveLeader } from "./pointDrag.js";
import type { SnapContext } from "./snap.js";
import type { PointTarget } from "./types.js";

/**
 * The owner's report: "the snap to wall ... create[s] an error for being outside the field". A
 * point snapped flush to a wall must never produce a PERIMETER finding, including when an intake
 * mouth sticks out past the body and when the heading at the point turns as the point moves.
 */

const examples = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

describe.skipIf(!existsSync(`${examples}zenith.json`))("wall snap against the PERIMETER check", () => {
  const field = loadField(read("autos/field/biobuzz.field.json"));
  const bounds = fieldBounds(field);
  const base = loadRobot(read("autos/robot.json"));
  // A front mouth that reaches 3 in past the body, so the body alone would snap it over the wall.
  const robot: Robot = parseRobot({
    ...base,
    mouths: [
      {
        id: "front",
        side: "FRONT",
        offsetIn: { xIn: base.footprint.expandedIn.lengthIn / 2 + 1, yIn: 0 },
        widthIn: 10,
        depthIn: 4,
        provenance: "PLACEHOLDER: test fixture",
      },
    ],
  });

  const target: PointTarget = { segmentIndex: 0, pointKind: "to" };

  const routine = (end: { xIn: number; yIn: number }): Auto =>
    parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 2,
      name: "wall",
      alliance: "RED",
      start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
      steps: [
        {
          id: "run",
          kind: "path",
          segments: [{ kind: "line", from: "current", to: { xIn: end.xIn, yIn: end.yIn, headingRad: 0 } }],
          heading: { mode: "tangent" },
        },
      ],
    });

  const perimeter = (auto: Auto): string[] =>
    check(plan(resolve(auto), robot, field), null, robot, field)
      .filter((finding) => finding.code === "PERIMETER")
      .map((finding) => finding.stepId ?? "");

  const drag = (auto: Auto, pointerIn: { xIn: number; yIn: number }, alt = false): ReturnType<typeof resolveLeader> => {
    const steps = flattenSteps(plan(resolve(auto), robot, field).steps);
    const context: SnapContext = {
      enabled: true,
      altHeld: false,
      pxPerIn: 4,
      waypoints: [],
      bounds,
      footprintBounds: (pose: Pose) => draggedFootprintBounds(steps, robot, "run", target, pose, "all"),
      bodyBounds: (pose: Pose) => draggedFootprintBounds(steps, robot, "run", target, pose, "body"),
    };
    const startPose: Pose = { xIn: 40, yIn: 10, headingRad: 0 };
    return resolveLeader(startPose, pointerIn, resolveModifiers(true, { ...NO_KEYS, alt }), context);
  };

  it("reaches out to the mouth, which the body box alone would not", () => {
    const pose = { xIn: 0, yIn: 0, headingRad: 0 };
    expect(footprintBoundsIn(pose, robot).maxXIn).toBeGreaterThan(bodyBoundsIn(pose, robot).maxXIn + 2);
  });

  for (const [label, yIn] of [
    ["straight at the wall", 0],
    ["at an angle, so the tangent heading turns as the point moves", 18],
  ] as const) {
    it(`leaves no PERIMETER finding when snapped ${label}`, () => {
      const auto = routine({ xIn: 40, yIn: yIn / 2 });
      // Aim so the whole footprint (mouth included) sits 0.6 in inside the +X wall.
      const probe = drag(auto, { xIn: 40, yIn }, true).pose;
      const steps = flattenSteps(plan(resolve(auto), robot, field).steps);
      const box = draggedFootprintBounds(steps, robot, "run", target, probe, "all");
      expect(box).not.toBeNull();
      const aimX = probe.xIn + (bounds.maxXIn - 0.6 - (box?.maxXIn ?? 0));

      for (const alt of [false, true]) {
        const result = drag(auto, { xIn: aimX, yIn }, alt);
        expect(result.snap.kind).toBe("wall");
        expect(result.snap.mouth).toBe(true);
        expect(result.label).toContain("wall (mouth)");
        const moved = setPose(auto, "run", target, result.pose);
        expect(perimeter(moved)).toEqual([]);

        // Flush, not merely inside: the union box touches the wall to within a micro-inch.
        const after = flattenSteps(plan(resolve(moved), robot, field).steps);
        const flush = draggedFootprintBounds(after, robot, "run", target, result.pose, "all");
        expect(flush?.maxXIn).toBeCloseTo(bounds.maxXIn, 5);
      }
    });
  }

  it("would have produced PERIMETER with the body-only box of v1", () => {
    const auto = routine({ xIn: 40, yIn: 0 });
    const pose = { xIn: 0, yIn: 0, headingRad: 0 };
    const bodyHalf = bodyBoundsIn(pose, robot).maxXIn;
    const moved = setPose(auto, "run", target, { xIn: bounds.maxXIn - bodyHalf, yIn: 0, headingRad: 0 });
    expect(perimeter(moved)).toContain("run");
  });
});
