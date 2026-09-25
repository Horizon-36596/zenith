import { describe, expect, it } from "vitest";
import { constrainAngle, measure, measureDeltaLabel, measureLabel, snapMeasureEnd } from "./measure.js";

describe("measure", () => {
  it("reads distance, run on each axis and field-frame bearing", () => {
    const readout = measure({ fromIn: { xIn: 0, yIn: 0 }, toIn: { xIn: 3, yIn: 4 } });
    expect(readout.distanceIn).toBeCloseTo(5, 9);
    expect(readout.dxIn).toBe(3);
    expect(readout.dyIn).toBe(4);
    expect(readout.angleDeg).toBeCloseTo(53.13, 2);
    expect(measureLabel(readout)).toBe("5.00 in · 53.1°");
    expect(measureDeltaLabel(readout)).toBe("Δx +3.00  Δy +4.00 in");
  });

  it("reads a leftward line as 180 degrees, never -180", () => {
    expect(measure({ fromIn: { xIn: 0, yIn: 0 }, toIn: { xIn: -10, yIn: -0 } }).angleDeg).toBe(180);
  });

  it("reads zero for a click with no drag", () => {
    const readout = measure({ fromIn: { xIn: 2, yIn: 2 }, toIn: { xIn: 2, yIn: 2 } });
    expect(readout.distanceIn).toBe(0);
    expect(readout.angleDeg).toBe(0);
  });

  it("swings the far end to the nearest 45 degree bearing with Shift, keeping its length", () => {
    const end = constrainAngle({ xIn: 0, yIn: 0 }, { xIn: 10, yIn: 8 });
    expect(Math.hypot(end.xIn, end.yIn)).toBeCloseTo(Math.hypot(10, 8), 9);
    expect(end.xIn).toBeCloseTo(end.yIn, 9);
  });

  it("lands an end on a point within eight pixels, measured at the zoom", () => {
    const points = [{ xIn: 10, yIn: 10 }];
    // 8 px at 4 px per inch is 2 in.
    expect(snapMeasureEnd({ xIn: 11.5, yIn: 10 }, points, 4)).toEqual({ pointIn: points[0], snapped: true });
    expect(snapMeasureEnd({ xIn: 12.5, yIn: 10 }, points, 4).snapped).toBe(false);
    expect(snapMeasureEnd({ xIn: 12.5, yIn: 10 }, points, 2).snapped).toBe(true);
  });
});
