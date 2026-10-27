/**
 * Focus that code moves draws a ring only after a key press (UI_GUIDE section 11): a menu opened by
 * a right-click, a sheet closed by a click and a page that has had no input yet all focus without
 * one, and a menu opened from the keyboard still shows its ring.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { focusForInput, focusOptions, isKeyboardUse, lastInput, noteInput } from "./inputModality";

afterEach(() => {
  noteInput(null);
});

describe("focus moved by code", () => {
  it("draws a ring after a key press", () => {
    expect(focusOptions({}, "keyboard")).toEqual({ focusVisible: true });
  });

  it("draws none after a pointer press, or before any input", () => {
    expect(focusOptions({}, "pointer")).toEqual({ focusVisible: false });
    expect(focusOptions({}, null)).toEqual({ focusVisible: false });
  });

  it("keeps the caller's own options", () => {
    expect(focusOptions({ preventScroll: true }, "pointer")).toEqual({ preventScroll: true, focusVisible: false });
  });

  it("asks the element for focus with the last input's ring", () => {
    const focus = vi.fn();
    noteInput("pointer");
    focusForInput({ focus } as unknown as HTMLElement);
    expect(focus).toHaveBeenCalledWith({ focusVisible: false });
    noteInput("keyboard");
    focusForInput({ focus } as unknown as HTMLElement, { preventScroll: true });
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true, focusVisible: true });
    expect(() => {
      focusForInput(null);
    }).not.toThrow();
    expect(lastInput()).toBe("keyboard");
  });
});

describe("what counts as keyboard use", () => {
  it("counts a key that does something, not a modifier pressed alone", () => {
    expect(isKeyboardUse({ key: "ArrowDown" })).toBe(true);
    expect(isKeyboardUse({ key: "Tab" })).toBe(true);
    expect(isKeyboardUse({ key: "F10" })).toBe(true);
    expect(isKeyboardUse({ key: "Shift" })).toBe(false);
    expect(isKeyboardUse({ key: "Control" })).toBe(false);
  });
});
