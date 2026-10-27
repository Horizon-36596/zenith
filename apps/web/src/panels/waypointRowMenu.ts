/**
 * The Waypoints list's ⋯ menu, apart from the list's own state (`WaypointSection.tsx`): the ⋯ selects
 * its pin first, and selecting a pin from the Routine view puts the list in another part of the
 * Inspector, which mounts it again. `wanted` is the row whose menu opens once the list is laid out
 * again, and `open.owner` is the list that opened it.
 *
 * The owner matters when the list moves (issue #403). React runs the new list's layout effect, which
 * opens the menu, before the old list's unmount cleanup. A cleanup that closed any open menu therefore
 * closed the one the new list had just opened, so in a production build the ⋯ in the Routine view
 * showed no menu. StrictMode hid it in development by running the layout effect a second time.
 */
import type { CanvasAction } from "../canvas/types";

/** The ⋯ menu that is open, under the button of its row, and the list that opened it. */
export interface RowMenu {
  name: string;
  xPx: number;
  yPx: number;
  items: CanvasAction[];
  owner: symbol;
}

export interface RowMenuState {
  wanted: string | null;
  open: RowMenu | null;
}

const CLOSED: RowMenuState = { wanted: null, open: null };

let rowMenu: RowMenuState = CLOSED;
const menuListeners = new Set<() => void>();

export const setRowMenu = (next: RowMenuState): void => {
  rowMenu = next;
  for (const listener of menuListeners) listener();
};

export const subscribeRowMenu = (listener: () => void): (() => void) => {
  menuListeners.add(listener);
  return () => menuListeners.delete(listener);
};

export const getRowMenu = (): RowMenuState => rowMenu;

/**
 * What the menu becomes when the list `owner` goes, as when a step is selected: the list takes the
 * menu it opened with it, and leaves alone a menu another list opened or a row still waiting to open.
 */
export function rowMenuAfterListGoes(menu: RowMenuState, owner: symbol): RowMenuState {
  return menu.open !== null && menu.wanted === null && menu.open.owner === owner ? CLOSED : menu;
}

/** Closes the menu when the list `owner` goes, if that list opened it (`rowMenuAfterListGoes`). */
export function closeRowMenuOf(owner: symbol): void {
  const next = rowMenuAfterListGoes(rowMenu, owner);
  if (next !== rowMenu) setRowMenu(next);
}
