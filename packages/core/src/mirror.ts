import {
  childLists,
  withChildLists,
  type Auto,
  type Expect,
  type Field,
  type Pose,
  type PoseSource,
  type Segment,
  type Step,
} from "@horizon36596/zenith-schema";
import { wrapAngle } from "./geometry/angle.js";
import type { Vec2 } from "./geometry/vec.js";

/**
 * Mirroring a routine to the other alliance, the way `field.json` declares the field is symmetric
 * (`alliances.mirror`). BIOBUZZ, like most FTC games, is point symmetric about the field centre.
 *
 * Every mode is its own inverse: mirroring twice gives the document back, which is the property the
 * editor's "flip alliance" button rests on and what `05` section 6 asks to be tested.
 *
 * A pose that lives in `waypoints.json` is left as the reference it is: the mirrored routine wants
 * the other alliance's waypoint of the same name, not a moved copy of this one.
 */
export type MirrorMode = "pointSymmetry" | "mirrorX" | "mirrorY" | "none";

/**
 * The symmetry this field declares between the two alliances. `field.json` is the only place that
 * says it, and every renderer asks here rather than assuming point symmetry.
 */
export const mirrorForField = (field: Field): MirrorMode => field.frame.mirror;

/**
 * Whether a routine has to be mirrored to be drawn for `viewAlliance`.
 *
 * Poses in a file are in the field's canonical frame (site/docs/file-format.md), not in the
 * routine's own alliance's frame: an auto written `"alliance": "BLUE"` still carries canonical
 * coordinates. So the question is whether the alliance being *viewed* is the canonical one, and the
 * routine's own alliance only supplies the default view. Keying this on the routine's alliance
 * instead drew the same file two different ways in the SVG and on the canvas.
 *
 * `viewAlliance` is what a caller is asking to see; omit it to mean the routine's own alliance.
 */
export function shouldMirror(
  auto: Auto,
  field: Field,
  viewAlliance?: Auto["alliance"],
): boolean {
  if (mirrorForField(field) === "none") return false;
  return (viewAlliance ?? auto.alliance) !== field.frame.canonicalAlliance;
}

/** `mirrorX` reflects across the x axis, so y changes sign; `mirrorY` reflects across the y axis. */
export function mirrorVec(point: Vec2, mode: MirrorMode): Vec2 {
  switch (mode) {
    case "pointSymmetry":
      return { xIn: -point.xIn, yIn: -point.yIn };
    case "mirrorX":
      return { xIn: point.xIn, yIn: -point.yIn };
    case "mirrorY":
      return { xIn: -point.xIn, yIn: point.yIn };
    default:
      return { xIn: point.xIn, yIn: point.yIn };
  }
}

/**
 * How far past the (-pi, pi] boundary a heading may sit and still be read as the half turn it is.
 *
 * Canonical form rounds radians to four decimals, so a half turn is written 3.1416 or -3.1416, both
 * a hair outside the interval. Wrapping one of those to the other side is what stopped mirroring
 * twice from giving the document back: the pose was right and the bytes were not. Half of the last
 * canonical digit is far more than the 7.4e-6 involved and far less than anything a heading means.
 */
const HALF_TURN_TOLERANCE_RAD = 5e-5;

const inCanonicalRange = (rad: number): boolean =>
  rad > -Math.PI - HALF_TURN_TOLERANCE_RAD && rad <= Math.PI + HALF_TURN_TOLERANCE_RAD;

/**
 * A half turn from `rad`: the same angle either way round, so the one that stays inside the
 * canonical range is chosen, and `preferNegative` decides when both do.
 *
 * Both do exactly when `rad` is a hair either side of zero, whose two half-turn partners are the
 * two spellings of a half turn, +3.1416 and -3.1416. Which one to write back is the whole question
 * this function exists to answer: picking by the side of zero the caller came from is what makes
 * mirroring its own inverse there, rather than turning every half turn positive.
 */
function halfTurn(rad: number, preferNegative: boolean): number {
  const up = rad + Math.PI;
  const down = rad - Math.PI;
  const upFits = inCanonicalRange(up);
  const downFits = inCanonicalRange(down);
  if (upFits && downFits) return preferNegative ? down : up;
  if (upFits) return up;
  if (downFits) return down;
  // A heading written far outside the canonical range; there is no spelling to preserve.
  return wrapAngle(up);
}

/** Negation without producing -0, which canonical form would write as 0 anyway. */
const negate = (rad: number): number => (rad === 0 ? 0 : -rad);

/**
 * The mirrored heading, and its own inverse: mirroring twice gives back the exact number the file
 * carried, for every heading canonical form can write, half turns included.
 *
 * The one value that cannot round-trip is a heading at exactly +/-pi in full double precision, which
 * is the same pose either way and which four-decimal canonical form never writes.
 */
export function mirrorHeadingRad(headingRad: number, mode: MirrorMode): number {
  switch (mode) {
    case "pointSymmetry":
      return halfTurn(headingRad, headingRad < 0);
    case "mirrorX":
      // Reflecting across the x axis is exact negation, which is its own inverse for every value,
      // boundary included. Wrapping the result is what broke that at -pi.
      return negate(headingRad);
    case "mirrorY":
      // Reflecting across the y axis is pi - h, which is the negation taken a half turn round.
      return halfTurn(negate(headingRad), headingRad > 0);
    default:
      // "none": the field declares no symmetry, so the heading is the heading.
      return headingRad;
  }
}

/** The mirrored pose, keeping the provenance: the number came from the same place either way. */
export function mirrorPose(pose: Pose, mode: MirrorMode): Pose {
  const point = mirrorVec(pose, mode);
  return {
    ...pose,
    xIn: point.xIn,
    yIn: point.yIn,
    ...(pose.headingRad === undefined ? {} : { headingRad: mirrorHeadingRad(pose.headingRad, mode) }),
  };
}

const mirrorSource = (source: PoseSource, mode: MirrorMode): PoseSource =>
  source === "current" || "ref" in source ? source : mirrorPose(source, mode);

const mirrorSegment = (segment: Segment, mode: MirrorMode): Segment =>
  segment.kind === "bezier"
    ? {
        ...segment,
        from: mirrorSource(segment.from, mode),
        control: segment.control.map((point) => mirrorPose(point, mode)),
        to: mirrorSource(segment.to, mode),
      }
    : { ...segment, from: mirrorSource(segment.from, mode), to: mirrorSource(segment.to, mode) };

/**
 * The other alliance's name for a field id, from the season's `mirrorId` hook.
 *
 * Mirroring is refused rather than guessed: an id with no counterpart would leave a BLUE routine
 * expecting to launch into the RED hive, and LEGAL_APPROACH, TURRET_RANGE and the ledger would all
 * then be about the wrong side of the field.
 */
function mirrorExpect(step: { expect?: Expect }, mirrorId: MirrorIds | undefined): Expect | undefined {
  const expected = step.expect;
  if (expected === undefined || mirrorId === undefined) return expected;
  const other = (id: string | undefined): string | undefined => {
    if (id === undefined) return undefined;
    const mapped = mirrorId(id);
    if (mapped === null) {
      throw new Error(
        `This routine cannot be mirrored: ${JSON.stringify(id)} has no counterpart on the other alliance.`,
      );
    }
    return mapped;
  };
  return {
    ...expected,
    ...(expected.collectFrom === undefined ? {} : { collectFrom: other(expected.collectFrom) }),
    ...(expected.launchesInto === undefined ? {} : { launchesInto: other(expected.launchesInto) }),
  };
}

function mirrorStep(step: Step, mode: MirrorMode, mirrorId: MirrorIds | undefined): Step {
  switch (step.kind) {
    case "path": {
      // Markers are placed by t or by distance along the path, so they mirror with it untouched.
      const heading = step.heading;
      const expected = mirrorExpect(step, mirrorId);
      return {
        ...step,
        segments: step.segments.map((segment) => mirrorSegment(segment, mode)),
        ...(heading === undefined ? {} : { heading: mirrorHeading(heading, mode) }),
        ...(expected === undefined ? {} : { expect: expected }),
      };
    }
    case "command": {
      const expected = mirrorExpect(step, mirrorId);
      return expected === undefined ? step : { ...step, expect: expected };
    }
    case "sequence":
    case "parallel":
    case "branch":
      return withChildLists(
        step,
        childLists(step).map((list) => list.map((child) => mirrorStep(child, mode, mirrorId))),
      );
    default:
      return step;
  }
}

type Heading = NonNullable<Extract<Step, { kind: "path" }>["heading"]>;

/**
 * +1 when a mirror keeps the way a turn goes, -1 when it reverses it. A point symmetry is a half
 * turn of the whole field, so a counter-clockwise turn stays counter-clockwise; a reflection makes
 * it clockwise.
 */
export function mirrorTurnSign(mode: MirrorMode): 1 | -1 {
  return mode === "mirrorX" || mode === "mirrorY" ? -1 : 1;
}

const TWO_PI = Math.PI * 2;

/**
 * The mirrored end of a `linear` sweep. The sweep `toRad - fromRad` is what the robot shares out
 * between segments (`linearHeadingPieces`), so it has to survive the mirror with its size and with
 * its direction turned by `mirrorTurnSign`. Mirroring each end on its own keeps both in the
 * canonical range, which moves the sweep by a whole turn whenever the two ends wrap differently:
 * a 270 degree sweep split over two segments then turned 90 degrees the other way on the other
 * alliance. So the end is the mirrored heading moved by whole turns until the sweep is right, which
 * leaves it untouched, and the file unchanged, whenever the two already agree.
 */
function mirrorSweepEnd(heading: Extract<Heading, { mode: "linear" }>, fromRad: number, mode: MirrorMode): number {
  const toRad = mirrorHeadingRad(heading.toRad, mode);
  const sweep = mirrorTurnSign(mode) * (heading.toRad - heading.fromRad);
  const turns = Math.round((sweep - (toRad - fromRad)) / TWO_PI);
  return turns === 0 ? toRad : toRad + turns * TWO_PI;
}

function mirrorHeading(heading: Heading, mode: MirrorMode): Heading {
  switch (heading.mode) {
    case "constant":
      return { ...heading, headingRad: mirrorHeadingRad(heading.headingRad, mode) };
    case "linear": {
      const fromRad = mirrorHeadingRad(heading.fromRad, mode);
      return { ...heading, fromRad, toRad: mirrorSweepEnd(heading, fromRad, mode) };
    }
    case "facePoint": {
      const point = mirrorVec({ xIn: heading.xIn, yIn: heading.yIn }, mode);
      // The offset is measured from the line to the point, so it survives the mirror unchanged
      // under point symmetry and changes sign under a reflection.
      return {
        ...heading,
        xIn: point.xIn,
        yIn: point.yIn,
        ...(heading.offsetRad === undefined || mode === "pointSymmetry" || mode === "none"
          ? {}
          : { offsetRad: -heading.offsetRad }),
      };
    }
    case "piecewise":
      // The ranges are fractions of the path, which the mirror keeps; only their headings move.
      return {
        ...heading,
        ranges: heading.ranges.map((range) => ({
          ...range,
          heading: mirrorHeading(range.heading, mode) as typeof range.heading,
        })),
      };
    default:
      // `tangent` and `tangentReversed` follow the mirrored path on their own.
      return heading;
  }
}

/** The other alliance's name for a field id; `null` when there is none. */
export type MirrorIds = (id: string) => string | null;

/**
 * The same routine for the other alliance: every pose mirrored, the alliance flipped, waypoint
 * references left alone. Mirroring twice gives the document back, byte for byte.
 *
 * `mirrorId` is the season's `SeasonRules.mirrorId` hook, and a caller that is going to write the
 * result out has to pass it: a step's `expect.collectFrom` and `expect.launchesInto` name field
 * elements by id, and `hiveRedUpCell` means the RED hive whichever alliance the file claims. Left
 * out, those ids are carried across unchanged, which is only safe for a preview that never reads
 * them back — the editor's "mirror to the other alliance" is a view toggle and does exactly that.
 */
export function mirrorAuto(
  auto: Auto,
  mode: MirrorMode = "pointSymmetry",
  mirrorId?: MirrorIds,
): Auto {
  const startPose = auto.start.pose;
  return {
    ...auto,
    alliance: auto.alliance === "RED" ? "BLUE" : "RED",
    start: {
      ...auto.start,
      pose: "ref" in startPose ? startPose : mirrorPose(startPose, mode),
    },
    steps: auto.steps.map((step) => mirrorStep(step, mode, mirrorId)),
  };
}
