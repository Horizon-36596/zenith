/**
 * What a press on the field does as it ends or is interrupted (`FieldCanvas.tsx`), kept pure so the
 * rules are unit-tested without a pointer.
 */

/**
 * Whether a release is a click: a left press that did not move. A pan is never a click (issue #402:
 * a quick Space+click used to run the tool's click, so Add path added a step), and a click while an
 * envelope is being drawn does nothing else either.
 */
export const releaseIsClick = (press: { moved: boolean; button: number }, dragKind: string | undefined): boolean =>
  !press.moved && press.button === 0 && dragKind !== "pan" && dragKind !== "envelopeDraw";

/**
 * Whether Escape cancels the press under way: a marquee, a measure (issue #402: clearing only the
 * measurement left the press live, so the next move drew it again) or an edit drag.
 */
export const escapeCancelsDrag = (dragKind: string | undefined, editDrag: boolean): boolean =>
  dragKind === "marquee" || dragKind === "measure" || editDrag;

/**
 * Whether Space is held after a window event. The window losing focus counts as letting it go
 * (issue #402): its keyup goes to another window, and a held Space would make every press a pan.
 */
export function spaceHeldAfter(held: boolean, event: { type: string; code?: string }): boolean {
  if (event.type === "blur") return false;
  if (event.code !== "Space") return held;
  if (event.type === "keydown") return true;
  if (event.type === "keyup") return false;
  return held;
}
