import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  afterBetaNotice,
  BETA_NOTICE_DISMISSED,
  betaNoticeDue,
  betaNoticeKey,
  dismissBetaNotice,
  initBetaNotice,
  isBetaNoticeOpen,
  resetBetaNoticeForTest,
  type NoticeStorage,
} from "./betaNoticeState";

/** An in-memory storage, as localStorage behaves. */
function memory(seed: Record<string, string> = {}): NoticeStorage & { items: Map<string, string> } {
  const items = new Map(Object.entries(seed));
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

/** A storage whose every read and write throws, as blocked site data does. */
const throwing: NoticeStorage = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};

afterEach(() => {
  resetBetaNoticeForTest();
});

describe("the beta notice", () => {
  it("names the version in its key", () => {
    expect(betaNoticeKey("0.1.2")).toBe("zenith.betaNotice.0.1.2");
  });

  it("is spelled the same in the scripts that cannot import it", () => {
    // The docs screenshot script and the desktop e2e seed write the key themselves.
    for (const file of ["../../scripts/capture-screenshots.mjs", "../../../desktop/e2e/firstRunDone.ts"]) {
      const text = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
      expect(text, file).toContain(`\`${betaNoticeKey("${")}`);
      expect(text, file).toContain(`"${BETA_NOTICE_DISMISSED}"`);
    }
  });

  it("is due on a fresh profile and not once this version was dismissed", () => {
    expect(betaNoticeDue("0.1.2", memory())).toBe(true);
    expect(betaNoticeDue("0.1.2", memory({ [betaNoticeKey("0.1.2")]: BETA_NOTICE_DISMISSED }))).toBe(false);
  });

  it("is due again for a new version", () => {
    expect(betaNoticeDue("0.1.3", memory({ [betaNoticeKey("0.1.2")]: BETA_NOTICE_DISMISSED }))).toBe(true);
  });

  it("is due on every load when storage is missing or throws", () => {
    expect(betaNoticeDue("0.1.2", null)).toBe(true);
    expect(betaNoticeDue("0.1.2", throwing)).toBe(true);
  });

  it("remembers a dismissal for the version it was shown for", () => {
    const storage = memory();
    initBetaNotice("0.1.2", storage);
    expect(isBetaNoticeOpen()).toBe(true);
    dismissBetaNotice(storage);
    expect(isBetaNoticeOpen()).toBe(false);
    expect(storage.items.get(betaNoticeKey("0.1.2"))).toBe(BETA_NOTICE_DISMISSED);
  });

  it("closes without an error when the write throws", () => {
    initBetaNotice("0.1.2", throwing);
    expect(isBetaNoticeOpen()).toBe(true);
    expect(() => {
      dismissBetaNotice(throwing);
    }).not.toThrow();
    expect(isBetaNoticeOpen()).toBe(false);
  });

  it("decides once per page, so a second init does not reopen it", () => {
    const storage = memory();
    initBetaNotice("0.1.2", storage);
    dismissBetaNotice(storage);
    initBetaNotice("0.1.2", memory());
    expect(isBetaNoticeOpen()).toBe(false);
  });

  it("holds what waits for it until it closes, and runs it at once when it is closed", () => {
    const ran: string[] = [];
    initBetaNotice("0.1.2", memory());
    afterBetaNotice(() => ran.push("tour"));
    expect(ran).toEqual([]);
    dismissBetaNotice(memory());
    expect(ran).toEqual(["tour"]);
    afterBetaNotice(() => ran.push("later"));
    expect(ran).toEqual(["tour", "later"]);
  });
});
