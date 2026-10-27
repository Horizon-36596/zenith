import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HINT_DELAY_MS,
  OPEN_DELAY_MS,
  SKIP_DELAY_MS,
  anyOpen,
  claim,
  cssMs,
  explainFocused,
  focusFromKeyboard,
  holdOpens,
  openDelayMs,
  registerExplainer,
  release,
  startHoverWait,
  takesText,
} from "./tooltipGate";

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
    expect(focusFromKeyboard(element(true), "keyboard")).toBe(true);
  });

  it("stays shut for a focus moved in code after a click, such as a menu focusing its first item", () => {
    expect(focusFromKeyboard(element(false), "keyboard")).toBe(false);
  });

  it("stays shut after a pointer press even where the browser draws a ring", () => {
    expect(focusFromKeyboard(element(true), "pointer")).toBe(false);
  });

  it("stays shut on a page that has had no input yet, such as a dialog focusing Close as it opens", () => {
    expect(focusFromKeyboard(element(true), null)).toBe(false);
  });

  it("treats a browser that cannot answer as keyboard focus, and no element as none", () => {
    const old = {
      matches: () => {
        throw new SyntaxError("unknown pseudo-class");
      },
    };
    expect(focusFromKeyboard(old, "keyboard")).toBe(true);
    expect(focusFromKeyboard(null, "keyboard")).toBe(false);
  });
});

describe("fields a person types into", () => {
  it("counts text inputs, textareas and editable elements", () => {
    expect(takesText({ type: "input", props: {} })).toBe(true);
    expect(takesText({ type: "input", props: { type: "email" } })).toBe(true);
    expect(takesText({ type: "input", props: { type: "Number" } })).toBe(true);
    expect(takesText({ type: "textarea", props: {} })).toBe(true);
    expect(takesText({ type: "div", props: { contentEditable: true } })).toBe(true);
  });

  it("does not count buttons, checkboxes or other controls", () => {
    expect(takesText({ type: "button", props: {} })).toBe(false);
    expect(takesText({ type: "input", props: { type: "checkbox" } })).toBe(false);
    expect(takesText({ type: "input", props: { type: "range" } })).toBe(false);
    expect(takesText({ type: "select", props: {} })).toBe(false);
    expect(takesText({ type: () => null, props: {} })).toBe(false);
  });
});

describe("how long the pointer rests before a tooltip opens", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const wait = (delay: "normal" | "long", sinceCloseMs = Number.POSITIVE_INFINITY) => {
    vi.useFakeTimers();
    const opened = vi.fn();
    startHoverWait(delay, opened, { sinceCloseMs, hintDelayMs: HINT_DELAY_MS });
    return opened;
  };

  it("opens a row hint after 800 ms of hover, and not at 799 ms", () => {
    const opened = wait("long");
    vi.advanceTimersByTime(799);
    expect(opened).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("keeps every other tooltip at 400 ms", () => {
    const opened = wait("normal");
    vi.advanceTimersByTime(399);
    expect(opened).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("opens either kind at once within the 100 ms skip delay of the last one closing", () => {
    for (const delay of ["normal", "long"] as const) {
      const opened = wait(delay, SKIP_DELAY_MS - 1);
      vi.advanceTimersByTime(0);
      expect(opened, delay).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    }
  });

  it("can be cancelled, as a pointer that leaves does", () => {
    vi.useFakeTimers();
    const opened = vi.fn();
    const cancel = startHoverWait("long", opened, { sinceCloseMs: Number.POSITIVE_INFINITY, hintDelayMs: HINT_DELAY_MS });
    vi.advanceTimersByTime(500);
    cancel();
    vi.advanceTimersByTime(1000);
    expect(opened).not.toHaveBeenCalled();
  });

  it("sets the row hint delay by hand at twice the tooltip delay, and reads the --hint-delay token", () => {
    expect(HINT_DELAY_MS).toBe(2 * OPEN_DELAY_MS);
    expect(openDelayMs("long", Number.POSITIVE_INFINITY, 650)).toBe(650);
    expect(cssMs(" 800ms")).toBe(800);
    expect(cssMs("0.8s")).toBe(800);
    expect(cssMs("")).toBeUndefined();
    expect(cssMs("soon")).toBeUndefined();
  });
});

/** A stand-in for a DOM element: its parent, and the selectors it sits inside. */
interface FakeElement {
  parentElement: FakeElement | null;
  closest(selector: string): FakeElement | null;
}

function fake(parent: FakeElement | null = null, inside: readonly string[] = []): FakeElement {
  const element: FakeElement = {
    parentElement: parent,
    closest: (selector) =>
      selector.split(",").some((part) => inside.includes(part.trim())) ? element : (parent?.closest(selector) ?? null),
  };
  return element;
}

const asElement = (element: FakeElement): Element => element as unknown as Element;

describe("Shift F1 opens the focused element's hint", () => {
  const undo: Array<() => void> = [];
  afterEach(() => {
    for (const off of undo.splice(0)) off();
  });

  it("opens the hint of the row the focused control sits in, ahead of the control's own tooltip", () => {
    const row = fake();
    const input = fake(row);
    const rowHint = vi.fn();
    const own = vi.fn();
    undo.push(registerExplainer(asElement(row), rowHint, "row"));
    undo.push(registerExplainer(asElement(input), own, "own"));
    expect(explainFocused(asElement(input))).toBe(true);
    expect(rowHint).toHaveBeenCalledTimes(1);
    expect(own).not.toHaveBeenCalled();
  });

  it("opens the focused control's own tooltip, or the nearest one around it, when no row has a hint", () => {
    const button = fake();
    const icon = fake(button);
    const own = vi.fn();
    undo.push(registerExplainer(asElement(button), own, "own"));
    expect(explainFocused(asElement(icon))).toBe(true);
    expect(own).toHaveBeenCalledTimes(1);
  });

  it("opens nothing for focus in a menu or the palette, or with nothing focused", () => {
    const menu = fake(null, ['[role="menu"]']);
    const item = fake(menu);
    const own = vi.fn();
    undo.push(registerExplainer(asElement(item), own, "own"));
    expect(explainFocused(asElement(item))).toBe(false);
    expect(explainFocused(null)).toBe(false);
    expect(own).not.toHaveBeenCalled();
  });

  it("forgets an element once its tooltip goes away", () => {
    const input = fake();
    registerExplainer(asElement(input), vi.fn(), "own")();
    expect(explainFocused(asElement(input))).toBe(false);
  });
});

describe("a touch hold", () => {
  it("opens a row hint on a row that does not drag", () => {
    expect(holdOpens("long", asElement(fake()))).toBe(true);
  });

  it("leaves a row that drags, such as a step row, to its drag", () => {
    const stepRow = fake(null, ["[data-drag-row]"]);
    expect(holdOpens("long", asElement(fake(stepRow)))).toBe(false);
  });

  it("still opens an ordinary tooltip anywhere", () => {
    const stepRow = fake(null, ["[data-drag-row]"]);
    expect(holdOpens("normal", asElement(fake(stepRow)))).toBe(true);
  });
});
