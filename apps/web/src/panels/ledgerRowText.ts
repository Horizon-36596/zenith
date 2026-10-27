import type { LedgerRow } from "@horizon36596/zenith-core";

/**
 * A ledger row in words, the hint on the Ledger's lines. An end row names a holder (the robot, a
 * hive, the garden), so its words are what that holder holds at the end, "robot: empty", rather than
 * the name alone; the step rows already say what the step did.
 */
export function ledgerRowText(row: LedgerRow): string {
  if (row.stepId !== "end" || row.detail === undefined || row.detail === "") return row.label;
  // A step the author called "end" has a step row, whose label starts with the step's id.
  if (row.label === row.stepId || row.label.startsWith(`${row.stepId}: `)) return row.label;
  return `${row.label}: ${row.detail}`;
}
