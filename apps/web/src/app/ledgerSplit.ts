/**
 * The divider between the step list and the Ledger in the left column (issue #86): how tall the
 * Ledger may be, given the room the two share. The height is a UI preference (`Prefs.ledgerH`),
 * remembered per viewer with the other panel sizes; null means the default split.
 */

/** The step list never shrinks below this, so a few step rows and the panel header stay usable. */
export const MIN_STEPS_H = 120;

/** The Ledger never shrinks below this while open: its header, the table header and one row. */
export const MIN_LEDGER_H = 80;

/** How far one arrow-key press moves the divider, and with Shift held. */
export const KEY_STEP_PX = 8;
export const KEY_STEP_LARGE_PX = 32;

/**
 * The Ledger height to use for a wanted height, when the step list and the Ledger share
 * `availablePx` between them. Each side keeps its minimum; when there is not room for both, the
 * step list keeps its own and the Ledger takes what is left, never below zero.
 */
export function clampLedgerHeight(wantedPx: number, availablePx: number): number {
  const most = Math.max(0, availablePx - MIN_STEPS_H);
  const least = Math.min(MIN_LEDGER_H, most);
  return Math.round(Math.max(least, Math.min(most, wantedPx)));
}

/** A saved height read back from storage: a finite positive number, or null for the default split. */
export function parseLedgerHeight(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}
