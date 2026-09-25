/**
 * The measure tool (tool id `measure`, key `U`; site/docs/editor.md): click-drag
 * from one field point to another and read the distance and the angle. It is a heads-up overlay only
 * and never edits the document, so it needs no undo entry. `Esc` clears it; a new drag replaces it.
 *
 * The ends snap to a nearby path point or waypoint (a pixel rule, like the waypoint snap) when
 * snapping is on, Ctrl inverting it as for any drag, and Shift turns the angle in 45 degree steps
 * about the start, the way Shift constrains every other drag.
 *
 * Pure arithmetic.
 */
import { radToDeg, type Vec2 } from "@horizon36596/zenith-core";
import { HEADING_COARSE_DEG } from "./snap.js";

/** How close, in screen pixels, an end must come to a point to land on it. */
export const MEASURE_SNAP_PX = 8;

export interface Measurement {
  fromIn: Vec2;
  toIn: Vec2;
}

export interface MeasureReadout {
  distanceIn: number;
  dxIn: number;
  dyIn: number;
  /** Field-frame bearing from the start to the end, counter-clockwise from +X, in (-180, 180]. */
  angleDeg: number;
}

export function measure(measurement: Measurement): MeasureReadout {
  const dxIn = measurement.toIn.xIn - measurement.fromIn.xIn;
  const dyIn = measurement.toIn.yIn - measurement.fromIn.yIn;
  const distanceIn = Math.hypot(dxIn, dyIn);
  const raw = distanceIn < 1e-9 ? 0 : radToDeg(Math.atan2(dyIn, dxIn));
  // atan2 gives [-180, 180]; fold -180 into 180 so a leftward line always reads the same.
  const angleDeg = raw <= -180 + 1e-9 ? 180 : raw;
  return { distanceIn, dxIn, dyIn, angleDeg };
}

/** The label drawn beside the line: "23.40 in · 37.5°". */
export function measureLabel(readout: MeasureReadout): string {
  return `${readout.distanceIn.toFixed(2)} in · ${readout.angleDeg.toFixed(1)}°`;
}

/** The second line: the run along each axis. */
export function measureDeltaLabel(readout: MeasureReadout): string {
  const signed = (value: number): string => `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}`;
  return `Δx ${signed(readout.dxIn)}  Δy ${signed(readout.dyIn)} in`;
}

/** Shift: the end swung to the nearest 45 degree bearing about the start, keeping its distance. */
export function constrainAngle(fromIn: Vec2, toIn: Vec2, stepDeg: number = HEADING_COARSE_DEG): Vec2 {
  const dxIn = toIn.xIn - fromIn.xIn;
  const dyIn = toIn.yIn - fromIn.yIn;
  const distanceIn = Math.hypot(dxIn, dyIn);
  if (distanceIn < 1e-9) return toIn;
  const stepRad = (stepDeg * Math.PI) / 180;
  const bearing = Math.round(Math.atan2(dyIn, dxIn) / stepRad) * stepRad;
  return { xIn: fromIn.xIn + Math.cos(bearing) * distanceIn, yIn: fromIn.yIn + Math.sin(bearing) * distanceIn };
}

/**
 * The nearest candidate within `tolerancePx` of the pointer, measured in screen pixels through
 * `pxPerIn`, or the pointer itself when none is close enough.
 */
export function snapMeasureEnd(
  pointerIn: Vec2,
  candidates: readonly Vec2[],
  pxPerIn: number,
  tolerancePx: number = MEASURE_SNAP_PX,
): { pointIn: Vec2; snapped: boolean } {
  const toleranceIn = tolerancePx / Math.max(pxPerIn, 1e-6);
  let best: Vec2 | null = null;
  let bestIn = toleranceIn;
  for (const candidate of candidates) {
    const distanceIn = Math.hypot(candidate.xIn - pointerIn.xIn, candidate.yIn - pointerIn.yIn);
    if (distanceIn <= bestIn) {
      best = candidate;
      bestIn = distanceIn;
    }
  }
  return best === null ? { pointIn: pointerIn, snapped: false } : { pointIn: best, snapped: true };
}
