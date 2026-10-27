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

describe("CloseGuard for a page that stopped", () => {
  function stopped(holdsEdits: boolean) {
    const window = { isDestroyed: vi.fn(() => false), close: vi.fn(), askPage: vi.fn(), holdsEdits: vi.fn(() => holdsEdits), askMain: vi.fn() };
    const quit = vi.fn();
    const guard = new CloseGuard(window, quit);
    return { guard, window, quit };
  }

  it("asks main's own question at once when the page stops, and Reload keeps the window", () => {
    const { guard, window } = stopped(true);
    guard.pageListening();
    guard.pageStopped();
    expect(window.askMain).toHaveBeenCalledTimes(1);
    // A close while that question is open waits for it.
    expect(guard.onClose()).toBe(false);
    expect(window.askMain).toHaveBeenCalledTimes(1);
    guard.answer(false);
    expect(window.close).not.toHaveBeenCalled();
  });

  it("asks main before closing a stopped page that left edits, and closes on its yes", () => {
    const { guard, window } = stopped(true);
    expect(guard.onClose()).toBe(false);
    expect(window.askMain).toHaveBeenCalledTimes(1);
    expect(window.askPage).not.toHaveBeenCalled();
    guard.answer(true);
    expect(window.close).toHaveBeenCalledTimes(1);
  });

  it("holds a quit for those edits too", () => {
    const { guard, quit } = stopped(true);
    expect(guard.onBeforeQuit()).toBe(false);
    guard.answer(true);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("closes a stopped page with no edits at once", () => {
    const { guard, window } = stopped(false);
    expect(guard.onClose()).toBe(true);
    expect(guard.onBeforeQuit()).toBe(true);
    expect(window.askMain).not.toHaveBeenCalled();
  });
});
