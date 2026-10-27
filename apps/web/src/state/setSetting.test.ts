/**
 * `setSetting` is the one way a registered setting is written: the feature switches, the snap key and the
 * palette toggles all go through it, and it stores each value flat in `zenith.ui` under its existing
 * name.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalize, loadAuto } from "@horizon36596/zenith-core";
import type { Auto } from "@horizon36596/zenith-schema";
import { setFeature, setFeatures } from "./features";
import { actionById } from "../app/actions";
import { DEFAULT_FEATURES, DEFAULT_PREFS, loadPrefs, readPrefs } from "./prefs";
import { getState, openAuto, setPrefs, setSelection, setSetting, setTool, toggleClipGhosts, toggleLedgerCounts, toggleSnap } from "./store";

const starter = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const first = (): Auto => loadAuto(JSON.parse(readFileSync(`${starter}first-auto.auto.json`, "utf8")));

const stored = new Map<string, string>();
const saved = (): Record<string, unknown> => JSON.parse(stored.get("zenith.ui") ?? "{}") as Record<string, unknown>;

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
  // Everything but the theme, which would reach for the document.
  const { theme: _theme, ...rest } = DEFAULT_PREFS;
  setPrefs(rest);
  const auto = first();
  openAuto("first-auto.auto.json", auto, canonicalize("auto", auto));
});
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("setSetting", () => {
  it("stores a value under its existing name and leaves the others", () => {
    setSetting("features.ledger", true);
    expect(getState().prefs.features).toEqual({ ...DEFAULT_FEATURES, ledger: true });
    expect(saved()["features"]).toEqual({ ...DEFAULT_FEATURES, ledger: true });
    setSetting("editing.snap", false);
    expect(saved()["snap"]).toBe(false);
    expect(saved()["features"]).toEqual({ ...DEFAULT_FEATURES, ledger: true });
  });

  it("clears what a switch now hides, as setFeature always did", () => {
    setSelection({ stepId: "scorePreload" });
    setTool("marker");
    setSetting("features.commands", false);
    expect(getState().selection).toEqual({});
    expect(getState().tool).toBe("select");
  });

  it("carries setFeature and setFeatures", () => {
    setFeature("partners", true);
    expect(saved()["features"]).toEqual({ ...DEFAULT_FEATURES, partners: true });
    setFeatures({ partners: false, ledger: true, commands: false });
    expect(getState().prefs.features).toEqual({ ...DEFAULT_FEATURES, ledger: true, commands: false });
    expect(saved()["features"]).toEqual({ ...DEFAULT_FEATURES, ledger: true, commands: false });
    // A switch it does not name stays as it was.
    setFeatures({ groups: false });
    expect(getState().prefs.features).toEqual({ ...DEFAULT_FEATURES, ledger: true, commands: false, groups: false });
  });

  it("carries the snap, clip ghost and ledger count toggles", () => {
    toggleSnap();
    toggleClipGhosts();
    toggleLedgerCounts();
    expect([saved()["snap"], saved()["clipGhosts"], saved()["ledgerCounts"]]).toEqual([false, false, false]);
    toggleSnap();
    expect(getState().prefs.snap).toBe(true);
  });
});

describe("the Grid setting (spec 15 section 10)", () => {
  it("is Tiles until chosen, and a saved blob with no grid reads as Tiles", () => {
    expect(getState().prefs.fieldGrid).toBe("tiles");
    expect(readPrefs({ version: 1, snap: false }).fieldGrid).toBe("tiles");
  });

  it("keeps each choice, and one that is not a choice falls back alone to Tiles", () => {
    for (const choice of ["off", "tiles", "12", "6"] as const) {
      expect(readPrefs({ version: 1, fieldGrid: choice }).fieldGrid).toBe(choice);
    }
    const junk = readPrefs({ version: 1, fieldGrid: "24", snap: false });
    expect(junk.fieldGrid).toBe("tiles");
    expect(junk.snap).toBe(false);
    expect(readPrefs({ version: 1, fieldGrid: 12 }).fieldGrid).toBe("tiles");
  });

  it("is written flat under fieldGrid by setSetting, and survives a reload", () => {
    setSetting("display.fieldGrid", "12");
    expect(getState().prefs.fieldGrid).toBe("12");
    expect(saved()["fieldGrid"]).toBe("12");
    expect(loadPrefs().fieldGrid).toBe("12");
  });

  it("is stepped through Off, Tiles, 12 in and 6 in by the palette action, and round again", () => {
    const step = (): string => {
      void actionById("view.fieldGrid")?.run();
      return getState().prefs.fieldGrid;
    };
    expect([step(), step(), step(), step()]).toEqual(["12", "6", "off", "tiles"]);
    expect(saved()["fieldGrid"]).toBe("tiles");
    expect(actionById("view.fieldGrid")?.labelFor?.(getState())).toBe("Field grid: Tiles (24 in)");
  });

  it("is joined in the palette by the other display toggles, which say their state too (0.1.2 UX sweep, W1-13)", () => {
    const label = (id: string): string | undefined => actionById(id)?.labelFor?.(getState());
    setPrefs({ clipGhosts: true, overheadOutlines: false, descriptions: "full" });
    expect(label("view.clipGhosts")).toBe("Clip ghosts: Shown");
    expect(label("view.overheadOutlines")).toBe("Overhead outlines: Hidden");
    expect(label("view.descriptions")).toBe("Descriptions: With descriptions");
    setPrefs({ clipGhosts: false, overheadOutlines: true, descriptions: "compact" });
    expect(label("view.clipGhosts")).toBe("Clip ghosts: Hidden");
    expect(label("view.overheadOutlines")).toBe("Overhead outlines: Shown");
    expect(label("view.descriptions")).toBe("Descriptions: Labels only");
  });
});

describe("Start a new path with the previous path's end heading (issue #435)", () => {
  it("is on until turned off, under its own name, and a saved blob without it reads as on", () => {
    expect(getState().prefs.newPathKeepsHeading).toBe(true);
    expect(readPrefs({ version: 1, snap: false }).newPathKeepsHeading).toBe(true);
    setSetting("editing.newPathKeepsHeading", false);
    expect(getState().prefs.newPathKeepsHeading).toBe(false);
    expect(saved()["newPathKeepsHeading"]).toBe(false);
    expect(loadPrefs().newPathKeepsHeading).toBe(false);
    expect(readPrefs({ version: 1, newPathKeepsHeading: "no" }).newPathKeepsHeading).toBe(true);
  });
});

describe("the heading for new paths (spec 15 section 11, owner ruling D6)", () => {
  it("is Linear until chosen, and a saved blob with no heading setting reads as Linear", () => {
    expect(getState().prefs.defaultHeading).toBe("linear");
    expect(readPrefs({ version: 1, snap: false }).defaultHeading).toBe("linear");
    expect(readPrefs({ version: 1, snap: false }).addPathExtends).toBe(false);
  });

  it("keeps each choice, and one that is not a choice falls back alone to Linear", () => {
    for (const choice of ["tangent", "linear", "constant"] as const) {
      expect(readPrefs({ version: 1, defaultHeading: choice }).defaultHeading).toBe(choice);
    }
    const junk = readPrefs({ version: 1, defaultHeading: "piecewise", snap: false });
    expect(junk.defaultHeading).toBe("linear");
    expect(junk.snap).toBe(false);
    expect(readPrefs({ version: 1, defaultHeading: 1 }).defaultHeading).toBe("linear");
  });

  it("is written flat under defaultHeading by setSetting, and survives a reload", () => {
    setSetting("editing.defaultHeading", "tangent");
    expect(getState().prefs.defaultHeading).toBe("tangent");
    expect(saved()["defaultHeading"]).toBe("tangent");
    expect(loadPrefs().defaultHeading).toBe("tangent");
  });

  it("is never written into the open document", () => {
    const before = getState().auto;
    setSetting("editing.defaultHeading", "constant");
    expect(getState().auto).toBe(before);
  });

  it("keeps Extend this chain under its own name", () => {
    setSetting("editing.addPathExtends", true);
    expect(getState().prefs.addPathExtends).toBe(true);
    expect(saved()["addPathExtends"]).toBe(true);
    expect(readPrefs({ version: 1, addPathExtends: "yes" }).addPathExtends).toBe(false);
  });

  it("keeps Protect measured waypoints on until turned off, under its own name, and never in the document", () => {
    expect(getState().prefs.protectMeasuredPins).toBe(true);
    expect(readPrefs({ version: 1, snap: false }).protectMeasuredPins).toBe(true);
    const before = getState().auto;
    setSetting("editing.protectMeasuredPins", false);
    expect(getState().prefs.protectMeasuredPins).toBe(false);
    expect(saved()["protectMeasuredPins"]).toBe(false);
    expect(loadPrefs().protectMeasuredPins).toBe(false);
    expect(getState().auto).toBe(before);
    expect(readPrefs({ version: 1, protectMeasuredPins: false }).protectMeasuredPins).toBe(false);
    expect(readPrefs({ version: 1, protectMeasuredPins: "no" }).protectMeasuredPins).toBe(true);
  });
});
