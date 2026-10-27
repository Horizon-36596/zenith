import type { LedgerLocation, Pose, TransferResult } from "@horizon36596/zenith-core";
import {
  addKinds,
  cellPoint,
  columnHolds,
  isNectar,
  isOpponentNectar,
  kindOrder,
  oppositeSide,
  popRobot,
  pushRobot,
  total,
  type AreaState,
  type BiobuzzState,
  type HiveState,
  type Holds,
} from "./state.js";

/**
 * The BIOBUZZ ledger's locations: every place it counts pieces, the ids a transfer step names
 * (site/docs/file-format.md, "Transfers"), and the numbers a condition's `{ quantity }` test reads.
 *
 *   robot                    what this robot carries, a stack: the last piece in is the first out
 *   partner                  what the alliance partner carries
 *   <hive>UpCell, <hive>DownCell
 *                            the routine's own hive's two cells (`hiveRedUpCell` is the one up
 *                            now); the hive's own id (`hiveRed`) names its up cell too. The down
 *                            cell is always empty, and only a tip takes pieces out of the up cell
 *   flower0 .. flower3       a flower's column
 *   gardenRed, gardenBlue    a garden line still on the floor
 *   floorRedGardenSide ...   a quarter of the floor (state.ts, `floorQuadrants`); a tip dumps its
 *                            cell into one of these
 *   loadingZoneRed ...       an alliance's LOADING ZONE (`ledger: "loadingZone"` in `field.json`)
 *   loose                    on the floor, where is not known (a launch that did not go in)
 *   humanPlayerRed, humanPlayerBlue
 *                            the routine's own human player, a source of its own alliance's nectar
 *                            only, one per tip of its own hive and five in all (`rules.humanPlayer`)
 *   offField                 outside the ledger: a source and a sink that is never counted
 *
 * `Own` and `Opponent` may stand in for `Red` and `Blue` in any id (`hiveOwnUpCell`), read against
 * the routine's alliance. A condition may also read `<hive>.tips`, how many times a hive has tipped.
 *
 * Nectar is a game piece like pollen (owner ruling 2026-10-03): every
 * place counts both by kind. Any id may end in `.nectar` or `.<kind>` (`loose.nectar`,
 * `robot.pollen`) to mean only those pieces there, for a collect, a transfer or a condition. Zenith
 * edits one alliance's auto at a time, so the ledger follows that alliance's hive, human player and
 * nectar: the other alliance's nectar never goes into a robot or a hive (G408, and issue #95).
 */

/** The ids that are neither a hive cell nor an area, with what each is. */
const ROBOT = "robot";
const PARTNER = "partner";
const LOOSE = "loose";
const OFF_FIELD = "offField";
const HUMAN_PLAYER = "humanPlayer";

/** `hiveOwnUpCell` read for a RED routine is `hiveRedUpCell`. */
export function resolveAllianceWords(id: string, alliance: "RED" | "BLUE"): string {
  const own = alliance === "RED" ? "Red" : "Blue";
  const opponent = alliance === "RED" ? "Blue" : "Red";
  return id.split("Opponent").join(opponent).split("Own").join(own);
}

/** The garden line an element belongs to: its id without the trailing index (`gardenRed2`). */
const gardenLineOf = (elementId: string): string => elementId.replace(/\d+$/, "");

/** The cell ids of a hive: the up cell is its target's id when it has one. */
const upCellId = (hive: HiveState): string => hive.targetId ?? `${hive.id}UpCell`;
const downCellId = (hive: HiveState): string => `${hive.id}DownCell`;

const humanPlayerId = (alliance: "RED" | "BLUE"): string =>
  `${HUMAN_PLAYER}${alliance === "RED" ? "Red" : "Blue"}`;

type Place =
  | { kind: "robot" }
  | { kind: "partner" }
  | { kind: "hiveCell"; hive: HiveState; up: boolean }
  | { kind: "flower"; id: string }
  | { kind: "garden"; line: string }
  | { kind: "floor"; id: string }
  | { kind: "loadingZone"; id: string }
  | { kind: "loose" }
  | { kind: "humanPlayer"; alliance: "RED" | "BLUE" }
  | { kind: "offField" };

/** Which pieces an id's `.nectar` or `.<kind>` suffix picks, or null for every kind. */
export type KindFilter = { nectar: true } | { kind: string } | null;

const matches = (state: BiobuzzState, filter: KindFilter, kind: string): boolean =>
  filter === null || ("nectar" in filter ? isNectar(state, kind) : filter.kind === kind);

/** Splits `loose.nectar` into the place `loose` and the filter for nectar. */
export function splitKind(id: string): { placeId: string; filter: KindFilter } {
  const dot = id.lastIndexOf(".");
  if (dot <= 0 || dot === id.length - 1) return { placeId: id, filter: null };
  const suffix = id.slice(dot + 1);
  return { placeId: id.slice(0, dot), filter: suffix === "nectar" ? { nectar: true } : { kind: suffix } };
}

/**
 * A record's own entry for `id`, never one it inherits: an id such as `toString` or `constructor`
 * names nothing on the field, not a method of every object.
 */
const own = <T>(record: Readonly<Record<string, T>>, id: string): T | undefined =>
  Object.hasOwn(record, id) ? record[id] : undefined;

/** What a location id names in this state, or null when it names nothing the ledger counts. */
function placeOf(state: BiobuzzState, id: string): Place | null {
  if (id === ROBOT) return { kind: "robot" };
  if (id === PARTNER) return { kind: "partner" };
  if (id === LOOSE) return { kind: "loose" };
  if (id === OFF_FIELD) return { kind: "offField" };
  if (id === humanPlayerId("RED")) return { kind: "humanPlayer", alliance: "RED" };
  if (id === humanPlayerId("BLUE")) return { kind: "humanPlayer", alliance: "BLUE" };
  for (const hive of Object.values(state.hives)) {
    if (id === upCellId(hive) || id === hive.id) return { kind: "hiveCell", hive, up: true };
    if (id === downCellId(hive)) return { kind: "hiveCell", hive, up: false };
  }
  if (Object.hasOwn(state.flowers, id)) return { kind: "flower", id };
  if (Object.hasOwn(state.floor, id)) return { kind: "floor", id };
  if (Object.hasOwn(state.loadingZone, id)) return { kind: "loadingZone", id };
  if (Object.keys(state.garden).some((element) => gardenLineOf(element) === id)) return { kind: "garden", line: id };
  return null;
}

/** What a place holds, by kind, or null for off the field. A human player's is what it has brought in. */
function holdsAt(state: BiobuzzState, place: Place): Holds | null {
  switch (place.kind) {
    case "robot":
      return state.robotHolds;
    case "partner":
      return state.partnerHolds;
    case "hiveCell": {
      // The down cell is always empty: a cell empties as it swings down.
      const hive = state.hives[place.hive.id] ?? place.hive;
      return place.up ? hive.upCell : {};
    }
    case "flower":
      return columnHolds(own(state.flowers, place.id)?.column ?? []);
    case "garden": {
      const there = Object.entries(state.garden).filter(
        ([element, present]) => present && gardenLineOf(element) === place.line,
      ).length;
      return there === 0 ? {} : { [state.elementKind]: there };
    }
    case "floor":
      return own(state.floor, place.id)?.holds ?? {};
    case "loadingZone":
      return own(state.loadingZone, place.id)?.holds ?? {};
    case "loose":
      return state.loose;
    case "humanPlayer":
      return state.humanPlayer[place.alliance];
    case "offField":
      return null;
  }
}

/** How many pieces a place holds that the filter picks, or null for off the field. */
function countAt(state: BiobuzzState, place: Place, filter: KindFilter): number | null {
  const holds = holdsAt(state, place);
  if (holds === null) return null;
  return Object.entries(holds).reduce((sum, [kind, count]) => sum + (matches(state, filter, kind) ? count : 0), 0);
}

/** Takes up to `count` pieces the filter and `accept` pick out of a by-kind count, in `kindOrder`. */
function takeKinds(
  state: BiobuzzState,
  holds: Readonly<Holds>,
  count: number,
  filter: KindFilter,
  accept: (kind: string) => boolean,
): { left: Holds; taken: Holds } {
  const left = { ...holds };
  const taken: Holds = {};
  let wanted = count;
  for (const kind of kindOrder(state, holds)) {
    if (wanted <= 0) break;
    if (!matches(state, filter, kind) || !accept(kind)) continue;
    const have = left[kind] ?? 0;
    const take = Math.min(have, wanted);
    if (take <= 0) continue;
    taken[kind] = take;
    if (have - take <= 0) delete left[kind];
    else left[kind] = have - take;
    wanted -= take;
  }
  return { left, taken };
}

const withArea = (areas: Readonly<Record<string, AreaState>>, id: string, holds: Holds): Record<string, AreaState> => {
  const area = own(areas, id);
  if (area === undefined) return { ...areas };
  return { ...areas, [id]: { ...area, holds } };
};

/** What a take did: the new state, what came out by kind, and whether a flower's lock stopped it. */
interface Taken {
  state: BiobuzzState;
  taken: Holds;
  locked: boolean;
}

/**
 * How many nectar the routine's human player may still enter: what is left of its stock
 * (`rules.humanPlayer.nectar`, 5: Competition Manual §10.3.1 B.ii) and of its allowance of one per
 * tip of its own hive (`rules.humanPlayer.perTip`, G426.A), whichever is smaller, with the reason
 * for that limit. Null for a limit the field file does not give.
 */
export function humanPlayerRoom(
  state: BiobuzzState,
  alliance: "RED" | "BLUE",
): { room: number | null; why: string } {
  const brought = total(state.humanPlayer[alliance]);
  const { nectar, perTip } = state.humanPlayerLimits;
  const hive = Object.values(state.hives).find((candidate) => candidate.alliance === alliance);
  const tips = hive?.tips ?? 0;
  const stockLeft = nectar === null ? null : Math.max(0, nectar - brought);
  const tipLeft = perTip === null ? null : Math.max(0, perTip * tips - brought);
  const stockWhy =
    nectar === null
      ? ""
      : `it starts with ${String(nectar)} nectar (Competition Manual §10.3.1) and has entered ${String(brought)}`;
  const tipWhy =
    perTip === null
      ? ""
      : `it may enter ${String(perTip)} for each tip of ${hive?.id ?? "its hive"} (G426.A), which has tipped ${String(tips)} ${tips === 1 ? "time" : "times"}, and it has entered ${String(brought)}`;
  if (stockLeft === null && tipLeft === null) return { room: null, why: "" };
  if (tipLeft === null || (stockLeft !== null && stockLeft <= tipLeft)) return { room: stockLeft, why: stockWhy };
  return { room: tipLeft, why: tipWhy };
}

/**
 * Takes up to `count` pieces the filter and `accept` pick out of a place. A flower gives only from
 * the bottom of its column, and only the kinds its retrieval opening lets out, so a nectar at the
 * bottom stops it. The robot gives from the top of its stack. A hive cell gives nothing. A human
 * player gives its alliance's nectar, as many as its stock and its per-tip allowance leave room for
 * (`humanPlayerRoom`).
 */
function takeFrom(
  state: BiobuzzState,
  place: Place,
  count: number,
  filter: KindFilter,
  accept: (kind: string) => boolean,
): Taken {
  const none = (value: BiobuzzState): Taken => ({ state: value, taken: {}, locked: false });
  switch (place.kind) {
    case "robot": {
      const popped = popRobot(state, count, (kind) => matches(state, filter, kind) && accept(kind));
      return { state: popped.state, taken: popped.taken, locked: false };
    }
    case "partner": {
      const { left, taken } = takeKinds(state, state.partnerHolds, count, filter, accept);
      return { state: { ...state, partnerHolds: left }, taken, locked: false };
    }
    case "flower": {
      const flower = own(state.flowers, place.id);
      if (flower === undefined) return none(state);
      const column = [...flower.column];
      const taken: Holds = {};
      let locked = false;
      for (let left = count; left > 0 && column.length > 0; left -= 1) {
        const bottom = column[0] as string;
        if (!flower.takes.includes(bottom)) {
          locked = true;
          break;
        }
        if (!matches(state, filter, bottom) || !accept(bottom)) break;
        column.shift();
        taken[bottom] = (taken[bottom] ?? 0) + 1;
      }
      return { state: { ...state, flowers: { ...state.flowers, [place.id]: { ...flower, column } } }, taken, locked };
    }
    case "hiveCell":
      // Only a tip takes pieces out of a cell (manual G417; DSim `capturePollen` takes only pieces
      // on the ground).
      return none(state);
    case "garden": {
      if (!matches(state, filter, state.elementKind) || !accept(state.elementKind)) return none(state);
      const there = Object.keys(state.garden)
        .filter((element) => state.garden[element] === true && gardenLineOf(element) === place.line)
        .slice(0, count);
      const garden = { ...state.garden };
      for (const element of there) garden[element] = false;
      return {
        state: { ...state, garden },
        taken: there.length === 0 ? {} : { [state.elementKind]: there.length },
        locked: false,
      };
    }
    case "floor": {
      const { left, taken } = takeKinds(state, own(state.floor, place.id)?.holds ?? {}, count, filter, accept);
      return { state: { ...state, floor: withArea(state.floor, place.id, left) }, taken, locked: false };
    }
    case "loadingZone": {
      const { left, taken } = takeKinds(state, own(state.loadingZone, place.id)?.holds ?? {}, count, filter, accept);
      return { state: { ...state, loadingZone: withArea(state.loadingZone, place.id, left) }, taken, locked: false };
    }
    case "loose": {
      const { left, taken } = takeKinds(state, state.loose, count, filter, accept);
      return { state: { ...state, loose: left }, taken, locked: false };
    }
    case "humanPlayer": {
      const kind = state.nectarKind[place.alliance];
      if (kind === null || count <= 0 || !matches(state, filter, kind)) return none(state);
      const { room } = humanPlayerRoom(state, place.alliance);
      const entered = room === null ? count : Math.min(count, room);
      if (entered <= 0) return none(state);
      const brought = { [kind]: entered };
      return {
        state: { ...state, humanPlayer: { ...state.humanPlayer, [place.alliance]: addKinds(state.humanPlayer[place.alliance], brought) } },
        taken: brought,
        locked: false,
      };
    }
    case "offField": {
      // Off the field is the author's own source: it gives the kind the id names, the routine's
      // own nectar for `.nectar`, and the field's element kind otherwise.
      const kind =
        filter === null ? state.elementKind : "nectar" in filter ? state.nectarKind[state.alliance] : filter.kind;
      return { state, taken: kind === null || count <= 0 ? {} : { [kind]: count }, locked: false };
    }
  }
}

/** What `rules.ts` lends this file: the hive's own rules, passed in so the two files do not import each other. */
export interface HiveRules {
  settle: (state: BiobuzzState, hiveId: string) => BiobuzzState;
  scoresFrom: (state: BiobuzzState, hive: HiveState, pose: Pose | undefined) => boolean;
  intoUpCell: (state: BiobuzzState, hive: HiveState, pieces: Readonly<Holds>, scores: boolean) => BiobuzzState;
}

/**
 * Puts pieces into a place. A flower takes them in at the top of its column, the robot on top of
 * its stack. A hive's up cell takes them when `scores` (`HiveRules.intoUpCell`), and then tips if
 * it holds enough; whatever does not go in lands loose.
 */
function putInto(
  state: BiobuzzState,
  place: Place,
  pieces: Readonly<Holds>,
  scores: boolean,
  hiveRules: HiveRules,
): BiobuzzState {
  switch (place.kind) {
    case "robot":
      return pushRobot(state, pieces);
    case "partner":
      return { ...state, partnerHolds: addKinds(state.partnerHolds, pieces) };
    case "flower": {
      const flower = own(state.flowers, place.id);
      if (flower === undefined) return state;
      const added = kindOrder(state, pieces).flatMap((kind) => Array.from({ length: pieces[kind] ?? 0 }, () => kind));
      return { ...state, flowers: { ...state.flowers, [place.id]: { ...flower, column: [...flower.column, ...added] } } };
    }
    case "hiveCell":
      return place.up ? hiveRules.intoUpCell(state, place.hive, pieces, scores) : state;
    case "floor":
      return { ...state, floor: withArea(state.floor, place.id, addKinds(own(state.floor, place.id)?.holds ?? {}, pieces)) };
    case "loadingZone":
      return {
        ...state,
        loadingZone: withArea(state.loadingZone, place.id, addKinds(own(state.loadingZone, place.id)?.holds ?? {}, pieces)),
      };
    case "loose":
      return { ...state, loose: addKinds(state.loose, pieces), looseUnknown: state.looseUnknown || total(pieces) > 0 };
    case "garden":
    case "humanPlayer":
    case "offField":
      return state;
  }
}

/**
 * The ids a transfer may name in this state, in the order the editor lists them: the routine's own
 * hive cells and human player, not the other alliance's.
 */
export function locationIds(state: BiobuzzState, alliance: "RED" | "BLUE" = state.alliance): string[] {
  const ids = [ROBOT, PARTNER];
  for (const hive of Object.values(state.hives)) {
    if (hive.alliance === alliance) ids.push(upCellId(hive), downCellId(hive));
  }
  ids.push(...Object.keys(state.flowers));
  ids.push(...[...new Set(Object.keys(state.garden).map(gardenLineOf))]);
  ids.push(...Object.keys(state.floor), ...Object.keys(state.loadingZone), LOOSE);
  if (state.nectarKind[alliance] !== null) ids.push(humanPlayerId(alliance));
  ids.push(OFF_FIELD);
  return ids;
}

const lockedSentence = (flowerId: string): string =>
  `${flowerId} is locked: a nectar is at the bottom of its column, and its retrieval opening lets out only what the field file lists, so nothing comes out until the nectar is gone.`;

/**
 * A transfer step: up to `count` pieces from one place to another, as the author says happens.
 * The source gives what it has, so a transfer from an empty place moves nothing and says so; a
 * garden line is only ever a source, because nothing puts a piece back on one.
 *
 * The hive: nothing comes out of a cell (only a tip empties it), nothing goes into the down cell,
 * and only the routine's own hive is followed. Pieces from this robot go into the up cell only
 * when `pose`, where the robot is, is in the up cell's quarter of the field, and land loose
 * otherwise (owner, 2026-10-03, issue #95); pieces from anywhere else are the author's word. The
 * other alliance's nectar never goes into a robot or a hive (G408).
 *
 * The human player: only the routine's own, only its own alliance's nectar, only into its own
 * loading zone (G427.C), and only as many as its stock and its allowance of one per tip of its own
 * hive leave (§10.3.1, G426.A).
 */
export function transferPieces(
  state: BiobuzzState,
  from: string,
  to: string,
  count: number,
  alliance: "RED" | "BLUE",
  pose: Pose | undefined,
  hiveRules: HiveRules,
): TransferResult {
  const current: BiobuzzState = state.alliance === alliance ? state : { ...state, alliance };
  const fromSplit = splitKind(resolveAllianceWords(from, alliance));
  const toId = resolveAllianceWords(to, alliance);
  const fromId = fromSplit.placeId;
  const opaque = (value: BiobuzzState): TransferResult["state"] => value as unknown as TransferResult["state"];
  const refuse = (problem: string): TransferResult => ({ state: opaque(state), moved: 0, problem });
  const source = placeOf(current, fromId);
  const target = placeOf(current, toId);
  const known = locationIds(current, alliance).join(", ");
  if (source === null) return refuse(`${JSON.stringify(from)} is not a place the ledger counts; use one of ${known}.`);
  if (target === null) return refuse(`${JSON.stringify(to)} is not a place the ledger counts; use one of ${known}.`);
  if (fromId === toId) return refuse(`This transfer moves pieces from ${fromId} to itself.`);
  if (target.kind === "garden") {
    return refuse(
      `Nothing puts a piece back on a garden line; move it to a floor quarter such as ${Object.keys(current.floor)[0] ?? "loose"} instead.`,
    );
  }
  if (target.kind === "humanPlayer") {
    return refuse(`${toId} is a human player, which only brings pieces in; move them to a place on the field instead.`);
  }
  if (source.kind === "hiveCell") {
    return refuse(
      `Nothing takes pieces out of ${fromId}: only a tip empties a hive cell, and it dumps the whole cell onto the floor on that cell's side.`,
    );
  }
  if (target.kind === "hiveCell") {
    if (target.hive.alliance !== alliance) {
      return refuse(
        `The ledger follows ${alliance}'s own hive, and only ${alliance}'s pieces go into it; ${toId} is the other alliance's.`,
      );
    }
    if (!target.up) {
      return refuse(
        `${toId} is the down cell, which is always empty: pieces go into a hive only by launching into the up cell, ${upCellId(target.hive)}.`,
      );
    }
  }
  if (source.kind === "humanPlayer") {
    if (source.alliance !== alliance) {
      return refuse(`The ledger follows ${alliance}'s own human player only; ${fromId} is the other alliance's.`);
    }
    const zone = target.kind === "loadingZone" ? current.loadingZone[target.id] : undefined;
    if (zone === undefined || zone.alliance !== source.alliance) {
      const own = Object.values(current.loadingZone).find((area) => area.alliance === source.alliance)?.id ?? "its loading zone";
      return refuse(`A human player brings nectar in only through its own alliance's loading zone, so ${fromId} can move pieces only to ${own}.`);
    }
    if (current.nectarKind[source.alliance] === null) {
      return refuse(`The field file stages no nectar for ${source.alliance}, so ${fromId} has none to bring in.`);
    }
  }

  // The other alliance's nectar never goes into a robot (G408) or this alliance's hive (issue #95).
  const guarded = target.kind === "robot" || target.kind === "partner" || target.kind === "hiveCell";
  const accept = (kind: string): boolean => !guarded || !isOpponentNectar(current, kind);
  const named = fromSplit.filter;
  if (guarded && named !== null && "kind" in named && isOpponentNectar(current, named.kind)) {
    return refuse(
      `${named.kind} is the other alliance's nectar: a robot may not control it (G408) and it never goes into ${alliance}'s hive.`,
    );
  }

  const wanted = Math.max(0, count);
  const taken = takeFrom(current, source, wanted, fromSplit.filter, accept);
  const moved = total(taken.taken);
  if (moved === 0 && taken.locked && source.kind === "flower") {
    return { state: opaque(state), moved: 0, problem: lockedSentence(source.id) };
  }
  // This robot's pieces score from where it stands; anyone else's are the author's word.
  const scores =
    target.kind === "hiveCell" ? hiveRules.scoresFrom(taken.state, target.hive, source.kind === "robot" ? pose : undefined) : true;
  const next = putInto(taken.state, target, taken.taken, scores, hiveRules);
  if (source.kind === "humanPlayer" && moved < wanted) {
    const { why } = humanPlayerRoom(current, source.alliance);
    return {
      state: opaque(next),
      moved,
      problem: `${fromId} can enter ${String(moved)} of the ${String(wanted)} nectar asked for here: ${why}.`,
    };
  }
  return { state: opaque(next), moved };
}

/**
 * A robot intake: up to `count` pieces out of a place and into the top of the robot's stack,
 * nectar the same as pollen, but never the other alliance's nectar (G408). The place is any
 * location id, a garden element's id or a prefix of the garden's ids, each optionally ending in
 * `.nectar` or `.<kind>`. The robot, the partner, a hive cell, a human player and off the field are
 * not places an intake reaches, so they give nothing.
 */
export function collectPieces(state: BiobuzzState, containerId: string, count: number): BiobuzzState {
  if (count <= 0) return state;
  const { placeId, filter } = splitKind(containerId);
  const place = placeOf(state, placeId);
  const accept = (kind: string): boolean => !isOpponentNectar(state, kind);
  if (place !== null) {
    if (
      place.kind === "robot" ||
      place.kind === "partner" ||
      place.kind === "hiveCell" ||
      place.kind === "humanPlayer" ||
      place.kind === "offField"
    ) {
      return state;
    }
    const taken = takeFrom(state, place, count, filter, accept);
    if (total(taken.taken) === 0) return state;
    return pushRobot(taken.state, taken.taken);
  }

  // A garden element by its own id, or every garden element whose id starts with the name given.
  if (!matches(state, filter, state.elementKind)) return state;
  const gardenIds = Object.keys(state.garden).filter(
    (id) => (id === placeId || id.startsWith(placeId)) && state.garden[id] === true,
  );
  if (gardenIds.length === 0) return state;
  const taken = gardenIds.slice(0, count);
  const garden = { ...state.garden };
  for (const id of taken) garden[id] = false;
  return pushRobot({ ...state, garden }, { [state.elementKind]: taken.length });
}

/**
 * A number the ledger keeps, for a condition's quantity test: a location's count, the count of
 * one kind there (`loose.nectar`), or `<hive>.tips`. Null for off the field and for anything the
 * ledger does not keep.
 */
export function measureQuantity(state: BiobuzzState, quantity: string, alliance: "RED" | "BLUE"): number | null {
  const id = resolveAllianceWords(quantity, alliance);
  if (id.endsWith(".tips")) {
    return state.hives[id.slice(0, -".tips".length)]?.tips ?? null;
  }
  const { placeId, filter } = splitKind(id);
  const place = placeOf(state, placeId);
  return place === null ? null : countAt(state, place, filter);
}

const allianceWord = (alliance: "RED" | "BLUE"): string => (alliance === "RED" ? "RED" : "BLUE");

const centreOf = (area: AreaState): { xIn: number; yIn: number } => ({
  xIn: (area.minXIn + area.maxXIn) / 2,
  yIn: (area.minYIn + area.maxYIn) / 2,
});

/**
 * Every location with its count now, by kind too, for the transfer editor and the field's count
 * badges: the routine's own hive and human player, not the other alliance's.
 */
export function listLocations(state: BiobuzzState, alliance: "RED" | "BLUE" = state.alliance): LedgerLocation[] {
  const at = (place: Place): { count: number; holds: Holds } => {
    const holds = { ...(holdsAt(state, place) ?? {}) };
    return { count: total(holds), holds };
  };
  const locations: LedgerLocation[] = [
    { id: ROBOT, label: "this robot", kind: "robot", ...at({ kind: "robot" }), atIn: null },
    { id: PARTNER, label: "alliance partner", kind: "partner", ...at({ kind: "partner" }), atIn: null },
  ];
  for (const hive of Object.values(state.hives)) {
    if (hive.alliance !== alliance) continue;
    locations.push(
      {
        id: upCellId(hive),
        label: `${hive.id} up cell (${hive.upSide.toLowerCase()})`,
        kind: "hiveCell",
        ...at({ kind: "hiveCell", hive, up: true }),
        atIn: cellPoint(hive, true),
      },
      {
        id: downCellId(hive),
        label: `${hive.id} down cell (${oppositeSide(hive.upSide).toLowerCase()}, always empty)`,
        kind: "hiveCell",
        ...at({ kind: "hiveCell", hive, up: false }),
        atIn: cellPoint(hive, false),
      },
    );
  }
  for (const flower of Object.values(state.flowers)) {
    locations.push({
      id: flower.id,
      label: flower.id,
      kind: "flower",
      ...at({ kind: "flower", id: flower.id }),
      atIn: { xIn: flower.xIn, yIn: flower.yIn },
    });
  }
  const lines = [...new Set(Object.keys(state.garden).map(gardenLineOf))];
  for (const line of lines) {
    const members = Object.keys(state.gardenAt).filter((element) => gardenLineOf(element) === line);
    const points = members.map((element) => state.gardenAt[element] as { xIn: number; yIn: number });
    locations.push({
      id: line,
      label: `${line} line`,
      kind: "garden",
      ...at({ kind: "garden", line }),
      atIn:
        points.length === 0
          ? null
          : {
              xIn: points.reduce((sum, point) => sum + point.xIn, 0) / points.length,
              yIn: points.reduce((sum, point) => sum + point.yIn, 0) / points.length,
            },
    });
  }
  for (const area of Object.values(state.floor)) {
    const side = area.id.endsWith("GardenSide") ? "garden side" : "loading side";
    locations.push({
      id: area.id,
      label: `floor, ${allianceWord(area.alliance)} ${side}`,
      kind: "floor",
      ...at({ kind: "floor", id: area.id }),
      atIn: centreOf(area),
    });
  }
  for (const area of Object.values(state.loadingZone)) {
    locations.push({
      id: area.id,
      label: `${allianceWord(area.alliance)} loading zone`,
      kind: "loadingZone",
      ...at({ kind: "loadingZone", id: area.id }),
      atIn: centreOf(area),
    });
  }
  locations.push({ id: LOOSE, label: "loose, place unknown", kind: "loose", ...at({ kind: "loose" }), atIn: null });
  if (state.nectarKind[alliance] !== null) {
    // A source, like off the field, so it has no count on the field: what it has brought in is in
    // its holds, in the ledger's rows, and in a condition's `humanPlayerOwn` quantity.
    locations.push({
      id: humanPlayerId(alliance),
      label: `${allianceWord(alliance)} human player (brings nectar in, one per tip)`,
      kind: "humanPlayer",
      count: null,
      holds: { ...state.humanPlayer[alliance] },
      atIn: null,
    });
  }
  locations.push({ id: OFF_FIELD, label: "off the field (not counted)", kind: "offField", count: null, atIn: null });
  return locations;
}
