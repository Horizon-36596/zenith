import { describe, expect, it } from "vitest";
import { HEADING_MODES, headingModeHint, headingModeInfo } from "./headingModes";

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
