/**
 * Issue #403: in the Routine view the ⋯ on a Waypoints row selects the pin, which mounts the list
 * again elsewhere in the Inspector. React runs the new list's layout effect, which opens the menu,
 * before the old list's unmount cleanup, and that cleanup closed any open menu, so a production build
 * showed none. StrictMode hid it in development. These run the store in that order, with no React.
 */
import { afterEach, describe, expect, it } from "vitest";
import { closeRowMenuOf, getRowMenu, rowMenuAfterListGoes, setRowMenu, type RowMenuState } from "./waypointRowMenu";

const oldList = Symbol("old list");
const newList = Symbol("new list");
const openBy = (owner: symbol): RowMenuState => ({ wanted: null, open: { name: "scoreSouth", xPx: 10, yPx: 20, items: [], owner } });

afterEach(() => {
  setRowMenu({ wanted: null, open: null });
});

describe("the Waypoints list's ⋯ menu", () => {
  it("stays open when the list that is going is not the one that opened it", () => {
    // The ⋯ asks for the menu, the new list opens it, then the old list's cleanup runs.
    setRowMenu({ wanted: "scoreSouth", open: null });
    setRowMenu(openBy(newList));
    closeRowMenuOf(oldList);
    expect(getRowMenu().open?.name).toBe("scoreSouth");
    expect(getRowMenu().open?.owner).toBe(newList);
  });

  it("goes with the list that opened it, as when a step is selected", () => {
    setRowMenu(openBy(oldList));
    closeRowMenuOf(oldList);
    expect(getRowMenu()).toEqual({ wanted: null, open: null });
  });

  it("leaves a row that is still waiting to open its menu", () => {
    const waiting: RowMenuState = { wanted: "scoreSouth", open: null };
    expect(rowMenuAfterListGoes(waiting, oldList)).toBe(waiting);
  });
});
