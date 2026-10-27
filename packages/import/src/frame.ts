import type { Field } from "@horizon36596/zenith-schema";

/**
 * A planner's coordinate frame, described by where it sits on the season's field (the frame of the
 * season's `field.json`, which Zenith calls the field frame: for BIOBUZZ, centre origin, +x to the
 * audience's right, +y away from the audience, inches, heading counter-clockwise from +x).
 *
 * Every direction is named as a direction of the field frame, so a frame that is turned, mirrored or
 * offset against Zenith's can be written down exactly, and a frame written in any planner's own
 * words has one reading.
 */
export interface FrameSpec {
  /** Where the planner's (0, 0) sits, in field-frame inches. */
  originIn: { xIn: number; yIn: number };
  /** The field-frame direction the planner's +x points along. */
  xAxis: AxisDirection;
  /** The field-frame direction the planner's +y points along. */
  yAxis: AxisDirection;
  /** The length unit of the planner's positions. */
  units: LengthUnit;
  /** The unit of the planner's headings. */
  headingUnit: "rad" | "deg";
  /** The planner axis a heading of zero points along. */
  headingZero: "+x" | "+y";
  /** Which way a positive heading turns, seen from above in the planner's own axes. */
  headingPositive: "ccw" | "cw";
}

export const AXIS_DIRECTIONS = ["+x", "-x", "+y", "-y"] as const;
export type AxisDirection = (typeof AXIS_DIRECTIONS)[number];

export const LENGTH_UNITS = ["in", "mm", "cm", "m"] as const;
export type LengthUnit = (typeof LENGTH_UNITS)[number];

/** Inches per unit. An inch is exactly 25.4 mm by definition. */
export const INCHES_PER_UNIT: Record<LengthUnit, number> = {
  in: 1,
  mm: 1 / 25.4,
  cm: 1 / 2.54,
  m: 1 / 0.0254,
};

export const FRAME_PRESETS = ["zenith", "pedro", "roadrunner"] as const;
export type FramePreset = (typeof FRAME_PRESETS)[number];

/**
 * The Pedro Pathing Visualizer's field centre in its own coordinates, in inches: half its
 * `FIELD_SIZE` of 141.5 in, the axis its own "Mirror Horizontally" export mirrors about
 * (ADR 0008 section 2).
 */
export const PEDRO_VISUALIZER_CENTRE_IN = 141.5 / 2;

/**
 * The seasons each preset's placement was checked against. A preset used with another season still
 * converts, with a warning, because the check rests on where that season's field image and Red Wall
 * sit (ADR 0008 sections 2 and 4).
 */
export const PRESET_VERIFIED_SEASONS: Record<FramePreset, readonly string[] | "any"> = {
  zenith: "any",
  pedro: ["biobuzz"],
  roadrunner: ["biobuzz"],
};

/**
 * The three named frames (ADR 0008).
 *
 * - `zenith`: the field frame itself, inches and radians.
 * - `pedro`: the Pedro Visualizer's frame: corner origin, the same axes as the field frame for
 *   BIOBUZZ, inches, degrees counter-clockwise from +x.
 * - `roadrunner`: MeepMeep's frame, which for BIOBUZZ is the FTC Field Coordinate System: centre
 *   origin, +x toward the audience (field -y), +y away from the Red Wall (field +x), inches, radians.
 */
export function presetFrame(preset: FramePreset, pedroCentreIn: number = PEDRO_VISUALIZER_CENTRE_IN): FrameSpec {
  switch (preset) {
    case "zenith":
      return {
        originIn: { xIn: 0, yIn: 0 },
        xAxis: "+x",
        yAxis: "+y",
        units: "in",
        headingUnit: "rad",
        headingZero: "+x",
        headingPositive: "ccw",
      };
    case "pedro":
      return {
        originIn: { xIn: -pedroCentreIn, yIn: -pedroCentreIn },
        xAxis: "+x",
        yAxis: "+y",
        units: "in",
        headingUnit: "deg",
        headingZero: "+x",
        headingPositive: "ccw",
      };
    case "roadrunner":
      return {
        originIn: { xIn: 0, yIn: 0 },
        xAxis: "-y",
        yAxis: "+x",
        units: "in",
        headingUnit: "rad",
        headingZero: "+x",
        headingPositive: "ccw",
      };
  }
}

/** A warning when `preset` was not checked against this season's field, else null. */
export function presetSeasonWarning(preset: FramePreset, field: Field): string | null {
  const verified = PRESET_VERIFIED_SEASONS[preset];
  if (verified === "any" || verified.includes(field.season)) return null;
  return `The ${preset} frame preset was checked against ${verified.join(", ")} only; on ${field.season} its placement may be turned. Declare the frame explicitly if the imported path looks rotated.`;
}

const UNIT_VECTOR: Record<AxisDirection, { x: number; y: number }> = {
  "+x": { x: 1, y: 0 },
  "-x": { x: -1, y: 0 },
  "+y": { x: 0, y: 1 },
  "-y": { x: 0, y: -1 },
};

/** Null when the two axes are perpendicular, else a sentence saying why the frame is unusable. */
export function frameProblem(frame: FrameSpec): string | null {
  const ex = UNIT_VECTOR[frame.xAxis];
  const ey = UNIT_VECTOR[frame.yAxis];
  if (ex.x * ey.x + ex.y * ey.y !== 0) {
    return `frame.xAxis (${frame.xAxis}) and frame.yAxis (${frame.yAxis}) must point along different field axes.`;
  }
  return null;
}

/** A planner point in field-frame inches. */
export function pointToField(frame: FrameSpec, x: number, y: number): { xIn: number; yIn: number } {
  const k = INCHES_PER_UNIT[frame.units];
  const ex = UNIT_VECTOR[frame.xAxis];
  const ey = UNIT_VECTOR[frame.yAxis];
  return {
    xIn: frame.originIn.xIn + k * (x * ex.x + y * ey.x),
    yIn: frame.originIn.yIn + k * (x * ex.y + y * ey.y),
  };
}

/** A planner heading as a field-frame heading in radians, wrapped to (-pi, pi]. */
export function headingToField(frame: FrameSpec, heading: number): number {
  const rad = frame.headingUnit === "deg" ? (heading * Math.PI) / 180 : heading;
  const zero = frame.headingZero === "+x" ? 0 : Math.PI / 2;
  const planner = zero + (frame.headingPositive === "ccw" ? rad : -rad);
  // The direction in the planner's axes, carried into the field frame by the same axis map as a
  // point, so a mirrored (left-handed) frame turns the right way too.
  const ex = UNIT_VECTOR[frame.xAxis];
  const ey = UNIT_VECTOR[frame.yAxis];
  const c = Math.cos(planner);
  const s = Math.sin(planner);
  return wrap(Math.atan2(c * ex.y + s * ey.y, c * ex.x + s * ey.x));
}

/**
 * A turn written in the planner's heading unit and direction (the difference between two headings,
 * or an offset added to one), as a field-frame turn in radians. It is not wrapped: a turn of 270
 * degrees stays 3 pi / 2, so a linear heading that turns the long way keeps doing so.
 *
 * A turn flips sign when the planner counts headings clockwise, and flips again when the planner's
 * axes are mirrored against the field frame (a left-handed frame), since a counter-clockwise turn
 * in such a frame is a clockwise one on the field.
 */
export function turnToField(frame: FrameSpec, turn: number): number {
  const rad = frame.headingUnit === "deg" ? (turn * Math.PI) / 180 : turn;
  const ex = UNIT_VECTOR[frame.xAxis];
  const ey = UNIT_VECTOR[frame.yAxis];
  const handedness = ex.x * ey.y - ex.y * ey.x;
  const direction = frame.headingPositive === "ccw" ? 1 : -1;
  return rad * direction * handedness;
}

/** A planner pose in the field frame. */
export function poseToField(
  frame: FrameSpec,
  x: number,
  y: number,
  heading: number,
): { xIn: number; yIn: number; headingRad: number } {
  return { ...pointToField(frame, x, y), headingRad: headingToField(frame, heading) };
}

/** Wraps an angle to (-pi, pi]. */
export function wrap(rad: number): number {
  let a = rad % (2 * Math.PI);
  if (a <= -Math.PI) a += 2 * Math.PI;
  if (a > Math.PI) a -= 2 * Math.PI;
  return a;
}
