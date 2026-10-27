import { describe, expect, it } from "vitest";
import { escapeCancelsDrag, releaseIsClick, spaceHeldAfter } from "./press.js";

describe("how a press on the field ends (issue #402)", () => {
  it("runs no click for a pan, even one that did not move (Space+click, the Pan tool)", () => {
    expect(releaseIsClick({ moved: false, button: 0 }, "pan")).toBe(false);
    expect(releaseIsClick({ moved: false, button: 0 }, "envelopeDraw")).toBe(false);
    // A left press that stayed put is a click, on nothing or on something it would have dragged.
    expect(releaseIsClick({ moved: false, button: 0 }, undefined)).toBe(true);
    expect(releaseIsClick({ moved: false, button: 0 }, "points")).toBe(true);
    expect(releaseIsClick({ moved: true, button: 0 }, "points")).toBe(false);
    expect(releaseIsClick({ moved: false, button: 2 }, undefined)).toBe(false);
  });

  it("cancels a measure drag on Escape, as it does a marquee or an edit drag", () => {
    expect(escapeCancelsDrag("measure", false)).toBe(true);
    expect(escapeCancelsDrag("marquee", false)).toBe(true);
    expect(escapeCancelsDrag("points", true)).toBe(true);
    expect(escapeCancelsDrag("pan", false)).toBe(false);
    expect(escapeCancelsDrag(undefined, false)).toBe(false);
  });

  it("lets Space go when the window loses focus, whose keyup goes elsewhere", () => {
    expect(spaceHeldAfter(false, { type: "keydown", code: "Space" })).toBe(true);
    expect(spaceHeldAfter(true, { type: "keyup", code: "Space" })).toBe(false);
    expect(spaceHeldAfter(true, { type: "blur" })).toBe(false);
    expect(spaceHeldAfter(true, { type: "keydown", code: "ShiftLeft" })).toBe(true);
  });
});
