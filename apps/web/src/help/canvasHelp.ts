/**
 * The canvas gestures and drag modifiers the shortcut overlay and the tour list, read from the
 * canvas's own table (`CANVAS_HELP` in `canvas/help.ts`), so the words are the ones the canvas
 * is built to (site/docs/editor.md).
 */
import { CANVAS_HELP } from "../canvas/help";

export interface GestureHelp {
  /** What the hand does: `Hold Ctrl while dragging`. */
  gesture: string;
  /** What happens, in plain words. */
  does: string;
}

const ROWS: readonly GestureHelp[] = CANVAS_HELP.map((entry) => ({
  gesture: entry.gesture,
  does: entry.action,
}));

/** Every canvas gesture, in the canvas table's order. */
export const canvasHelp = (): readonly GestureHelp[] => ROWS;

/** One short sentence naming the three drag modifiers, for the tour's snap stop. */
export function modifierSentence(): string {
  const has = (id: string) => CANVAS_HELP.some((entry) => entry.id === id);
  const parts = [
    has("invertSnap") ? "Ctrl to flip snapping" : null,
    has("noQuantise") ? "Alt to skip the grid" : null,
    has("axis") ? "Shift to keep to one axis" : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return "";
  const last = parts.pop() as string;
  return `While dragging, hold ${parts.length === 0 ? last : `${parts.join(", ")} or ${last}`}.`;
}
