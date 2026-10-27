/**
 * The bottom panel's own height (issue #413): it opens four rows tall for a problem and to most of
 * the column for the Code tab, but never lower, never past the resizer's limit, and never over a
 * height the person dragged to.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS } from "../state/prefs";
import { PANEL_ROW_PX, PROBLEMS_OPEN_PX, PROBLEM_ROWS, personSizedPanel, raisedHeight } from "./bottomTab";

describe("the bottom panel's height", () => {
  it("has room for the header and four one-line rows above the status line", () => {
    expect(PROBLEM_ROWS).toBe(4);
    expect(PROBLEMS_OPEN_PX).toBeGreaterThanOrEqual(PANEL_ROW_PX * (PROBLEM_ROWS + 1));
  });

  it("raises the default height, and the editor's own, but not the person's", () => {
    expect(raisedHeight(DEFAULT_PREFS.findingsH, PROBLEMS_OPEN_PX, null)).toBe(PROBLEMS_OPEN_PX);
    expect(raisedHeight(PROBLEMS_OPEN_PX, 380, { setPx: PROBLEMS_OPEN_PX, restorePx: DEFAULT_PREFS.findingsH })).toBe(380);
    expect(raisedHeight(150, PROBLEMS_OPEN_PX, null)).toBeNull();
    expect(personSizedPanel(150, null)).toBe(true);
    expect(personSizedPanel(DEFAULT_PREFS.findingsH, null)).toBe(false);
  });

  it("never lowers it and never goes past the resizer's limit", () => {
    expect(raisedHeight(DEFAULT_PREFS.findingsH, 100, null)).toBeNull();
    expect(raisedHeight(DEFAULT_PREFS.findingsH, 900, null)).toBe(420);
  });
});
