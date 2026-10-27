import { describe, expect, it } from "vitest";
import {
  constrainToAxis,
  constrainToRay,
  dominantAxis,
  heldKeys,
  NO_KEYS,
  rayBearingLabel,
  resolveModifiers,
} from "./modifiers.js";

describe("resolveModifiers", () => {
  it("snaps when the toggle is on and Ctrl is not held, and when the toggle is off and Ctrl is", () => {
    // The XOR table: Ctrl inverts the toolbar toggle for the length of the drag.
    expect(resolveModifiers(true, NO_KEYS).snap).toBe(true);
    expect(resolveModifiers(true, { ...NO_KEYS, ctrl: true }).snap).toBe(false);
    expect(resolveModifiers(false, NO_KEYS).snap).toBe(false);
    expect(resolveModifiers(false, { ...NO_KEYS, ctrl: true }).snap).toBe(true);
  });

  it("says Ctrl inverted the toggle, so the bubble can name why nothing snapped", () => {
    expect(resolveModifiers(true, { ...NO_KEYS, ctrl: true }).inverted).toBe(true);
    expect(resolveModifiers(true, NO_KEYS).inverted).toBe(false);
  });

  it("lets Alt turn off only the quantising snaps", () => {
    const alt = resolveModifiers(true, { ...NO_KEYS, alt: true });
    expect(alt.snap).toBe(true);
    expect(alt.quantise).toBe(false);
    expect(resolveModifiers(true, NO_KEYS).quantise).toBe(true);
    // With snapping off there is nothing to quantise, Alt or not.
    expect(resolveModifiers(false, NO_KEYS).quantise).toBe(false);
  });

  it("makes Shift constrain the axis, step the heading by 45 degrees and break the handle mirror", () => {
    for (const toggle of [true, false]) {
      const shift = resolveModifiers(toggle, { ...NO_KEYS, shift: true });
      expect(shift.constrainAxis).toBe(true);
      expect(shift.coarseHeading).toBe(true);
      expect(shift.breakMirror).toBe(true);
    }
    const none = resolveModifiers(true, NO_KEYS);
    expect(none.constrainAxis || none.coarseHeading || none.breakMirror).toBe(false);
  });
});

describe("heldKeys", () => {
  it("counts Cmd as Ctrl, so macOS reads the same as Windows", () => {
    expect(heldKeys({ ctrlKey: false, metaKey: true, altKey: false, shiftKey: false }).ctrl).toBe(true);
    expect(heldKeys({ ctrlKey: false, metaKey: false, altKey: true, shiftKey: true })).toEqual({
      ctrl: false,
      alt: true,
      shift: true,
    });
  });
});

describe("axis constraint", () => {
  it("runs along whichever axis the pointer has moved further on", () => {
    expect(dominantAxis({ xIn: 0, yIn: 0 }, { xIn: 10, yIn: 3 })).toBe("x");
    expect(dominantAxis({ xIn: 0, yIn: 0 }, { xIn: -2, yIn: -9 })).toBe("y");
    expect(dominantAxis({ xIn: 1, yIn: 1 }, { xIn: 1, yIn: 1 })).toBe("x");
  });

  it("puts the off-axis coordinate back where the drag started", () => {
    expect(constrainToAxis({ xIn: 5, yIn: 5 }, { xIn: 20, yIn: 8 })).toEqual({ xIn: 20, yIn: 5 });
    expect(constrainToAxis({ xIn: 5, yIn: 5 }, { xIn: 7, yIn: -30 })).toEqual({ xIn: 5, yIn: -30 });
  });
});

describe("ray constraint", () => {
  const anchor = { xIn: -12, yIn: -63 };
  const deg = (rad: number): number => (rad * 180) / Math.PI;

  it("projects the pointer onto the nearest of the 45 degree multiples", () => {
    const east = constrainToRay(anchor, { xIn: 8, yIn: -61 });
    expect(deg(east.bearingRad)).toBeCloseTo(0, 9);
    expect(east.pointIn.xIn).toBeCloseTo(8, 9);
    expect(east.pointIn.yIn).toBeCloseTo(-63, 9);
    const north = constrainToRay(anchor, { xIn: -10, yIn: -40 });
    expect(deg(north.bearingRad)).toBeCloseTo(90, 9);
    expect(north.pointIn.xIn).toBeCloseTo(-12, 9);
    expect(north.lengthIn).toBeCloseTo(23, 9);
  });

  it("goes onto the 45 degree ray at a 40 degree bearing, with no axis flip at 45", () => {
    const at = (bearingDeg: number): ReturnType<typeof constrainToRay> =>
      constrainToRay(
        { xIn: 0, yIn: 0 },
        { xIn: 10 * Math.cos((bearingDeg * Math.PI) / 180), yIn: 10 * Math.sin((bearingDeg * Math.PI) / 180) },
      );
    expect(deg(at(40).bearingRad)).toBeCloseTo(45, 9);
    expect(deg(at(45).bearingRad)).toBeCloseTo(45, 9);
    expect(deg(at(50).bearingRad)).toBeCloseTo(45, 9);
    // Just either side of 45 degrees the point differs by hairs, not by the jump an axis flip makes.
    const below = at(44.9).pointIn;
    const above = at(45.1).pointIn;
    expect(Math.hypot(below.xIn - above.xIn, below.yIn - above.yIn)).toBeLessThan(0.1);
  });

  it("also takes the line's own bearing at the press when that is nearer", () => {
    const press = Math.atan2(13, 20);
    const kept = constrainToRay({ xIn: 0, yIn: 0 }, { xIn: 20, yIn: 14 }, press);
    expect(kept.bearingRad).toBe(press);
    const stepped = constrainToRay({ xIn: 0, yIn: 0 }, { xIn: 20, yIn: 19 }, press);
    expect(deg(stepped.bearingRad)).toBeCloseTo(45, 9);
  });

  it("can come as close to the anchor as the pointer does, and stops at the anchor", () => {
    const diagonalPress = Math.PI / 4;
    const near = constrainToRay({ xIn: -12, yIn: -63 }, { xIn: -10.7, yIn: -61.7 }, diagonalPress);
    expect(near.lengthIn).toBeCloseTo(Math.hypot(1.3, 1.3), 9);
    const behind = constrainToRay({ xIn: 0, yIn: 0 }, { xIn: -5, yIn: -5 }, diagonalPress);
    expect(deg(behind.bearingRad)).toBeCloseTo(-135, 9);
    expect(behind.lengthIn).toBeCloseTo(Math.hypot(5, 5), 9);
    const onAnchor = constrainToRay({ xIn: 3, yIn: 4 }, { xIn: 3, yIn: 4 }, diagonalPress);
    expect(onAnchor.lengthIn).toBe(0);
    expect(onAnchor.pointIn).toEqual({ xIn: 3, yIn: 4 });
    expect(onAnchor.bearingRad).toBe(diagonalPress);
  });

  it("names the bearing in degrees to a tenth", () => {
    expect(rayBearingLabel(Math.PI / 4)).toBe("45°");
    expect(rayBearingLabel(-Math.PI)).toBe("180°");
    expect(rayBearingLabel(0)).toBe("0°");
    expect(rayBearingLabel(Math.atan2(13, 20))).toBe("33°");
  });
});
