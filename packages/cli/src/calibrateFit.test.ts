import { describe, expect, it } from "vitest";
import { fitCalibration, predictTravelS, type CalibrationSample } from "./calibrateFit.js";

describe("predictTravelS", () => {
  it("is zero-length safe", () => {
    expect(predictTravelS(0, 100, 90, 0.25)).toBe(0.25);
  });

  it("grows with distance", () => {
    const short = predictTravelS(24, 100, 90, 0.25);
    const long = predictTravelS(96, 100, 90, 0.25);
    expect(long).toBeGreaterThan(short);
  });
});

describe("fitCalibration", () => {
  it("recovers accel and settleS close to the values used to generate the samples", () => {
    const trueAccel = 80;
    const trueSettle = 0.3;
    const cruiseInPerS = 96;
    const lengths = [12, 24, 36, 48, 72, 96, 120];
    const samples: CalibrationSample[] = lengths.map((lengthIn, index) => ({
      stepId: `s${String(index)}`,
      headingMode: "tangent",
      lengthIn,
      actualS: predictTravelS(lengthIn, cruiseInPerS, trueAccel, trueSettle),
    }));

    const fit = fitCalibration(samples, cruiseInPerS);
    expect(fit.sampleCount).toBe(lengths.length);
    // The grid is coarse (5 in/s^2, 0.05 s), so this checks "close", not exact.
    expect(fit.accelInPerS2).toBeGreaterThanOrEqual(trueAccel - 10);
    expect(fit.accelInPerS2).toBeLessThanOrEqual(trueAccel + 10);
    expect(fit.settleS).toBeGreaterThanOrEqual(trueSettle - 0.1);
    expect(fit.settleS).toBeLessThanOrEqual(trueSettle + 0.1);
    // A near-perfect fit against its own generated data has a tiny residual band.
    expect(fit.residualHighFraction - fit.residualLowFraction).toBeLessThan(0.1);
  });

  it("gives a constant-heading leg a scale above 1 when it consistently runs slower than tangent", () => {
    const cruiseInPerS = 96;
    const accel = 80;
    const settle = 0.25;
    const samples: CalibrationSample[] = [
      ...[24, 48, 72].map((lengthIn, index) => ({
        stepId: `tangent${String(index)}`,
        headingMode: "tangent",
        lengthIn,
        actualS: predictTravelS(lengthIn, cruiseInPerS, accel, settle),
      })),
      ...[24, 48, 72].map((lengthIn, index) => ({
        stepId: `constant${String(index)}`,
        headingMode: "constant",
        lengthIn,
        // A strafe-like leg that consistently takes 40% longer than the trapezoid model predicts.
        actualS: predictTravelS(lengthIn, cruiseInPerS, accel, settle) * 1.4,
      })),
    ];

    const fit = fitCalibration(samples, cruiseInPerS);
    // The accel/settle grid fits both groups jointly, so neither scale lands exactly on 1 or 1.4;
    // what the fit is for is that the leg which consistently runs slower gets the larger scale.
    expect(fit.scaleByMode.constant).toBeGreaterThan(fit.scaleByMode.tangent ?? 0);
    expect((fit.scaleByMode.constant ?? 0) / (fit.scaleByMode.tangent ?? 1)).toBeGreaterThan(1.2);
  });

  it("returns a zero-sample result rather than throwing when there is nothing to fit", () => {
    const fit = fitCalibration([], 96);
    expect(fit.sampleCount).toBe(0);
    expect(fit.accelInPerS2).toBe(0);
  });
});
