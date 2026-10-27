/**
 * Issue #412: a context menu opens where the person clicked, in window coordinates. Its top is at
 * the pointer, it flips to end at the pointer when it would leave the window below, and when it
 * fits neither way it stays inside the window and scrolls. It is never held to a panel's top.
 */
import { describe, expect, it } from "vitest";
import { placeMenu } from "./ContextMenu";

describe("placeMenu", () => {
  it("opens with its top at the pointer when it fits below", () => {
    expect(placeMenu(400, 327, 220, 300, 1280, 720)).toEqual({ left: 400, top: 327 });
  });

  it("flips above the pointer when it would leave the window below", () => {
    expect(placeMenu(400, 600, 220, 300, 1280, 720)).toEqual({ left: 400, top: 300 });
  });

  it("flips to the pointer's left at the window's right edge", () => {
    expect(placeMenu(1200, 100, 220, 300, 1280, 720).left).toBe(980);
  });

  it("stays inside the window and scrolls when it fits neither below nor above", () => {
    const tall = placeMenu(400, 360, 220, 900, 1280, 720);
    expect(tall.maxHeightPx).toBe(712);
    expect(tall.top).toBe(4);
    // One that fits the window's height, but on neither side of the pointer, ends at the window's bottom.
    expect(placeMenu(400, 360, 220, 700, 1280, 720).top).toBe(16);
  });
});
