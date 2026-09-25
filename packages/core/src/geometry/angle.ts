const TWO_PI = Math.PI * 2;

/**
 * Wraps a heading to (-pi, pi]. That interval is the one site/docs/paths-explained.md names, so -pi
 * comes back as +pi and the result is never -0.
 */
export function wrapAngle(rad: number): number {
  let wrapped = rad % TWO_PI;
  if (wrapped <= -Math.PI) wrapped += TWO_PI;
  else if (wrapped > Math.PI) wrapped -= TWO_PI;
  return wrapped === 0 ? 0 : wrapped;
}

/** The signed short-way difference from one heading to another, in (-pi, pi]. */
export const angleDelta = (fromRad: number, toRad: number): number => wrapAngle(toRad - fromRad);

/** Interpolates the short way round, so a turn from 170 deg to -170 deg is 20 deg, not 340. */
export const lerpAngle = (fromRad: number, toRad: number, t: number): number =>
  wrapAngle(fromRad + angleDelta(fromRad, toRad) * t);

/** Degrees are a user-interface unit only; files and core are radians (CLAUDE.md rule 3). */
export const degToRad = (deg: number): number => (deg * Math.PI) / 180;

export const radToDeg = (rad: number): number => (rad * 180) / Math.PI;
