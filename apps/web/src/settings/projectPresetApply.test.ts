/**
 * Applying one of the project's presets (issue #484): it
 * is applied through the person's copy, linked to its file, so applying it again after the file
 * changed updates that copy rather than adding another. Add to project links the person's preset to
 * the file it wrote, and Duplicate makes a copy that is the person's own.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PresetFilePreset } from "./presetFile";
import type { UserPreset } from "./presets";
import type { ProjectPreset } from "./projectPresets";

const KEY = "zenith.presets";
const PROJECT = "folder:robot-repo";
const FILE = "Drive team.zenith-preset.json";

const item = (settings: PresetFilePreset["settings"], extra: Partial<PresetFilePreset> = {}): ProjectPreset => ({
  file: FILE,
  preset: { name: "Drive team", description: "", basedOn: "full", settings, ...extra },
  report: { unknown: 0, dropped: [], refused: [], keysRefused: [], ignored: [], renamed: false },
});

describe("applying a project's preset", () => {
  const stored = new Map<string, string>();
  let store: typeof import("./presetStore");
  let state: typeof import("../state/store");

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
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    store = await import("./presetStore");
    state = await import("../state/store");
  }, 30_000);

  afterAll(() => {
    delete (globalThis as { window?: unknown }).window;
    vi.resetModules();
  });

  const mine = (): UserPreset[] => (JSON.parse(stored.get(KEY) ?? '{"presets":[]}') as { presets: UserPreset[] }).presets;

  beforeEach(() => {
    // Start each test from an empty list, through the store, so its cached list is empty too.
    for (const one of store.getUserPresets()) store.deletePreset(one.id);
    stored.clear();
  });

  it("keeps a linked copy under the file's name and applies it", () => {
    const result = store.applyProjectPreset(PROJECT, item({ "features.ledger": true }), { keys: false });
    expect(result.ok).toBe(true);
    expect(mine()).toHaveLength(1);
    expect(mine()[0]).toMatchObject({ name: "Drive team", basedOn: "full", fromProject: { project: PROJECT, file: FILE } });
    const { prefs } = state.getState();
    expect(prefs.preset.id).toBe(mine()[0]?.id);
    expect(prefs.features.ledger).toBe(true);
  });

  it("updates the same copy when applied again after the file changed, keeping the name the person gave it", () => {
    store.applyProjectPreset(PROJECT, item({ "features.ledger": true }), { keys: false });
    const first = mine()[0];
    if (first === undefined) throw new Error("no copy");
    expect(store.renamePreset(first.id, "Ours").ok).toBe(true);

    store.applyProjectPreset(PROJECT, item({ "features.ledger": false }, { description: "Ledger off now" }), { keys: false });
    expect(mine()).toHaveLength(1);
    expect(mine()[0]).toMatchObject({ id: first.id, name: "Ours", description: "Ledger off now", settings: { "features.ledger": false } });
    expect(state.getState().prefs.features.ledger).toBe(false);
  });

  it("drops the copy's keys when the file no longer has any, and takes them only when asked", () => {
    store.applyProjectPreset(PROJECT, item({}, { keys: { "run.validate": "Ctrl Shift E" } }), { keys: false });
    expect(mine()[0]?.keys).toEqual({ "run.validate": "Ctrl Shift E" });
    expect(state.getState().prefs.keys).not.toHaveProperty("run.validate");
    expect(state.getState().prefs.preset.keptKeys).toBe(true);
    store.applyProjectPreset(PROJECT, item({}), { keys: false });
    expect(mine()[0]).not.toHaveProperty("keys");
  });

  it("names a new copy 'Name (2)' when the person has a preset of that name already", () => {
    store.saveCurrentAsPreset({ name: "Drive team", description: "", includeKeys: false });
    store.applyProjectPreset(PROJECT, item({ "features.ledger": true }), { keys: false });
    expect(mine().map((one) => one.name)).toEqual(["Drive team", "Drive team (2)"]);
    expect(mine()[0]).not.toHaveProperty("fromProject");
  });

  it("adds nothing when the person has 20 presets and no copy of this one", () => {
    for (let n = 0; n < 20; n += 1) store.saveCurrentAsPreset({ name: `P${String(n)}`, description: "", includeKeys: false });
    const before = state.getState().prefs.preset;
    const result = store.applyProjectPreset(PROJECT, item({ "features.ledger": true }), { keys: false });
    expect(result.ok).toBe(false);
    expect(mine()).toHaveLength(20);
    expect(state.getState().prefs.preset).toEqual(before);
  });

  it("links a preset to the file Add to project wrote, and lets any other copy of that file go", () => {
    store.applyProjectPreset(PROJECT, item({ "features.ledger": true }), { keys: false });
    const saved = store.saveCurrentAsPreset({ name: "Mine", description: "", includeKeys: false });
    if (!saved.ok) throw new Error(saved.reason);
    store.linkPresetToProject(saved.preset.id, { project: PROJECT, file: FILE });
    const byName = Object.fromEntries(mine().map((one) => [one.name, one]));
    expect(byName["Mine"]?.fromProject).toEqual({ project: PROJECT, file: FILE });
    expect(byName["Drive team"]).not.toHaveProperty("fromProject");
  });

  it("makes Duplicate's copy the person's own, with no link", () => {
    store.applyProjectPreset(PROJECT, item({ "features.ledger": true }), { keys: false });
    const first = mine()[0];
    if (first === undefined) throw new Error("no copy");
    expect(store.duplicatePreset(first.id).ok).toBe(true);
    expect(mine()[1]).toMatchObject({ name: "Drive team (2)" });
    expect(mine()[1]).not.toHaveProperty("fromProject");
  });
});
