import { describe, expect, it } from "vitest";
import { constrainToAxis, dominantAxis, heldKeys, NO_KEYS, resolveModifiers } from "./modifiers.js";

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
