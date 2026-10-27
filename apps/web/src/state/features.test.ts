/**
 * The feature switches of Settings, General (issue #101): what each one hides, that hiding never
 * changes the auto, and that turning a switch back on restores everything at once.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAuto, type Finding } from "@horizon36596/zenith-core";
import { SCHEMA_ID, type Auto, type Heading, type Step } from "@horizon36596/zenith-schema";
import { ACTIONS } from "../app/actions";
import { shownBottomTab } from "../panels/bottomTab";
import {
  ALL_FEATURES,
  DEFAULT_FEATURES,
  FEATURES,
  FULL_SIM_DEFAULT,
  NO_FEATURES,
  actionNeeds,
  actionOffBy,
  actionShown,
  deriveGates,
  envelopeEntryShown,
  forHostMode,
  featureLabel,
  findingShown,
  hiddenCommandsNote,
  hiddenDataNotes,
  hiddenInside,
  hiddenProblems,
  hiddenProblemsLine,
  hiddenErrorsHint,
  errorsHidden,
  hiddenErrorsWhere,
  turnOnWords,
  emptyProblemsLine,
  hiddenStepIds,
  hiddenStepNoun,
  insertKindShown,
  madeWith,
  madeWithLine,
  madeWithOff,
  markerCount,
  piecewiseOffered,
  sectionShown,
  shownFindings,
  shownSelection,
  toolShown,
  tourStopShown,
  visibleMoveIndex,
} from "./features";
import { SETTINGS, settingEntry, type AnySettingEntry, type SettingGates } from "../settings/registry";
import { DEFAULT_PREFS, PREFS_VERSION, loadPrefs, migrateFeatures, parseFeatures, savePrefs } from "./prefs";
import { stopsShown, TOUR_STOPS } from "../tour/stops";

const starter = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const auto = (name: string): Auto => loadAuto(JSON.parse(readFileSync(`${starter}${name}.auto.json`, "utf8")));

describe("the switches as stored", () => {
  it("start with Commands on, partner sharing and the ledger off (issue #112), and the presets' new switches on", () => {
    expect(DEFAULT_PREFS.features).toEqual({
      partners: false,
      ledger: false,
      commands: true,
      groups: true,
      waypoints: true,
      advancedHeading: true,
      optimizer: true,
      codeTab: true,
      fullSim: true,
    });
    expect(DEFAULT_FEATURES).toEqual(DEFAULT_PREFS.features);
    expect(Object.values(NO_FEATURES).every((on) => !on)).toBe(true);
    expect(Object.values(ALL_FEATURES).every((on) => on)).toBe(true);
    expect(NO_FEATURES.fullSim).toBe(false);
    expect(Object.keys(NO_FEATURES).sort()).toEqual(Object.keys(DEFAULT_FEATURES).sort());
  });

  it("read partner sharing and the ledger as off unless stored true", () => {
    expect(parseFeatures({ partners: "true", ledger: 1, commands: true })).toEqual(DEFAULT_FEATURES);
    expect(parseFeatures(ALL_FEATURES)).toEqual(ALL_FEATURES);
  });

  it("read Commands as on until someone stores a choice, and then keep that choice", () => {
    expect(parseFeatures(undefined)).toEqual(DEFAULT_FEATURES);
    expect(parseFeatures("yes")).toEqual(DEFAULT_FEATURES);
    expect(parseFeatures({}).commands).toBe(true);
    expect(parseFeatures({ partners: true }).commands).toBe(true);
    expect(parseFeatures({ commands: "false" }).commands).toBe(true);
    expect(parseFeatures({ commands: false }).commands).toBe(false);
    // Full sim reads only a stored true, else its default (issue #207), so a stored false is not kept.
    expect(parseFeatures(NO_FEATURES)).toEqual({ ...NO_FEATURES, fullSim: FULL_SIM_DEFAULT });
  });
});

describe("the one-time switch-on of Commands (issue #112)", () => {
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
  const saved = (): { version?: number; features?: { commands?: boolean } } =>
    JSON.parse(stored.get("zenith.ui") ?? "{}") as { version?: number; features?: { commands?: boolean } };

  it("turns a false stored before the migration on once, and saves it at the new version", () => {
    stored.set("zenith.ui", JSON.stringify({ theme: "light", features: { partners: true, ledger: false, commands: false } }));
    const prefs = loadPrefs();
    expect(prefs.features).toEqual({ ...DEFAULT_FEATURES, partners: true });
    expect(prefs.version).toBe(PREFS_VERSION);
    expect(prefs.theme).toBe("light");
    expect(saved().version).toBe(PREFS_VERSION);
    expect(saved().features?.commands).toBe(true);
  });

  it("keeps a false saved after the migration across reloads", () => {
    stored.set("zenith.ui", JSON.stringify({ features: { partners: false, ledger: false, commands: false } }));
    const migrated = loadPrefs();
    expect(migrated.features.commands).toBe(true);
    // The person switches it off again; that is a choice, and it stays.
    savePrefs({ ...migrated, features: { ...migrated.features, commands: false } });
    expect(loadPrefs().features.commands).toBe(false);
    expect(loadPrefs().features.commands).toBe(false);
    expect(saved().features?.commands).toBe(false);
  });

  it("leaves partner sharing and the ledger as stored", () => {
    expect(migrateFeatures({ ...NO_FEATURES, ledger: true }, 0)).toEqual({ ...NO_FEATURES, ledger: true, commands: true });
    expect(migrateFeatures({ ...NO_FEATURES, partners: true }, PREFS_VERSION)).toEqual({ ...NO_FEATURES, partners: true });
  });

  it("writes nothing when there is nothing stored, or it is already current", () => {
    expect(loadPrefs().features).toEqual(DEFAULT_PREFS.features);
    expect(stored.has("zenith.ui")).toBe(false);
    const current = JSON.stringify({ version: PREFS_VERSION, features: { partners: false, ledger: false, commands: false } });
    stored.set("zenith.ui", current);
    expect(loadPrefs().features.commands).toBe(false);
    expect(stored.get("zenith.ui")).toBe(current);
  });
});

describe("the Full sim switch (issue #207, back on 2026-10-14)", () => {
  it("is on, and Settings does not list it", () => {
    expect(FULL_SIM_DEFAULT).toBe(true);
    expect(DEFAULT_FEATURES.fullSim).toBe(true);
    expect(FEATURES.map((feature) => feature.id)).not.toContain("fullSim");
  });

  it("is on whatever is stored, since nobody can switch it in the app", () => {
    expect(parseFeatures({}).fullSim).toBe(true);
    expect(parseFeatures({ fullSim: "true" }).fullSim).toBe(true);
    expect(parseFeatures({ fullSim: false }).fullSim).toBe(true);
    expect(parseFeatures({ fullSim: true }).fullSim).toBe(true);
  });

  it("is off whatever is stored once the constant is off, saved preferences included", async () => {
    vi.resetModules();
    vi.doMock("./fullSimSwitch", () => ({ FULL_SIM_DEFAULT: false }));
    try {
      const prefs = await import("./prefs");
      expect(prefs.parseFeatures({ fullSim: true }).fullSim).toBe(false);
      expect(prefs.parseFeatures({}).fullSim).toBe(false);
      expect(prefs.DEFAULT_PREFS.features.fullSim).toBe(false);
      const { settingEntry } = await import("../settings/registry");
      const { resolveSetting } = await import("../settings/presets");
      expect(resolveSetting(settingEntry("features.fullSim"), true, "full")).toBe(false);
    } finally {
      vi.doUnmock("./fullSimSwitch");
      vi.resetModules();
    }
  });

  it("shows Simulate and the high-fidelity sim, and hides them in the toolbar, palette, keys and menus alike when off", () => {
    for (const id of ["run.simulate", "desktop.sim"]) {
      expect(actionShown(id, DEFAULT_FEATURES), id).toBe(true);
      expect(actionShown(id, { ...DEFAULT_FEATURES, fullSim: false }), id).toBe(false);
    }
    // Deploy and Git are not part of it.
    expect(actionShown("desktop.deploy", { ...DEFAULT_FEATURES, fullSim: false })).toBe(true);
    expect(actionShown("desktop.git", { ...DEFAULT_FEATURES, fullSim: false })).toBe(true);
  });

  it("shows the Simulate tour stop, and hides it when off", () => {
    expect(tourStopShown("run.simulate", DEFAULT_FEATURES)).toBe(true);
    expect(tourStopShown("run.simulate", { ...DEFAULT_FEATURES, fullSim: false })).toBe(false);
    const ids = (features: typeof DEFAULT_FEATURES) => stopsShown(TOUR_STOPS, features).full.map((stop) => stop.id);
    expect(ids(DEFAULT_FEATURES)).toContain("run.simulate");
    expect(ids({ ...DEFAULT_FEATURES, fullSim: false })).not.toContain("run.simulate");
  });
});

describe("the Full sim switch in the registry (issue #207)", () => {
  it("is a feature entry that Settings does not list and no preset carries", () => {
    const entry = settingEntry("features.fullSim");
    expect(entry.kind).toBe("feature");
    expect(entry.unlisted).toBeDefined();
    expect(entry.presets).toBe("never");
    expect(entry.defaultValue).toBe(FULL_SIM_DEFAULT);
    expect([entry.parse(true), entry.parse(false), entry.parse("true")]).toEqual([undefined, undefined, undefined]);
  });

  it("reads nothing stored, so a saved value never outlasts the constant", () => {
    const stored = new Map<string, string>();
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => {
          stored.set(key, value);
        },
      },
    };
    try {
      stored.set("zenith.ui", JSON.stringify({ version: PREFS_VERSION, features: { fullSim: false } }));
      expect(loadPrefs().features.fullSim).toBe(FULL_SIM_DEFAULT);
      stored.set("zenith.ui", JSON.stringify({ version: PREFS_VERSION, features: { fullSim: true } }));
      expect(loadPrefs().features.fullSim).toBe(FULL_SIM_DEFAULT);
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  it("leaves Simulate and its tour stop to the host in host mode, and the high-fidelity sim gated", () => {
    const host = forHostMode(deriveGates(SETTINGS));
    expect(host.actions.get("run.simulate")).toBeUndefined();
    expect(host.tourStops.get("run.simulate")).toBeUndefined();
    expect(host.actions.get("desktop.sim")).toEqual(["fullSim"]);
  });
});

describe("actions", () => {
  it("each switch hides its own actions and nothing else", () => {
    for (const id of ["share.open", "share.page", "project.downloadShareFile", "project.downloadProposeShareFile", "proposal.open"]) {
      expect(actionShown(id, NO_FEATURES), id).toBe(false);
      expect(actionShown(id, { ...NO_FEATURES, partners: true }), id).toBe(true);
    }
    expect(actionShown("view.ledgerCounts", NO_FEATURES)).toBe(false);
    expect(actionShown("view.ledgerCounts", { ...NO_FEATURES, ledger: true })).toBe(true);
    for (const id of ["tool.addCommand", "tool.marker", "insert.command", "project.importCommands", "project.commands"]) {
      expect(actionShown(id, NO_FEATURES), id).toBe(false);
      expect(actionShown(id, { ...NO_FEATURES, commands: true }), id).toBe(true);
    }
  });

  it("never hide pathing, the mirror or anything no switch covers", () => {
    for (const id of ["tool.addPath", "insert.path", "insert.wait", "view.alliance", "project.robot", "project.commandLibrary", "run.save", "run.propose"]) {
      expect(actionShown(id, NO_FEATURES), id).toBe(true);
    }
  });

  it("insert kinds follow the same switches", () => {
    expect(insertKindShown("command", NO_FEATURES)).toBe(false);
    expect(insertKindShown("parallel", NO_FEATURES)).toBe(false);
    expect(insertKindShown("transfer", NO_FEATURES)).toBe(false);
    expect(insertKindShown("path", NO_FEATURES)).toBe(true);
    expect(insertKindShown("branch", NO_FEATURES)).toBe(false);
    expect(insertKindShown("branch", { ...NO_FEATURES, groups: true })).toBe(true);
    expect(insertKindShown("transfer", { ...NO_FEATURES, ledger: true })).toBe(true);
    expect(insertKindShown("command", { ...NO_FEATURES, commands: true })).toBe(true);
  });
});

describe("the switches that take away only the tools (spec 15 section 4.1)", () => {
  const only = (feature: keyof typeof ALL_FEATURES) => ({ ...ALL_FEATURES, [feature]: false });

  it("Step groups off takes the group kinds and Wrap out of Insert, the palette and the menus, and leaves Unwrap", () => {
    const off = only("groups");
    for (const id of ["insert.sequence", "insert.parallel", "insert.race", "insert.deadline", "insert.branch", "edit.wrapSequence", "edit.wrapParallel", "edit.wrapBranch"]) {
      expect(actionShown(id, off), id).toBe(false);
      expect(actionOffBy(id, off), id).toBe("groups");
    }
    for (const kind of ["sequence", "parallel", "branch"]) expect(insertKindShown(kind, off), kind).toBe(false);
    for (const kind of ["path", "turn", "command", "wait"]) expect(insertKindShown(kind, off), kind).toBe(true);
    for (const id of ["edit.unwrap", "insert.path", "insert.command", "edit.duplicate"]) expect(actionShown(id, off), id).toBe(true);
  });

  it("Waypoints off takes away making, renaming and deleting a waypoint, and leaves hiding and following one", () => {
    const off = only("waypoints");
    for (const id of ["waypoint.add", "field.addWaypointHere", "waypoint.saveAs", "waypoint.rename", "waypoint.followRename", "waypoint.delete"]) {
      expect(actionShown(id, off), id).toBe(false);
    }
    for (const id of ["waypoint.hide", "waypoint.copyPosition", "waypoint.selectFollowers", "waypoint.followSelect", "view.waypointPins", "edit.delete"]) {
      expect(actionShown(id, off), id).toBe(true);
    }
  });

  it("Advanced heading off offers Piecewise only for a path that is piecewise already", () => {
    const off = only("advancedHeading");
    expect(piecewiseOffered({ mode: "tangent" }, off)).toBe(false);
    expect(piecewiseOffered(undefined, off)).toBe(false);
    expect(piecewiseOffered({ mode: "piecewise", ranges: [] } as unknown as Heading, off)).toBe(true);
    expect(piecewiseOffered({ mode: "tangent" }, ALL_FEATURES)).toBe(true);
  });

  it("the Code tab and Advanced heading hide no action, and Optimize path hides only its own entry points", () => {
    // Optimize path gained its gates with its action (spec 16 section 8.1): the two palette commands
    // and the field's Add a clear path here.
    const optimizerOnly = ["path.optimize", "path.optimizeWithOptions", "path.optimizeAll", "field.addClearPathHere"];
    for (const action of ACTIONS) {
      expect(actionShown(action.id, only("optimizer")), action.id).toBe(!optimizerOnly.includes(action.id));
      expect(actionShown(action.id, only("codeTab")), action.id).toBe(true);
      expect(actionShown(action.id, only("advancedHeading")), action.id).toBe(true);
    }
  });

  it("Settings, General lists every switch, Optimize path among them now that its action is here", () => {
    expect(FEATURES.map((feature) => feature.id)).toEqual([
      "partners",
      "ledger",
      "commands",
      "groups",
      "waypoints",
      "advancedHeading",
      "optimizer",
      "codeTab",
    ]);
    expect(featureLabel("optimizer")).toBe("Optimize path");
    expect(featureLabel("groups")).toBe("Step groups");
  });
});

describe("a step made with a switched-off tool", () => {
  const every = auto("all-step-kinds");
  const kinds = new Map(every.steps.map((step) => [step.kind, step]));
  const piecewise: Step = {
    id: "p",
    kind: "path",
    segments: [{ kind: "line", from: "current", to: { pose: { xIn: 0, yIn: 0, headingRad: 0 } } }],
    heading: { mode: "piecewise", ranges: [] },
  } as unknown as Step;

  it("names Step groups for a group and Advanced heading for a piecewise heading, only while that switch is off", () => {
    for (const kind of ["sequence", "parallel", "branch"] as const) {
      const step = kinds.get(kind);
      if (step === undefined) continue;
      expect(madeWith(step), kind).toEqual(["groups"]);
      expect(madeWithOff(step, { ...ALL_FEATURES, groups: false }), kind).toBe("groups");
      expect(madeWithOff(step, ALL_FEATURES), kind).toBeUndefined();
    }
    expect(madeWithOff(piecewise, { ...ALL_FEATURES, advancedHeading: false })).toBe("advancedHeading");
    expect(madeWithOff(piecewise, ALL_FEATURES)).toBeUndefined();
    const plain = kinds.get("wait");
    if (plain !== undefined) expect(madeWithOff(plain, NO_FEATURES)).toBeUndefined();
    expect(madeWithLine("groups")).toBe("Made with Step groups, which your settings turn off");
  });

  it("never hides the step: a group stays listed and selectable with Step groups off", () => {
    const off = { ...ALL_FEATURES, groups: false };
    expect(hiddenStepIds(every, off).size).toBe(0);
    const group = every.steps.find((step) => step.kind === "parallel" || step.kind === "sequence");
    if (group?.id !== undefined) expect(shownSelection({ stepId: group.id }, every, off)).toEqual({ stepId: group.id });
  });
});

describe("the Code tab", () => {
  it("falls back to Problems while it is off, and keeps the stored tab for when it is on again", () => {
    expect(shownBottomTab("code", false)).toBe("problems");
    expect(shownBottomTab("problems", false)).toBe("problems");
    expect(shownBottomTab("code", true)).toBe("code");
  });
});

describe("adding an envelope", () => {
  // Owner ruling 2026-10-10 (issue #273): adding an envelope comes with Commands, not with Partners.
  it("is offered while Commands is on, in every preset, whatever Partners and the ledger say", () => {
    expect(envelopeEntryShown(DEFAULT_FEATURES)).toBe(true);
    expect(envelopeEntryShown(ALL_FEATURES)).toBe(true);
    expect(envelopeEntryShown({ ...NO_FEATURES, commands: true })).toBe(true);
  });

  it("is hidden while Commands is off, even with partner sharing on", () => {
    expect(envelopeEntryShown(NO_FEATURES)).toBe(false);
    expect(envelopeEntryShown({ ...ALL_FEATURES, commands: false })).toBe(false);
  });
});

describe("findings", () => {
  type Shown = Pick<Finding, "code" | "message" | "stepId">;
  const finding = (code: string, stepId = "a", message = ""): Shown => ({ code: code as Finding["code"], stepId, message });

  it("ledger findings go with the ledger, command findings with commands", () => {
    for (const code of ["CAPACITY", "EMPTY_SHOT", "TRANSFER", "LAUNCH_TARGET"]) {
      expect(findingShown(finding(code), NO_FEATURES, new Set()), code).toBe(false);
      expect(findingShown(finding(code), { ...NO_FEATURES, ledger: true }, new Set()), code).toBe(true);
    }
    for (const code of ["STATIONARY_MARKER", "MOVES_ROBOT"]) {
      expect(findingShown(finding(code), NO_FEATURES, new Set()), code).toBe(false);
      expect(findingShown(finding(code), { ...NO_FEATURES, commands: true }, new Set()), code).toBe(true);
    }
    expect(findingShown(finding("SCHEMA", "a", 'Step a names the command "zap", which robot.json does not register.'), NO_FEATURES, new Set())).toBe(false);
    expect(findingShown(finding("SCHEMA", "a", "Something else."), NO_FEATURES, new Set())).toBe(true);
    expect(findingShown(finding("COLLISION"), NO_FEATURES, new Set())).toBe(true);
  });

  it("a shot from an illegal spot or out of the turret's reach shows whatever the switches say (issue #493)", () => {
    for (const code of ["LEGAL_APPROACH", "TURRET_RANGE"]) {
      expect(findingShown(finding(code), NO_FEATURES, new Set()), code).toBe(true);
      expect(findingShown(finding(code), { ...ALL_FEATURES, ledger: false }, new Set()), code).toBe(true);
    }
  });

  it("a finding about a hidden step is hidden with it", () => {
    const list = [finding("COLLISION", "a"), finding("COLLISION", "b")];
    expect(shownFindings(list, NO_FEATURES, new Set(["b"]))).toEqual([list[0]]);
  });
});

describe("an auto with commands while Commands is off", () => {
  const first = auto("first-auto");

  it("hides its command steps and says so in one line", () => {
    expect([...hiddenStepIds(first, NO_FEATURES)]).toEqual(["scorePreload"]);
    expect(hiddenStepIds(first, ALL_FEATURES).size).toBe(0);
    expect(hiddenCommandsNote(first, NO_FEATURES)).toBe(
      "This auto has 1 command step. Turn on Commands in Settings, General to see them.",
    );
    expect(hiddenCommandsNote(first, ALL_FEATURES)).toBeNull();
  });

  it("finds command steps inside groups and counts markers", () => {
    const every = auto("all-step-kinds");
    const hidden = hiddenStepIds(every, NO_FEATURES);
    expect(hidden.size).toBeGreaterThan(0);
    const note = hiddenCommandsNote(every, NO_FEATURES);
    expect(note).toContain(`${String(hidden.size)} command step`);
    if (markerCount(every) > 0) expect(note).toContain("marker");
  });

  it("never changes the auto", () => {
    const before = JSON.stringify(first);
    hiddenStepIds(first, NO_FEATURES);
    hiddenCommandsNote(first, NO_FEATURES);
    shownSelection({ stepId: "scorePreload" }, first, NO_FEATURES);
    expect(JSON.stringify(first)).toBe(before);
  });

  it("cannot select a hidden step or a marker", () => {
    expect(shownSelection({ stepId: "scorePreload" }, first, NO_FEATURES)).toEqual({});
    expect(shownSelection({ stepId: "driveOut", markerIndex: 0 }, first, NO_FEATURES)).toEqual({ stepId: "driveOut" });
    expect(shownSelection({ stepId: "driveOut", markerIndex: 0 }, first, ALL_FEATURES)).toEqual({ stepId: "driveOut", markerIndex: 0 });
    expect(shownSelection({ stepId: "scorePreload" }, first, ALL_FEATURES)).toEqual({ stepId: "scorePreload" });
  });

  it("an auto with no commands has nothing to say", () => {
    const pathsOnly: Auto = { ...first, steps: first.steps.filter((step) => step.kind === "path") };
    expect(hiddenCommandsNote(pathsOnly, NO_FEATURES)).toBeNull();
  });
});

describe("the tour", () => {
  it("skips the stops of hidden features", () => {
    expect(tourStopShown("tool.marker", NO_FEATURES)).toBe(false);
    expect(tourStopShown("section.markers", NO_FEATURES)).toBe(false);
    expect(tourStopShown("ledger", NO_FEATURES)).toBe(false);
    expect(tourStopShown("timeline", NO_FEATURES)).toBe(true);

    const off = stopsShown(TOUR_STOPS, NO_FEATURES);
    const ids = off.full.map((stop) => stop.id);
    expect(ids).not.toContain("tool.marker");
    expect(ids).not.toContain("section.markers");
    expect(ids).not.toContain("ledger");
    // The core tour keeps every stop but the one on the Waypoints list, which goes with the list.
    expect(off.core.map((stop) => stop.id)).toEqual(TOUR_STOPS.core.map((stop) => stop.id).filter((id) => id !== "waypoints"));

    const on = stopsShown(TOUR_STOPS, ALL_FEATURES);
    expect(on.full.map((stop) => stop.id)).toEqual(TOUR_STOPS.full.map((stop) => stop.id));
  });

  it("does not mention commands or the ledger while they are off", () => {
    const off = stopsShown(TOUR_STOPS, NO_FEATURES);
    for (const stop of [...off.core, ...off.full]) {
      expect(stop.body, stop.id).not.toMatch(/a command|nothing loaded/);
    }
    const on = stopsShown(TOUR_STOPS, ALL_FEATURES);
    expect(on.core.find((stop) => stop.id === "steps")?.body).toContain("runs a command");
  });
});

describe("moving among hidden steps", () => {
  const ids = ["a", "h1", "s", "h2", "b"];
  const hidden = new Set(["h1", "h2"]);

  it("lands just past the next visible sibling, whatever hidden siblings lie between", () => {
    expect(visibleMoveIndex(ids, 2, 1, hidden)).toBe(4);
    expect(visibleMoveIndex(ids, 2, -1, hidden)).toBe(0);
  });

  it("moves one place when nothing is hidden", () => {
    expect(visibleMoveIndex(ids, 2, 1, new Set())).toBe(3);
  });

  it("is null when only hidden siblings, or none, lie that way", () => {
    expect(visibleMoveIndex(["s", "h1"], 0, 1, hidden)).toBeNull();
    expect(visibleMoveIndex(ids, 0, -1, hidden)).toBeNull();
  });
});

describe("hidden steps inside a delete", () => {
  const nested = loadAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "nested",
    alliance: "RED",
    start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
    steps: [
      { id: "lone", kind: "command", name: "score" },
      {
        id: "outer",
        kind: "parallel",
        mode: "all",
        steps: [
          { id: "inner", kind: "parallel", mode: "all", steps: [{ id: "deep", kind: "command", name: "spinUp" }] },
          { id: "wait", kind: "wait", seconds: 1 },
        ],
      },
    ],
  });

  it("counts hidden steps at any depth inside the deleted steps, not the ones beside them", () => {
    expect(hiddenInside(nested, ["outer"], NO_FEATURES)).toBe(1);
    expect(hiddenInside(nested, ["wait"], NO_FEATURES)).toBe(0);
  });

  it("is 0 while Commands is on", () => {
    expect(hiddenInside(nested, ["outer"], ALL_FEATURES)).toBe(0);
  });
});

describe("the desktop app's native menu", () => {
  // The native menu is built once in the main process and cannot follow the switches, so it must
  // hold nothing a switch hides. A hidden action sent from it is refused with a status anyway
  // (`project/desktopActions.ts`); this keeps the menu from offering one in the first place.
  const menu = readFileSync(fileURLToPath(new URL("../../../desktop/src/main/menu.ts", import.meta.url)), "utf8");
  const sent = [...menu.matchAll(/send\("([a-zA-Z.]+)"/g)].map((match) => match[1] ?? "");

  it("sends only actions that every switch shows", () => {
    expect(sent.length).toBeGreaterThan(5);
    // The one exception is the high-fidelity sim, which the menu leaves out by the Full sim switch's
    // own constant (`state/fullSimSwitch.ts`, issue #207), the value the page starts from too.
    expect(menu).toContain("handlers.fullSim && ");
    for (const id of sent) expect(actionShown(id, { ...NO_FEATURES, fullSim: true }), id).toBe(true);
  });
});

describe("gates derived from the registry (spec 15 section 7)", () => {
  const entry = (id: "features.partners" | "features.ledger" | "features.commands", gates: SettingGates): AnySettingEntry =>
    ({ ...settingEntry(id), gates }) as AnySettingEntry;

  it("an id that two switches gate needs both on", () => {
    const gates = deriveGates([
      entry("features.commands", { actions: ["insert.parallel"], insertKinds: ["parallel"] }),
      entry("features.ledger", { actions: ["insert.parallel"] }),
    ]);
    expect(gates.actions.get("insert.parallel")).toEqual(["commands", "ledger"]);
    expect(gates.insertKinds.get("parallel")).toEqual(["commands"]);
    expect(gates.tourStops.size).toBe(0);
  });

  it("matches what each switch hid before the maps moved into the registry", () => {
    const gates = deriveGates(SETTINGS);
    const by = (feature: string, map: ReadonlyMap<string, readonly string[]>): string[] =>
      [...map].filter(([, needs]) => needs.includes(feature)).map(([id]) => id).sort();
    expect(by("partners", gates.actions)).toEqual(["project.downloadProposeShareFile", "project.downloadShareFile", "proposal.open", "share.open", "share.page"]);
    expect(by("ledger", gates.actions)).toEqual(["view.ledgerCounts"]);
    expect(by("commands", gates.actions)).toEqual([
      "insert.command",
      "insert.deadline",
      "insert.parallel",
      "insert.race",
      "marker.delete",
      "project.commands",
      "project.importCommands",
      "tool.addCommand",
      "tool.marker",
    ]);
    expect(Object.fromEntries(gates.insertKinds)).toEqual({
      transfer: ["ledger"],
      command: ["commands"],
      parallel: ["commands", "groups"],
      sequence: ["groups"],
      branch: ["groups"],
    });
    expect(Object.fromEntries(gates.tourStops)).toEqual({
      ledger: ["ledger"],
      "tool.marker": ["commands"],
      "section.markers": ["commands"],
      groups: ["groups"],
      waypoints: ["waypoints"],
      "run.simulate": ["fullSim"],
    });
    expect(by("fullSim", gates.actions)).toEqual(["desktop.sim", "run.simulate"]);
    expect(by("ledger", gates.findings)).toEqual(["CAPACITY", "EMPTY_SHOT", "LAUNCH_TARGET", "TRANSFER"]);
    expect(by("commands", gates.findings)).toEqual(["MOVES_ROBOT", "STATIONARY_MARKER"]);
  });

  it("names the first switch that keeps an action hidden", () => {
    expect(actionNeeds("insert.parallel")).toEqual(["commands", "groups"]);
    expect(actionOffBy("insert.parallel", { ...ALL_FEATURES, groups: false })).toBe("groups");
    expect(actionOffBy("insert.parallel", NO_FEATURES)).toBe("commands");
    expect(actionOffBy("insert.parallel", ALL_FEATURES)).toBeUndefined();
    expect(actionOffBy("insert.path", NO_FEATURES)).toBeUndefined();
  });

  it("hides the Commands section and the command tools with Commands", () => {
    expect(sectionShown("commands", NO_FEATURES)).toBe(false);
    expect(sectionShown("commands", DEFAULT_FEATURES)).toBe(true);
    expect(sectionShown("general", NO_FEATURES)).toBe(true);
    expect(toolShown("marker", NO_FEATURES)).toBe(false);
    expect(toolShown("addCommand", NO_FEATURES)).toBe(false);
    expect(toolShown("addPath", NO_FEATURES)).toBe(true);
    expect(toolShown("marker", DEFAULT_FEATURES)).toBe(true);
  });
});

describe("hidden data through the hooks", () => {
  const first = auto("first-auto");

  it("gives one step-list line per data switch that is off", () => {
    expect(hiddenDataNotes(first, NO_FEATURES)).toEqual([{ feature: "commands", note: hiddenCommandsNote(first, NO_FEATURES) }]);
    expect(hiddenDataNotes(first, DEFAULT_FEATURES)).toEqual([]);
    expect(hiddenDataNotes(null, NO_FEATURES)).toEqual([]);
  });

  it("names the hidden steps after the switch that hides them", () => {
    expect(hiddenStepNoun(NO_FEATURES)).toEqual({ one: "command step", many: "command steps" });
  });
});

describe("the problems the switches hide", () => {
  type Facts = Pick<Finding, "code" | "message" | "stepId" | "severity">;
  const finding = (code: string, severity: Finding["severity"], stepId = "driveOut", message = ""): Facts => ({
    code: code as Finding["code"],
    severity,
    stepId,
    message,
  });
  const first = auto("first-auto");

  it("counts the hidden errors and warnings, not info, and names the switch that hides them", () => {
    const findings = [finding("CAPACITY", "error", "start"), finding("EMPTY_SHOT", "warning"), finding("TRANSFER", "info"), finding("COLLISION", "error")];
    expect(hiddenProblems(findings, first, DEFAULT_FEATURES)).toEqual({ count: 2, errors: 1, features: ["ledger"] });
    expect(hiddenProblems(findings, first, ALL_FEATURES)).toEqual({ count: 0, errors: 0, features: [] });
  });

  it("never counts a shot from an illegal spot or out of the turret's reach as hidden (issue #493)", () => {
    const findings = [finding("LEGAL_APPROACH", "error"), finding("TURRET_RANGE", "warning"), finding("CAPACITY", "error", "start")];
    expect(hiddenProblems(findings, first, DEFAULT_FEATURES)).toEqual({ count: 1, errors: 1, features: ["ledger"] });
    expect(errorsHidden(findings, first, DEFAULT_FEATURES)).toEqual({ errors: 2, hidden: 1, features: ["ledger"] });
  });

  it("counts a problem on a hidden step against the switch that hides the step", () => {
    const findings = [finding("COLLISION", "warning", "scorePreload"), finding("STATIONARY_MARKER", "warning")];
    expect(hiddenProblems(findings, first, { ...ALL_FEATURES, commands: false })).toEqual({ count: 2, errors: 0, features: ["commands"] });
    const both = [...findings, finding("CAPACITY", "error", "start")];
    expect(hiddenProblems(both, first, NO_FEATURES)).toEqual({ count: 3, errors: 1, features: ["ledger", "commands"] });
  });

  it("agrees with what Problems leaves out", () => {
    const findings = [finding("CAPACITY", "error", "start"), finding("COLLISION", "warning", "scorePreload"), finding("COLLISION", "error")];
    const shown = shownFindings(findings, NO_FEATURES, hiddenStepIds(first, NO_FEATURES));
    expect(shown).toEqual([findings[2]]);
    expect(hiddenProblems(findings, first, NO_FEATURES).count).toBe(findings.length - shown.length);
  });

  it("says how many in one line", () => {
    expect(hiddenProblemsLine(1)).toBe("1 more problem in hidden features.");
    expect(hiddenProblemsLine(2)).toBe("2 more problems in hidden features.");
    expect(hiddenProblemsLine(2, 0)).toBe("2 more problems in hidden features.");
  });

  it("names the errors among them, so a hidden error is never silent (0.1.2 UX sweep)", () => {
    expect(hiddenProblemsLine(1, 1)).toBe("1 more problem in hidden features, and it is an error.");
    expect(hiddenProblemsLine(3, 1)).toBe("3 more problems in hidden features, 1 of them an error.");
    expect(hiddenProblemsLine(3, 2)).toBe("3 more problems in hidden features, 2 of them errors.");
    expect(hiddenProblemsLine(2, 2)).toBe("2 more problems in hidden features, all of them errors.");
  });

  it("gives the header's error count a hint only when errors are hidden", () => {
    expect(hiddenErrorsHint(0)).toBeUndefined();
    expect(hiddenErrorsHint(1)).toBe(
      "Not counted: 1 error in hidden features, named in the last line of the list. Deploy skips an auto with any error.",
    );
    expect(hiddenErrorsHint(2)).toContain("2 errors in hidden features");
  });

  it("counts every error for Propose, Save and the share file, and says where the hidden ones are", () => {
    const findings = [finding("CAPACITY", "error", "start"), finding("COLLISION", "error"), finding("EMPTY_SHOT", "warning")];
    const some = errorsHidden(findings, first, DEFAULT_FEATURES);
    expect(some).toEqual({ errors: 2, hidden: 1, features: ["ledger"] });
    expect(hiddenErrorsWhere(some)).toBe(", 1 of them in a feature your settings hide (Ledger and ball counting)");
    const all = errorsHidden(findings.slice(0, 1), first, DEFAULT_FEATURES);
    expect(hiddenErrorsWhere(all)).toBe(", in a feature your settings hide (Ledger and ball counting)");
    expect(hiddenErrorsWhere(errorsHidden(findings, first, ALL_FEATURES))).toBe("");
    expect(turnOnWords(["ledger"])).toBe("turn the feature on");
    expect(turnOnWords(["ledger", "commands"])).toBe("turn the features on");
  });

  it("does not call a list clean when the switches hide every problem in it", () => {
    const findings = [finding("CAPACITY", "error", "start")];
    const listed = shownFindings(findings, NO_FEATURES, hiddenStepIds(first, NO_FEATURES)).length;
    const hidden = hiddenProblems(findings, first, NO_FEATURES).count;
    expect(listed).toBe(0);
    expect(hidden).toBe(1);
    expect(emptyProblemsLine(listed, hidden)).toBe("No problems in the features you have on.");
    expect(emptyProblemsLine(0, 0)).toBe("No problems found.");
    expect(emptyProblemsLine(2, 1)).toBe("No problems at that severity.");
  });
});
