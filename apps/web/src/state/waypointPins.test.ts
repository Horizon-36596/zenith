/**
 * Issue #236: hiding waypoint pins is a view choice of one person. A show mode (all, the pins the
 * open auto uses, or none) and per-pin overrides decide which pins the field shows; the overrides
 * are kept per project, only where they differ from the mode, and at most 500 of them. Hiding or
 * showing a pin never changes waypoints.json, the undo history or the unsaved state, a rename keeps
 * a hidden pin hidden under its new name, a delete then undo keeps it hidden, and a delete forgets
 * the override so a new waypoint given the same name starts from the mode.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, loadAuto, loadField, loadRobot, loadWaypoints, waypointsUsed } from "@horizon36596/zenith-core";
import type { Auto } from "@horizon36596/zenith-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectBackend } from "../project/backend";
import { projectKey, type Project, type ProjectSource } from "../project/types";
import { addWaypointAt, deleteWaypointNamed, renameWaypointTo } from "../app/waypointEdits";
import { DEFAULT_PREFS, loadPrefs } from "./prefs";
import {
  getState,
  hiddenWaypoints,
  isDirty,
  openAuto,
  openProject,
  redo,
  setPrefs,
  setSelection,
  setWaypointPins,
  setWaypointPinShown,
  showAllWaypointPins,
  undo,
  waypointsDirty,
} from "./store";
import {
  MAX_WAYPOINT_PIN_OVERRIDES,
  hiddenWaypointNames,
  parseWaypointPinOverrides,
  parseWaypointPins,
  pinKey,
  projectPinOverrideCount,
  prunedForMode,
  withPinOverride,
  withPinRenamed,
  withPinShown,
  withoutProjectPins,
} from "./waypointPins";

const starter = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${starter}${relative}`, "utf8"));
const collectAndScore = (): Auto => loadAuto(read("autos/collect-and-score.auto.json"));

const example = (): Project => ({
  source: { kind: "example" },
  name: "examples/starter",
  link: { autosDir: "autos", robot: "autos/robot.json", field: "autos/field.json", waypoints: "autos/waypoints.json" } as Project["link"],
  robot: loadRobot(read("autos/robot.json")),
  field: loadField(read("autos/field/biobuzz.field.json")),
  waypoints: loadWaypoints(read("autos/waypoints.json")),
  autoFiles: ["collect-and-score.auto.json"],
  autoTexts: {},
});

describe("the stored choices", () => {
  const stored = new Map<string, string>();
  beforeEach(() => {
    stored.clear();
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
      },
    };
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("read a show mode that is unset or not one of the three as used (issues #211 and #217)", () => {
    expect(DEFAULT_PREFS.waypointPins).toBe("used");
    expect(loadPrefs().waypointPins).toBe("used");
    stored.set("zenith.ui", JSON.stringify({ version: 1 }));
    expect(loadPrefs().waypointPins).toBe("used");
    stored.set("zenith.ui", JSON.stringify({ version: 1, waypointPins: "some" }));
    expect(loadPrefs().waypointPins).toBe("used");
    stored.set("zenith.ui", JSON.stringify({ version: 1, waypointPins: 2 }));
    expect(loadPrefs().waypointPins).toBe("used");
    stored.set("zenith.ui", JSON.stringify({ version: 1, waypointPins: "all" }));
    expect(loadPrefs().waypointPins).toBe("all");
    stored.set("zenith.ui", JSON.stringify({ version: 1, waypointPins: "none" }));
    expect(loadPrefs().waypointPins).toBe("none");
    expect(parseWaypointPins(undefined)).toBe("used");
  });

  it("keep only well-formed overrides, and at most 500, dropping the oldest first", () => {
    expect(parseWaypointPinOverrides(undefined)).toEqual({});
    expect(parseWaypointPinOverrides(["hide"])).toEqual({});
    expect(parseWaypointPinOverrides({ "a#x": "hide", "a#y": "show", "a#z": "gone", "a#w": true })).toEqual({ "a#x": "hide", "a#y": "show" });

    const many = Object.fromEntries(Array.from({ length: 510 }, (_, index) => [`example:examples/starter#pin${String(index)}`, "hide"]));
    stored.set("zenith.ui", JSON.stringify({ version: 1, waypointPinOverrides: many }));
    const loaded = Object.keys(loadPrefs().waypointPinOverrides);
    expect(MAX_WAYPOINT_PIN_OVERRIDES).toBe(500);
    expect(loaded).toHaveLength(500);
    expect(loaded[0]).toBe("example:examples/starter#pin10");
    expect(loaded[499]).toBe("example:examples/starter#pin509");

    // A new override past the cap pushes out the oldest one, and a changed one becomes the newest.
    const full = parseWaypointPinOverrides(many);
    const added = Object.keys(withPinShown(full, "example:examples/starter#fresh", false, true));
    expect(added).toHaveLength(500);
    expect(added[0]).toBe("example:examples/starter#pin11");
    expect(added[499]).toBe("example:examples/starter#fresh");
    const touched = Object.keys(withPinShown({ "p#a": "hide", "p#b": "hide" }, "p#a", true, false));
    expect(touched).toEqual(["p#b", "p#a"]);
  });

  it("store an override only where it differs from the mode", () => {
    expect(withPinShown({}, "p#park", true, true)).toEqual({});
    expect(withPinShown({}, "p#park", false, true)).toEqual({ "p#park": "hide" });
    expect(withPinShown({ "p#park": "hide" }, "p#park", true, true)).toEqual({});
    expect(withPinShown({}, "p#park", true, false)).toEqual({ "p#park": "show" });
    // A mode that makes an override say nothing drops it, in every project.
    const overrides = { "p#a": "hide", "p#b": "show", "q#c": "hide" } as const;
    expect(prunedForMode(overrides, "all")).toEqual({ "p#a": "hide", "q#c": "hide" });
    expect(prunedForMode(overrides, "none")).toEqual({ "p#b": "show" });
    expect(prunedForMode(overrides, "used")).toEqual(overrides);
  });

  it("drop one project's overrides and keep every other project's", () => {
    const overrides = { "p#park": "hide", "q#park": "hide", "p#start": "show", "pp#start": "hide" } as const;
    expect(withoutProjectPins(overrides, "p")).toEqual({ "q#park": "hide", "pp#start": "hide" });
    expect(withoutProjectPins({ "q#park": "hide" }, "p")).toEqual({ "q#park": "hide" });
  });

  it("keep a project whose key, with a #, starts like another's apart", () => {
    const inner = pinKey("a#b", "p1");
    expect(inner).toBe("a%23b#p1");
    const overrides = { [pinKey("a", "p1")]: "hide", [inner]: "hide" } as const;
    expect(withoutProjectPins(overrides, "a")).toEqual({ [inner]: "hide" });
    expect(projectPinOverrideCount({ [inner]: "hide" }, "a")).toBe(0);
    expect(projectPinOverrideCount({ [inner]: "hide" }, "a#b")).toBe(1);
    expect(withoutProjectPins({ [inner]: "hide" }, "a")).toEqual({ [inner]: "hide" });
    expect(pinKey("100%", "p1")).toBe("100%25#p1");
  });

  it("move an override with a rename", () => {
    expect(withPinRenamed({ "p#park": "hide", "q#park": "show" }, "p", "park", "parkEast")).toEqual({ "q#park": "show", "p#parkEast": "hide" });
    const none = { "q#park": "show" } as const;
    expect(withPinRenamed(none, "p", "park", "parkEast")).toBe(none);
  });

  it("set or clear one override, and keep the same map when nothing changes", () => {
    const overrides = { "p#park": "hide", "q#park": "show" } as const;
    expect(withPinOverride(overrides, "p#park", undefined)).toEqual({ "q#park": "show" });
    expect(withPinOverride(overrides, "p#start", "hide")).toEqual({ ...overrides, "p#start": "hide" });
    expect(withPinOverride(overrides, "p#park", "hide")).toBe(overrides);
    expect(withPinOverride(overrides, "p#start", undefined)).toBe(overrides);
  });
});

describe("the project key", () => {
  const key = (source: ProjectSource, name = "robot-repo"): string => projectKey({ source, name });

  it("names each kind of project by what opens it again", () => {
    expect(key({ kind: "example" }, "examples/starter")).toBe("example:examples/starter");
    expect(key({ kind: "directory", handle: { name: "horizon-robot" } as FileSystemDirectoryHandle })).toBe("folder:horizon-robot");
    expect(key({ kind: "desktop", root: "C:/robots/horizon" })).toBe("desktop:C:/robots/horizon");
    expect(key({ kind: "github", owner: "Horizon-36596", repo: "robot", base: "main", branch: "zenith/x", login: "dohun" })).toBe("github:Horizon-36596/robot");
    expect(key({ kind: "files" }, "picked-files")).toBe("files:picked-files");
    expect(key({ kind: "host", hostId: "dsim" })).toBe("host:dsim");
    expect(pinKey("example:examples/starter", "park")).toBe("example:examples/starter#park");
  });
});

describe("which pins are hidden", () => {
  const waypoints = loadWaypoints(read("autos/waypoints.json"));
  const auto = collectAndScore();
  const all = Object.keys(waypoints.waypoints);
  const used = waypointsUsed(auto);
  const hidden = (mode: "all" | "used" | "none", overrides = {}): string[] =>
    [...hiddenWaypointNames({ waypoints, auto, mode, overrides, projectKey: "p" })].sort();

  it("follow the mode: all hides none, used hides the ones the auto does not follow, none hides every one", () => {
    expect(used.length).toBeGreaterThan(0);
    expect(used.length).toBeLessThan(all.length);
    expect(hidden("all")).toEqual([]);
    expect(hidden("used")).toEqual(all.filter((name) => !used.includes(name)).sort());
    expect(hidden("none")).toEqual([...all].sort());
  });

  it("let an override win over the mode, in its own project only", () => {
    expect(hidden("all", { "p#park": "hide", "q#start": "hide" })).toEqual(["park"]);
    expect(hidden("none", { "p#park": "show" })).toEqual(all.filter((name) => name !== "park").sort());
  });
});

describe("hiding a pin in the editor", () => {
  beforeEach(() => {
    setPrefs({ waypointPins: "all", waypointPinOverrides: {} });
    openProject(example(), { kind: "local" } as unknown as ProjectBackend);
    const auto = collectAndScore();
    openAuto("collect-and-score.auto.json", auto, canonicalize("auto", auto));
  });

  it("never changes waypoints.json, the undo history or the unsaved state", () => {
    const before = getState();
    setSelection({ waypoint: "park" });
    setWaypointPinShown("park", false);
    setWaypointPins("used");
    setWaypointPins("none");
    setWaypointPinShown("park", true);
    setWaypointPins("all");
    const after = getState();
    expect(after.project?.waypoints).toBe(before.project?.waypoints);
    expect(after.auto).toBe(before.auto);
    expect(after.undo).toBe(before.undo);
    expect(isDirty(after)).toBe(false);
    expect(waypointsDirty(after)).toBe(false);
  });

  it("clears the selection of the pin it hides, and Show brings it back", () => {
    setSelection({ waypoint: "park" });
    setWaypointPinShown("park", false);
    expect(hiddenWaypoints().has("park")).toBe(true);
    expect(getState().selection.waypoint).toBeUndefined();
    expect(getState().prefs.waypointPinOverrides).toEqual({ "example:examples/starter#park": "hide" });
    setWaypointPinShown("park", true);
    expect(hiddenWaypoints().has("park")).toBe(false);
    expect(getState().prefs.waypointPinOverrides).toEqual({});
  });

  it("keeps a hidden pin hidden under its new name after a rename", () => {
    setWaypointPinShown("park", false);
    expect(renameWaypointTo("park", "parkEast")).toBe(true);
    expect(hiddenWaypoints().has("parkEast")).toBe(true);
    expect(getState().prefs.waypointPinOverrides).toEqual({ "example:examples/starter#parkEast": "hide" });
  });

  it("moves the override back with an undo of the rename, and on again with its redo", () => {
    setWaypointPinShown("park", false);
    expect(renameWaypointTo("park", "parkEast")).toBe(true);
    undo();
    expect(getState().project?.waypoints?.waypoints["park"]).toBeDefined();
    expect(hiddenWaypoints().has("park")).toBe(true);
    expect(getState().prefs.waypointPinOverrides).toEqual({ "example:examples/starter#park": "hide" });
    redo();
    expect(getState().project?.waypoints?.waypoints["parkEast"]).toBeDefined();
    expect(hiddenWaypoints().has("parkEast")).toBe(true);
    expect(getState().prefs.waypointPinOverrides).toEqual({ "example:examples/starter#parkEast": "hide" });
    undo();
    expect(getState().prefs.waypointPinOverrides).toEqual({ "example:examples/starter#park": "hide" });
  });

  it("keeps a hidden pin hidden through a delete and its undo", () => {
    setWaypointPinShown("park", false);
    expect(deleteWaypointNamed("park")).toBe(true);
    expect(getState().project?.waypoints?.waypoints["park"]).toBeUndefined();
    undo();
    expect(getState().project?.waypoints?.waypoints["park"]).toBeDefined();
    expect(hiddenWaypoints().has("park")).toBe(true);
  });

  it("drops a deleted waypoint's override, so a new waypoint of that name starts shown", () => {
    setWaypointPinShown("park", false);
    expect(deleteWaypointNamed("park")).toBe(true);
    expect(getState().prefs.waypointPinOverrides).toEqual({});
    undo();
    expect(getState().prefs.waypointPinOverrides).toEqual({ "example:examples/starter#park": "hide" });
    expect(hiddenWaypoints().has("park")).toBe(true);
    redo();
    expect(getState().project?.waypoints?.waypoints["park"]).toBeUndefined();
    expect(getState().prefs.waypointPinOverrides).toEqual({});
    expect(addWaypointAt({ xIn: 0, yIn: 0, headingRad: 0 }, "park")).toBe(true);
    expect(hiddenWaypoints().has("park")).toBe(false);
  });

  it("Show all clears this project's overrides only, and changes nothing in the file", () => {
    const before = getState();
    setWaypointPinShown("park", false);
    setWaypointPinShown("start", false);
    setPrefs({ waypointPinOverrides: { ...getState().prefs.waypointPinOverrides, "folder:robot-repo#park": "hide" } });
    expect(hiddenWaypoints().has("park")).toBe(true);
    showAllWaypointPins();
    expect(getState().prefs.waypointPinOverrides).toEqual({ "folder:robot-repo#park": "hide" });
    expect(hiddenWaypoints().size).toBe(0);
    expect(getState().project?.waypoints).toBe(before.project?.waypoints);
    expect(getState().undo).toBe(before.undo);
    expect(isDirty()).toBe(false);
  });

  it("forgets a deleted pin's override, so a new waypoint with its name follows the mode, and undo and redo carry it", () => {
    setWaypointPinShown("park", false);
    expect(deleteWaypointNamed("park")).toBe(true);
    expect(getState().prefs.waypointPinOverrides).toEqual({});
    redo();
    undo();
    expect(getState().prefs.waypointPinOverrides).toEqual({ "example:examples/starter#park": "hide" });
    redo();
    expect(getState().prefs.waypointPinOverrides).toEqual({});
    expect(addWaypointAt({ xIn: 10, yIn: 20, headingRad: 0 }, "park")).toBe(true);
    expect(hiddenWaypoints().has("park")).toBe(false);
  });

  it("leaves the undo history alone when the deleted pin had no override", () => {
    expect(deleteWaypointNamed("park")).toBe(true);
    expect(getState().undo.at(-1)?.pinDrop).toBeUndefined();
    expect(getState().prefs.waypointPinOverrides).toEqual({});
  });
});
