/**
 * The settings registry: the tests that hold the system together. Every switch, display option and
 * editing setting is one entry, and the presets, loading and saving read the entries rather than
 * keeping lists of their own.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FINDING_HELP } from "@horizon36596/zenith-core";
import { ACTIONS, TOOLBAR_GROUPS } from "../app/actions";
import { DESKTOP_ACTIONS } from "../project/desktopActions";
import { INSERT_KINDS } from "../help/content";
import { DEFAULT_PREFS } from "../state/prefs";
import { TOUR_STOPS } from "../tour/stops";
import { SECTIONS } from "./sections";
import {
  BUILT_IN_PRESET_IDS,
  SETTINGS,
  TOOLBAR_BUTTONS,
  getSetting,
  isPresettable,
  settingEntry,
  toolbarButtonShown,
  toolbarSettingId,
  withSetting,
  type SettingEntry,
} from "./registry";

const JUNK: readonly unknown[] = [undefined, null, 0, 1, -1, "", "on", "true", "maybe", [], [true], {}, { value: true }, Number.NaN];

describe("the registry", () => {
  it("has unique ids and unique storage keys", () => {
    const ids = SETTINGS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = SETTINGS.map((entry) => entry.storage);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("registers today's settings under their existing storage names, and the new ones beside them", () => {
    const notToolbar = SETTINGS.filter((entry) => !entry.id.startsWith("display.toolbar."));
    expect(Object.fromEntries(notToolbar.map((entry) => [entry.id, entry.storage]))).toEqual({
      "features.partners": "features.partners",
      "features.ledger": "features.ledger",
      "features.commands": "features.commands",
      "features.groups": "features.groups",
      "features.waypoints": "features.waypoints",
      "features.advancedHeading": "features.advancedHeading",
      "features.optimizer": "features.optimizer",
      "features.codeTab": "features.codeTab",
      "features.fullSim": "features.fullSim",
      "sim.speed": "fullSimSpeed",
      "optimizer.scorer": "optimizeScorer",
      "optimizer.allowSplit": "optimizeAllowSplit",
      "optimizer.allowRanges": "optimizeAllowRanges",
      "optimizer.holdStartHeadingIn": "optimizeHoldStartHeadingIn",
      "optimizer.holdEndHeadingIn": "optimizeHoldEndHeadingIn",
      "editing.snap": "snap",
      "editing.defaultHeading": "defaultHeading",
      "editing.addPathExtends": "addPathExtends",
      "editing.newPathKeepsHeading": "newPathKeepsHeading",
      "editing.protectMeasuredPins": "protectMeasuredPins",
      "editing.nudgeIn": "nudgeIn",
      "editing.nudgeFarIn": "nudgeFarIn",
      "editing.rotateDeg": "rotateDeg",
      "editing.scrubStepS": "scrubStepS",
      "display.clipGhosts": "clipGhosts",
      "display.ledgerCounts": "ledgerCounts",
      "display.clearanceOutline": "clearanceOutline",
      "display.waypointPins": "waypointPins",
      "display.theme": "theme",
      "display.fieldView": "fieldView",
      "display.fieldGrid": "fieldGrid",
      "display.fieldStyle": "fieldStyle",
      "display.findingCodes": "findingCodes",
      "keys.bindings": "keys",
    });
    for (const { id } of TOOLBAR_BUTTONS) expect(settingEntry(toolbarSettingId(id)).storage).toBe(`toolbar.${id}`);
  });

  it("sets the new switches and Finding codes as spec 15 section 4 gives them: off in Basic, on in Essential and Full", () => {
    for (const id of [
      "features.groups",
      "features.waypoints",
      "features.advancedHeading",
      "features.optimizer",
      "features.codeTab",
      "display.findingCodes",
    ] as const) {
      expect(settingEntry(id).presets, id).toEqual({ basic: false, essential: true, full: true });
      expect(settingEntry(id).defaultValue, id).toBe(true);
    }
    expect(settingEntry("features.codeTab").hides).toBe("none");
    for (const id of ["features.groups", "features.waypoints", "features.advancedHeading", "features.optimizer"] as const) {
      expect(settingEntry(id).hides, id).toBe("authoring");
    }
  });

  it("gives every toolbar button its own display setting, shown by default and left alone by every built-in", () => {
    // Every button any toolbar draws, in this build or the desktop app's or a cloud build's.
    const source = readFileSync(fileURLToPath(new URL("../app/actions.ts", import.meta.url)), "utf8");
    const groups = source.slice(source.indexOf("export const TOOLBAR_GROUPS"), source.indexOf("/** The help menu, in order. */"));
    const listed = [...groups.matchAll(/"([a-z]+\.[A-Za-z]+)"/g)].map((match) => match[1] ?? "");
    const buttons = new Set<string>(TOOLBAR_BUTTONS.map((button) => button.id));
    for (const id of [...listed, ...TOOLBAR_GROUPS.flat(), ...DESKTOP_ACTIONS.map((action) => action.id), "share.open", "share.page", "help.docs"]) {
      expect(buttons.has(id), `the toolbar's ${id} has a display.toolbar setting`).toBe(true);
    }
    const labels = new Map<string, string>([
      ...ACTIONS.map((action) => [action.id, action.label] as const),
      ...DESKTOP_ACTIONS.map((action) => [action.id, action.label] as const),
    ]);
    for (const { id, label } of TOOLBAR_BUTTONS) {
      const entry = settingEntry(toolbarSettingId(id));
      if (labels.has(id)) expect(label, id).toBe(labels.get(id));
      expect(entry.presets, id).toBe("leave");
      expect(entry.defaultValue, id).toBe(true);
      expect(entry.kind, id).toBe("display");
      expect(toolbarButtonShown(DEFAULT_PREFS, id), id).toBe(true);
    }
    const hidden = withSetting(DEFAULT_PREFS, "display.toolbar.run.validate", false);
    expect(toolbarButtonShown(hidden, "run.validate")).toBe(false);
    expect(toolbarButtonShown(hidden, "run.save")).toBe(true);
    expect(hidden.toolbar["run"]?.["validate"]).toBe(false);
    // Search, Settings and Help are the way back to everything, so no setting hides them.
    expect(toolbarButtonShown(hidden, "view.settings")).toBe(true);
  });

  it("keeps a switch registered ahead of its feature out of Settings, with nothing gated yet", () => {
    // Optimize path was the one such switch until its action arrived (spec 16), which gave it its gates.
    const awaiting = SETTINGS.filter((entry) => entry.awaiting !== undefined);
    expect(awaiting.map((entry) => entry.id)).toEqual([]);
    for (const entry of awaiting) {
      const gated = Object.values(entry.gates ?? {}).flat();
      expect(gated, entry.id).toEqual([]);
    }
    const optimizer = settingEntry("features.optimizer");
    expect(optimizer.awaiting).toBeUndefined();
    expect(optimizer.gates?.actions).toContain("path.optimize");
    expect(optimizer.gates?.fixes).toEqual(["optimizeRoute"]);
  });

  it("gives every presettable entry a value for every built-in, and its default is the Essential value", () => {
    const presettable = SETTINGS.filter(isPresettable);
    expect(presettable.length).toBeGreaterThan(0);
    for (const entry of presettable) {
      for (const preset of BUILT_IN_PRESET_IDS) {
        expect(entry.presets[preset], `${entry.id} in ${preset}`).not.toBeUndefined();
        expect(entry.parse(entry.presets[preset]), `${entry.id} in ${preset}`).toEqual(entry.presets[preset]);
      }
      expect(entry.defaultValue, entry.id).toEqual(entry.presets.essential);
    }
  });

  it("registers the clearance outline as spec 15 section 4.2 gives it: off but in Full (D8)", () => {
    const entry = settingEntry("display.clearanceOutline");
    expect([entry.scope, entry.kind, entry.section, entry.group, entry.hides]).toEqual(["person", "display", "editor", "Field", "none"]);
    expect(entry.defaultValue).toBe(false);
    expect(entry.presets).toEqual({ basic: false, essential: false, full: true });
  });

  it("sets the heading of a new path to Linear in every preset, and Extend this chain off (spec 15 section 4.3)", () => {
    const heading = settingEntry("editing.defaultHeading");
    expect(heading.defaultValue).toBe("linear");
    expect(heading.presets).toEqual({ basic: "linear", essential: "linear", full: "linear" });
    expect(heading.control).toMatchObject({ type: "dropdown" });
    for (const mode of ["tangent", "linear", "constant"]) expect(heading.parse(mode)).toBe(mode);
    for (const raw of ["tangentReversed", "Linear", "piecewise", "facePoint"]) expect(heading.parse(raw), raw).toBeUndefined();

    const extend = settingEntry("editing.addPathExtends");
    expect(extend.defaultValue).toBe(false);
    expect(extend.presets).toEqual({ basic: false, essential: false, full: false });
    expect([heading.section, extend.section, heading.kind, extend.kind]).toEqual(["editor", "editor", "editing", "editing"]);
  });

  it("starts a new path with the previous path's end heading in every preset, on until turned off (issue #435)", () => {
    const keeps = settingEntry("editing.newPathKeepsHeading");
    expect(keeps.defaultValue).toBe(true);
    expect(keeps.presets).toEqual({ basic: true, essential: true, full: true });
    expect(keeps.control).toEqual({ type: "switch" });
    expect([keeps.section, keeps.kind, keeps.group, keeps.scope, keeps.hides]).toEqual(["editor", "editing", "Editing", "person", "none"]);
    expect([keeps.parse(true), keeps.parse(false)]).toEqual([true, false]);
    for (const raw of ["yes", 1, null, "false"]) expect(keeps.parse(raw), String(raw)).toBeUndefined();
  });

  it("protects measured waypoints in every preset, on until turned off (spec 15 sections 4.3 and 13, decision D12)", () => {
    const protect = settingEntry("editing.protectMeasuredPins");
    expect(protect.defaultValue).toBe(true);
    expect(protect.presets).toEqual({ basic: true, essential: true, full: true });
    expect(protect.control).toEqual({ type: "switch" });
    expect([protect.section, protect.kind, protect.group, protect.scope, protect.hides]).toEqual(["editor", "editing", "Editing", "person", "none"]);
    expect([protect.parse(true), protect.parse(false)]).toEqual([true, false]);
    for (const raw of ["yes", 1, null, "false"]) expect(protect.parse(raw), String(raw)).toBeUndefined();
  });

  it("keeps Full sim out of Settings and out of every preset, with what it hides gated (issue #207)", () => {
    const entry = settingEntry("features.fullSim");
    expect(entry.unlisted).toBeDefined();
    expect(entry.presets).toBe("never");
    expect(entry.gates?.actions).toEqual(["desktop.sim", "run.simulate"]);
    expect(entry.gates?.tourStops).toEqual(["run.simulate"]);
    expect(SETTINGS.filter((one) => one.unlisted !== undefined).map((one) => one.id)).toEqual(["features.fullSim"]);
  });

  it("shows the open auto's waypoint pins in Basic and Essential, and every pin in Full (issues #217 and #236)", () => {
    const entry = settingEntry("display.waypointPins");
    expect([entry.scope, entry.kind, entry.section, entry.group, entry.hides]).toEqual(["person", "display", "editor", "Field", "none"]);
    expect(entry.defaultValue).toBe("used");
    expect(entry.presets).toEqual({ basic: "used", essential: "used", full: "all" });
    expect(DEFAULT_PREFS.waypointPins).toBe("used");
  });

  it("keeps layout out of every preset (spec 15 section 2)", () => {
    for (const id of ["display.theme", "display.fieldView", "display.fieldStyle"] as const) {
      expect(settingEntry(id).presets, id).toBe("never");
    }
  });

  it("parses the default back to itself and rejects junk", () => {
    for (const entry of SETTINGS as readonly SettingEntry[]) {
      // Full sim reads nothing stored (issue #207): the constant is the switch, so even its default parses to nothing.
      if (entry.id !== "features.fullSim") expect(entry.parse(entry.defaultValue), entry.id).toEqual(entry.defaultValue);
      for (const raw of JUNK) {
        // A field style is any look's name, or null for the field's own: which names exist depends on
        // the field file, and one the field does not have draws its default look, as today.
        if (entry.id === "display.fieldStyle" && (raw === null || typeof raw === "string")) continue;
        // The keys are an object of bindings, read entry by entry: an object of junk keeps none of it.
        if (entry.id === "keys.bindings" && typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
          expect(entry.parse(raw), `keys given ${JSON.stringify(raw)}`).toEqual({});
          continue;
        }
        // A number is any finite number in its range: 1 is a fine nudge, and 0 and -1 are not.
        if (typeof raw === "number" && entry.control.type === "number" && raw >= entry.control.min && raw <= entry.control.max) continue;
        expect(entry.parse(raw), `${entry.id} given ${JSON.stringify(raw)}`).toBeUndefined();
      }
    }
  });

  it("parses every value a control offers", () => {
    for (const entry of SETTINGS as readonly SettingEntry[]) {
      const { control } = entry;
      if (control.type === "switch") {
        // Full sim has no row, and reads anything stored as nothing (issue #207).
        const fullSim = entry.id === "features.fullSim";
        expect(entry.parse(true), entry.id).toBe(fullSim ? undefined : true);
        expect(entry.parse(false), entry.id).toBe(fullSim ? undefined : false);
      } else if (control.type === "number") {
        expect(entry.parse(control.min), `${entry.id} min`).toBe(control.min);
        expect(entry.parse(control.max), `${entry.id} max`).toBe(control.max);
        expect(entry.parse(entry.defaultValue), `${entry.id} default`).toBe(entry.defaultValue);
        expect(control.min, entry.id).toBeLessThan(control.max);
        expect(control.step, entry.id).toBeGreaterThan(0);
      } else if (control.type !== "keymap" && control.options !== "fieldStyles") {
        for (const option of control.options) expect(entry.parse(option.value), `${entry.id} ${option.value}`).toBe(option.value);
      }
    }
    expect(settingEntry("display.fieldStyle").parse("dark")).toBe("dark");
    expect(settingEntry("display.fieldStyle").parse(null)).toBeNull();
  });

  it("reads the keys entry by entry, so one damaged binding falls back alone", () => {
    const keys = settingEntry("keys.bindings");
    expect(keys.parse({ "run.validate": "Ctrl E", "tool.select": null, "edit.undo": 3, "": "F9", "view.snap": " ", "run.save": "x".repeat(41) })).toEqual({
      "run.validate": "Ctrl E",
      "tool.select": null,
    });
    expect(keys.presets, "a built-in preset never changes keys").toBe("leave");
  });

  it("names only registered settings in needs, with no cycles", () => {
    const byId = new Map(SETTINGS.map((entry) => [entry.id, entry]));
    for (const entry of SETTINGS) {
      for (const need of entry.needs) expect(byId.has(need), `${entry.id} needs ${need}`).toBe(true);
    }
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (id: string): void => {
      if (done.has(id)) return;
      expect(visiting.has(id), `a cycle through ${id}`).toBe(false);
      visiting.add(id);
      for (const need of byId.get(id as SettingEntry["id"])?.needs ?? []) visit(need);
      visiting.delete(id);
      done.add(id);
    };
    for (const entry of SETTINGS) visit(entry.id);
    expect(settingEntry("display.ledgerCounts").needs).toEqual(["features.ledger"]);
  });

  it("matches DEFAULT_PREFS, so a person with nothing stored sees today's editor", () => {
    for (const entry of SETTINGS as readonly SettingEntry[]) {
      expect(getSetting(DEFAULT_PREFS, entry.id), entry.id).toEqual(entry.defaultValue);
    }
  });

  it("reads and writes a setting at its storage name, and leaves everything else as it was", () => {
    const off = withSetting(DEFAULT_PREFS, "features.commands", false);
    expect(off.features).toEqual({ ...DEFAULT_PREFS.features, commands: false });
    expect(getSetting(off, "features.commands")).toBe(false);
    expect({ ...off, features: DEFAULT_PREFS.features }).toEqual(DEFAULT_PREFS);
    expect(DEFAULT_PREFS.features.commands).toBe(true);

    const light = withSetting(DEFAULT_PREFS, "display.theme", "light");
    expect(light.theme).toBe("light");
    expect({ ...light, theme: DEFAULT_PREFS.theme }).toEqual(DEFAULT_PREFS);
  });

  it("gates only ids that exist: actions, insert kinds, tour stops, finding codes and sections", () => {
    // The sharing actions exist only in a build with the cloud, and Delete marker only on a marker's
    // own right-click menu, so the ids are also read from where those are written.
    const source = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
    const actions = new Set<string>([
      ...ACTIONS.map((action) => action.id),
      // The desktop app's own actions, such as the high-fidelity sim that Full sim hides.
      ...DESKTOP_ACTIONS.map((action) => action.id),
      ...[...source("../app/actions.ts").matchAll(/\bid: "([\w.]+)"/g)].map((match) => match[1] ?? ""),
      ...[...source("../app/canvasMenu.ts").matchAll(/\bcase "([\w.]+)":/g)].map((match) => match[1] ?? ""),
    ]);
    const kinds = new Set(Object.keys(INSERT_KINDS));
    const stops = new Set([...TOUR_STOPS.core, ...TOUR_STOPS.full].map((stop) => stop.id));
    const codes = new Set(Object.keys(FINDING_HELP));
    const sections = new Set(SECTIONS.map((section) => section.id));
    const fixKinds = new Set(
      [...source("../../../../packages/core/src/types.ts").matchAll(/kind: "([\w]+)"; params/g)].map((match) => match[1] ?? ""),
    );
    let gated = 0;
    for (const entry of SETTINGS as readonly SettingEntry[]) {
      const gates = entry.gates;
      if (gates === undefined) continue;
      expect(entry.kind, `${entry.id} has gates`).toBe("feature");
      const check = (ids: readonly string[] | undefined, known: ReadonlySet<string>, what: string): void => {
        for (const id of ids ?? []) {
          gated += 1;
          expect(known.has(id), `${entry.id} gates the ${what} ${id}`).toBe(true);
        }
      };
      check(gates.actions, actions, "action");
      check(gates.insertKinds, kinds, "insert kind");
      check(gates.tourStops, stops, "tour stop");
      check(gates.findings, codes, "finding code");
      check(gates.sections, sections, "section");
      // Core's Fix kinds, read from where they are written.
      check(gates.fixes, fixKinds, "fix kind");
    }
    expect(gated).toBeGreaterThan(20);
  });

  it("gives every switch that hides file data its hidden-data hooks, and no other entry any", () => {
    for (const entry of SETTINGS as readonly SettingEntry[]) {
      if (entry.hides === "data") {
        const hooks = entry.hiddenData;
        expect(hooks, entry.id).toBeDefined();
        expect(typeof hooks?.hiddenSteps, entry.id).toBe("function");
        expect(typeof hooks?.shownSelection, entry.id).toBe("function");
        expect(typeof hooks?.hidesFinding, entry.id).toBe("function");
        expect(typeof hooks?.note, entry.id).toBe("function");
        expect(hooks?.stepNoun.one, entry.id).not.toBe("");
      } else {
        expect(entry.hiddenData, entry.id).toBeUndefined();
      }
    }
    expect(settingEntry("features.commands").hides).toBe("data");
  });

  it("is pure: no window, document or storage", () => {
    for (const file of ["registry.ts", "presets.ts", "hiddenData.ts"]) {
      const source = readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), "utf8");
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code, file).not.toMatch(/\b(window|document|localStorage|sessionStorage|indexedDB)\b/);
      // Types only from the preference and store modules, which do touch storage.
      for (const match of code.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gm)) {
        const from = match[2] ?? "";
        if (/state\/(prefs|store)$/.test(from)) expect(match[1], `${file} imports ${from}`).toBe("type ");
      }
    }
  });
});
