import { afterEach, describe, expect, it, vi } from "vitest";
import { registerExplainer } from "../components/tooltipGate";
import { WHATS_THIS_ATTRIBUTE, WHATS_THIS_ON, endWhatsThis } from "../components/whatsThisMode";
import { clearStatus, getState } from "../state/store";
import { actionById } from "./actions";

/**
 * "What's this" from the Help menu or the palette (issue #237): it opens the focused element's hint
 * when there is one, and otherwise starts a mode where the next click explains what it lands on.
 * The unit tests have no DOM, so `document.activeElement` is a stand-in.
 */

/** A stand-in for a focused element outside any menu, with no parent. */
const element = (): Element => ({ parentElement: null, closest: () => null }) as unknown as Element;

const run = (): void => {
  const action = actionById("help.whatsThis");
  if (action === undefined) throw new Error("no help.whatsThis action");
  void action.run();
};

afterEach(() => {
  vi.unstubAllGlobals();
  clearStatus();
});

describe("What's this", () => {
  // UX review, S14: from the Help menu it is a mode, and the next click explains its target.
  it("starts the click-to-explain mode, and says so, when nothing focused has a hint", () => {
    const attributes = new Map<string, string>();
    const listeners: string[] = [];
    vi.stubGlobal("document", {
      activeElement: element(),
      documentElement: {
        setAttribute: (name: string, value: string) => attributes.set(name, value),
        removeAttribute: (name: string) => attributes.delete(name),
      },
    });
    vi.stubGlobal("window", {
      setTimeout: (run: () => void) => {
        run();
        return 0;
      },
      clearTimeout: () => undefined,
      addEventListener: (type: string) => listeners.push(type),
      removeEventListener: () => undefined,
    });
    run();
    try {
      expect(getState().status?.kind).toBe("info");
      expect(getState().status?.message).toBe(WHATS_THIS_ON);
      expect(attributes.has(WHATS_THIS_ATTRIBUTE)).toBe(true);
      expect(listeners).toEqual(expect.arrayContaining(["pointerdown", "keydown", "click"]));
    } finally {
      endWhatsThis();
    }
    expect(attributes.has(WHATS_THIS_ATTRIBUTE)).toBe(false);
  });

  it("opens the focused element's hint and leaves the status line alone", () => {
    const focused = element();
    const explain = vi.fn();
    const off = registerExplainer(focused, explain, "own");
    vi.stubGlobal("document", { activeElement: focused });
    try {
      run();
    } finally {
      off();
    }
    expect(explain).toHaveBeenCalledTimes(1);
    expect(getState().status).toBeNull();
  });
});
