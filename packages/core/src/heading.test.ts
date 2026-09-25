import { describe, expect, it } from "vitest";
import { makePath } from "./geometry/path.js";
import { headingFunction, linearHeadingPieces, tangentHeading } from "./heading.js";

describe("tangentHeading", () => {
  it("finding 4: a repeated last control point still reads as travelling forwards", () => {
    // A bezier whose last control point equals its `to`: the analytic derivative vanishes at t = 1,
    // so the cusp fallback samples just before the end. The path travels in +x throughout.
    const path = makePath([
      [
        { xIn: 0, yIn: 0 },
        { xIn: 10, yIn: 0 },
        { xIn: 10, yIn: 0 },
      ],
    ]);
    expect(tangentHeading(path, 1)).toBeCloseTo(0, 6);
    expect(headingFunction({ mode: "tangent" }, path)(1)).toBeCloseTo(0, 6);
    expect(Math.abs(headingFunction({ mode: "tangentReversed" }, path)(1))).toBeCloseTo(Math.PI, 6);
  });

  it("finding 4: a repeated first control point still reads as travelling forwards", () => {
    const path = makePath([
      [
        { xIn: 0, yIn: 0 },
        { xIn: 0, yIn: 0 },
        { xIn: 10, yIn: 0 },
      ],
    ]);
    expect(tangentHeading(path, 0)).toBeCloseTo(0, 6);
  });
});

describe("the linear heading mode turns the short way, as Pedro does", () => {
  const straight = makePath([
    [
      { xIn: 0, yIn: 0 },
      { xIn: 20, yIn: 0 },
    ],
  ]);
  // Two segments of equal length, so the runtime gives each half of the sweep.
  const twoLegs = makePath([
    [
      { xIn: 0, yIn: 0 },
      { xIn: 10, yIn: 0 },
    ],
    [
      { xIn: 10, yIn: 0 },
      { xIn: 20, yIn: 0 },
    ],
  ]);

  it("turns a quarter turn the way the file wrote it", () => {
    const h = headingFunction({ mode: "linear", fromRad: 0, toRad: 1.5708 }, straight);
    expect(h(0)).toBeCloseTo(0, 6);
    expect(h(0.5)).toBeCloseTo(0.7854, 4);
    expect(h(1)).toBeCloseTo(1.5708, 4);
  });

  it("turns the editor's half turn, 3.1416, clockwise, because 3.1416 is a hair over pi", () => {
    const h = headingFunction({ mode: "linear", fromRad: 0, toRad: 3.1416 }, straight);
    expect(h(0.25)).toBeCloseTo(-0.7854, 3);
    expect(h(0.5)).toBeCloseTo(-1.5708, 3);
    expect(Math.abs(h(1))).toBeCloseTo(Math.PI, 3);
    const counter = headingFunction({ mode: "linear", fromRad: 0, toRad: -3.1416 }, straight);
    expect(counter(0.5)).toBeCloseTo(1.5708, 3);
  });

  it("turns a 270 degree sweep on one segment 90 degrees the other way", () => {
    const h = headingFunction({ mode: "linear", fromRad: 0, toRad: 4.7124 }, straight);
    expect(h(0.5)).toBeCloseTo(-0.7854, 4);
    expect(h(1)).toBeCloseTo(-1.5708, 4);
    expect(linearHeadingPieces({ mode: "linear", fromRad: 0, toRad: 4.7124 }, straight)[0]?.reversed).toBe(true);
  });

  it("keeps a 270 degree sweep split over two segments at 270 degrees, as the runtime cuts it", () => {
    const heading = { mode: "linear", fromRad: 0, toRad: 4.7124 } as const;
    const h = headingFunction(heading, twoLegs);
    expect(h(0.25)).toBeCloseTo(1.1781, 4);
    expect(h(0.5)).toBeCloseTo(2.3562, 4);
    expect(h(0.75)).toBeCloseTo(3.5343 - 2 * Math.PI, 4);
    expect(h(1)).toBeCloseTo(-1.5708, 4);
    const pieces = linearHeadingPieces(heading, twoLegs);
    expect(pieces.map((piece) => piece.reversed)).toEqual([false, false]);
    expect(pieces.reduce((sum, piece) => sum + piece.turnRad, 0)).toBeCloseTo(4.7124, 6);
  });
});
