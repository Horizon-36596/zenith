import { describe, expect, it } from "vitest";
import { SELECTION_MIN_SPAN_IN, selectionFrameBounds } from "./selectionFrame.js";

const centre = (box: { minXIn: number; maxXIn: number; minYIn: number; maxYIn: number }) => ({
  xIn: (box.minXIn + box.maxXIn) / 2,
  yIn: (box.minYIn + box.maxYIn) / 2,
});

describe("the box F frames", () => {
  it("frames a selected pin where it is, in a mirrored alliance view too", () => {
    const pin = [{ xIn: -40, yIn: -36 }];
    for (const mirror of ["pointSymmetry", "mirrorX", "mirrorY"] as const) {
      const box = selectionFrameBounds(pin, true, mirror);
      expect(centre(box)).toEqual({ xIn: -40, yIn: -36 });
      expect(box.maxXIn - box.minXIn).toBeGreaterThanOrEqual(SELECTION_MIN_SPAN_IN);
    }
  });

  it("frames path points as they are drawn, mirrored with the view", () => {
    const points = [{ xIn: -40, yIn: -36 }];
    expect(centre(selectionFrameBounds(points, false, "pointSymmetry"))).toEqual({ xIn: 40, yIn: 36 });
    expect(centre(selectionFrameBounds(points, false, "none"))).toEqual({ xIn: -40, yIn: -36 });
  });
});
