/**
 * Issue #431: a piecewise range is one row, `1  0–18%  Linear  90.0° → 135.9°`. Its span is in
 * percent of the path, and its values never leave the column empty: a range the path decides says
 * "follows the path", so it never looks broken.
 */
import { describe, expect, it } from "vitest";
import { forgetPendingFold, openFoldForNow, rangeFoldId } from "../components/foldMemory";
import { pendingRanges, rangeSpan, rangeValues } from "./PiecewiseEditor";

describe("a range's row", () => {
  it("spans whole percents of the path", () => {
    expect(rangeSpan({ startT: 0, endT: 0.18, heading: { mode: "tangent" } })).toBe("0–18%");
    expect(rangeSpan({ startT: 0.754, endT: 1, heading: { mode: "tangent" } })).toBe("75–100%");
  });

  it("says follows the path for a range the path decides, and its angles for one set by hand", () => {
    expect(rangeValues({ mode: "tangent" })).toBe("follows the path");
    expect(rangeValues({ mode: "tangentReversed" })).toBe("follows the path");
    expect(rangeValues({ mode: "constant", headingRad: Math.PI / 6 })).toBe("30.0°");
    expect(rangeValues({ mode: "linear", fromRad: Math.PI / 2, toRad: -Math.PI })).toBe("90.0° → 180.0°");
    expect(rangeValues({ mode: "facePoint", xIn: -20, yIn: 10.25 })).toBe("faces -20.0, 10.3");
  });
});

describe("a range the heading pencil opens before its rows are drawn", () => {
  // With Heading folded, the pencil opens Heading and the range in one click, and the range's rows
  // mount only after Heading opens, so the range reads its waiting open when it mounts.
  it("opens on mount while the open waits, and not once the pencil forgets it", () => {
    openFoldForNow(rangeFoldId(1), { untilMounted: true });
    expect([...pendingRanges(3)]).toEqual([1]);
    // A mount effect React runs twice reads the same answer.
    expect([...pendingRanges(3)]).toEqual([1]);
    forgetPendingFold(rangeFoldId(1));
    expect([...pendingRanges(3)]).toEqual([]);
  });

  it("does not wait for a plain open for now, which only a mounted section hears", () => {
    openFoldForNow(rangeFoldId(0));
    expect([...pendingRanges(3)]).toEqual([]);
  });
});
