import {
  fieldBounds,
  footprintAt,
  noSeasonRules,
  pastLineIn,
  polygonOverlapsBox,
  type Finding,
  type OwnSide,
  type LedgerLocation,
  type LedgerRow,
  type Pose,
  type SeasonRules,
  type SeasonState,
  type TargetId,
  type TransferResult,
  type Vec2,
} from "@horizon36596/zenith-core";
import type { BoxObstacle, Field, Robot } from "@horizon36596/zenith-schema";
import {
  addKinds,
  cellArea,
  cellPoint,
  columnHolds,
  heldTotal,
  holdsWords,
  inArea,
  initialBiobuzzState,
  isOpponentNectar,
  kindOrder,
  nectarIn,
  oppositeSide,
  ownHive,
  popRobot,
  total,
  upCellFace,
  withRobotOrder,
  type BiobuzzState,
  type FlowerState,
  type HiveState,
  type Holds,
} from "./state.js";
import { collectPieces, listLocations, measureQuantity, resolveAllianceWords, transferPieces } from "./locations.js";

/**
 * The BIOBUZZ season plugin: the `SeasonRules` of
 * site/docs/seasons.md, implemented from `field.json` alone.
 *
 * The hive follows the BIOBUZZ Competition Manual V1 and DSim, the team's simulator, which
 * implements it, with the owner's rulings of
 * 2026-10-03 (issue #95) where the two leave a gap:
 *
 * - A cell tips once the pollen in it reaches the tip table's entry for the nectar in it, and past
 *   the table's last row that row holds (DSim `hive.ts`, `hiveWillTip`): 3 pollen with the 3 staged
 *   nectar, 8 in an empty cell, none with 5 nectar.
 * - A tip dumps everything in the cell onto the floor on that cell's own side, the side opposite
 *   the cell that comes up, and the cell that comes up is empty (DSim `hive.ts`, `hiveStep` and
 *   `spillPoses`). The dump lands in that side's floor quarter.
 * - This robot's launch goes into the up cell only from the cell's own quarter of the field, and
 *   only into its own alliance's hive (DSim `play.ts`: a cell takes only its own alliance's
 *   launch). Anything else lands loose.
 * - Nothing takes pieces out of a hive cell but a tip (manual G417; DSim `elements.ts`,
 *   `capturePollen`, takes only pieces on the ground).
 *
 * Nectar is a game piece like pollen (owner ruling 2026-10-03): the
 * robot can intake, carry, launch and drop its own alliance's nectar, and it counts toward the
 * robot's capacity. What sets it apart is the tip table, which reads the nectar in the up cell, a
 * flower's retrieval opening, which does not let it out, and the human player, who brings it in.
 */

/** How close a footprint corner has to be to a wall to count as touching it, in inches. */
export const TOUCHING_WALL_TOLERANCE_IN = 0.5;

/**
 * How far a footprint may sit over the centre line before it is no longer in its own half, at the
 * start (START_ILLEGAL) and all through auto (OPPONENT_SIDE), in inches.
 */
export const OWN_HALF_TOLERANCE_IN = 0.05;

/**
 * G402 and what breaking it costs, the sentence that ends an OPPONENT_SIDE message (BIOBUZZ
 * Competition Manual V1, §11.4.1: "Violation: MAJOR FOUL per MATCH. MAJOR FOUL and YELLOW CARD per
 * MATCH, if STRATEGIC.", and its note that navigating into the opposing side during AUTO may be seen
 * as STRATEGIC).
 */
export const G402_RULE =
  "Under G402 (BIOBUZZ Competition Manual V1, §11.4.1) driving onto the other alliance's side during AUTO risks a MAJOR FOUL, and a YELLOW CARD if the referees see it as STRATEGIC.";

/**
 * The side of the field `alliance` has to stay on during AUTO, and starts on, in the frame of
 * `alliance`, the file's own. BIOBUZZ Competition Manual V1 splits the field down the middle: columns
 * A to C are red's side and D to F blue's (G304.A for the start, Figure 9-4; G402 for AUTO, Figure
 * 9-5), so the line is `x = 0`, the field's centre, and the alliance's own side is the half its own
 * hive is in. Null when the field file has no hive for the alliance, so nothing says which side is
 * its own. START_ILLEGAL's own-half test and OPPONENT_SIDE both read it, so the two never disagree.
 */
export function biobuzzOwnSide(field: Field, alliance: "RED" | "BLUE"): OwnSide | null {
  const ownHive = (field.elements ?? []).find(
    (element) => element.container === "hive" && element.id.toLowerCase().includes(alliance.toLowerCase()),
  );
  const pivotX = ownHive === undefined ? null : numberAt(ownHive, "pivotIn", "xIn");
  if (pivotX === null) return null;
  return { axis: "x", lineIn: 0, ownSign: pivotX < 0 ? -1 : 1, toleranceIn: OWN_HALF_TOLERANCE_IN, rule: G402_RULE };
}

const as = (state: SeasonState): BiobuzzState => state as unknown as BiobuzzState;

const plural = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? "" : "s"}`;

/**
 * The pollen it takes to tip the hive now: `rules.tipTable` indexed by the nectar in the up cell
 * (docs/skills/build-auto/references/seasons/biobuzz.md, "Tip table"). Past the table's last row
 * that row holds, as in DSim (`hiveWillTip`): with the BIOBUZZ table
 * five nectar or more tip a cell with no pollen at all. Null only when the field gives no table.
 */
export function pollenToTip(state: BiobuzzState, hive: HiveState): number | null {
  if (state.tipTable.length === 0) return null;
  const nectar = nectarIn(state, hive.upCell);
  return state.tipTable[Math.min(nectar, state.tipTable.length - 1)] ?? null;
}

/** The pollen in the up cell: every piece there that is not nectar. */
const pollenIn = (state: BiobuzzState, holds: Readonly<Holds>): number => total(holds) - nectarIn(state, holds);

/** Pieces put on the floor at a place the ledger does not know. */
export const landLoose = (state: BiobuzzState, pieces: Readonly<Holds>): BiobuzzState =>
  total(pieces) === 0
    ? state
    : { ...state, loose: addKinds(state.loose, pieces), looseUnknown: true };

/**
 * Swings the hive over: everything in the up cell is dumped onto the floor quarter on that cell's
 * own side, which is the side opposite the cell that comes up, and the empty down cell comes up
 * (DSim `hiveStep` empties the tray as it passes level and
 * `spillPoses` throws the load outboard over the emptying cell's open end). A tip the table
 * predicted is counted as predicted, so an author's later assertion confirms it.
 */
function tipHive(state: BiobuzzState, hive: HiveState, predicted: boolean): BiobuzzState {
  const dumped = hive.upCell;
  const area = cellArea(state, hive, true);
  const tipped: HiveState = {
    ...hive,
    upSide: oppositeSide(hive.upSide),
    upCell: {},
    tips: hive.tips + 1,
    predictedTips: hive.predictedTips + (predicted ? 1 : 0),
  };
  const next: BiobuzzState = { ...state, hives: { ...state.hives, [hive.id]: tipped } };
  if (area === null) return landLoose(next, dumped);
  return {
    ...next,
    floor: { ...next.floor, [area.id]: { ...area, holds: addKinds(area.holds, dumped) } },
  };
}

/**
 * Whether a robot at `pose` scores into the hive's up cell: it is this alliance's own hive, and the
 * robot is in the floor quarter the up cell is over (owner, 2026-10-03, issue #95; the cell is open
 * only at its outer end, so a launch has to come from that side, DSim `hive.ts` `hiveAccepts`).
 * Without a pose the author's word is taken.
 */
export function scoresFrom(state: BiobuzzState, hive: HiveState, pose: Pose | undefined): boolean {
  if (hive.alliance !== state.alliance) return false;
  if (pose === undefined) return true;
  const area = cellArea(state, hive, true);
  return area === null || inArea(area, pose);
}

/**
 * Pieces arriving at a hive's up cell: they go in when `scores`, apart from the other alliance's
 * nectar, which only its own hive takes (owner, 2026-10-03, issue #95), and the hive then tips if
 * the cell holds enough. Whatever does not go in lands loose.
 */
export function intoUpCell(
  state: BiobuzzState,
  hive: HiveState,
  pieces: Readonly<Holds>,
  scores: boolean,
): BiobuzzState {
  if (!scores) return landLoose(state, pieces);
  const enters: Holds = {};
  const misses: Holds = {};
  for (const [kind, count] of Object.entries(pieces)) {
    if (count <= 0) continue;
    if (isOpponentNectar(state, kind)) misses[kind] = count;
    else enters[kind] = count;
  }
  const standing = state.hives[hive.id] ?? hive;
  const filled: BiobuzzState = {
    ...state,
    hives: { ...state.hives, [hive.id]: { ...standing, upCell: addKinds(standing.upCell, enters) } },
  };
  return landLoose(settleHive(filled, hive.id), misses);
}

/** Tips the hive for as long as its up cell holds the pollen the tip table asks for its nectar. */
function settleHive(state: BiobuzzState, hiveId: string): BiobuzzState {
  let next = state;
  for (let guard = 0; guard < 8; guard += 1) {
    const standing = next.hives[hiveId];
    if (standing === undefined) break;
    const needed = pollenToTip(next, standing);
    if (needed === null || pollenIn(next, standing.upCell) < needed) break;
    next = tipHive(next, standing, true);
  }
  return next;
}

/** The hive a target id belongs to, or null when the target is not a hive cell. */
function hiveOfTarget(state: BiobuzzState, target: TargetId): HiveState | null {
  for (const hive of Object.values(state.hives)) {
    if (hive.targetId === target || hive.id === target) return hive;
  }
  return null;
}

/** "3 nectarRed (3 pollen to tip)": what an up cell holds and what it still takes to tip it. */
function upCellWords(state: BiobuzzState, hive: HiveState): string {
  const needed = pollenToTip(state, hive);
  const short = needed === null ? null : Math.max(0, needed - pollenIn(state, hive.upCell));
  const cost = needed === null ? "the field gives no tip table" : `${String(short)} more pollen to tip`;
  return `${holdsWords(state, hive.upCell)} (${cost})`;
}

/** What `locations.ts` needs from the hive rules here, passed in so the two files do not import each other. */
const hiveRules = { settle: settleHive, scoresFrom, intoUpCell };

export const biobuzzRules: SeasonRules = {
  id: "season-biobuzz",

  initialState: (field: Field): SeasonState => initialBiobuzzState(field) as unknown as SeasonState,

  start: (state: SeasonState, holds: Readonly<Record<string, number>>, alliance?: "RED" | "BLUE"): SeasonState => {
    const current = as(state);
    const order = kindOrder(current, holds).flatMap((kind) => Array.from({ length: holds[kind] ?? 0 }, () => kind));
    return withRobotOrder({ ...current, alliance: alliance ?? current.alliance }, order) as unknown as SeasonState;
  },

  holds: (state: SeasonState): Record<string, number> => ({ ...as(state).robotHolds }),

  /**
   * A volley at a hive's up cell. The pieces leave the robot last in first out (DSim
   * `releasePollen`). They go into the cell when it is this
   * alliance's own hive and the robot is in the up cell's quarter of the field, and once the cell
   * holds the pollen the tip table asks for the nectar in it, the hive tips and dumps the whole cell
   * on its own side. A launch from anywhere else, at the other alliance's hive, or at a target that
   * is no hive cell, lands loose: the pieces leave the robot either way.
   */
  onLaunch: (state: SeasonState, target: TargetId, count: number, pose: Pose): SeasonState => {
    const current = as(state);
    const hive = hiveOfTarget(current, target);
    const { state: fired, taken } = popRobot(current, Math.max(0, count));
    if (hive === null) return landLoose(fired, taken) as unknown as SeasonState;
    return intoUpCell(fired, hive, taken, scoresFrom(fired, hive, pose)) as unknown as SeasonState;
  },

  /**
   * A robot intake of pieces on the field, up to the room left under the capacity, which nectar
   * counts toward; the other alliance's nectar is never taken (G408). A flower hands pieces out of
   * the opening at its base, only the kinds that opening lists and only while one of them is at the
   * bottom, so a nectar there locks it. A hive cell gives nothing: only a tip empties it. A garden
   * element is a single piece lying on the floor. A floor quarter, a loading zone or the loose
   * pieces give what they hold, and `.nectar` or `.<kind>` on the id picks one kind
   * (`locations.ts`, `collectPieces`). `Own` and `Opponent` in the id stand for the routine's
   * alliance and the other one, as they do in a transfer.
   */
  onCollect: (state: SeasonState, containerId: string, count: number, alliance?: "RED" | "BLUE"): SeasonState => {
    const current = as(state);
    const room = Math.max(0, current.capacity - heldTotal(current));
    const wanted = Math.max(0, Math.min(count, room));
    if (wanted === 0) return state;
    const next = collectPieces(current, resolveAllianceWords(containerId, alliance ?? current.alliance), wanted);
    return next === current ? state : (next as unknown as SeasonState);
  },

  /**
   * The author asserting the hive swung, which `assumeTipped` and `expect.tip` both do. It is
   * trusted over the tip table, because a camera or a driver saw it and the table only predicts it.
   * When the table already predicted a tip the author has not confirmed, the assertion confirms
   * that one: it is the same swing, seen, not a second one.
   */
  onTip: (state: SeasonState, which: "own" | "opponent", alliance: "RED" | "BLUE"): SeasonState => {
    const current = as(state);
    const wanted = which === "own" ? alliance : alliance === "RED" ? "BLUE" : "RED";
    const hive = Object.values(current.hives).find((candidate) => candidate.alliance === wanted);
    if (hive === undefined) return state;
    if (hive.predictedTips > 0) {
      const confirmed: HiveState = { ...hive, predictedTips: hive.predictedTips - 1 };
      return { ...current, hives: { ...current.hives, [hive.id]: confirmed } } as unknown as SeasonState;
    }
    return tipHive(current, hive, false) as unknown as SeasonState;
  },

  /**
   * Every place the ledger counts pieces, with its count, for transfers and the field's badges: the
   * routine's own hive and human player, not the other alliance's.
   */
  locations: (state: SeasonState, alliance: "RED" | "BLUE"): LedgerLocation[] => listLocations(as(state), alliance),

  /** A transfer step: pieces the author says move between two places (`locations.ts`). */
  onTransfer: (
    state: SeasonState,
    from: string,
    to: string,
    count: number,
    alliance: "RED" | "BLUE",
    pose?: Pose,
  ): TransferResult => transferPieces(as(state), from, to, count, alliance, pose, hiveRules),

  /** A location's count or a hive's tips, for a condition's quantity test in `robot.json`. */
  measure: (state: SeasonState, quantity: string, alliance: "RED" | "BLUE"): number | null =>
    measureQuantity(as(state), quantity, alliance),

  /** The alliance's own hive cell that is currently up: the only thing worth shooting at. */
  currentTarget: (state: SeasonState, alliance: "RED" | "BLUE"): TargetId | null => {
    for (const hive of Object.values(as(state).hives)) {
      if (hive.alliance === alliance) return hive.targetId ?? hive.id;
    }
    return null;
  },

  /**
   * A launch is only legal from the up cell's own quarter of the field, the only place a robot
   * scores into it from (owner, 2026-10-03, issue #95), and there from outboard of the cell's outer
   * face, by the margin the field file states, along the hive's swing axis and on the side the cell
   * faces.
   */
  legalApproach: (
    state: SeasonState,
    target: TargetId,
    pose: Pose,
    robot: Robot,
  ): boolean => {
    void robot;
    const current = as(state);
    const hive = hiveOfTarget(current, target);
    if (hive === null) return true;
    const area = cellArea(current, hive, true);
    if (area !== null && !inArea(area, pose)) return false;
    const { faceIn, outboardSign } = upCellFace(hive);
    const along = hive.axis === "x" ? pose.xIn : pose.yIn;
    const limit = faceIn + outboardSign * hive.approachMarginIn;
    return outboardSign > 0 ? along >= limit : along <= limit;
  },

  /** A hive cell, by its target's id or the hive's own: the only things a robot launches into. */
  knowsTarget: (state: SeasonState, target: TargetId): boolean => hiveOfTarget(as(state), target) !== null,

  /**
   * Where the up cell sits, for the turret-range check: the middle of the cell, which is half the
   * outer-face distance out from the pivot on the side that is up.
   */
  targetPoint: (state: SeasonState, target: TargetId): Vec2 | null => {
    const hive = hiveOfTarget(as(state), target);
    return hive === null ? null : cellPoint(hive, true);
  },

  /**
   * The nearest pose the approach rule would accept: straight out along the hive's axis to the
   * edge of the legal band, with the other coordinate brought inside the up cell's quarter of the
   * field when it is outside it, facing the cell.
   */
  nearestLegalApproach: (
    state: SeasonState,
    target: TargetId,
    pose: Pose,
    robot: Robot,
  ): Pose | null => {
    const current = as(state);
    const hive = hiveOfTarget(current, target);
    if (hive === null) return null;
    if (biobuzzRules.legalApproach(state, target, pose, robot)) return pose;
    const { faceIn, outboardSign } = upCellFace(hive);
    const along = hive.axis === "x" ? pose.xIn : pose.yIn;
    const outboard = outboardSign > 0 ? along >= faceIn + hive.approachMarginIn : along <= faceIn - hive.approachMarginIn;
    const area = cellArea(current, hive, true);
    const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
    // Along the axis: out to the edge of the legal band, and kept inside the up cell's quarter, so a
    // pose already outboard but past the quarter's far edge (off the field) is brought back into it.
    const band = outboard ? along : faceIn + outboardSign * hive.approachMarginIn;
    const limit =
      area === null
        ? band
        : hive.axis === "x"
          ? clamp(band, area.minXIn, area.maxXIn)
          : clamp(band, area.minYIn, area.maxYIn);
    // The other coordinate, brought inside the up cell's quarter when the robot is outside it.
    const across =
      hive.axis === "x"
        ? area === null ? pose.yIn : clamp(pose.yIn, area.minYIn, area.maxYIn)
        : area === null ? pose.xIn : clamp(pose.xIn, area.minXIn, area.maxXIn);
    const moved = hive.axis === "x" ? { xIn: limit, yIn: across } : { xIn: across, yIn: limit };
    const aim = biobuzzRules.targetPoint?.(state, target) ?? null;
    const headingRad =
      aim === null ? pose.headingRad : Math.atan2(aim.yIn - moved.yIn, aim.xIn - moved.xIn);
    return { ...moved, headingRad };
  },

  /**
   * `startRules` from `field.json`, checked against the footprint at the start pose.
   *
   * The pose is in the frame of `alliance`, the file's own, which is where the robot starts it. The
   * field file writes its rules for `field.frame.canonicalAlliance`, so for the other alliance its
   * own half is the one its own hive is in and a named zone is read as its counterpart
   * (`loadingZoneRed` is BLUE's `loadingZoneBlue`).
   */
  startLegal: (
    field: Field,
    pose: Pose,
    robot: Robot,
    alliance: "RED" | "BLUE" = field.frame.canonicalAlliance,
  ): Finding[] => {
    const rules = field.startRules;
    if (rules === undefined) return [];
    const ownId = (id: string): string =>
      alliance === field.frame.canonicalAlliance ? id : (swapAllianceWord(id) ?? id);
    const findings: Finding[] = [];
    const bounds = fieldBounds(field);
    const corners = footprintAt(pose, robot, "startIn").bodyIn;

    const say = (message: string): void => {
      findings.push({
        severity: "error",
        stepId: "start",
        code: "START_ILLEGAL",
        message,
        geometry: { polygonIn: corners },
      });
    };

    if (rules.touchingWall === true) {
      const nearest = Math.min(
        ...corners.map((corner) =>
          Math.min(
            corner.xIn - bounds.minXIn,
            bounds.maxXIn - corner.xIn,
            corner.yIn - bounds.minYIn,
            bounds.maxYIn - corner.yIn,
          ),
        ),
      );
      if (nearest > TOUCHING_WALL_TOLERANCE_IN) {
        say(
          `The robot must start touching a wall, and its nearest corner is ${nearest.toFixed(2)} in away from one.`,
        );
      }
    }

    if (rules.ownHalf === true) {
      // The pose is in the frame of the file's own alliance, and that alliance's hive says which
      // side of the centre line is its own half (`biobuzzOwnSide`, which OPPONENT_SIDE reads too).
      // A field file with no hive for the alliance keeps the old reading, the half below x = 0.
      const side: Pick<OwnSide, "axis" | "lineIn" | "ownSign"> = biobuzzOwnSide(field, alliance) ?? { axis: "x", lineIn: 0, ownSign: -1 };
      const worst = Math.max(...corners.map((corner) => pastLineIn(corner, side)));
      const nearest = Math.min(...corners.map((corner) => pastLineIn(corner, side)));
      if (nearest > OWN_HALF_TOLERANCE_IN) {
        // Every corner is over the line: "crosses it by 72 in" read as a small overlap, when the
        // robot is in the other alliance's half altogether, often because the file names the other
        // alliance or the start was drawn in the other alliance's frame.
        say(
          `The robot must start in ${alliance}'s own half, the side with ${alliance}'s hive, and it starts entirely in the other half, ${worst.toFixed(2)} in past the centre line.`,
        );
      } else if (worst > OWN_HALF_TOLERANCE_IN) {
        say(
          `The robot must start in ${alliance}'s own half, and its footprint crosses the centre line by ${worst.toFixed(2)} in.`,
        );
      }
    }

    for (const zoneId of (rules.notInZones ?? []).map(ownId)) {
      const zone = (field.zones ?? []).find((candidate) => candidate.id === zoneId);
      if (zone === undefined) continue;
      if (polygonOverlapsBox(corners, zone).overlaps) {
        say(`The robot must not start in ${zoneId}${zone.rule === undefined ? "" : ` (${zone.rule})`}.`);
      }
    }

    for (const containerKind of rules.notTouchingContainers ?? []) {
      for (const element of field.elements ?? []) {
        if (element.container !== containerKind) continue;
        // A container's footprint on the floor is the obstacle the field file draws for it.
        for (const obstacle of field.obstacles ?? []) {
          if (obstacle.kind !== "box" || !obstacle.id.startsWith(element.id)) continue;
          if (polygonOverlapsBox(corners, obstacle).overlaps) {
            say(`The robot must not start touching a ${containerKind}, and it overlaps ${obstacle.id}.`);
          }
        }
      }
    }

    return findings;
  },

  describe: (before: SeasonState, after: SeasonState): string | null => {
    const a = as(before);
    const b = as(after);
    const parts: string[] = [];
    // Only the routine's own hive: Zenith edits one alliance's auto at a time (issue #95).
    const hive = ownHive(b);
    const was = hive === undefined ? undefined : a.hives[hive.id];
    if (hive !== undefined && was !== undefined) {
      if (hive.tips !== was.tips) {
        const area = cellArea(b, hive, false);
        const dumped = area === null ? "" : `, dumping its cell into ${area.id}`;
        parts.push(`${hive.id} tipped${dumped} and now faces ${hive.upSide}`);
      } else if (!sameHolds(hive.upCell, was.upCell)) {
        parts.push(`${hive.id} up cell holds ${upCellWords(b, hive)}`);
      }
    }
    if (!sameHolds(b.partnerHolds, a.partnerHolds)) parts.push(`the partner holds ${holdsWords(b, b.partnerHolds)}`);
    for (const areas of [b.floor, b.loadingZone]) {
      for (const area of Object.values(areas)) {
        const was = a.floor[area.id] ?? a.loadingZone[area.id];
        if (was !== undefined && !sameHolds(was.holds, area.holds)) parts.push(`${area.id} has ${holdsWords(b, area.holds)}`);
      }
    }
    for (const flower of Object.values(b.flowers)) {
      const was = a.flowers[flower.id];
      if (was === undefined) continue;
      if (flower.column.join() !== was.column.join()) {
        const locked = flowerLocked(flower) ? ", locked by the nectar at its bottom" : "";
        parts.push(`${flower.id} has ${holdsWords(b, columnHolds(flower.column))} left${locked}`);
      }
    }
    {
      const now = b.humanPlayer[b.alliance];
      const had = a.humanPlayer[b.alliance];
      if (!sameHolds(now, had)) {
        const brought: Holds = {};
        for (const [kind, count] of Object.entries(now)) {
          if (count > (had[kind] ?? 0)) brought[kind] = count - (had[kind] ?? 0);
        }
        parts.push(`the ${b.alliance} human player brought in ${holdsWords(b, brought)}`);
      }
    }
    const looseNow = total(b.loose);
    const looseWas = total(a.loose);
    if (looseNow > looseWas) {
      parts.push(`${plural(looseNow - looseWas, "piece")} landed loose, place unknown`);
    } else if (looseNow < looseWas) {
      parts.push(`${plural(looseWas - looseNow, "loose piece")} picked up`);
    }
    return parts.length === 0 ? null : parts.join("; ");
  },

  /**
   * The other alliance's name for a field id.
   *
   * Every alliance-specific id in `biobuzz.field.json` is spelled with `Red` or `Blue` in it
   * (`hiveRed`, `hiveBlueUpCell`, `gardenRed2`, `loadingZoneBlue`), so the counterpart is the same
   * id with the colour swapped. An id with neither — a flower, which both alliances share — is its
   * own counterpart. Nothing here invents an id: a swapped name that the field file does not carry
   * is reported as having no counterpart, so `mirrorAuto` refuses rather than writing a dangling
   * reference.
   */
  mirrorId: (id: string): string | null => {
    const swapped = swapAllianceWord(id);
    if (swapped === null) return id;
    return swapped;
  },

  /** The hive cell a robot at `pose` scores into for a hive target (`biobuzzClaimPlace`). */
  claimPlace: (field: Field, elementId: string, pose: Pose): string | null => biobuzzClaimPlace(field, elementId, pose),

  /** The side the robot stays on during AUTO, for OPPONENT_SIDE (G402, `biobuzzOwnSide`). */
  ownSide: (field: Field, alliance: "RED" | "BLUE"): OwnSide | null => biobuzzOwnSide(field, alliance),

  /** What a person calls an obstacle of the field file, for STRUCTURE messages (`biobuzzObstacleLabel`). */
  obstacleLabel: (id: string, field?: Field): string | null => biobuzzObstacleLabel(id, field),

  /**
   * The end-of-routine rows the ledger panel and the pull-request body both print: what the robot
   * holds, the routine's own hive's up side, tips and up cell with the pollen it still takes to tip,
   * what each flower and the garden have left, and every other place holding a piece, nectar
   * included. The other alliance's hive is left out: Zenith edits one alliance's auto at a time.
   */
  summary: (state: SeasonState): LedgerRow[] => {
    const current = as(state);
    const rows: LedgerRow[] = [
      {
        stepId: "end",
        label: "robot",
        detail: holdsWords(current, current.robotHolds),
        holds: { ...current.robotHolds },
      },
    ];
    const hive = ownHive(current);
    if (hive !== undefined) {
      rows.push({
        stepId: "end",
        label: hive.id,
        detail: `up ${hive.upSide}, ${plural(hive.tips, "tip")}; up cell ${upCellWords(current, hive)}`,
      });
    }
    for (const flower of Object.values(current.flowers)) {
      const locked = flowerLocked(flower) ? ", locked by the nectar at its bottom" : "";
      rows.push({ stepId: "end", label: flower.id, detail: `${holdsWords(current, columnHolds(flower.column))}${locked}` });
    }
    const gardenLeft = Object.values(current.garden).filter(Boolean).length;
    rows.push({ stepId: "end", label: "garden", detail: plural(gardenLeft, "piece") });
    // A floor quarter, a loading zone or a human player gets a row only once a transfer has put a
    // piece there, so a routine with no transfers prints the rows it always did.
    for (const area of [...Object.values(current.floor), ...Object.values(current.loadingZone)]) {
      if (total(area.holds) > 0) rows.push({ stepId: "end", label: area.id, detail: holdsWords(current, area.holds) });
    }
    {
      const alliance = current.alliance;
      const brought = current.humanPlayer[alliance];
      if (total(brought) > 0) {
        const stock = current.humanPlayerLimits.nectar;
        const left = stock === null ? "" : `, ${String(Math.max(0, stock - total(brought)))} left`;
        rows.push({
          stepId: "end",
          label: `humanPlayer${alliance === "RED" ? "Red" : "Blue"}`,
          detail: `brought in ${holdsWords(current, brought)}${left}`,
        });
      }
    }
    if (total(current.loose) > 0) {
      rows.push({
        stepId: "end",
        label: "loose",
        detail: `${holdsWords(current, current.loose)}, position unknown`,
      });
    }
    return rows;
  },
};

/** True when two by-kind counts hold the same pieces. */
function sameHolds(a: Readonly<Holds>, b: Readonly<Holds>): boolean {
  const kinds = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const kind of kinds) if ((a[kind] ?? 0) !== (b[kind] ?? 0)) return false;
  return true;
}

/** True when the piece at the bottom of a flower is one its retrieval opening does not let out. */
const flowerLocked = (flower: FlowerState): boolean => {
  const bottom = flower.column[0];
  return bottom !== undefined && !flower.takes.includes(bottom);
};

/**
 * What a person calls each obstacle `biobuzz.field.json` carries (issue #152). The ids are the file's
 * own and nothing on the field is labelled with them: `frameBarWest` is a 1 in wide base bar of the
 * hive frame, drawn as a thin line, so a STRUCTURE message that names only the id names nothing a
 * student can find. The labels are the words the manual and the starter autos use. A flower's foot
 * also says which wall it stands against, worked out from the field file when it is given, so a team
 * that corrects its own copy gets the corrected wall. An id this plugin does not know gets null.
 */
export function biobuzzObstacleLabel(id: string, field?: Field): string | null {
  const frameBar = /^frameBar(East|West)$/.exec(id);
  if (frameBar !== null) return `the ${(frameBar[1] ?? "").toLowerCase()} base bar of the hive frame`;
  // The four slanted legs (issue #229), which the editor does not label either.
  const frameLeg = /^frameLeg(North|South)(East|West)$/.exec(id);
  if (frameLeg !== null) return `the ${(frameLeg[1] ?? "").toLowerCase()}-${(frameLeg[2] ?? "").toLowerCase()} leg of the hive frame`;
  // The pivot bar's box is the envelope of the hive's two cells over their whole swing, which the
  // editor draws as the hive itself.
  const pivotBar = /^hive(Red|Blue)PivotBar$/.exec(id);
  if (pivotBar !== null) return `the ${(pivotBar[1] ?? "").toUpperCase()} hive`;
  const foot = /^(flower\d+)Foot$/.exec(id);
  if (foot !== null) {
    const wall = field === undefined ? null : wallBeside(field, id);
    return `the foot of ${foot[1] ?? id}${wall === null ? "" : ` on the ${wall} wall`}`;
  }
  return null;
}

/**
 * The wall an obstacle stands against, in the words the starter autos use: south is the audience
 * wall (y = -72), north the far one, west and east the walls at x = -72 and x = +72 in the field
 * file's frame. Null when the obstacle is not within a touching distance of any wall.
 */
function wallBeside(field: Field, id: string): string | null {
  const box = (field.obstacles ?? []).find((obstacle): obstacle is BoxObstacle => obstacle.kind === "box" && obstacle.id === id);
  if (box === undefined) return null;
  const bounds = fieldBounds(field);
  const gaps: Array<[string, number]> = [
    ["west", box.minXIn - bounds.minXIn],
    ["east", bounds.maxXIn - box.maxXIn],
    ["south", box.minYIn - bounds.minYIn],
    ["north", bounds.maxYIn - box.maxYIn],
  ];
  const [wall, gapIn] = gaps.reduce((best, gap) => (gap[1] < best[1] ? gap : best));
  return gapIn <= TOUCHING_WALL_TOLERANCE_IN ? wall : null;
}

/** `hiveRedUpCell` -> `hiveBlueUpCell`, and null when the id names no alliance at all. */
function swapAllianceWord(id: string): string | null {
  if (id.includes("Red")) return id.split("Red").join("Blue");
  if (id.includes("Blue")) return id.split("Blue").join("Red");
  return null;
}

function numberAt(source: unknown, key: string, inner: string): number | null {
  if (typeof source !== "object" || source === null) return null;
  const nested = (source as Record<string, unknown>)[key];
  if (typeof nested !== "object" || nested === null) return null;
  const value = (nested as Record<string, unknown>)[inner];
  return typeof value === "number" ? value : null;
}

/** The kickoff state of each field file `biobuzzClaimPlace` has read, which never changes. */
const kickoffStates = new WeakMap<Field, BiobuzzState>();

/**
 * Which of a hive's two cells a robot at `pose` scores into, when `elementId` names the hive or its
 * up cell: "the north cell" (or south, east, west). The hive's target id always names the cell
 * that is up, and the other cell comes up at every tip, so two robots scoring into that one id
 * from opposite sides of the hive score into different cells. A robot scores into the up cell
 * only from the floor quarter that cell is over (owner, 2026-10-03, issue #95; `scoresFrom`), so
 * the quarter the robot is in names the cell, whatever the tips before it. Null for any other
 * element, which is always one place, and for a pose in neither of the hive's quarters.
 */
export function biobuzzClaimPlace(field: Field, elementId: string, pose: Pose): string | null {
  let state = kickoffStates.get(field);
  if (state === undefined) {
    state = initialBiobuzzState(field);
    kickoffStates.set(field, state);
  }
  const hive = hiveOfTarget(state, elementId);
  if (hive === null) return null;
  for (const up of [true, false]) {
    const area = cellArea(state, hive, up);
    if (area !== null && inArea(area, pose)) {
      return `the ${(up ? hive.upSide : oppositeSide(hive.upSide)).toLowerCase()} cell`;
    }
  }
  return null;
}

/** The rules for a field file: this plugin when the file names it, and nothing otherwise. */
export function loadSeason(field: Field): SeasonRules {
  const plugin = field.rules?.plugin;
  if (plugin === biobuzzRules.id || field.season === "biobuzz") return biobuzzRules;
  return noSeasonRules;
}
