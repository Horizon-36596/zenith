/**
 * The heading modes as the editor names them: Pedro Pathing's own names for its heading
 * interpolation, checked against the Pedro v3 source the robot runtime compiles against
 * (site/docs/paths-explained.md, "Heading modes"). The plain explanation and the exact Pedro call go in the
 * tooltip; the value is what the file says, which does not change.
 */
import type { Heading } from "@horizon36596/zenith-schema";

export type HeadingMode = Heading["mode"];

export interface HeadingModeInfo {
  value: HeadingMode;
  /** Pedro's method name, as words. */
  label: string;
  /** What the robot does, in plain words, for the tooltip. */
  explain: string;
  /** The call the runtime makes on a Pedro `Path`. */
  pedro: string;
}

export const HEADING_MODES: readonly HeadingModeInfo[] = [
  { value: "tangent", label: "Tangent", explain: "Face the way it drives.", pedro: "path.tangent()" },
  {
    value: "tangentReversed",
    label: "Reverse tangent",
    explain: "Face backwards: the back of the robot leads.",
    pedro: "path.reverseTangent()",
  },
  { value: "constant", label: "Constant", explain: "Hold one angle the whole way.", pedro: "path.constant(heading)" },
  { value: "linear", label: "Linear", explain: "Turn between two angles.", pedro: "path.linear(start, end)" },
  {
    value: "facePoint",
    label: "Facing point",
    explain: "Keep facing a point on the field.",
    pedro: "path.facingPoint(point)",
  },
  {
    value: "piecewise",
    label: "Piecewise",
    explain: "Use a different mode on each stretch of the path.",
    pedro: "Interpolator.piecewise().until(t, ...)",
  },
];

/** The modes a piecewise range may hold: every mode but piecewise itself. */
export const RANGE_HEADING_MODES: readonly HeadingModeInfo[] = HEADING_MODES.filter(
  (info) => info.value !== "piecewise",
);

export function headingModeInfo(mode: HeadingMode): HeadingModeInfo {
  return HEADING_MODES.find((info) => info.value === mode) ?? (HEADING_MODES[0] as HeadingModeInfo);
}

/** The tooltip line for a mode: the explanation, then the Pedro call. */
export const headingModeHint = (info: HeadingModeInfo): string => `${info.explain} Pedro: ${info.pedro}.`;
