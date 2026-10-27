import { headingAtT, makePath } from "@horizon36596/zenith-core";
import { describe, expect, it } from "vitest";
import { HEADING_MODES, defaultPathHeading, headingForMode, headingModeHint, headingModeInfo, heldPathHeadingFor } from "./headingModes";

/**
 * The heading control shows Pedro's names, as Pedro v3's `Path` methods spell them
 * (site/docs/paths-explained.md, "Heading modes"), with the plain words moved into the tooltip.
 */
describe("heading mode names", () => {
  it("labels every file mode with Pedro's name, in the file's order", () => {
    expect(HEADING_MODES.map((info) => [info.value, info.label])).toEqual([
      ["tangent", "Tangent"],
      ["tangentReversed", "Reverse tangent"],
      ["constant", "Constant"],
      ["linear", "Linear"],
      ["facePoint", "Facing point"],
      ["piecewise", "Piecewise"],
    ]);
  });

  it("names the Path method the robot runtime calls for each one", () => {
    expect(HEADING_MODES.map((info) => info.pedro)).toEqual([
      "path.tangent()",
      "path.reverseTangent()",
      "path.constant(heading)",
      "path.linear(start, end)",
      "path.facingPoint(point)",
      "Interpolator.piecewise().until(t, ...)",
    ]);
  });

  it("keeps the old plain explanation in the tooltip, then the Pedro call", () => {
    expect(headingModeHint(headingModeInfo("tangent"))).toBe("Face the way it drives. Pedro: path.tangent().");
    for (const info of HEADING_MODES) expect(headingModeHint(info)).toContain(info.pedro);
  });
});

/** Switching a path's heading mode keeps what the path does now (sweep item A12). */
describe("headingForMode", () => {
  const planned = { startRad: 0.5, endRad: 1.25 };

  it("starts Constant at the heading the path ends at now, not at 0", () => {
    expect(headingForMode("constant", { mode: "tangent" }, planned)).toEqual({ mode: "constant", headingRad: 1.25 });
    expect(headingForMode("constant", undefined, planned)).toEqual({ mode: "constant", headingRad: 1.25 });
  });

  it("starts Linear from the heading the path starts at to the one it ends at", () => {
    expect(headingForMode("linear", { mode: "tangent" }, planned)).toEqual({ mode: "linear", fromRad: 0.5, toRad: 1.25 });
  });

  it("turns Linear the short way round when the ends straddle the half turn", () => {
    const heading = headingForMode("linear", { mode: "tangent" }, { startRad: 3, endRad: -3 });
    expect(heading.mode).toBe("linear");
    if (heading.mode !== "linear") return;
    expect(heading.fromRad).toBe(3);
    expect(heading.toRad - heading.fromRad).toBeCloseTo(2 * Math.PI - 6, 9);
  });

  it("keeps a constant or linear heading's own angles", () => {
    expect(headingForMode("linear", { mode: "constant", headingRad: 2 }, planned)).toEqual({
      mode: "linear",
      fromRad: 2,
      toRad: 2,
    });
    expect(headingForMode("constant", { mode: "linear", fromRad: 0, toRad: -1 }, planned)).toEqual({
      mode: "constant",
      headingRad: -1,
    });
  });

  it("starts at 0 only when there is no plan to read", () => {
    expect(headingForMode("constant", { mode: "tangent" }, null)).toEqual({ mode: "constant", headingRad: 0 });
    expect(headingForMode("linear", { mode: "tangent" }, null)).toEqual({ mode: "linear", fromRad: 0, toRad: 0 });
  });

  it("makes Piecewise from a linear sweep of more than half a turn over two segments one range per segment", () => {
    const geometry = makePath([
      [
        { xIn: 0, yIn: 0 },
        { xIn: 24, yIn: 0 },
      ],
      [
        { xIn: 24, yIn: 0 },
        { xIn: 48, yIn: 0 },
      ],
    ]);
    const linear = { mode: "linear", fromRad: -2, toRad: 2 } as const;
    const heading = headingForMode("piecewise", linear, { ...planned, geometry });
    expect(heading).toEqual({
      mode: "piecewise",
      ranges: [
        { startT: 0, endT: 0.5, heading: { mode: "linear", fromRad: -2, toRad: 0 } },
        { startT: 0.5, endT: 1, heading: { mode: "linear", fromRad: 0, toRad: 2 } },
      ],
    });
    expect(headingAtT(heading, geometry, 0.25)).toBeCloseTo(headingAtT(linear, geometry, 0.25), 9);
    expect(headingForMode("piecewise", linear, planned)).toEqual({
      mode: "piecewise",
      ranges: [{ startT: 0, endT: 1, heading: linear }],
    });
  });

  it("leaves the other modes as they were", () => {
    expect(headingForMode("tangent", { mode: "constant", headingRad: 1 }, planned)).toEqual({ mode: "tangent" });
    expect(headingForMode("facePoint", { mode: "tangent" }, planned)).toEqual({ mode: "facePoint", xIn: 0, yIn: 0 });
  });
});

/** The heading of a path that must hold the heading the robot arrives with (issue #445). */
describe("heldPathHeadingFor", () => {
  it("is Linear from the heading to itself with the default and Linear settings", () => {
    expect(heldPathHeadingFor({ defaultHeading: "linear" }, 0.5)).toEqual({ mode: "linear", fromRad: 0.5, toRad: 0.5 });
  });

  it("is Linear from the heading to itself with the Tangent setting, which would turn the robot", () => {
    expect(heldPathHeadingFor({ defaultHeading: "tangent" }, 0.5)).toEqual({ mode: "linear", fromRad: 0.5, toRad: 0.5 });
  });

  it("is Constant only with the Constant setting", () => {
    expect(heldPathHeadingFor({ defaultHeading: "constant" }, 0.5)).toEqual({ mode: "constant", headingRad: 0.5 });
  });
});

/** The heading a new path gets from the person's setting (spec 15 section 11, owner ruling D6). */
describe("defaultPathHeading", () => {
  it("is Tangent whatever the angles are", () => {
    expect(defaultPathHeading("tangent", 0.5, 2)).toEqual({ mode: "tangent" });
  });

  it("holds the arrival heading for Constant", () => {
    expect(defaultPathHeading("constant", 0.5, 2)).toEqual({ mode: "constant", headingRad: 0.5 });
  });

  it("turns Linear from the arrival heading to the end heading", () => {
    expect(defaultPathHeading("linear", 0.5, 2)).toEqual({ mode: "linear", fromRad: 0.5, toRad: 2 });
    expect(defaultPathHeading("linear", 1, 1)).toEqual({ mode: "linear", fromRad: 1, toRad: 1 });
  });

  it("turns Linear the short way round", () => {
    const heading = defaultPathHeading("linear", 3, -3);
    if (heading.mode !== "linear") throw new Error("expected linear");
    expect(heading.fromRad).toBe(3);
    expect(heading.toRad).toBeCloseTo(3 + (2 * Math.PI - 6), 12);
  });
});
