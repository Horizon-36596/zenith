import { fieldBounds } from "@horizon36596/zenith-core";
import type { BoxObstacle, Field, FieldElement } from "@horizon36596/zenith-schema";

/**
 * The BIOBUZZ ledger state. Everything in it is read out of `field.json` at kickoff, because
 * site/docs/file-format.md says the file alone is the season: nothing here is a constant typed
 * from the manual, and a team that corrects a measurement in their own copy of the field file gets
 * the corrected rules for free.
 *
 * A `type` rather than an `interface` on purpose: the core threads this through `SeasonState`,
 * which is `Readonly<Record<string, unknown>>`, and only a type alias is assignable to that.
 */
/** Game pieces by element kind, such as `{ pollen: 2, nectarRed: 3 }`. A kind with none is left out. */
export type Holds = Record<string, number>;

export type HiveState = {
  id: string;
  /** RED or BLUE, taken from the hive's own id, which is how `field.json` names sides. */
  alliance: "RED" | "BLUE";
  pivotIn: { xIn: number; yIn: number };
  /** Which way the cell that is currently up faces. */
  upSide: string;
  /**
   * What is sitting in the cell that is up, by kind: pollen and nectar alike. There is no count for
   * the down cell, because it is always empty: a cell empties as it swings down (DSim
   * `hiveStep`, whose hive carries one `contents` list, the up cell's).
   */
  upCell: Holds;
  /** How many times this hive has tipped so far. */
  tips: number;
  /**
   * Tips the tip table predicted that no author's assertion (`assumeTipped`, `expect.tip`) has
   * confirmed yet. An assertion confirms one of these rather than swinging the hive a second time.
   */
  predictedTips: number;
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
  /**
   * What is stacked inside, one kind per piece, bottom first. Pieces enter through the hole at the
   * top and leave through the retrieval opening at the bottom, so the order is what decides what
   * comes out next (docs/skills/build-auto/references/seasons/biobuzz.md, "Where the pollen is").
   */
  column: string[];
  /**
   * The kinds the bottom retrieval opening lets out, from `field.json`. Nectar is not one of them,
   * so a nectar at the bottom of the column locks the flower: nothing comes out until it is gone.
   */
  takes: string[];
};

/**
 * An area of the floor the ledger keeps a count for: a quarter of the field (`floor`), or a zone
 * `field.json` marks `ledger: "loadingZone"`. Its box is read from the field file, never typed in.
 */
export type AreaState = {
  id: string;
  alliance: "RED" | "BLUE";
  minXIn: number;
  maxXIn: number;
  minYIn: number;
  maxYIn: number;
  /** What the ledger says is lying in it, by kind. */
  holds: Holds;
};

export type BiobuzzState = {
  /**
   * The routine's alliance, set by `start` (the field's canonical alliance until then). Zenith edits
   * one alliance's auto at a time, so the ledger follows this alliance's hive, human player and
   * nectar (owner, 2026-10-03, issue #95).
   */
  alliance: "RED" | "BLUE";
  /** What the robot is carrying, by element kind: always the count of `robotOrder`. */
  robotHolds: Record<string, number>;
  /**
   * The robot's pieces in the order they went in, first in first. The hopper is a stack: the last
   * piece in is the first out (DSim `releasePollen` and `takeHeld`).
   */
  robotOrder: string[];
  /**
   * What the alliance partner is carrying, by element kind. It starts at `startRules.holds`, the
   * preload every robot starts with, and only transfer steps change it: the ledger does not plan
   * the partner's routine.
   */
  partnerHolds: Record<string, number>;
  /**
   * The four quarters of the floor, split at the field's centre lines, each with the count of
   * pieces a transfer has put there (`floorRedGardenSide` and so on). The garden lines and the
   * loose pieces are counted on their own, not here.
   */
  floor: Record<string, AreaState>;
  /** The loading zones, by the zone's own id in `field.json`. */
  loadingZone: Record<string, AreaState>;
  /** Where each garden element lies, for drawing a garden line's count. */
  gardenAt: Record<string, { xIn: number; yIn: number }>;
  hives: Record<string, HiveState>;
  flowers: Record<string, FlowerState>;
  /** The garden lines, still on the floor: element id to true while it is there. */
  garden: Record<string, boolean>;
  /**
   * Pieces on the floor at a place the ledger does not know, by kind: a launch that did not go into
   * a cell (from outside the up cell's quarter of the field, or at the other alliance's hive) lands
   * here. A tip does not: it dumps its cell into a known floor quarter (`tipHive` in `rules.ts`).
   * They are collectable like any other piece on the floor.
   */
  loose: Holds;
  /** True once a piece has gone loose: its position is unknown and a collect near it is untimed. */
  looseUnknown: boolean;
  /**
   * The pollen it takes to tip a hive, indexed by how many nectar are in its up cell: `rules.tipTable`
   * (docs/skills/build-auto/references/seasons/biobuzz.md, "Tip table"; TRANSCRIPTION.md).
   */
  tipTable: number[];
  /** How many pieces the robot may hold at once, from `rules.capacity`. Nectar counts toward it. */
  capacity: number;
  /** The element kind the field lays out on the floor and in the flowers: pollen. */
  elementKind: string;
  /**
   * Each alliance's nectar kind: the kind its hive's up cell is staged with in `field.json`
   * (`nectarRed`, `nectarBlue`), or null when the field stages none. A kind named here is nectar to
   * the tip table; every other kind counts as pollen.
   */
  nectarKind: Record<"RED" | "BLUE", string | null>;
  /**
   * What each alliance's human player has brought into play so far, by kind. A transfer out of the
   * routine's own `humanPlayerRed` or `humanPlayerBlue` adds to it; nothing else does.
   */
  humanPlayer: Record<"RED" | "BLUE", Holds>;
  /**
   * The human player's limits from `rules.humanPlayer`: how many nectar it starts with, and how
   * many it may enter for each tip of its own hive. Null when the field file gives none.
   */
  humanPlayerLimits: { nectar: number | null; perTip: number | null };
};

const allianceOf = (id: string): "RED" | "BLUE" =>
  id.toLowerCase().includes("blue") ? "BLUE" : "RED";

const countKinds = (holds: readonly string[] | undefined): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const kind of holds ?? []) counts[kind] = (counts[kind] ?? 0) + 1;
  return counts;
};

/** How many pieces a by-kind count holds, across every kind. */
export const total = (counts: Readonly<Holds>): number =>
  Object.values(counts).reduce((sum, value) => sum + value, 0);

/** A by-kind count with `added` put in. */
export const addKinds = (holds: Readonly<Holds>, added: Readonly<Holds>): Holds => {
  const next = { ...holds };
  for (const [kind, count] of Object.entries(added)) if (count > 0) next[kind] = (next[kind] ?? 0) + count;
  return next;
};

/** True when `kind` is either alliance's nectar, as the field file stages it. */
export const isNectar = (state: BiobuzzState, kind: string): boolean =>
  kind === state.nectarKind.RED || kind === state.nectarKind.BLUE;

/** How many nectar a by-kind count holds. */
export const nectarIn = (state: BiobuzzState, holds: Readonly<Holds>): number =>
  Object.entries(holds).reduce((sum, [kind, count]) => sum + (isNectar(state, kind) ? count : 0), 0);

/**
 * The order pieces leave a place on the floor (a floor quarter, a loading zone, the loose pieces)
 * or the partner when nothing says which kind: the field's own element kind first, then the rest by
 * name. On the floor it is where the balls lie that decides which an intake reaches first, and
 * neither the manual nor DSim gives an order the ledger could use, so it picks one fixed order
 * rather than guess per step. The robot is a stack instead (`robotOrder`), and a flower gives from
 * the bottom of its column.
 */
export const kindOrder = (state: BiobuzzState, holds: Readonly<Holds>): string[] => [
  ...(holds[state.elementKind] === undefined ? [] : [state.elementKind]),
  ...Object.keys(holds)
    .filter((kind) => kind !== state.elementKind)
    .sort((a, b) => a.localeCompare(b)),
];

/** A flower column as a by-kind count. */
export const columnHolds = (column: readonly string[]): Holds => countKinds(column);

/** "2 pollen, 3 nectarRed", or "empty". Kinds are field ids, so they are not pluralised. */
export const holdsWords = (state: BiobuzzState, holds: Readonly<Holds>): string => {
  const kinds = kindOrder(state, holds).filter((kind) => (holds[kind] ?? 0) > 0);
  return kinds.length === 0 ? "empty" : kinds.map((kind) => `${String(holds[kind])} ${kind}`).join(", ");
};

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

  const box: BoxObstacle | undefined = (field.obstacles ?? []).find(
    (obstacle): obstacle is BoxObstacle => obstacle.kind === "box" && obstacle.id.startsWith(hive.id),
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
  const gardenAt: Record<string, { xIn: number; yIn: number }> = {};
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
        upCell: countKinds(element.holds),
        tips: 0,
        predictedTips: 0,
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
        column: [...(element.holds ?? [])],
        takes: Array.isArray(takesRaw) ? takesRaw.filter((v): v is string => typeof v === "string") : [],
      };
      continue;
    }
    if (element.container === null || element.container === undefined) {
      garden[element.id] = true;
      gardenAt[element.id] = { xIn: element.xIn ?? 0, yIn: element.yIn ?? 0 };
      elementKind = element.kind;
    }
  }

  const loadingZone: Record<string, AreaState> = {};
  for (const zone of field.zones ?? []) {
    if (zone.ledger !== "loadingZone") continue;
    loadingZone[zone.id] = {
      id: zone.id,
      alliance: allianceOf(zone.id),
      minXIn: zone.minXIn,
      maxXIn: zone.maxXIn,
      minYIn: zone.minYIn,
      maxYIn: zone.maxYIn,
      holds: {},
    };
  }

  const preload = field.startRules?.holds ?? {};
  const partnerHolds: Record<string, number> = {};
  for (const [kind, count] of Object.entries(preload)) if (count > 0) partnerHolds[kind] = count;

  // An alliance's nectar is what its hive is staged with: the field file names no other source.
  const nectarKind: Record<"RED" | "BLUE", string | null> = { RED: null, BLUE: null };
  for (const hive of Object.values(hives)) {
    const staged = Object.keys(hive.upCell).find((kind) => kind !== elementKind);
    if (staged !== undefined) nectarKind[hive.alliance] = staged;
  }

  const humanPlayerRaw = rules["humanPlayer"];
  const humanPlayerLimits = {
    nectar: numberAt(humanPlayerRaw, "nectar"),
    perTip: numberAt(humanPlayerRaw, "perTip"),
  };

  return {
    alliance: field.frame.canonicalAlliance,
    robotHolds: {},
    robotOrder: [],
    partnerHolds,
    floor: floorQuadrants(field, hives, gardenAt),
    loadingZone,
    gardenAt,
    hives,
    flowers,
    garden,
    loose: {},
    looseUnknown: false,
    tipTable,
    capacity,
    elementKind,
    nectarKind,
    humanPlayer: { RED: {}, BLUE: {} },
    humanPlayerLimits,
  };
}

/**
 * The four quarters of the floor, named for the alliance whose half each is in and whether it is
 * that alliance's garden side or the other side (its loading side on the BIOBUZZ field):
 * `floorRedGardenSide`, `floorRedLoadingSide`, `floorBlueGardenSide`, `floorBlueLoadingSide`.
 *
 * The split is the field's own centre lines, from `sizeIn` and the frame's origin. Which half is
 * an alliance's is where its hive's pivot is, and which quarter is its garden side is where its
 * garden elements lie, so the names follow the field file and swap correctly under the alliance
 * mirror (`floorRedGardenSide` is BLUE's `floorBlueGardenSide`).
 */
function floorQuadrants(
  field: Field,
  hives: Readonly<Record<string, HiveState>>,
  gardenAt: Readonly<Record<string, { xIn: number; yIn: number }>>,
): Record<string, AreaState> {
  const bounds = fieldBounds(field);
  const midX = (bounds.minXIn + bounds.maxXIn) / 2;
  const midY = (bounds.minYIn + bounds.maxYIn) / 2;
  const sign = (value: number, fallback: 1 | -1): 1 | -1 => (value > 0 ? 1 : value < 0 ? -1 : fallback);
  const areas: Record<string, AreaState> = {};
  for (const alliance of ["RED", "BLUE"] as const) {
    const fallback: 1 | -1 = alliance === "RED" ? -1 : 1;
    const hive = Object.values(hives).find((candidate) => candidate.alliance === alliance);
    const xSign = sign((hive?.pivotIn.xIn ?? fallback) - midX, fallback);
    const own = Object.entries(gardenAt).filter(([id]) => allianceOf(id) === alliance);
    const meanY = own.length === 0 ? fallback : own.reduce((sum, [, at]) => sum + at.yIn, 0) / own.length - midY;
    const gardenSign = sign(meanY, fallback);
    const word = alliance === "RED" ? "Red" : "Blue";
    for (const [side, ySign] of [
      ["GardenSide", gardenSign],
      ["LoadingSide", -gardenSign as 1 | -1],
    ] as const) {
      const id = `floor${word}${side}`;
      areas[id] = {
        id,
        alliance,
        minXIn: xSign < 0 ? bounds.minXIn : midX,
        maxXIn: xSign < 0 ? midX : bounds.maxXIn,
        minYIn: ySign < 0 ? bounds.minYIn : midY,
        maxYIn: ySign < 0 ? midY : bounds.maxYIn,
        holds: {},
      };
    }
  }
  return areas;
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

/**
 * Where a hive's cell sits in plan: half the outer-face distance out from the pivot, on the side
 * the cell faces (the up cell's side when `up`, the other side otherwise). It is the point
 * TURRET_RANGE aims the up cell at and where the field draws the cell's count.
 */
export function cellPoint(hive: HiveState, up: boolean): { xIn: number; yIn: number } {
  const side = up ? hive.upSide : oppositeSide(hive.upSide);
  const sign = side === "SOUTH" || side === "WEST" ? -1 : 1;
  const middle = sign * (hive.outerFaceIn / 2);
  return hive.axis === "x"
    ? { xIn: hive.pivotIn.xIn + middle, yIn: hive.pivotIn.yIn }
    : { xIn: hive.pivotIn.xIn, yIn: hive.pivotIn.yIn + middle };
}

/** True when a point lies in an area's box, its edges included. */
export const inArea = (area: AreaState, point: { xIn: number; yIn: number }): boolean =>
  point.xIn >= area.minXIn && point.xIn <= area.maxXIn && point.yIn >= area.minYIn && point.yIn <= area.maxYIn;

/** The floor quarter a point lies in, or null when it is off the floor the ledger splits. */
export function floorAreaAt(state: BiobuzzState, point: { xIn: number; yIn: number }): AreaState | null {
  return Object.values(state.floor).find((area) => inArea(area, point)) ?? null;
}

/**
 * The floor quarter a hive's cell is over: the up cell's when `up`, the down cell's otherwise. A
 * robot scores into the up cell only from this quarter (owner, 2026-10-03, issue #95), and a tip
 * dumps the cell that swings down into the quarter on its own side (DSim
 * `spillPoses`).
 */
export const cellArea = (state: BiobuzzState, hive: HiveState, up: boolean): AreaState | null =>
  floorAreaAt(state, cellPoint(hive, up));

/** The routine's own hive, or undefined when the field file has none for its alliance. */
export const ownHive = (state: BiobuzzState): HiveState | undefined =>
  Object.values(state.hives).find((hive) => hive.alliance === state.alliance);

/**
 * True when `kind` is the other alliance's nectar. No robot may control it (G408; DSim
 * `bbIntakeAccepts`), and only an alliance's own nectar goes into its
 * hive (owner, 2026-10-03, issue #95).
 */
export const isOpponentNectar = (state: BiobuzzState, kind: string): boolean => {
  const theirs = state.nectarKind[state.alliance === "RED" ? "BLUE" : "RED"];
  return theirs !== null && kind === theirs && theirs !== state.nectarKind[state.alliance];
};

/** The robot holding `order`, with its by-kind count to match. */
export const withRobotOrder = (state: BiobuzzState, order: readonly string[]): BiobuzzState => ({
  ...state,
  robotOrder: [...order],
  robotHolds: countKinds(order),
});

/** Pieces going into the robot, on top of what it holds, in `kindOrder` within the batch. */
export const pushRobot = (state: BiobuzzState, pieces: Readonly<Holds>): BiobuzzState =>
  withRobotOrder(state, [
    ...state.robotOrder,
    ...kindOrder(state, pieces).flatMap((kind) => Array.from({ length: pieces[kind] ?? 0 }, () => kind)),
  ]);

/**
 * Up to `count` pieces off the top of the robot's stack, last in first out, taking only the kinds
 * `accept` picks: a launch or a transfer that names a kind takes the top-most pieces of that kind,
 * the way DSim's `takeHeld` takes the last held element of a colour.
 */
export function popRobot(
  state: BiobuzzState,
  count: number,
  accept: (kind: string) => boolean = () => true,
): { state: BiobuzzState; taken: Holds } {
  const order = [...state.robotOrder];
  const taken: Holds = {};
  let wanted = count;
  for (let index = order.length - 1; index >= 0 && wanted > 0; index -= 1) {
    const kind = order[index] as string;
    if (!accept(kind)) continue;
    order.splice(index, 1);
    taken[kind] = (taken[kind] ?? 0) + 1;
    wanted -= 1;
  }
  return { state: withRobotOrder(state, order), taken };
}
