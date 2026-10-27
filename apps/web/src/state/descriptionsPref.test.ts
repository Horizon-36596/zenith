/**
 * The Descriptions option (issue #238): stored as `descriptions` in `zenith.ui`, "compact" (Labels
 * only) by decision desc-default, and the one-time hint that says how to read a row's description.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_DESCRIPTIONS, DEFAULT_PREFS, loadPrefs, parseDescriptions, savePrefs } from "./prefs";

describe("the Descriptions option as stored", () => {
  const stored = new Map<string, string>();
  beforeEach(() => {
    stored.clear();
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => {
          stored.set(key, value);
        },
      },
    };
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("defaults to Labels only, the choice of decision desc-default", () => {
    expect(DEFAULT_DESCRIPTIONS).toBe("compact");
    expect(DEFAULT_PREFS.descriptions).toBe("compact");
  });

  it("loads as the default when it was never stored", () => {
    expect(loadPrefs().descriptions).toBe("compact");
    stored.set("zenith.ui", JSON.stringify({ version: 1, theme: "light" }));
    expect(loadPrefs().descriptions).toBe("compact");
  });

  it("falls back to the default for a value it does not know", () => {
    for (const value of ["Full", "labels", 1, true, null, {}]) {
      stored.set("zenith.ui", JSON.stringify({ version: 1, descriptions: value }));
      expect(loadPrefs().descriptions, JSON.stringify(value)).toBe("compact");
      expect(parseDescriptions(value)).toBe("compact");
    }
  });

  it("keeps a stored choice across a reload", () => {
    savePrefs({ ...DEFAULT_PREFS, descriptions: "full" });
    expect(JSON.parse(stored.get("zenith.ui") ?? "{}")).toMatchObject({ descriptions: "full" });
    expect(loadPrefs().descriptions).toBe("full");
    savePrefs({ ...DEFAULT_PREFS, descriptions: "compact" });
    expect(loadPrefs().descriptions).toBe("compact");
  });

  it("remembers that the one-time hint was shown, and starts with it unshown", () => {
    expect(DEFAULT_PREFS.descriptionsHintSeen).toBe(false);
    expect(loadPrefs().descriptionsHintSeen).toBe(false);
    savePrefs({ ...DEFAULT_PREFS, descriptionsHintSeen: true });
    expect(loadPrefs().descriptionsHintSeen).toBe(true);
    stored.set("zenith.ui", JSON.stringify({ version: 1, descriptionsHintSeen: "yes" }));
    expect(loadPrefs().descriptionsHintSeen).toBe(false);
  });
});
