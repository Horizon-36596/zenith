import { afterEach, describe, expect, it, vi } from "vitest";
import { anyOpen, claim, focusFromKeyboard, release } from "./tooltipGate";

const opened: symbol[] = [];

afterEach(() => {
  for (const token of opened.splice(0)) release(token);
});

function open(close: () => void, token?: symbol): symbol {
  const got = claim(close, token);
  opened.push(got);
  return got;
}

describe("one tooltip at a time", () => {
  it("closes the open tooltip when another opens", () => {
    const first = vi.fn();
    const second = vi.fn();
    open(first);
    open(second);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("does not close a tooltip that opens again while it is the open one", () => {
    const close = vi.fn();
    const token = Symbol("same");
    open(close, token);
    open(close, token);
    expect(close).not.toHaveBeenCalled();
  });

  it("forgets a tooltip once it closes, so the next one has nothing to close", () => {
    const first = vi.fn();
    const token = open(first);
    release(token);
    expect(anyOpen()).toBe(false);
    open(vi.fn());
    expect(first).not.toHaveBeenCalled();
  });

  it("ignores a late release from a tooltip that was already replaced", () => {
    const old = open(vi.fn());
    open(vi.fn());
    release(old);
    expect(anyOpen()).toBe(true);
  });
});

describe("focus opens a tooltip only from the keyboard", () => {
  const element = (focusVisible: boolean) => ({
    matches: (selector: string) => selector === ":focus-visible" && focusVisible,
  });

  it("opens for keyboard focus, which draws a focus ring", () => {
    expect(focusFromKeyboard(element(true))).toBe(true);
  });

  it("stays shut for a focus moved in code after a click, such as a menu focusing its first item", () => {
    expect(focusFromKeyboard(element(false))).toBe(false);
  });

  it("treats a browser that cannot answer as keyboard focus, and no element as none", () => {
    const old = {
      matches: () => {
        throw new SyntaxError("unknown pseudo-class");
      },
    };
    expect(focusFromKeyboard(old)).toBe(true);
    expect(focusFromKeyboard(null)).toBe(false);
  });
});
