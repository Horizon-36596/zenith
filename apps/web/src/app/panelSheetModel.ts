/**
 * The pure part of the narrow-window layout (UI_GUIDE section 3, layout rule 9, `PanelSheets.tsx`):
 * the widths at which each side panel becomes a sheet over the field, and which sheet must be open
 * for an element to be seen.
 */

/** Below this width the Inspector is a sheet. */
export const INSPECTOR_SHEET_BELOW_PX = 820;
/** Below this width the steps column is a sheet too. */
export const STEPS_SHEET_BELOW_PX = 640;

/** The sheet that is open over the field, or none. */
export type Sheet = "steps" | "inspector" | null;

/** A panel, as far as `sheetHolding` needs one. */
export interface Holder {
  contains(other: Node | null): boolean;
}

/**
 * Which sheet has to be open for `element` to be seen at this width: the steps sheet or the Inspector
 * sheet when it is inside that panel and the panel is a sheet here, `null` (the field, with no sheet
 * over it) when it is anywhere else, and `undefined` when there is no element to show.
 */
export function sheetHolding(
  element: Node | null,
  panels: { steps: Holder | null; inspector: Holder | null },
  sheets: { steps: boolean; inspector: boolean },
): Sheet | undefined {
  if (element === null) return undefined;
  if (sheets.steps && panels.steps?.contains(element) === true) return "steps";
  if (sheets.inspector && panels.inspector?.contains(element) === true) return "inspector";
  return null;
}

/**
 * The open sheet once the window is this wide: a sheet whose panel is back in the row at this width
 * closes, so the bar never shows a sheet it no longer offers with no segment pressed.
 */
export function sheetAtWidth(sheet: Sheet, sheets: { steps: boolean; inspector: boolean }): Sheet {
  if (sheet === "steps" && !sheets.steps) return null;
  if (sheet === "inspector" && !sheets.inspector) return null;
  return sheet;
}
