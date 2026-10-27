/**
 * Where a popover (the action menu, a choice field's list) is portalled. By default that is the page,
 * at `--z-popover`, over the panels. A modal drawn in the page, the Settings window, sits above
 * `--z-popover`, so a popover opened from inside it would be drawn under it, and the window's focus
 * guard would pull focus back out of it (issue #313). Such a modal provides its own layer, an element
 * inside its backdrop: a popover portalled there is drawn over the window and counts as inside it.
 */
import { createContext, useContext } from "react";

export const PopoverLayer = createContext<HTMLElement | null>(null);

/** The element to portal a popover into: the nearest modal's layer, else the page. */
export function usePopoverLayer(): HTMLElement {
  return useContext(PopoverLayer) ?? document.body;
}
