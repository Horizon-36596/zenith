/**
 * "Split heading here" on a linear sweep of more than half a turn over two segments (issue #375):
 * the sweep is shared out by segment and each share turns the short way, so made piecewise it takes
 * one range per segment, and the split leaves the robot turning exactly as before.
 */
import { headingAtT, makePath } from "@horizon36596/zenith-core";
import type { Heading } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { splitHeadingAt } from "./headingHandles";

const polygons = [
  [
    { xIn: 0, yIn: 0 },
    { xIn: 24, yIn: 0 },
  ],
  [
    { xIn: 24, yIn: 0 },
    { xIn: 48, yIn: 0 },
  ],
];
const geometry = makePath(polygons);

describe("Split heading here on a linear sweep over two segments", () => {
  it("keeps the turn the robot makes", () => {
    const linear: Heading = { mode: "linear", fromRad: -2, toRad: 2 };
    const split = splitHeadingAt(linear, 0.25, polygons);
    expect(split?.mode).toBe("piecewise");
    if (split?.mode !== "piecewise") return;
    expect(split.ranges.map((range) => [range.startT, range.endT])).toEqual([
      [0, 0.25],
      [0.25, 0.5],
      [0.5, 1],
    ]);
    for (const t of [0.1, 0.25, 0.4, 0.6, 0.9]) {
      expect(Math.cos(headingAtT(split, geometry, t) - headingAtT(linear, geometry, t))).toBeCloseTo(1, 9);
    }
  });

  it("offers no split, rather than a bare conversion to piecewise, too close to a segment's range end", () => {
    const linear: Heading = { mode: "linear", fromRad: -2, toRad: 2 };
    expect(splitHeadingAt(linear, 0.51, polygons)).toBeNull();
    expect(splitHeadingAt({ mode: "tangent" }, 0.01, polygons)).toBeNull();
  });

  it("splits a heading of any other mode as one range, as before", () => {
    const split = splitHeadingAt({ mode: "tangent" }, 0.25, polygons);
    expect(split).toEqual({
      mode: "piecewise",
      ranges: [
        { startT: 0, endT: 0.25, heading: { mode: "tangent" } },
        { startT: 0.25, endT: 1, heading: { mode: "tangent" } },
      ],
    });
  });
});
