import {
  fieldBounds,
  footprintAt,
  noSeasonRules,
  polygonOverlapsBox,
  type Finding,
  type LedgerRow,
  type Pose,
  type SeasonRules,
  type SeasonState,
  type TargetId,
  type Vec2,
} from "@horizon36596/zenith-core";
import type { Field, Robot } from "@horizon36596/zenith-schema";
import {
  heldTotal,
  initialBiobuzzState,
  oppositeSide,
  upCellFace,
  type BiobuzzState,
  type HiveState,
} from "./state.js";

/**
 * The BIOBUZZ season plugin: the `SeasonRules` of
 * site/docs/seasons.md, implemented from `field.json` alone.
 *
 * It is deliberately simple. It does not model where a spilled game piece lands; after a tip the
 * spilled count becomes loose with an unknown position, which is what makes a following
 * `collectNearestPollen` an unknown time rather than a made-up one.
 */

/** How close a footprint corner has to be to a wall to count as touching it, in inches. */
export const TOUCHING_WALL_TOLERANCE_IN = 0.5;

/** How far a footprint may sit over the centre line before it is no longer in its own half. */
export const OWN_HALF_TOLERANCE_IN = 0.05;

const as = (state: SeasonState): BiobuzzState => state as unknown as BiobuzzState;

const plural = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? "" : "s"}`;

const addHold = (
  holds: Readonly<Record<string, number>>,
  kind: string,
  delta: number,
): Record<string, number> => {
  const next = { ...holds };
  const value = (next[kind] ?? 0) + delta;
  if (value <= 0) delete next[kind];
  else next[kind] = value;
  return next;
};

/** The number in the up cell that tips the hive next, from `rules.tipTable` (`02`). */
function tipThreshold(hive: HiveState, tipTable: readonly number[]): number | null {
  if (tipTable.length === 0) return null;
  const index = Math.min(hive.tips, tipTable.length - 1);
  return tipTable[index] ?? null;
}

/** Swings the hive over: the up cell spills, the down cell comes up, and the up side flips. */
function tipHive(state: BiobuzzState, hive: HiveState): BiobuzzState {
  const spilled = hive.upCellCount;
  const tipped: HiveState = {
    ...hive,
    upSide: oppositeSide(hive.upSide),
    upCellCount: hive.downCellCount,
    downCellCount: 0,
    tips: hive.tips + 1,
  };
  return {
    ...state,
    hives: { ...state.hives, [hive.id]: tipped },
    looseCount: state.looseCount + spilled,
    looseUnknown: state.looseUnknown || spilled > 0,
  };
}

/** The hive a target id belongs to, or null when the target is not a hive cell. */
function hiveOfTarget(state: BiobuzzState, target: TargetId): HiveState | null {
  for (const hive of Object.values(state.hives)) {
    if (hive.targetId === target || hive.id === target) return hive;
  }
  return null;
}

export const biobuzzRules: SeasonRules = {
  id: "season-biobuzz",

  initialState: (field: Field): SeasonState => initialBiobuzzState(field) as unknown as SeasonState,

  start: (state: SeasonState, holds: Readonly<Record<string, number>>): SeasonState => {
    const current = as(state);
    return { ...current, robotHolds: { ...holds } } as unknown as SeasonState;
  },

  holds: (state: SeasonState): Record<string, number> => ({ ...as(state).robotHolds }),

  /**
   * A volley into the hive's up cell: the pieces leave the robot, land in the cell, and once the
   * cell holds what the tip table says, the hive swings and whatever was up spills onto the floor.
   */
  onLaunch: (state: SeasonState, target: TargetId, count: number, pose: Pose): SeasonState => {
    void pose;
    const current = as(state);
    const hive = hiveOfTarget(current, target);
    const launched = Math.max(0, Math.min(count, heldTotal(current)));

    let robotHolds = current.robotHolds;
    let remaining = launched;
    for (const kind of Object.keys(robotHolds)) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, robotHolds[kind] ?? 0);
      robotHolds = addHold(robotHolds, kind, -take);
      remaining -= take;
    }

    if (hive === null) return { ...current, robotHolds } as unknown as SeasonState;

    const filled: HiveState = { ...hive, upCellCount: hive.upCellCount + launched };
    let next: BiobuzzState = {
      ...current,
      robotHolds,
      hives: { ...current.hives, [hive.id]: filled },
    };

    for (let guard = 0; guard < 8; guard += 1) {
      const standing = next.hives[hive.id];
      if (standing === undefined) break;
      const threshold = tipThreshold(standing, next.tipTable);
      if (threshold === null || standing.upCellCount < threshold) break;
      next = tipHive(next, standing);
    }
    return next as unknown as SeasonState;
  },

  /**
   * The flowers hand pollen out of the opening at their base, and only the kinds that opening
   * lists; a hive's nectar is locked in and no `collectFrom` annotation can take it out. A garden
   * element is a single piece lying on the floor.
   */
  onCollect: (state: SeasonState, containerId: string, count: number): SeasonState => {
    const current = as(state);
    const room = Math.max(0, current.capacity - heldTotal(current));
    const wanted = Math.max(0, Math.min(count, room));
    if (wanted === 0) return state;

    const flower = current.flowers[containerId];
    if (flower !== undefined) {
      let holds = flower.holds;
      let robotHolds = current.robotHolds;
      let left = wanted;
      for (const kind of flower.takes) {
        if (left <= 0) break;
        const take = Math.min(left, holds[kind] ?? 0);
        if (take === 0) continue;
        holds = addHold(holds, kind, -take);
        robotHolds = addHold(robotHolds, kind, take);
        left -= take;
      }
      return {
        ...current,
        robotHolds,
        flowers: { ...current.flowers, [containerId]: { ...flower, holds } },
      } as unknown as SeasonState;
    }

    if (current.hives[containerId] !== undefined) {
      // Nectar is locked inside the hive: there is no legal way to take it back out in auto.
      return state;
    }

    const gardenIds = Object.keys(current.garden).filter(
      (id) => (id === containerId || id.startsWith(containerId)) && current.garden[id] === true,
    );
    if (gardenIds.length > 0) {
      const taken = gardenIds.slice(0, wanted);
      const garden = { ...current.garden };
      for (const id of taken) garden[id] = false;
      return {
        ...current,
        garden,
        robotHolds: addHold(current.robotHolds, current.elementKind, taken.length),
      } as unknown as SeasonState;
    }

    if (containerId === "loose" && current.looseCount > 0) {
      const taken = Math.min(wanted, current.looseCount);
      return {
        ...current,
        looseCount: current.looseCount - taken,
        robotHolds: addHold(current.robotHolds, current.elementKind, taken),
      } as unknown as SeasonState;
    }
    return state;
  },

  /**
   * The author asserting the hive swung, which `assumeTipped` and `expect.tip` both do. It is
   * trusted over the tip table, because a camera or a driver saw it and the table only predicts it.
   */
  onTip: (state: SeasonState, which: "own" | "opponent", alliance: "RED" | "BLUE"): SeasonState => {
    const current = as(state);
    const wanted = which === "own" ? alliance : alliance === "RED" ? "BLUE" : "RED";
    const hive = Object.values(current.hives).find((candidate) => candidate.alliance === wanted);
    if (hive === undefined) return state;
    return tipHive(current, hive) as unknown as SeasonState;
  },

  /** The alliance's own hive cell that is currently up: the only thing worth shooting at. */
  currentTarget: (state: SeasonState, alliance: "RED" | "BLUE"): TargetId | null => {
    for (const hive of Object.values(as(state).hives)) {
      if (hive.alliance === alliance) return hive.targetId ?? hive.id;
    }
    return null;
  },

  /**
   * A launch is only legal from outboard of the up cell's outer face, by the margin the field file
   * states, along the hive's swing axis and on the side the cell faces.
   */
  legalApproach: (
    state: SeasonState,
    target: TargetId,
    pose: Pose,
    robot: Robot,
  ): boolean => {
    void robot;
    const hive = hiveOfTarget(as(state), target);
    if (hive === null) return true;
    const { faceIn, outboardSign } = upCellFace(hive);
    const along = hive.axis === "x" ? pose.xIn : pose.yIn;
    const limit = faceIn + outboardSign * hive.approachMarginIn;
    return outboardSign > 0 ? along >= limit : along <= limit;
  },

  /**
   * Where the up cell sits, for the turret-range check: the middle of the cell, which is half the
   * outer-face distance out from the pivot on the side that is up.
   */
  targetPoint: (state: SeasonState, target: TargetId): Vec2 | null => {
    const hive = hiveOfTarget(as(state), target);
    if (hive === null) return null;
    const { outboardSign } = upCellFace(hive);
    const middle = outboardSign * (hive.outerFaceIn / 2);
    return hive.axis === "x"
      ? { xIn: hive.pivotIn.xIn + middle, yIn: hive.pivotIn.yIn }
      : { xIn: hive.pivotIn.xIn, yIn: hive.pivotIn.yIn + middle };
  },

  /**
   * The nearest pose the approach rule would accept: straight out along the hive's axis to the
   * edge of the legal band, keeping the other coordinate, facing the cell.
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
    const limit = faceIn + outboardSign * hive.approachMarginIn;
    const moved =
      hive.axis === "x" ? { xIn: limit, yIn: pose.yIn } : { xIn: pose.xIn, yIn: limit };
    const aim = biobuzzRules.targetPoint?.(state, target) ?? null;
    const headingRad =
      aim === null ? pose.headingRad : Math.atan2(aim.yIn - moved.yIn, aim.xIn - moved.xIn);
    return { ...moved, headingRad };
  },

  /** `startRules` from `field.json`, checked against the footprint at the start pose. */
  startLegal: (field: Field, pose: Pose, robot: Robot): Finding[] => {
    const rules = field.startRules;
    if (rules === undefined) return [];
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
      // The file is written in the canonical alliance's frame, and that alliance's hive says which
      // side of the centre line is its own half.
      const ownHive = (field.elements ?? []).find(
        (element) =>
          element.container === "hive" &&
          element.id.toLowerCase().includes(field.frame.canonicalAlliance.toLowerCase()),
      );
      const pivotX = ownHive === undefined ? -1 : (numberAt(ownHive, "pivotIn", "xIn") ?? -1);
      // Own half is where `x * ownSign` is positive, so a corner on the wrong side of the centre
      // line is one whose `-x * ownSign` is above the tolerance.
      const ownSign = pivotX < 0 ? -1 : 1;
      const worst = Math.max(...corners.map((corner) => -corner.xIn * ownSign));
      if (worst > OWN_HALF_TOLERANCE_IN) {
        say(
          `The robot must start in its own half, and its footprint crosses the centre line by ${worst.toFixed(2)} in.`,
        );
      }
    }

    for (const zoneId of rules.notInZones ?? []) {
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
          if (!obstacle.id.startsWith(element.id)) continue;
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
    for (const hive of Object.values(b.hives)) {
      const was = a.hives[hive.id];
      if (was === undefined) continue;
      if (hive.tips !== was.tips) {
        parts.push(`${hive.id} tipped and now faces ${hive.upSide}`);
      } else if (hive.upCellCount !== was.upCellCount) {
        parts.push(`${hive.id} up cell holds ${plural(hive.upCellCount, "piece")}`);
      }
    }
    for (const flower of Object.values(b.flowers)) {
      const was = a.flowers[flower.id];
      if (was === undefined) continue;
      const left = Object.values(flower.holds).reduce((sum, value) => sum + value, 0);
      const had = Object.values(was.holds).reduce((sum, value) => sum + value, 0);
      if (left !== had) parts.push(`${flower.id} has ${plural(left, "piece")} left`);
    }
    if (b.looseCount !== a.looseCount) {
      parts.push(`${plural(b.looseCount - a.looseCount, "piece")} spilled to an unknown place`);
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

  /** The end-of-routine rows the ledger panel and the pull-request body both print. */
  summary: (state: SeasonState): LedgerRow[] => {
    const current = as(state);
    const rows: LedgerRow[] = [
      {
        stepId: "end",
        label: "robot",
        detail:
          heldTotal(current) === 0
            ? "empty"
            : Object.entries(current.robotHolds)
                .map(([kind, count]) => plural(count, kind))
                .join(", "),
        holds: { ...current.robotHolds },
      },
    ];
    for (const hive of Object.values(current.hives)) {
      rows.push({
        stepId: "end",
        label: hive.id,
        detail: `up ${hive.upSide}, ${plural(hive.tips, "tip")}, ${plural(hive.upCellCount, "piece")} in the up cell`,
      });
    }
    for (const flower of Object.values(current.flowers)) {
      const left = Object.values(flower.holds).reduce((sum, value) => sum + value, 0);
      rows.push({ stepId: "end", label: flower.id, detail: plural(left, "piece") });
    }
    const gardenLeft = Object.values(current.garden).filter(Boolean).length;
    rows.push({ stepId: "end", label: "garden", detail: plural(gardenLeft, "piece") });
    if (current.looseCount > 0) {
      rows.push({
        stepId: "end",
        label: "loose",
        detail: `${plural(current.looseCount, "piece")}, position unknown`,
      });
    }
    return rows;
  },
};

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

/** The rules for a field file: this plugin when the file names it, and nothing otherwise. */
export function loadSeason(field: Field): SeasonRules {
  const plugin = field.rules?.plugin;
  if (plugin === biobuzzRules.id || field.season === "biobuzz") return biobuzzRules;
  return noSeasonRules;
}
