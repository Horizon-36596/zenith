/**
 * `zenith calibrate`'s fit (site/docs/simulation.md): pairs a trace's
 * recorded step durations against the plan's geometry and fits the free parameters of the time
 * model - `accel`, `settleS`, and a per
 * heading-mode scale. Pure: no clock, no randomness, so the same samples always fit the same
 * numbers and a test can assert on them exactly.
 *
 * The fit is deliberately simple rather than the full two-pass velocity profile `core.estimate`
 * will run once M1 lands: a symmetric trapezoidal accelerate/cruise/decelerate model against a
 * fixed cruise speed (the robot's own measured `maxForwardVelInPerS`), searched on a coarse grid
 * over `accel` and `settleS` (the spec allows "simple grid or closed form"). The per-mode scale
 * then absorbs whatever the trapezoid model does not capture for a `constant` or `linear` heading
 * leg, which behaves more like a strafe. The residual band is what is left after both corrections,
 * reported as the fraction the estimate should still expect to be wrong by.
 */
export interface CalibrationSample {
  stepId: string;
  /** The path step's heading mode, or "none" for a step this fit does not otherwise use. */
  headingMode: string;
  lengthIn: number;
  actualS: number;
}

export type ModeScale = Record<string, number>;

export interface CalibrationResult {
  accelInPerS2: number;
  settleS: number;
  scaleByMode: ModeScale;
  /** The residual band as fractions of the actual duration, e.g. -0.12 to 0.15. Zero when there are
   * no samples to measure a residual from. */
  residualLowFraction: number;
  residualHighFraction: number;
  sampleCount: number;
}

const ACCEL_GRID = { minInPerS2: 10, maxInPerS2: 220, stepInPerS2: 5 };
const SETTLE_GRID = { minS: 0, maxS: 1, stepS: 0.05 };

/** A symmetric trapezoid: accelerate to `cruiseInPerS` (or to a lower peak on a short leg), cruise,
 * decelerate at the same rate, then add the settle time. */
export function predictTravelS(lengthIn: number, cruiseInPerS: number, accelInPerS2: number, settleS: number): number {
  if (lengthIn <= 0 || cruiseInPerS <= 0 || accelInPerS2 <= 0) return settleS;
  const accelDistanceIn = (cruiseInPerS * cruiseInPerS) / (2 * accelInPerS2);
  if (2 * accelDistanceIn <= lengthIn) {
    const cruiseS = (lengthIn - 2 * accelDistanceIn) / cruiseInPerS;
    return 2 * (cruiseInPerS / accelInPerS2) + cruiseS + settleS;
  }
  const peakInPerS = Math.sqrt(accelInPerS2 * lengthIn);
  return (2 * peakInPerS) / accelInPerS2 + settleS;
}

function sumSquaredError(samples: readonly CalibrationSample[], cruiseInPerS: number, accelInPerS2: number, settleS: number): number {
  let error = 0;
  for (const sample of samples) {
    const predicted = predictTravelS(sample.lengthIn, cruiseInPerS, accelInPerS2, settleS);
    const residual = predicted - sample.actualS;
    error += residual * residual;
  }
  return error;
}

export function fitCalibration(samples: readonly CalibrationSample[], maxForwardVelInPerS: number): CalibrationResult {
  const usable = samples.filter((sample) => sample.lengthIn > 0 && sample.actualS > 0);
  if (usable.length === 0) {
    return { accelInPerS2: 0, settleS: 0, scaleByMode: {}, residualLowFraction: 0, residualHighFraction: 0, sampleCount: 0 };
  }

  let bestAccel = ACCEL_GRID.minInPerS2;
  let bestSettle = SETTLE_GRID.minS;
  let bestError = Number.POSITIVE_INFINITY;
  for (let accel = ACCEL_GRID.minInPerS2; accel <= ACCEL_GRID.maxInPerS2; accel += ACCEL_GRID.stepInPerS2) {
    for (let settle = SETTLE_GRID.minS; settle <= SETTLE_GRID.maxS; settle += SETTLE_GRID.stepS) {
      const error = sumSquaredError(usable, maxForwardVelInPerS, accel, settle);
      if (error < bestError) {
        bestError = error;
        bestAccel = accel;
        bestSettle = settle;
      }
    }
  }

  const ratiosByMode = new Map<string, number[]>();
  for (const sample of usable) {
    const predicted = predictTravelS(sample.lengthIn, maxForwardVelInPerS, bestAccel, bestSettle);
    const ratio = predicted === 0 ? 1 : sample.actualS / predicted;
    const list = ratiosByMode.get(sample.headingMode) ?? [];
    list.push(ratio);
    ratiosByMode.set(sample.headingMode, list);
  }
  const scaleByMode: ModeScale = {};
  for (const [mode, ratios] of ratiosByMode) {
    scaleByMode[mode] = ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length;
  }

  const residualFractions = usable.map((sample) => {
    const scale = scaleByMode[sample.headingMode] ?? 1;
    const predicted = predictTravelS(sample.lengthIn, maxForwardVelInPerS, bestAccel, bestSettle) * scale;
    return (predicted - sample.actualS) / sample.actualS;
  });

  return {
    accelInPerS2: bestAccel,
    settleS: bestSettle,
    scaleByMode,
    residualLowFraction: Math.min(0, ...residualFractions),
    residualHighFraction: Math.max(0, ...residualFractions),
    sampleCount: usable.length,
  };
}
