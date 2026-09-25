import { parseAuto, SCHEMA_ID, type Auto, type Heading } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { plan } from "./plan.js";
import { resolve } from "./resolve.js";
import { testField, testRobot } from "./testing/fixtures.js";

/** One path leg travelling due north, then a stationary command that inherits its end pose. */
const autoWith = (heading: Heading): Auto =>
  parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "heading-end",
    alliance: "RED",
    start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
    steps: [
      {
        id: "leg",
        kind: "path",
        // The `to` pose names a heading the mode disagrees with, which is what the bug trusted.
        segments: [
          { kind: "line", from: "current", to: { xIn: 0, yIn: 20, headingRad: 0 } },
        ],
        heading,
      },
      { id: "after", kind: "command", name: "shootAll", args: { count: 1, cadence: 0.6 } },
    ],
  });

describe("resolve", () => {
  const cases: { name: string; heading: Heading; endRad: number }[] = [
    { name: "tangent", heading: { mode: "tangent" }, endRad: Math.PI / 2 },
    { name: "tangentReversed", heading: { mode: "tangentReversed" }, endRad: -Math.PI / 2 },
    {
      name: "facePoint",
      heading: { mode: "facePoint", xIn: 10, yIn: 20 },
      endRad: 0,
    },
  ];

  for (const { name, heading, endRad } of cases) {
    it(`finding 5: the end pose of a ${name} step is the mode's h(1), not the to pose's heading`, () => {
      const resolved = resolve(autoWith(heading));
      const leg = resolved.steps[0];
      const after = resolved.steps[1];
      expect(leg?.endPose.headingRad).toBeCloseTo(endRad, 6);
      expect(after?.startPose.headingRad).toBeCloseTo(endRad, 6);

      // `plan` samples the same mode at the last point, so the two must not disagree.
      const planned = plan(resolved, testRobot, testField, { memoize: false });
      expect(planned.steps[0]?.endPose?.headingRad).toBeCloseTo(leg?.endPose.headingRad ?? NaN, 6);
      expect(planned.steps[1]?.startPose.headingRad).toBeCloseTo(endRad, 6);
    });
  }

  it("finding 5: a constant mode still wins over the to pose's heading", () => {
    const resolved = resolve(autoWith({ mode: "constant", headingRad: 1 }));
    expect(resolved.steps[0]?.endPose.headingRad).toBeCloseTo(1, 6);
  });

  it("finding 5: a linear mode ends at toRad", () => {
    const resolved = resolve(autoWith({ mode: "linear", fromRad: 0, toRad: 1.5 }));
    expect(resolved.steps[0]?.endPose.headingRad).toBeCloseTo(1.5, 6);
  });
});
