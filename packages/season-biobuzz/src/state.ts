import type { Field, FieldElement, Obstacle } from "@horizon36596/zenith-schema";

/**
 * The BIOBUZZ ledger state. Everything in it is read out of `field.json` at kickoff, because
 * site/docs/file-format.md says the file alone is the season: nothing here is a constant typed
 * from the manual, and a team that corrects a measurement in their own copy of the field file gets
 * the corrected rules for free.
 *
 * A `type` rather than an `interface` on purpose: the core threads this through `SeasonState`,
 * which is `Readonly<Record<string, unknown>>`, and only a type alias is assignable to that.
 */
export type HiveState = {
  id: string;
  /** RED or BLUE, taken from the hive's own id, which is how `field.json` names sides. */
  alliance: "RED" | "BLUE";
  pivotIn: { xIn: number; yIn: number };
  /** Which way the cell that is currently up faces. */
  upSide: string;
  /** How many game pieces are sitting in the cell that is up. */
  upCellCount: number;
  /** How many are in the cell that is down; they ride back up at the next tip. */
  downCellCount: number;
  /** How many times this hive has tipped so far. */
  tips: number;
  /** The axis the cells swing along, and how far the outer faces sit from the pivot. */
  axis: "x" | "y";
  outerFaceIn: number;
  /** How far outboard of that face the robot has to be to have a legal approach. */
  approachMarginIn: number;
  /** The target id that names this hive's up cell. */
  targetId: string | null;
};

export type FlowerState = {
  id: string;
  xIn: number;
  yIn: number;
  /** What is left inside, by element kind. */
  holds: Record<string, number>;
  /** The kinds the bottom retrieval opening lets out. Nectar is not one of them. */
  takes: string[];
};

export type BiobuzzState = {
  /** What the robot is carrying, by element kind. */
  robotHolds: Record<string, number>;
  hives: Record<string, HiveState>;
  flowers: Record<string, FlowerState>;
  /** The garden lines, still on the floor: element id to true while it is there. */
  garden: Record<string, boolean>;
  /**
   * Pieces that spilled out of a tipping hive. `03` section 6 is explicit that the ledger does not
   * model where they land, so the count is carried and the position is not.
   */
  looseCount: number;
  /** True once a tip has spilled: their positions are unknown and a collect near them is untimed. */
  looseUnknown: boolean;
  /** The number in the up cell that makes the hive tip, for the first tip, the second, and so on. */
  tipTable: number[];
  /** How many pieces the robot may hold at once, from `rules.capacity`. */
  capacity: number;
  /** The element kind the robot carries and launches. */
  elementKind: string;
};

const allianceOf = (id: string): "RED" | "BLUE" =>
  id.toLowerCase().includes("blue") ? "BLUE" : "RED";

const countKinds = (holds: readonly string[] | undefined): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const kind of holds ?? []) counts[kind] = (counts[kind] ?? 0) + 1;
  return counts;
};

const total = (counts: Readonly<Record<string, number>>): number =>
  Object.values(counts).reduce((sum, value) => sum + value, 0);

const numberAt = (source: unknown, key: string): number | null => {
  if (typeof source !== "object" || source === null) return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "number" ? value : null;
};

/**
 * The hive's outer faces come from the obstacle box `field.json` draws for that hive: the cells
 * swing inside it, so its extent along the swing axis is where the outer face of a cell is. The
 * box is found by name, the way the file pairs `hiveRed` with `hiveRedPivotBar`.
 */
function hiveGeometry(
  field: Field,
  hive: FieldElement,
): { axis: "x" | "y"; outerFaceIn: number; approachMarginIn: number; targetId: string | null } {
  const target = (field.targets ?? []).find(
    (candidate) => (candidate as Record<string, unknown>)["hive"] === hive.id,
  );
  const approach = target === undefined ? undefined : (target as Record<string, unknown>)["legalApproach"];
  const axis =
    typeof approach === "object" && approach !== null &&
    (approach as Record<string, unknown>)["alongAxis"] === "x"
      ? "x"
      : "y";
  const approachMarginIn = numberAt(approach, "outboardOfOuterFaceByIn") ?? 0;

  const box: Obstacle | undefined = (field.obstacles ?? []).find((obstacle) =>
    obstacle.id.startsWith(hive.id),
  );
  const pivot = (hive as Record<string, unknown>)["pivotIn"];
  const pivotAlongAxis = (axis === "x" ? numberAt(pivot, "xIn") : numberAt(pivot, "yIn")) ?? 0;
  // The cells swing inside the hive's obstacle box, so the far edge of that box along the swing
  // axis is where a cell's outer face ends up.
  const edges =
    box === undefined
      ? [pivotAlongAxis]
      : axis === "x"
        ? [box.minXIn, box.maxXIn]
        : [box.minYIn, box.maxYIn];
  const outerFaceIn = Math.max(...edges.map((edge) => Math.abs(edge - pivotAlongAxis)));

  return { axis, outerFaceIn, approachMarginIn, targetId: target?.id ?? null };
}

/** The BIOBUZZ state at kickoff, entirely from `field.json` (`03` section 6, trust source one). */
export function initialBiobuzzState(field: Field): BiobuzzState {
  const rules = (field.rules ?? {}) as Record<string, unknown>;
  const tipTableRaw = rules["tipTable"];
  const tipTable = Array.isArray(tipTableRaw)
    ? tipTableRaw.filter((value): value is number => typeof value === "number")
    : [];
  const capacity = typeof rules["capacity"] === "number" ? rules["capacity"] : 0;

  const hives: Record<string, HiveState> = {};
  const flowers: Record<string, FlowerState> = {};
  const garden: Record<string, boolean> = {};
  let elementKind = "pollen";

  for (const element of field.elements ?? []) {
    if (element.container === "hive") {
      const pivot = (element as Record<string, unknown>)["pivotIn"];
      const upSide = (element as Record<string, unknown>)["upSide"];
      const geometry = hiveGeometry(field, element);
      hives[element.id] = {
        id: element.id,
        alliance: allianceOf(element.id),
        pivotIn: { xIn: numberAt(pivot, "xIn") ?? 0, yIn: numberAt(pivot, "yIn") ?? 0 },
        upSide: typeof upSide === "string" ? upSide : "NORTH",
        upCellCount: total(countKinds(element.holds)),
        downCellCount: 0,
        tips: 0,
        ...geometry,
      };
      continue;
    }
    if (element.container === "flower") {
      const retrieval = (element as Record<string, unknown>)["retrieval"];
      const takesRaw =
        typeof retrieval === "object" && retrieval !== null
          ? (retrieval as Record<string, unknown>)["takes"]
          : undefined;
      flowers[element.id] = {
        id: element.id,
        xIn: element.xIn ?? 0,
        yIn: element.yIn ?? 0,
        holds: countKinds(element.holds),
        takes: Array.isArray(takesRaw) ? takesRaw.filter((v): v is string => typeof v === "string") : [],
      };
      continue;
    }
    if (element.container === null || element.container === undefined) {
      garden[element.id] = true;
      elementKind = element.kind;
    }
  }

  return {
    robotHolds: {},
    hives,
    flowers,
    garden,
    looseCount: 0,
    looseUnknown: false,
    tipTable,
    capacity,
    elementKind,
  };
}

/** How many pieces the robot is carrying, across every kind. */
export const heldTotal = (state: BiobuzzState): number => total(state.robotHolds);

/** Which way the hive's up cell faces after it swings over. */
export const oppositeSide = (side: string): string => {
  const flips: Record<string, string> = {
    NORTH: "SOUTH",
    SOUTH: "NORTH",
    EAST: "WEST",
    WEST: "EAST",
  };
  return flips[side] ?? side;
};

/**
 * Where the up cell's outer face sits along the swing axis, in field coordinates, and which way is
 * outboard of it. A cell facing SOUTH or WEST has its face on the negative side of the pivot.
 */
export function upCellFace(hive: HiveState): { faceIn: number; outboardSign: 1 | -1 } {
  const negative = hive.upSide === "SOUTH" || hive.upSide === "WEST";
  const pivotAlongAxis = hive.axis === "x" ? hive.pivotIn.xIn : hive.pivotIn.yIn;
  const sign: 1 | -1 = negative ? -1 : 1;
  return { faceIn: pivotAlongAxis + sign * hive.outerFaceIn, outboardSign: sign };
}
