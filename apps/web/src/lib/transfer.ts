/**
 * The words and choices the editor shows for a planner-only transfer step: what it moves in a
 * sentence, the places the season's ledger counts for its two ends, and the ends a new transfer
 * starts with.
 */
import { transferCount, type Field, type TransferStep } from "@horizon36596/zenith-schema";
import type { LedgerLocation, SeasonRules } from "@horizon36596/zenith-core";

/** "3 from partner to hiveRedUpCell", or "0 of 3 expected from partner to hiveRedUpCell". */
export function transferWords(step: TransferStep): string {
  const actual = transferCount(step);
  const count = actual === step.expectedCount ? String(actual) : `${String(actual)} of ${String(step.expectedCount)} expected`;
  return `${count} ${actual === 1 && actual === step.expectedCount ? "piece" : "pieces"} from ${step.from} to ${step.to}`;
}

/** The count chip on the step's row: `3`, or `3→0` when the actual count differs. */
export function transferChip(step: TransferStep): string {
  const actual = transferCount(step);
  return actual === step.expectedCount ? `×${String(actual)}` : `${String(step.expectedCount)}→${String(actual)}`;
}

/** True when the actual count has been set to something other than the expected one. */
export const transferOverridden = (step: TransferStep): boolean => transferCount(step) !== step.expectedCount;

/**
 * Every place the season's ledger counts, at kickoff, for the from and to lists. A current value
 * the season does not list (a hand-written id, or `hiveOwnUpCell`) is kept at the top, so a select
 * never silently shows another place than the file names.
 */
export function transferChoices(
  season: SeasonRules,
  field: Field | null,
  alliance: "RED" | "BLUE",
  current: readonly string[],
): Array<{ value: string; label: string }> {
  const listed: LedgerLocation[] =
    field === null || season.locations === undefined ? [] : season.locations(season.initialState(field), alliance);
  const choices = listed.map((location) => ({ value: location.id, label: `${location.id} · ${location.label}` }));
  const known = new Set(choices.map((choice) => choice.value));
  const extra = [...new Set(current)]
    .filter((id) => !known.has(id))
    .map((id) => ({
      value: id,
      label: /Own|Opponent/.test(id)
        ? `${id} · Own and Opponent read for this routine's alliance`
        : `${id} · not a place this season counts`,
    }));
  return [...extra, ...choices];
}

/**
 * The ends a new transfer starts with: from the alliance partner into this alliance's hive up
 * cell, which is the partner-scores case the step exists for, when the season has both; otherwise
 * from off the field into this robot. The author changes them in the inspector.
 */
export function defaultTransferEnds(
  season: SeasonRules,
  field: Field | null,
  alliance: "RED" | "BLUE",
): { from: string; to: string } {
  const listed = field === null || season.locations === undefined ? [] : season.locations(season.initialState(field), alliance);
  const word = alliance === "RED" ? "Red" : "Blue";
  const partner = listed.find((location) => location.kind === "partner");
  const cell = listed.find((location) => location.kind === "hiveCell" && location.id.includes(word));
  if (partner !== undefined && cell !== undefined) return { from: partner.id, to: cell.id };
  const robot = listed.find((location) => location.kind === "robot");
  return { from: "offField", to: robot?.id ?? "robot" };
}
