/**
 * The list of the person's presets in this page (`presetStore.ts`) against `zenith.presets` when
 * another tab changes it: the page reads the list again, so its next change never writes over the
 * other tab's.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS } from "../state/prefs";
import { userPresetFrom, type UserPreset } from "./presets";

const preset = (id: `user:${string}`, name: string): UserPreset =>
  userPresetFrom(DEFAULT_PREFS, { id, name, description: "", basedOn: "essential", includeKeys: false });

const KEY = "zenith.presets";

describe("the preset list and another tab", () => {
  const stored = new Map<string, string>();
  const onStorage: ((event: { key: string | null }) => void)[] = [];
  const otherTab = (key: string | null): void => {
    for (const listener of onStorage) listener({ key });
  };
  let store: typeof import("./presetStore");

  // The store listens from the moment it loads, so it loads once, with the window stubbed first.
  beforeAll(async () => {
    vi.resetModules();
    (globalThis as { window?: unknown }).window = {
      location: { search: "", hash: "", pathname: "/", href: "http://localhost/" },
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => {
          stored.set(key, value);
        },
        removeItem: (key: string) => {
          stored.delete(key);
        },
      },
      addEventListener: (type: string, listener: (event: { key: string | null }) => void) => {
        if (type === "storage") onStorage.push(listener);
      },
      removeEventListener: () => undefined,
    };
    store = await import("./presetStore");
  }, 30_000);

  afterAll(() => {
    delete (globalThis as { window?: unknown }).window;
    vi.resetModules();
  });

  beforeEach(() => {
    stored.clear();
    // A cleared storage, as another tab would report it: the store forgets the list it read.
    otherTab(null);
  });

  it("reads the list again when another tab writes it, so a later change keeps that tab's preset", () => {
    const x = preset("user:x", "X");
    stored.set(KEY, JSON.stringify({ version: 1, presets: [x] }));
    expect(store.getUserPresets().map((one) => one.name)).toEqual(["X"]);

    // Another tab adds Y.
    stored.set(KEY, JSON.stringify({ version: 1, presets: [x, preset("user:y", "Y")] }));
    otherTab(KEY);
    expect(store.getUserPresets().map((one) => one.name)).toEqual(["X", "Y"]);

    // This tab duplicates X: Y is still there afterwards.
    expect(store.duplicatePreset("user:x").ok).toBe(true);
    const after = JSON.parse(stored.get(KEY) ?? "null") as { presets: UserPreset[] };
    expect(after.presets.map((one) => one.name)).toEqual(["X", "Y", "X (2)"]);
  });

  it("ignores another key's change", () => {
    stored.set(KEY, JSON.stringify({ version: 1, presets: [preset("user:x", "X")] }));
    const first = store.getUserPresets();
    otherTab("zenith.ui");
    expect(store.getUserPresets()).toBe(first);
  });
});
