import { describe, expect, it, vi } from "vitest";
import { appCommandDirection, forwardAppCommand } from "../src/main/navigate.js";

describe("the window's back and forward commands", () => {
  it("name back and forward for the side buttons and the Back and Forward keys", () => {
    expect(appCommandDirection("browser-backward")).toBe("back");
    expect(appCommandDirection("browser-forward")).toBe("forward");
  });

  it("forward only those two to the page", () => {
    const send = vi.fn();
    for (const command of ["media-play-pause", "browser-refresh", "browser-search", "volume-up", ""]) {
      expect(forwardAppCommand(command, send)).toBe(false);
    }
    expect(send).not.toHaveBeenCalled();
    expect(forwardAppCommand("browser-backward", send)).toBe(true);
    expect(forwardAppCommand("browser-forward", send)).toBe(true);
    expect(send.mock.calls).toEqual([["back"], ["forward"]]);
  });
});
