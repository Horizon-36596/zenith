/**
 * The tile seam's outline (issue #428): the tab edge of FIRST's am-2499 soft tile, rebuilt from the
 * profile's five numbers, must be the outline FIRST's BIOBUZZ field CAD has, corner for corner.
 */
import { ftcTileSeam } from "@horizon36596/zenith-season-biobuzz";
import { describe, expect, it } from "vitest";
import { tileSeamOutline } from "./tileSeam";

/**
 * The sharp corners of a centre tile's east edge in the CAD (part am-2499-Center, its top face's
 * loop with each pair of straight edges extended to meet), in inches: along the seam from its south
 * crossing, across it to the left of a south-to-north run, and whether a fillet rounds the corner.
 * Read by the method in packages/season-biobuzz/field/TRANSCRIPTION.md, Tile seams.
 */
const CAD: readonly (readonly [number, number, boolean])[] = [
  [0, 0, false], [0.4052, -0.4052, false], [1.3496, -0.4052, true], [0.8322, 0.4052, true], [2.5341, 0.4052, true],
  [2.0167, -0.4052, true], [3.7185, -0.4052, true], [3.2012, 0.4052, true], [4.903, 0.4052, true], [4.3856, -0.4052, true],
  [6.0874, -0.4052, true], [5.5701, 0.4052, true], [7.2719, 0.4052, true], [6.7545, -0.4052, true], [8.4563, -0.4052, true],
  [7.939, 0.4052, true], [9.6408, 0.4052, true], [9.1234, -0.4052, true], [10.8253, -0.4052, true], [10.3079, 0.4052, true],
  [11.3458, 0.4052, false], [12.1562, -0.4052, false], [13.1942, -0.4052, true], [12.6768, 0.4052, true], [14.3786, 0.4052, true],
  [13.8612, -0.4052, true], [15.5631, -0.4052, true], [15.0457, 0.4052, true], [16.7475, 0.4052, true], [16.2302, -0.4052, true],
  [17.932, -0.4052, true], [17.4146, 0.4052, true], [19.1164, 0.4052, true], [18.5991, -0.4052, true], [20.3009, -0.4052, true],
  [19.7835, 0.4052, true], [21.4854, 0.4052, true], [20.968, -0.4052, true], [22.6698, -0.4052, true], [22.1524, 0.4052, true],
  [23.0969, 0.4052, false], [23.5021, 0, false],
];

const outline = tileSeamOutline(ftcTileSeam);

describe("the tile seam's outline", () => {
  it("is the CAD's edge, corner for corner, to a thousandth of an inch", () => {
    expect(outline).toHaveLength(CAD.length);
    for (const [index, [alongIn, acrossIn, filleted]] of CAD.entries()) {
      const corner = outline[index];
      expect(corner?.alongIn, `corner ${String(index)} along`).toBeCloseTo(alongIn, 3);
      expect(corner?.acrossIn, `corner ${String(index)} across`).toBeCloseTo(acrossIn, 3);
      expect(corner?.filletIn, `corner ${String(index)} fillet`).toBe(filleted ? ftcTileSeam.filletRadiusIn : 0);
    }
  });

  it("runs from one seam crossing to the next, on the seam's centre line at both", () => {
    expect(outline[0]).toEqual({ alongIn: 0, acrossIn: 0, filletIn: 0 });
    expect(outline.at(-1)).toEqual({ alongIn: ftcTileSeam.edgeIn, acrossIn: 0, filletIn: 0 });
  });

  it("has 8 whole tabs each way, every one as wide at its end as the profile says", () => {
    const halfDepth = ftcTileSeam.depthIn / 2;
    // A flat is two corners in a row on the same side; whole ones are a tab's end, filleted at both.
    const flats = outline.slice(1).map((corner, index) => [outline[index], corner] as const);
    const whole = flats.filter(([a, b]) => a?.acrossIn === b.acrossIn && a.filletIn > 0 && b.filletIn > 0 && Math.abs(b.alongIn - a.alongIn) > 1);
    expect(whole.filter(([a]) => a?.acrossIn === halfDepth)).toHaveLength(8);
    expect(whole.filter(([a]) => a?.acrossIn === -halfDepth)).toHaveLength(8);
    for (const [a, b] of whole) expect(Math.abs(b.alongIn - (a?.alongIn ?? 0))).toBeCloseTo(ftcTileSeam.tabWidthIn, 6);
  });

  it("is point-symmetric about the edge's middle, so a tile turned any way mates with its neighbour", () => {
    const turned = [...outline].reverse().map((corner) => ({ ...corner, alongIn: ftcTileSeam.edgeIn - corner.alongIn, acrossIn: -corner.acrossIn }));
    for (const [index, corner] of outline.entries()) {
      expect(turned[index]?.alongIn).toBeCloseTo(corner.alongIn, 9);
      expect(turned[index]?.acrossIn).toBeCloseTo(corner.acrossIn, 9);
      expect(turned[index]?.filletIn).toBe(corner.filletIn);
    }
  });
});
