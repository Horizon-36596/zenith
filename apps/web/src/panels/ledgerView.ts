/**
 * What the Ledger panel draws, worked out from one ledger run (UI_GUIDE section 9.8): the strip at
 * the top that follows the playhead (what the robot carries and how full our hive's up cell is),
 * one line per step that moved pieces, and where every piece lies once the auto ends. A step's line
 * is a list of flows, each the same pattern, from a place to a place with the pieces that went: a
 * collect is a flower, garden or floor quarter to the robot, a shot the robot to the hive (or to
 * loose when it missed), a tip the hive to the floor quarter it dumped onto, and a transfer its two
 * ends. Counts are split by piece (`fieldCounts.ts` `countParts`), so the panel draws them with the
 * same glyphs as the field.
 *
 * A step has changed the counts once it has ended on the playback level's clock, the one the step
 * list's highlight uses (`useLedgerPhases.ts`). Pure: nothing here reads a clock.
 */
import {
  ledgerLocations,
  ledgerStateAfter,
  type LedgerEntry,
  type LedgerLocation,
  type LedgerRun,
  type SeasonRules,
  type SeasonState,
} from "@horizon36596/zenith-core";
import {
  asBiobuzzState,
  nectarIn,
  ownHive,
  pollenToTip,
  resolveAllianceWords,
  total,
} from "@horizon36596/zenith-season-biobuzz";
import { countParts, type CountPart } from "../canvas/fieldCounts";
import { ledgerRowText } from "./ledgerRowText";
import { collectedByKind } from "./ledgerSummary";

type Alliance = "RED" | "BLUE";
type Holds = Readonly<Record<string, number>>;

/** One end of a flow: a place on or off the field, with the short name the panel shows. */
export interface FlowEnd {
  id: string;
  /** The location's kind (`LedgerLocation.kind`), which picks the icon; `place` when the ledger does not list it. */
  kind: string;
  label: string;
}

/**
 * Pieces that went from one place to another in one step. `collect` is into the robot, `score` a
 * shot that went where it was aimed, `miss` a shot that landed loose, `tip` a hive dumping its up
 * cell, `transfer` a transfer step (`problem` says why it moved nothing, when it did not).
 */
export interface LedgerFlow {
  what: "collect" | "score" | "miss" | "tip" | "transfer";
  from: FlowEnd;
  to: FlowEnd;
  parts: CountPart[];
  count: number;
  /** For a tip: whose hive tipped. */
  whose?: "own" | "opponent";
  problem?: string | null;
}

/** One step that moved pieces, as the panel's step list shows it. */
export interface LedgerStepLine {
  stepId: string;
  flows: LedgerFlow[];
  /** What the robot holds once the step has run, and how many that is. */
  holds: CountPart[];
  held: number;
  /** Pieces collected and launched, for the folded summary's totals and the tests. */
  collected: number;
  launched: number;
  /** The step's row in words (`03` section 6), shown as the line's hint. */
  words: string;
}

/** Where a step is relative to the playhead. `idle` is every step while there is no playhead. */
export type StepPhase = "idle" | "done" | "now" | "next";

/** Our hive's up cell at one moment. */
export interface HiveNow {
  id: string;
  upCell: CountPart[];
  /**
   * The pollen and nectar in the up cell, and the pollen it takes to tip with that nectar there.
   * Nectar is heavier, so each nectar in the cell lowers what it takes (the field's tip table, 8
   * pollen with none down to none at all with 5).
   */
  pollen: number;
  nectar: number;
  needed: number | null;
  /** What the same cell would take with no nectar in it, the tip table's first row. */
  neededWithout: number | null;
  tips: number;
}

/** The strip at the top of the panel: the robot and our hive at the playhead. */
export interface LedgerNow {
  robot: CountPart[];
  held: number;
  /** The robot's pieces bottom first, one kind per piece, for the hopper's slots. */
  hopper: string[];
  hive: HiveNow | null;
}

/** A place that holds pieces at the end of the auto. */
export interface LedgerPlace {
  id: string;
  label: string;
  parts: CountPart[];
  count: number;
  /** The end row in words, for the hint. */
  words: string;
}

export interface LedgerEnd {
  robot: LedgerPlace;
  hive: (HiveNow & { words: string }) | null;
  /** Every flower, empty ones too, so a flower the auto emptied reads as 0. */
  flowers: LedgerPlace[];
  /** Every other counted place that holds a piece, in the season's order. */
  others: LedgerPlace[];
}

const sum = (holds: Holds): number => Object.values(holds).reduce((all, count) => all + Math.max(0, count), 0);

const partsOf = (holds: Holds, alliance: Alliance): CountPart[] => countParts({ count: sum(holds), holds }, alliance);

/** What the robot holds in `state`, by kind, or the robot location's count when the season gives no split. */
function robotHolds(state: SeasonState, season: SeasonRules, alliance: Alliance): Holds {
  if (season.holds !== undefined) return season.holds(state);
  const robot = ledgerLocations(state, season, alliance).find((location) => location.kind === "robot");
  return robot?.holds ?? (robot?.count == null ? {} : { pieces: robot.count });
}

/** The pieces counted as loose (on the floor, place unknown), where a shot that misses lands. */
const looseCount = (locations: readonly LedgerLocation[]): number =>
  locations.find((location) => location.kind === "loose")?.count ?? 0;

/**
 * The kinds a step launched: the kinds whose count in the robot fell, with what the same step
 * collected added back. When that does not add up to the launched count, the one kind the robot held
 * takes all of it, or else the pieces are counted without a kind.
 */
function launchedByKind(before: Holds, after: Holds, collected: ReadonlyMap<string, number>, launched: number): Holds {
  const kinds = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const out: Record<string, number> = {};
  for (const kind of kinds) {
    const fell = (before[kind] ?? 0) - (after[kind] ?? 0) + (collected.get(kind) ?? 0);
    if (fell > 0) out[kind] = fell;
  }
  if (sum(out) === launched) return out;
  const held = Object.keys(before).filter((kind) => (before[kind] ?? 0) > 0);
  return held.length === 1 && held[0] !== undefined ? { [held[0]]: launched } : { pieces: launched };
}

/** How one location's holds changed, by kind, counting only what it gained. */
function gained(before: LedgerLocation | undefined, after: LedgerLocation | undefined): Holds {
  const out: Record<string, number> = {};
  const was = before?.holds ?? {};
  for (const [kind, count] of Object.entries(after?.holds ?? {})) {
    const more = count - (was[kind] ?? 0);
    if (more > 0) out[kind] = more;
  }
  return out;
}

/** `held` with `taken` taken out, by kind. */
function minus(held: Holds, taken: Holds): Holds {
  const out: Record<string, number> = {};
  for (const [kind, count] of Object.entries(held)) {
    const left = count - (taken[kind] ?? 0);
    if (left > 0) out[kind] = left;
  }
  return out;
}

const COLOUR_WORD: Readonly<Record<string, string>> = { Red: "red", Blue: "blue" };

/**
 * The short name of a place, as a flow shows it: `flower 1`, `red garden`, `floor, garden side`,
 * `hive`. The routine's own alliance goes unsaid on a floor quarter or a loading zone, and the
 * other alliance's is named.
 */
function placeLabel(id: string, kind: string, alliance: Alliance): string {
  const own = alliance === "RED" ? "Red" : "Blue";
  const whose = (word: string): string => (word === own ? "" : `${COLOUR_WORD[word] ?? word} `);
  switch (kind) {
    case "robot":
      return "robot";
    case "partner":
      return "partner";
    case "hiveCell":
      return id.endsWith("DownCell") ? "hive down cell" : "hive";
    case "flower":
      return id.replace(/^flower(\d+)$/, "flower $1");
    case "garden":
      return id.replace(/^garden(Red|Blue)$/, (_, word: string) => `${COLOUR_WORD[word] ?? word} garden`);
    case "floor":
      return id.replace(
        /^floor(Red|Blue)(Garden|Loading)Side$/,
        (_, word: string, by: string) => `${whose(word)}floor, ${by.toLowerCase()} side`,
      );
    case "loadingZone":
      return id.replace(/^loadingZone(Red|Blue)$/, (_, word: string) => `${whose(word)}loading zone`);
    case "loose":
      return "loose";
    case "humanPlayer":
      return "human player";
    case "offField":
      return "off the field";
    default:
      return id;
  }
}

/** The place an id names (`flower1`, `floorRedGardenSide.nectar`, `hiveOwnUpCell`), among `locations`. */
function endOf(id: string, locations: readonly LedgerLocation[], alliance: Alliance): FlowEnd {
  const dot = id.lastIndexOf(".");
  const placeId = resolveAllianceWords(dot > 0 ? id.slice(0, dot) : id, alliance);
  const location = locations.find((candidate) => candidate.id === placeId);
  const kind = location?.kind ?? "place";
  return { id: placeId, kind, label: placeLabel(placeId, kind, alliance) };
}

const ROBOT: FlowEnd = { id: "robot", kind: "robot", label: "robot" };
const MISSED: FlowEnd = { id: "loose", kind: "loose", label: "missed" };

/** What each step that moved pieces did, in the ledger's own order, as flows from place to place. */
export function ledgerStepLines(run: LedgerRun, season: SeasonRules, alliance: Alliance): LedgerStepLine[] {
  const lines: LedgerStepLine[] = [];
  for (const entry of run.entries) {
    if (entry.row === null) continue;
    const before = robotHolds(entry.before, season, alliance);
    const after = robotHolds(entry.after, season, alliance);
    const beforeAt = ledgerLocations(entry.before, season, alliance);
    const afterAt = ledgerLocations(entry.after, season, alliance);
    const places = [...afterAt, ...beforeAt];
    const flow = (
      what: LedgerFlow["what"],
      from: FlowEnd,
      to: FlowEnd,
      holds: Holds,
      extra: Partial<LedgerFlow> = {},
    ): LedgerFlow => ({ what, from, to, parts: partsOf(holds, alliance), count: sum(holds), ...extra });
    const flows: LedgerFlow[] = [];
    const collected =
      entry.collected === null
        ? new Map<string, number>()
        : season.holds === undefined
          ? new Map([["pieces", entry.collected.count]])
          : collectedByKind(before, entry);
    if (entry.transfer !== null) flows.push(transferFlow(entry, beforeAt, afterAt, alliance));
    if (entry.launched > 0) {
      const shot = launchedByKind(before, after, collected, entry.launched);
      // A shot that misses lands loose: what the loose pieces gained, and no more than was shot.
      const missedCount = Math.min(entry.launched, Math.max(0, looseCount(afterAt) - looseCount(beforeAt)));
      const missedKinds = gained(
        beforeAt.find((location) => location.kind === "loose"),
        afterAt.find((location) => location.kind === "loose"),
      );
      const missed = sum(missedKinds) === missedCount ? missedKinds : missedCount > 0 ? { pieces: missedCount } : {};
      // Missed pieces of no known kind leave the made ones without a kind too.
      const madeCount = entry.launched - missedCount;
      const made = "pieces" in missed ? (madeCount > 0 ? { pieces: madeCount } : {}) : minus(shot, missed);
      const target: FlowEnd =
        entry.target === null ? { id: "target", kind: "place", label: "target" } : endOf(entry.target, places, alliance);
      if (sum(made) > 0) flows.push(flow("score", ROBOT, target, made));
      if (sum(missed) > 0) flows.push(flow("miss", ROBOT, MISSED, missed));
    }
    if (entry.collected !== null) {
      flows.push(flow("collect", endOf(entry.collected.containerId, places, alliance), ROBOT, Object.fromEntries(collected)));
    }
    // A tip the author asserted, or one the tip table predicted when the shot filled the up cell: our
    // hive to each floor quarter that gained pieces in the step, which is where the cell dumped.
    const tips = (state: SeasonState): number => hiveOf(state, alliance)?.tips ?? 0;
    const whose = entry.tipped ?? (tips(entry.after) > tips(entry.before) ? "own" : null);
    if (whose !== null) {
      const hive: FlowEnd =
        whose === "own"
          ? { id: hiveOf(entry.before, alliance)?.id ?? "hive", kind: "hiveCell", label: "hive" }
          : { id: "opponentHive", kind: "hiveCell", label: "their hive" };
      const dumps =
        whose === "own"
          ? afterAt
              .filter((location) => location.kind === "floor")
              .map((location) => ({ location, holds: gained(beforeAt.find((was) => was.id === location.id), location) }))
              .filter((dump) => sum(dump.holds) > 0)
          : [];
      if (dumps.length === 0) flows.push(flow("tip", hive, { id: "floor", kind: "floor", label: "floor" }, {}, { whose }));
      for (const dump of dumps) flows.push(flow("tip", hive, endOf(dump.location.id, places, alliance), dump.holds, { whose }));
    }
    lines.push({
      stepId: entry.stepId,
      flows,
      holds: partsOf(after, alliance),
      held: sum(after),
      collected: entry.collected === null ? 0 : sum(Object.fromEntries(collected)),
      launched: entry.launched,
      words: ledgerRowText(entry.row),
    });
  }
  return lines;
}

function transferFlow(
  entry: LedgerEntry,
  beforeAt: readonly LedgerLocation[],
  afterAt: readonly LedgerLocation[],
  alliance: Alliance,
): LedgerFlow {
  const transfer = entry.transfer;
  if (transfer === null) throw new Error("not a transfer");
  const places = [...afterAt, ...beforeAt];
  const from = endOf(transfer.from, places, alliance);
  const to = endOf(transfer.to, places, alliance);
  const moved = gained(
    beforeAt.find((location) => location.id === to.id),
    afterAt.find((location) => location.id === to.id),
  );
  const holds = sum(moved) === transfer.moved ? moved : transfer.moved > 0 ? { pieces: transfer.moved } : {};
  return { what: "transfer", from, to, parts: partsOf(holds, alliance), count: sum(holds), problem: transfer.problem };
}

/** How long past a step's end, in seconds, still counts as the end, for float noise in the clock. */
const END_SLOP_S = 1e-6;

/** The span of each step on the playback level's clock. */
export interface StepSpan {
  id: string;
  startS: number;
  endS: number;
}

/**
 * Each step's place relative to the playhead. With no playhead or no trace every step is `idle`,
 * and so is a step the clock has no timing for. A step is `done` once it has ended and `now` while
 * it runs.
 */
export function stepPhases(spans: readonly StepSpan[] | null, timeS: number | null): (stepId: string) => StepPhase {
  if (spans === null || timeS === null) return () => "idle";
  const byId = new Map(spans.map((span) => [span.id, span]));
  return (stepId) => {
    const span = byId.get(stepId);
    if (span === undefined) return "idle";
    if (span.endS <= timeS + END_SLOP_S) return "done";
    return span.startS <= timeS ? "now" : "next";
  };
}

/** The pieces in the robot bottom first, one kind per piece, from the season's own order when it keeps one. */
function hopperOf(state: SeasonState, holds: Holds, alliance: Alliance): string[] {
  const order = asBiobuzzState(state)?.robotOrder;
  if (order !== undefined && order.length === sum(holds)) return [...order];
  return partsOf(holds, alliance).flatMap((part) => Array.from({ length: part.count }, () => part.kind));
}

function hiveOf(state: SeasonState, alliance: Alliance): HiveNow | null {
  const biobuzz = asBiobuzzState(state);
  if (biobuzz === null) return null;
  const hive = ownHive(biobuzz);
  if (hive === undefined) return null;
  return {
    id: hive.id,
    upCell: partsOf(hive.upCell, alliance),
    pollen: total(hive.upCell) - nectarIn(biobuzz, hive.upCell),
    nectar: nectarIn(biobuzz, hive.upCell),
    needed: pollenToTip(biobuzz, hive),
    neededWithout: biobuzz.tipTable[0] ?? null,
    tips: hive.tips,
  };
}

/** The robot and our hive once every step `finished` says has run. */
export function ledgerNow(
  run: LedgerRun,
  season: SeasonRules,
  alliance: Alliance,
  finished: (stepId: string) => boolean,
): LedgerNow {
  const state = ledgerStateAfter(run, finished);
  const holds = robotHolds(state, season, alliance);
  return { robot: partsOf(holds, alliance), held: sum(holds), hopper: hopperOf(state, holds, alliance), hive: hiveOf(state, alliance) };
}

/** Where every piece lies at the end of the auto. */
export function ledgerEnd(run: LedgerRun, season: SeasonRules, alliance: Alliance): LedgerEnd {
  const state = run.finalState;
  const words = new Map<string, string>();
  for (const row of run.rows) if (row.stepId === "end") words.set(row.label, ledgerRowText(row));
  const place = (location: LedgerLocation, label = location.label): LedgerPlace => {
    const holds = location.holds ?? (location.count === null ? {} : { pieces: location.count });
    return {
      id: location.id,
      label,
      parts: partsOf(holds, alliance),
      count: sum(holds),
      words: words.get(location.id) ?? label,
    };
  };
  const locations = ledgerLocations(state, season, alliance);
  const robotAt = locations.find((location) => location.kind === "robot");
  const holds = robotHolds(state, season, alliance);
  const robot: LedgerPlace = robotAt === undefined
    ? { id: "robot", label: "robot", parts: partsOf(holds, alliance), count: sum(holds), words: words.get("robot") ?? "robot" }
    : place(robotAt, "robot");
  const hive = hiveOf(state, alliance);
  const others: LedgerPlace[] = [];
  for (const location of locations) {
    if (["robot", "hiveCell", "flower", "offField"].includes(location.kind)) continue;
    const label =
      location.kind === "humanPlayer"
        ? "human player brought in"
        : location.kind === "garden"
          ? location.label.replace(/^garden(Red|Blue) line$/, (_, side: string) => `${side.toLowerCase()} garden`)
          : location.label;
    const shown = place(location, label);
    if (shown.count > 0) others.push(shown);
  }
  return {
    robot,
    hive: hive === null ? null : { ...hive, words: words.get(hive.id) ?? hive.id },
    flowers: locations.filter((location) => location.kind === "flower").map((location) => place(location)),
    others,
  };
}
