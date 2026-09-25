import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  check,
  fieldBounds,
  flattenSteps,
  footprintBoundsIn,
  loadField,
  loadRobot,
  plan,
  resolve,
  setPose,
  type Box2,
  type Pose,
} from "@horizon36596/zenith-core";
import { parseAuto, parseRobot, SCHEMA_ID, type Auto, type Robot } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { draggedFootprintBounds } from "./footprintBounds.js";
import { NO_KEYS, resolveModifiers } from "./modifiers.js";
import { resolveLeader } from "./pointDrag.js";
import { WALL_SNAP_IN, type SnapContext } from "./snap.js";
import type { PointTarget } from "./types.js";

/**
 * QA matrix item 5 ("Wall snap is footprint-true", site/docs/editor.md): drag a
 * pose into each of the four walls at headings 0, 45, 90 and 180 degrees, for the example robot
 * and for one whose mouths reach past its body at the front and on the left. After the snap the
 * core `check` must report no PERIMETER for that step, and the union of the body and every mouth
 * must be flush with the wall to within 0.1 in (it is solved to a micro-inch, so the test holds it
 * to 1e-4).
 *
 * Two approaches per case: the pointer stopping just short of the wall (inside the 1 in reach),
 * and the pointer pushed on into the wall while the point itself stays on the field, which the
 * snap must pull back to flush.
 */

const examples = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

type Wall = "minX" | "maxX" | "minY" | "maxY";
const WALLS: readonly Wall[] = ["minX", "maxX", "minY", "maxY"];
const HEADINGS_DEG = [0, 45, 90, 180] as const;

describe.skipIf(!existsSync(`${examples}zenith.json`))("QA: wall snap into every wall at every heading", () => {
  const field = loadField(read("autos/field/biobuzz.field.json"));
  const bounds = fieldBounds(field);
  const example = loadRobot(read("autos/robot.json"));
  const reaching: Robot = parseRobot({
    ...example,
    mouths: [
      {
        id: "front",
        side: "FRONT",
        offsetIn: { xIn: example.footprint.expandedIn.lengthIn / 2 + 1.5, yIn: 0 },
        widthIn: 10,
        depthIn: 5,
        provenance: "PLACEHOLDER: QA fixture, a mouth 4 in past the nose",
      },
      {
        id: "left",
        side: "LEFT",
        offsetIn: { xIn: 2, yIn: example.footprint.expandedIn.widthIn / 2 + 1 },
        widthIn: 6,
        depthIn: 4,
        provenance: "PLACEHOLDER: QA fixture, a side mouth 3 in past the body",
      },
    ],
  });
  const robots: Array<[string, Robot]> = [
    ["the example robot", example],
    ["a robot whose mouths reach past its body", reaching],
  ];
  const target: PointTarget = { segmentIndex: 0, pointKind: "to" };

  /** One constant-heading leg from the field centre towards the wall. */
  const routine = (end: { xIn: number; yIn: number }, headingRad: number): Auto =>
    parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 2,
      name: "wall",
      alliance: "RED",
      start: { pose: { xIn: 0, yIn: 0, headingRad } },
      steps: [
        {
          id: "run",
          kind: "path",
          segments: [{ kind: "line", from: "current", to: { xIn: end.xIn, yIn: end.yIn, headingRad } }],
          heading: { mode: "constant", headingRad },
        },
      ],
    });

  const perimeterOn = (auto: Auto, robot: Robot): string[] =>
    check(plan(resolve(auto), robot, field), null, robot, field)
      .filter((finding) => finding.code === "PERIMETER")
      .map((finding) => `${finding.stepId ?? ""}: ${finding.message}`);

  const context = (auto: Auto, robot: Robot): SnapContext => {
    const steps = flattenSteps(plan(resolve(auto), robot, field).steps);
    return {
      enabled: true,
      altHeld: false,
      pxPerIn: 4,
      waypoints: [],
      bounds,
      footprintBounds: (pose: Pose) => draggedFootprintBounds(steps, robot, "run", target, pose, "all"),
      bodyBounds: (pose: Pose) => draggedFootprintBounds(steps, robot, "run", target, pose, "body"),
    };
  };

  /** How far the union box sits from the wall: 0 is flush, negative is through it. */
  const gap = (box: Box2, wall: Wall): number => {
    switch (wall) {
      case "minX":
        return box.minXIn - bounds.minXIn;
      case "maxX":
        return bounds.maxXIn - box.maxXIn;
      case "minY":
        return box.minYIn - bounds.minYIn;
      case "maxY":
        return bounds.maxYIn - box.maxYIn;
    }
  };

  /** A pointer position that leaves the union box `insideIn` from the wall, on the wall's axis. */
  const aim = (robot: Robot, headingRad: number, wall: Wall, insideIn: number): { xIn: number; yIn: number } => {
    const box = footprintBoundsIn({ xIn: 0, yIn: 0, headingRad }, robot);
    switch (wall) {
      case "minX":
        return { xIn: bounds.minXIn + insideIn - box.minXIn, yIn: 0.13 };
      case "maxX":
        return { xIn: bounds.maxXIn - insideIn - box.maxXIn, yIn: 0.13 };
      case "minY":
        return { xIn: 0.13, yIn: bounds.minYIn + insideIn - box.minYIn };
      case "maxY":
        return { xIn: 0.13, yIn: bounds.maxYIn - insideIn - box.maxYIn };
    }
  };

  for (const [robotName, robot] of robots) {
    for (const wall of WALLS) {
      for (const deg of HEADINGS_DEG) {
        const headingRad = (deg * Math.PI) / 180;
        for (const [approach, insideIn] of [
          ["stopping 0.4 in short", 0.4],
          ["pushed 3 in into it", -3],
        ] as const) {
          it(`${robotName}, ${wall} wall, ${String(deg)} degrees, ${approach}: flush and no PERIMETER`, () => {
            expect(0.4).toBeLessThan(WALL_SNAP_IN);
            const pointer = aim(robot, headingRad, wall, insideIn);
            const auto = routine({ xIn: pointer.xIn / 2, yIn: pointer.yIn / 2 }, headingRad);
            const start: Pose = { xIn: pointer.xIn / 2, yIn: pointer.yIn / 2, headingRad };
            for (const alt of [false, true]) {
              const result = resolveLeader(start, pointer, resolveModifiers(true, { ...NO_KEYS, alt }), context(auto, robot));
              expect(result.snap.kind, `the wall rule fired (alt ${String(alt)})`).toBe("wall");
              const moved = setPose(auto, "run", target, result.pose);
              expect(perimeterOn(moved, robot)).toEqual([]);
              const box = footprintBoundsIn({ ...result.pose, headingRad }, robot);
              expect(Math.abs(gap(box, wall)), `gap to the ${wall} wall`).toBeLessThan(1e-4);
              // Every other wall is clear too.
              for (const other of WALLS) expect(gap(box, other)).toBeGreaterThan(-1e-4);
            }
          });
        }
      }
    }
  }

  it("the reaching robot's mouth, not its body, is what touches the wall at the nose", () => {
    const headingRad = 0;
    const pointer = aim(reaching, headingRad, "maxX", 0.4);
    const auto = routine({ xIn: 30, yIn: 0 }, headingRad);
    const result = resolveLeader({ xIn: 30, yIn: 0, headingRad }, pointer, resolveModifiers(true, NO_KEYS), context(auto, reaching));
    expect(result.snap.mouth).toBe(true);
    expect(result.label).toContain("wall (mouth)");
  });

  it("Ctrl turns the wall snap off along with every other rule", () => {
    const headingRad = 0;
    const pointer = aim(example, headingRad, "maxX", 0.4);
    const auto = routine({ xIn: 30, yIn: 0 }, headingRad);
    const result = resolveLeader(
      { xIn: 30, yIn: 0, headingRad },
      pointer,
      resolveModifiers(true, { ...NO_KEYS, ctrl: true }),
      context(auto, example),
    );
    expect(result.snap.kind).toBe("none");
    expect(result.pose.xIn).toBe(pointer.xIn);
  });
});
