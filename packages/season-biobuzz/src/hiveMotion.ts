import type { BoxObstacle, Field } from "@horizon36596/zenith-schema";
import {
  cellArea,
  isNectar,
  nectarIn,
  oppositeSide,
  total,
  type AreaState,
  type BiobuzzState,
  type HiveState,
  type Holds,
} from "./state.js";

/**
 * What a drawing of the hive needs that the ledger does not keep: how long a tip swings, what fell
 * out of the cell and where it landed. The ledger flips a hive over in one instant, at the end of
 * the step that tipped it; the field draws the swing that follows from these, on the playback
 * clock, so a scrub always shows the same frame for the same time.
 *
 * Everything here is pure: no clock and no randomness. Where DSim scatters a spill with its random
 * stream, this spreads it on a fixed low-discrepancy sequence instead.
 */

/**
 * How long a tip swings from one stable state to the other, in seconds, at the tip table's
 * threshold. DSim's ruling (`hive.ts`, `BB_TIP_SWING_S`): a long bar carrying a dozen pieces is a
 * slow, damped see-saw, not a trigger.
 */
export const HIVE_TIP_SWING_S = 4;

/**
 * A load over its threshold swings faster: the rate rises by this much per extra piece, up to
 * `HIVE_TIP_RATE_MAX` times the base rate (DSim `hiveSwingRate`; both APPROX there, a feel ruling).
 */
export const HIVE_TIP_RATE_PER_EXTRA = 0.35;
export const HIVE_TIP_RATE_MAX = 3;

/**
 * How far the bar is tilted at rest, in radians: 30 degrees either way (DSim `BB_HIVE_TILT_DEG`).
 * The swing runs from +30 to -30 degrees and the cell empties as the bar passes level.
 */
export const HIVE_REST_TILT_RAD = Math.PI / 6;

/** One tip of one hive, as the ledger made it in one step. */
export interface HiveTip {
  hiveId: string;
  /** The side whose cell was up and swings down, emptying as it goes. */
  fromSide: string;
  /** The side whose cell comes up. */
  toSide: string;
  /** What fell out of the cell, by kind. */
  dumped: Holds;
  /** The floor quarter the dump landed in, or null when it landed loose. */
  areaId: string | null;
  /** How long the swing takes, in seconds (`tipSwingS`). */
  swingS: number;
}

/**
 * How many pieces a cell's load is over what the tip table asks, 0 at or under it. Past the table's
 * last row the threshold is already no pollen at all, so an extra nectar there counts as surplus in
 * its own right (DSim `hiveSurplus`).
 */
export function tipSurplus(state: BiobuzzState, load: Readonly<Holds>): number {
  if (state.tipTable.length === 0) return 0;
  const nectar = nectarIn(state, load);
  const pollen = total(load) - nectar;
  const row = Math.min(nectar, state.tipTable.length - 1);
  const threshold = state.tipTable[row] ?? 0;
  return Math.max(0, pollen - threshold + (nectar - row));
}

/** How long a cell holding `load` takes to swing over, in seconds: the base swing at its rate. */
export function tipSwingS(state: BiobuzzState, load: Readonly<Holds>): number {
  const rate = Math.min(HIVE_TIP_RATE_MAX, 1 + HIVE_TIP_RATE_PER_EXTRA * tipSurplus(state, load));
  return HIVE_TIP_SWING_S / rate;
}

/** What a by-kind count gained from `before` to `after`, leaving out every kind that did not grow. */
function gained(before: Readonly<Holds>, after: Readonly<Holds>): Holds {
  const out: Holds = {};
  for (const [kind, count] of Object.entries(after)) {
    const grew = count - (before[kind] ?? 0);
    if (grew > 0) out[kind] = grew;
  }
  return out;
}

/**
 * The tips one ledger step made: every hive whose tip count went up between the two states. What
 * fell out is what the floor quarter under the emptying cell gained in the step (or the loose
 * pieces, when that cell is over no quarter), which is the cell's load at the moment it tipped,
 * including any piece the same step put in. A tip an author asserted after the table had already
 * predicted it does not count again: the ledger confirms that one without swinging the hive.
 */
export function hiveTipsBetween(before: BiobuzzState, after: BiobuzzState): HiveTip[] {
  const tips: HiveTip[] = [];
  for (const hive of Object.values(after.hives)) {
    const was = before.hives[hive.id];
    if (was === undefined || hive.tips <= was.tips) continue;
    const area = cellArea(before, was, true);
    const dumped =
      area === null
        ? gained(before.loose, after.loose)
        : gained(before.floor[area.id]?.holds ?? {}, after.floor[area.id]?.holds ?? {});
    // An odd number of tips in one step leaves the other side up; an even number, the same side.
    const toSide = (hive.tips - was.tips) % 2 === 1 ? oppositeSide(was.upSide) : was.upSide;
    tips.push({
      hiveId: hive.id,
      fromSide: was.upSide,
      toSide,
      dumped,
      areaId: area?.id ?? null,
      swingS: tipSwingS(before, dumped),
    });
  }
  return tips;
}

/** The hive's frame in plan: the box the cells swing inside, from the obstacle `field.json` draws for it. */
export interface HiveBody {
  minXIn: number;
  maxXIn: number;
  minYIn: number;
  maxYIn: number;
}

/**
 * The box each hive swings inside, by hive id: the obstacle whose id starts with the hive's, the
 * way `field.json` pairs `hiveRed` with `hiveRedPivotBar`. A hive with no such obstacle gets a
 * square box reaching its outer faces, so it is still drawn.
 */
export function hiveBodies(field: Field, state: BiobuzzState): Record<string, HiveBody> {
  const bodies: Record<string, HiveBody> = {};
  for (const hive of Object.values(state.hives)) {
    const box = (field.obstacles ?? []).find(
      (obstacle): obstacle is BoxObstacle => obstacle.kind === "box" && obstacle.id.startsWith(hive.id),
    );
    bodies[hive.id] =
      box === undefined
        ? {
            minXIn: hive.pivotIn.xIn - hive.outerFaceIn,
            maxXIn: hive.pivotIn.xIn + hive.outerFaceIn,
            minYIn: hive.pivotIn.yIn - hive.outerFaceIn,
            maxYIn: hive.pivotIn.yIn + hive.outerFaceIn,
          }
        : { minXIn: box.minXIn, maxXIn: box.maxXIn, minYIn: box.minYIn, maxYIn: box.maxYIn };
  }
  return bodies;
}

/**
 * The spill's spread, after DSim `spillPoses`: the pieces leave the open end of the emptying cell
 * within a fan this wide either side of straight outboard (DSim `BB_SPILL_FAN`, 40 degrees), and
 * come to rest between these distances past the cell's outer face. DSim throws them at 30 to 62 in/s
 * from the cell and lets them roll, which settles them roughly 28 to 54 in from the pivot; these
 * two distances are that, measured from the outer face instead. APPROX, as DSim's figures are.
 */
const SPILL_FAN_RAD = (40 * Math.PI) / 180;
const SPILL_NEAR_IN = 10;
const SPILL_FAR_IN = 34;

/** The fractional part of a number, for the low-discrepancy sequence below. */
const fraction = (value: number): number => value - Math.floor(value);

/**
 * Where `count` dumped pieces come to rest, in field inches, in the order they fell: past the open
 * outer end of the cell that was up on `fromSide`, fanned out across the throw, and kept inside the
 * floor quarter the ledger put them in (`area`) by a piece's radius, so a drawn piece is never
 * across a line the ledger counts it on the other side of. The spread is a fixed sequence (the
 * plastic-number pair), so the same tip always lands the same way.
 */
export function spillPoints(
  hive: HiveState,
  fromSide: string,
  count: number,
  area: AreaState | null,
  marginIn = 1.4,
): Array<{ xIn: number; yIn: number }> {
  const sign = fromSide === "SOUTH" || fromSide === "WEST" ? -1 : 1;
  const points: Array<{ xIn: number; yIn: number }> = [];
  for (let index = 0; index < count; index += 1) {
    const across = fraction(0.5 + (index + 1) * 0.7548776662);
    const out = fraction(0.5 + (index + 1) * 0.5698402910);
    const angle = (2 * across - 1) * SPILL_FAN_RAD;
    const distance = SPILL_NEAR_IN + (SPILL_FAR_IN - SPILL_NEAR_IN) * out;
    const alongIn = sign * (hive.outerFaceIn + distance * Math.cos(angle));
    const acrossIn = distance * Math.sin(angle);
    let xIn = hive.axis === "x" ? hive.pivotIn.xIn + alongIn : hive.pivotIn.xIn + acrossIn;
    let yIn = hive.axis === "x" ? hive.pivotIn.yIn + acrossIn : hive.pivotIn.yIn + alongIn;
    if (area !== null) {
      xIn = Math.min(area.maxXIn - marginIn, Math.max(area.minXIn + marginIn, xIn));
      yIn = Math.min(area.maxYIn - marginIn, Math.max(area.minYIn + marginIn, yIn));
    }
    points.push({ xIn, yIn });
  }
  return points;
}

/**
 * A cell's pieces as a row, in the order they went in: the staged nectar first, then the rest by
 * kind, pollen before the other kinds. The ledger keeps a cell as a count, not an order, and nectar
 * is staged before any pollen arrives, so this is the order a drawing can trust.
 */
export function cellRow(state: BiobuzzState, holds: Readonly<Holds>): string[] {
  const kinds = Object.keys(holds).sort((a, b) => {
    const rank = (kind: string): number => (isNectar(state, kind) ? 0 : kind === state.elementKind ? 1 : 2);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  return kinds.flatMap((kind) => Array.from({ length: Math.max(0, holds[kind] ?? 0) }, () => kind));
}

/** The BIOBUZZ state inside an opaque season state, or null when it is some other season's. */
export function asBiobuzzState(state: unknown): BiobuzzState | null {
  if (typeof state !== "object" || state === null) return null;
  const hives = (state as Record<string, unknown>)["hives"];
  const floor = (state as Record<string, unknown>)["floor"];
  return typeof hives === "object" && hives !== null && typeof floor === "object" && floor !== null
    ? (state as BiobuzzState)
    : null;
}
