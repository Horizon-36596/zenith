/**
 * The Inspector's remembered folds (issue #239): `inspectorFolds` in `zenith.ui`, one boolean per
 * kind-level section id. They are layout, so they are read entry by entry: one bad entry is dropped
 * and the others are kept.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PREFS, loadPrefs, parseInspectorFolds, savePrefs } from "./prefs";

describe("the Inspector's folds as stored", () => {
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

  it("starts empty, so every section takes its own default", () => {
    expect(DEFAULT_PREFS.inspectorFolds).toEqual({});
    expect(loadPrefs().inspectorFolds).toEqual({});
  });

  it("drops an entry whose value is not a boolean and keeps the others", () => {
    stored.set(
      "zenith.ui",
      JSON.stringify({
        version: 1,
        inspectorFolds: { "path.heading": false, "step.more": true, "path.speed": "no", envelope: 0, rejoin: null },
      }),
    );
    expect(loadPrefs().inspectorFolds).toEqual({ "path.heading": false, "step.more": true });
  });

  it("reads anything that is not an object as no folds", () => {
    for (const value of [null, 3, "path.heading", true, ["path.heading"]]) {
      expect(parseInspectorFolds(value), JSON.stringify(value)).toEqual({});
    }
  });

  it("keeps the folds across a reload", () => {
    savePrefs({ ...DEFAULT_PREFS, inspectorFolds: { "path.heading": false } });
    expect(loadPrefs().inspectorFolds).toEqual({ "path.heading": false });
  });
});
