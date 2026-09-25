/**
 * The canonical shortcut map, as one table (apps/web/UI_GUIDE.md section 9.4, the tooltip contract;
 * the keyboard equivalents of every drag are in section 11). Tooltips, the command palette and the
 * keyboard handler all read it, so the three can never disagree.
 */
export const SHORTCUTS = {
  select: "V",
  addPath: "P",
  addCommand: "C",
  marker: "M",
  heading: "H",
  measure: "U",
  snap: "S",
  alliance: "A",
  palette: "Ctrl K",
  validate: "F8",
  simulate: "F5",
  save: "Ctrl S",
  propose: "Ctrl Shift Enter",
  undo: "Ctrl Z",
  redo: "Ctrl Y",
  delete: "Del",
  insertAfter: "Enter",
  nudge: "← ↑ → ↓",
  nudgeFar: "Shift + arrows",
  rotate: "R / Shift R",
  cycleRegion: "F6",
  playPause: "Space",
  stepTime: ", .",
  reorder: "Alt + ↑ ↓",
  openProject: "Ctrl O",
  duplicate: "Ctrl D",
  help: "? or F1",
} as const;

export type ShortcutId = keyof typeof SHORTCUTS;

/** How far an arrow key moves a point, in inches (UI_GUIDE section 9). */
export const NUDGE_IN = 0.5;
export const NUDGE_FAR_IN = 2;

/** How far `R` turns a heading, in degrees. */
export const ROTATE_DEG = 5;

/** How far `,` and `.` move the playback head, in seconds. */
export const SCRUB_STEP_S = 0.1;
