/**
 * The optimizer's settings: the `features.optimizer` switch, the card's remembered options, the margin
 * that belongs to the robot and not to a person, and the `--path-candidate` token.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS, DEFAULT_FEATURES, NO_FEATURES, loadPrefs, parseFeatures, readPrefs } from "../state/prefs";
import { fallbackTheme, LIGHT_FIELD_INK, readTheme } from "../canvas/theme";
import { applyPreset, presetSettings } from "./presets";
import { loadRobot } from "@horizon36596/zenith-core";
import type { Robot } from "@horizon36596/zenith-schema";
import { CLEARANCE, clearanceRow, optimizeMarginNote } from "./robotSettings";
import { SETTINGS, getSetting, settingEntry, withSetting, type SettingEntry } from "./registry";

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("the Optimize path switch (owner ruling D9)", () => {
  it("is a feature switch that is off in Basic and on in Essential and Full", () => {
    const entry = settingEntry("features.optimizer");
    expect([entry.scope, entry.kind, entry.section, entry.storage, entry.hides]).toEqual(["person", "feature", "general", "features.optimizer", "authoring"]);
    expect(entry.presets).toEqual({ basic: false, essential: true, full: true });
    expect(entry.defaultValue).toBe(true);
    expect(entry.control).toEqual({ type: "switch" });
  });

  it("is in the feature defaults, the stored switches and each built-in preset", () => {
    expect(DEFAULT_FEATURES.optimizer).toBe(true);
    expect(NO_FEATURES.optimizer).toBe(false);
    expect(DEFAULT_PREFS.features.optimizer).toBe(true);
    expect(presetSettings("basic")["features.optimizer"]).toBe(false);
    expect(presetSettings("essential")["features.optimizer"]).toBe(true);
    expect(presetSettings("full")["features.optimizer"]).toBe(true);
    expect(applyPreset(DEFAULT_PREFS, "basic").features.optimizer).toBe(false);
    expect(applyPreset(applyPreset(DEFAULT_PREFS, "basic"), "full").features.optimizer).toBe(true);
  });

  it("keeps a stored true or false and falls back to the default for anything else (parseFeatures)", () => {
    expect(parseFeatures({ optimizer: true }).optimizer).toBe(true);
    expect(parseFeatures({ optimizer: false }).optimizer).toBe(false);
    for (const junk of [undefined, null, "false", "on", 0, 1, [], {}, Number.NaN]) {
      expect(parseFeatures({ optimizer: junk }).optimizer, JSON.stringify(junk)).toBe(true);
    }
    expect(parseFeatures(undefined).optimizer).toBe(true);
    expect(parseFeatures("yes").optimizer).toBe(true);
    // The switch does not touch the others.
    expect(parseFeatures({ optimizer: false })).toEqual({ ...DEFAULT_FEATURES, optimizer: false });
  });

  it("writes through the registry at features.optimizer", () => {
    const off = withSetting(DEFAULT_PREFS, "features.optimizer", false);
    expect(off.features).toEqual({ ...DEFAULT_PREFS.features, optimizer: false });
    expect(getSetting(off, "features.optimizer")).toBe(false);
  });
});

describe("the optimizer card's remembered options", () => {
  it("are registered under the names the Prefs fields have, with their defaults SET BY HAND in spec 16", () => {
    const scorer = settingEntry("optimizer.scorer");
    expect([scorer.storage, scorer.section, scorer.group, scorer.defaultValue, scorer.presets, scorer.needs]).toEqual([
      "optimizeScorer",
      "editor",
      "Optimize path",
      "sim",
      "leave",
      ["features.optimizer"],
    ]);
    for (const id of ["optimizer.allowSplit", "optimizer.allowRanges"] as const) {
      const entry = settingEntry(id);
      expect([entry.defaultValue, entry.presets, entry.control.type, entry.needs], id).toEqual([true, "leave", "switch", ["features.optimizer"]]);
    }
    expect([DEFAULT_PREFS.optimizeScorer, DEFAULT_PREFS.optimizeAllowSplit, DEFAULT_PREFS.optimizeAllowRanges]).toEqual(["sim", true, true]);
  });

  it("registers the heading holds as inches from 0, off, to the field's side (issue #448)", () => {
    for (const id of ["optimizer.holdStartHeadingIn", "optimizer.holdEndHeadingIn"] as const) {
      const entry = settingEntry(id);
      expect([entry.defaultValue, entry.presets, entry.group, entry.needs], id).toEqual([0, "leave", "Optimize path", ["features.optimizer"]]);
      expect(entry.control, id).toEqual({ type: "number", unit: "in", min: 0, max: 144, step: 1 });
      expect(entry.parse(12), id).toBe(12);
      expect(entry.parse(-1), id).toBeUndefined();
      expect(entry.parse(145), id).toBeUndefined();
      expect(entry.parse("12"), id).toBeUndefined();
    }
    expect([DEFAULT_PREFS.optimizeHoldStartHeadingIn, DEFAULT_PREFS.optimizeHoldEndHeadingIn]).toEqual([0, 0]);
  });

  it("offers the instant sim and the estimate, and no other scorer", () => {
    const { control, parse } = settingEntry("optimizer.scorer");
    if (control.type !== "segmented" || control.options === "fieldStyles") throw new Error("a segmented control with its own options");
    expect(control.options.map((option) => option.value)).toEqual(["sim", "estimate"]);
    expect(parse("estimate")).toBe("estimate");
    expect(parse("full")).toBeUndefined();
    expect(parse(true)).toBeUndefined();
  });

  it("is left alone by every built-in preset, so applying one never changes a chosen option", () => {
    const chosen = { ...DEFAULT_PREFS, optimizeScorer: "estimate" as const, optimizeAllowSplit: false, optimizeAllowRanges: false };
    for (const preset of ["basic", "essential", "full"] as const) {
      const applied = applyPreset(chosen, preset);
      expect([applied.optimizeScorer, applied.optimizeAllowSplit, applied.optimizeAllowRanges], preset).toEqual(["estimate", false, false]);
    }
  });

  it("has no margin: the margin is the robot's footprint.clearanceIn, not a person's setting", () => {
    expect(SETTINGS.filter((entry) => /margin|clearance/i.test(entry.id + entry.storage)).map((entry) => entry.id)).toEqual(["display.clearanceOutline"]);
    expect(Object.keys(DEFAULT_PREFS).filter((key) => /margin/i.test(key))).toEqual([]);
  });
});

describe("loading the optimizer's stored choices", () => {
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
  const load = (blob: unknown) => {
    stored.set("zenith.ui", JSON.stringify(blob));
    return loadPrefs();
  };

  it("keeps a stored choice of each option", () => {
    const prefs = load({ version: 1, optimizeScorer: "estimate", optimizeAllowSplit: false, optimizeAllowRanges: false, features: { optimizer: false } });
    expect([prefs.optimizeScorer, prefs.optimizeAllowSplit, prefs.optimizeAllowRanges, prefs.features.optimizer]).toEqual(["estimate", false, false, false]);
  });

  it("falls back to the default for anything it does not know, one key at a time", () => {
    for (const junk of [undefined, null, "", "full", "SIM", 3, true, [], {}]) {
      const prefs = load({ version: 1, optimizeScorer: junk, optimizeAllowSplit: junk, optimizeAllowRanges: junk, features: { optimizer: junk } });
      expect([prefs.optimizeScorer, prefs.optimizeAllowSplit, prefs.optimizeAllowRanges, prefs.features.optimizer], JSON.stringify(junk)).toEqual([
        "sim",
        true,
        true,
        true,
      ]);
    }
    const one = load({ version: 1, optimizeScorer: "estimate", optimizeAllowSplit: "no", theme: "light" });
    expect([one.optimizeScorer, one.optimizeAllowSplit, one.theme]).toEqual(["estimate", true, "light"]);
  });

  it("gives a setting nothing stored the recorded preset's value, so Basic stays off", () => {
    expect(load({ version: 1, preset: { id: "basic", chosen: true } }).features.optimizer).toBe(false);
    expect(load({ version: 1, preset: { id: "full", chosen: true } }).features.optimizer).toBe(true);
    expect(load({ version: 1, preset: { id: "basic", chosen: true }, features: { optimizer: true } }).features.optimizer).toBe(true);
    expect(load({ version: 1 }).features.optimizer).toBe(true);
  });

  it("parses every registered default back and rejects junk, like the rest of the registry", () => {
    for (const id of [
      "features.optimizer",
      "optimizer.scorer",
      "optimizer.allowSplit",
      "optimizer.allowRanges",
      "optimizer.holdStartHeadingIn",
      "optimizer.holdEndHeadingIn",
    ] as const) {
      const entry = settingEntry(id) as SettingEntry;
      expect(entry.parse(entry.defaultValue), id).toEqual(entry.defaultValue);
      expect(entry.parse("junk"), id).toBeUndefined();
      expect(entry.parse(undefined), id).toBeUndefined();
    }
    expect(readPrefs({}).optimizeScorer).toBe("sim");
  });
});

describe("the margin's helper text", () => {
  const starter = (): Robot => loadRobot(JSON.parse(read("../../../../examples/starter/autos/robot.json")));
  const withTolerance = (robot: Robot, value: number): Robot => ({
    ...robot,
    kinematics: {
      ...robot.kinematics,
      follower: { ...robot.kinematics.follower, translationalDeviationToleranceIn: { value, provenance: "SET BY HAND: a test" } },
    },
  });

  it("says Pedro's follower may drift 2.5 in by default and that the instant sim's own motion is checked", () => {
    for (const note of [optimizeMarginNote(null), optimizeMarginNote(starter())]) {
      expect(note).toMatch(/Pedro/);
      expect(note).toContain("up to 2.5 in by default");
      expect(note).toMatch(/instant sim/i);
      expect(note.length).toBeLessThanOrEqual(300);
    }
  });

  it("reads the robot's own follower tolerance when robot.json sets one", () => {
    const note = optimizeMarginNote(withTolerance(starter(), 1.5));
    expect(note).toContain("up to 1.5 in on this robot");
    expect(note).not.toContain("2.5");
  });

  it("is on the robot's clearance row too, where the margin is set, while Optimize path is on", () => {
    const robot = withTolerance(starter(), 1.5);
    const row = clearanceRow(robot, true);
    expect(row.hint).toBe(`${CLEARANCE.hint} ${optimizeMarginNote(robot)}`);
    expect(row.hint.length).toBeLessThanOrEqual(300);
    expect({ ...row, hint: CLEARANCE.hint }).toEqual(CLEARANCE);
  });

  it("leaves the clearance row with no word of Optimize path while that switch is off", () => {
    const row = clearanceRow(starter(), false);
    expect(row.hint).toBe(CLEARANCE.hint);
    expect(row.hint).not.toMatch(/Optimize|Pedro|instant sim/);
  });
});

describe("--path-candidate", () => {
  const tokens = read("../styles/tokens.css");
  const guide = read("../../UI_GUIDE.md");

  it("is defined once in tokens.css, as a hex colour for the dark field, which the light page theme shares", () => {
    const definitions = [...tokens.matchAll(/^\s*--path-candidate:\s*(#[0-9a-f]{6})\s*;/gim)];
    expect(definitions).toHaveLength(1);
    // The field well stays dark in both themes (the light block does not override canvas tokens).
    const light = tokens.slice(tokens.indexOf(':root[data-theme="light"]'));
    expect(light).not.toMatch(/--path-candidate/);
  });

  it("reaches the canvas theme, and has its own ink over a light field picture", () => {
    const [, hex] = /--path-candidate:\s*(#[0-9a-f]{6})/i.exec(tokens) ?? [];
    expect(fallbackTheme().pathCandidate).toBe(hex);
    expect(LIGHT_FIELD_INK.pathCandidate).toMatch(/^#[0-9a-f]{6}$/);
    expect(LIGHT_FIELD_INK.pathCandidate).not.toBe(fallbackTheme().pathCandidate);
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: (name: string) => (name === "--path-candidate" ? " #123456 " : "") }));
    try {
      expect(readTheme({} as Element).pathCandidate).toBe("#123456");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("is in UI_GUIDE's token groups (4.3) and in a contrast row (4.4) for each ground it draws on", () => {
    const groups = guide.slice(guide.indexOf("### 4.3 Token groups"), guide.indexOf("### 4.4 Contrast"));
    expect(groups).toContain("`--path-candidate`");
    const contrast = guide.slice(guide.indexOf("### 4.4 Contrast"), guide.indexOf("## 5. Type"));
    const rows = contrast.split("\n").filter((line) => line.includes("--path-candidate"));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.some((row) => row.includes("`canvas`"))).toBe(true);
    expect(rows.some((row) => /light field/i.test(row))).toBe(true);
  });
});
