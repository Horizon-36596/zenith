/**
 * The desktop's native menu and the beta notice: a menu command that arrives over IPC while the
 * notice is open does nothing, as a key does nothing behind it, and runs as usual once it is closed.
 */
import { afterEach, describe, expect, it } from "vitest";
import { dismissBetaNotice, initBetaNotice, resetBetaNoticeForTest, type NoticeStorage } from "../dialogs/betaNoticeState";
import type { DesktopMenuCommand } from "./desktopBridge";
import { hearMenuCommand } from "./desktopActions";

const empty = (): NoticeStorage => {
  const items = new Map<string, string>();
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => void items.set(key, value) };
};

afterEach(() => {
  resetBetaNoticeForTest();
});

describe("a native menu command and the beta notice", () => {
  it("is ignored while the notice is open, and runs once it is closed", () => {
    const ran: string[] = [];
    const run = (command: DesktopMenuCommand): Promise<void> => {
      ran.push(command.action);
      return Promise.resolve();
    };
    const storage = empty();
    initBetaNotice("0.1.2", storage);
    expect(hearMenuCommand({ action: "help.tour" }, run)).toBe(false);
    expect(hearMenuCommand({ action: "project.openFolder" }, run)).toBe(false);
    expect(ran).toEqual([]);

    dismissBetaNotice(storage);
    expect(hearMenuCommand({ action: "help.tour" }, run)).toBe(true);
    expect(ran).toEqual(["help.tour"]);
  });
});
