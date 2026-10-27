/**
 * The ids of the last actions run from the action registry (`actions.ts`), newest last, kept in
 * memory for the Report a bug dialog's setup block. Only the id is kept: never an argument, a file
 * name or anything the person typed. Nothing is stored or sent unless the person sends a report,
 * which shows the list first. The registry records a run in one place, where every caller (the
 * toolbar, the menus, the palette and the keyboard) goes through `action.run`.
 */

/** How many ids are kept. SET BY HAND: enough to see what led to a bug, short enough to read. */
export const RECENT_ACTIONS_KEPT = 20;

let recent: string[] = [];

/** Notes that the action `id` was run. */
export function recordAction(id: string): void {
  recent = [...recent, id].slice(-RECENT_ACTIONS_KEPT);
}

/** The ids of the last actions run, oldest first. */
export function recentActions(): readonly string[] {
  return recent;
}

/** Forgets every id, for tests. */
export function clearRecentActions(): void {
  recent = [];
}
