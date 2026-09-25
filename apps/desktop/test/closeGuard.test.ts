import { describe, expect, it, vi } from "vitest";
import { CloseGuard } from "../src/main/closeGuard.js";

function setup() {
  const window = { isDestroyed: vi.fn(() => false), close: vi.fn(), askPage: vi.fn() };
  const quit = vi.fn();
  const guard = new CloseGuard(window, quit);
  return { guard, window, quit };
}

describe("CloseGuard", () => {
  it("lets a page that cannot answer close at once", () => {
    const { guard, window } = setup();
    expect(guard.onClose()).toBe(true);
    expect(window.askPage).not.toHaveBeenCalled();
  });

  it("holds the close, asks the page once, and closes for real on a yes", () => {
    const { guard, window } = setup();
    guard.pageListening();
    expect(guard.onClose()).toBe(false);
    expect(guard.onClose()).toBe(false);
    expect(window.askPage).toHaveBeenCalledTimes(1);
    guard.answer(true);
    expect(window.close).toHaveBeenCalledTimes(1);
    // The close that call makes goes through, so there is no second question and no loop.
    expect(guard.onClose()).toBe(true);
    expect(window.askPage).toHaveBeenCalledTimes(1);
  });

  it("keeps the window on Cancel, and asks again next time", () => {
    const { guard, window } = setup();
    guard.pageListening();
    guard.onClose();
    guard.answer(false);
    expect(window.close).not.toHaveBeenCalled();
    expect(guard.onClose()).toBe(false);
    expect(window.askPage).toHaveBeenCalledTimes(2);
  });

  it("holds a quit the same way, and a yes quits the app", () => {
    const { guard, window, quit } = setup();
    guard.pageListening();
    expect(guard.onBeforeQuit()).toBe(false);
    guard.answer(true);
    expect(quit).toHaveBeenCalledTimes(1);
    expect(window.close).not.toHaveBeenCalled();
    expect(guard.onBeforeQuit()).toBe(true);
  });

  it("forgets a question when the page goes away, and ignores an answer nobody asked for", () => {
    const { guard, window } = setup();
    guard.answer(true);
    expect(window.close).not.toHaveBeenCalled();
    guard.pageListening();
    guard.onClose();
    guard.pageGone();
    expect(guard.onClose()).toBe(true);
  });
});
