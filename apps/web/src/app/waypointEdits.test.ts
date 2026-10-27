/**
 * Issue #134: waypoints can be moved, added, renamed and deleted in the editor. Moving a waypoint
 * moves every point that follows it at once and makes its provenance the editor's; "Save as
 * waypoint…" makes one from the start or a path's end, which then follows it; a rename points the
 * open auto at the new name; a delete gives the open auto's points poses of their own and says so.
 * Each is one undo step, the editor counts it as unsaved, and where a project cannot write
 * waypoints.json, editing is off with one sentence saying why.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, EDITOR_PROVENANCE, loadAuto, loadField, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import { SCHEMA_ID, type Auto, type PathStep, type PoseSource } from "@horizon36596/zenith-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectBackend } from "../project/backend";
import type { Project, ProjectSource } from "../project/types";
import { actionById, isEnabled, labelOf } from "./actions";
import { deleteSelection } from "./edits";
import { askDeleteWaypoint, askRenameWaypoint, closeWaypointQuestion, getWaypointQuestion } from "./waypointDialog";
import { setFeatures } from "../state/features";
import {
  beginTransaction,
  cancelTransaction,
  clearStatus,
  commit,
  currentDerived,
  endTransaction,
  getState,
  isDirty,
  markWaypointsSaved,
  openAuto,
  openProject,
  redo,
  setHost,
  setSelection,
  setSetting,
  undo,
  waypointsDirty,
} from "../state/store";
import {
  addWaypointAt,
  addWaypointFrom,
  deleteWaypointNamed,
  dragWaypoint,
  endWaypointDrag,
  followersLines,
  followersOf,
  moveWaypoint,
  nudgeWaypoint,
  renameWaypointTo,
  rotateWaypoint,
  suggestedNewWaypointName,
  suggestedWaypointName,
  waypointEditingOff,
  whyNoWaypointAt,
  whyNoWaypointFrom,
  writeWaypointNumbers,
  writeWaypointProvenance,
} from "./waypointEdits";
import { NUDGE_IN } from "./shortcuts";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));
const text = (relative: string): string => readFileSync(`${examples}${relative}`, "utf8");

const project = (source: ProjectSource = { kind: "example" }, extra: Partial<Project> = {}): Project => ({
  source,
  name: "waypoint-fixture",
  link: { autosDir: "autos", robot: "autos/robot.json", field: "autos/field.json", waypoints: "autos/waypoints.json" } as Project["link"],
  robot: loadRobot(read("robot.json")),
  field: loadField(read("field/biobuzz.field.json")),
  waypoints: loadWaypoints(read("waypoints.json")),
  autoFiles: ["fixture.auto.json", "first-auto.auto.json", "cycle-and-park.auto.json"],
  autoTexts: {
    "first-auto.auto.json": text("first-auto.auto.json"),
    "cycle-and-park.auto.json": text("cycle-and-park.auto.json"),
  },
  ...extra,
});

// As in the starter autos: the start and driveOut's first point follow the waypoint start, at
// (-13, -63) facing 1.5708 rad; driveOut ends on scoreSouth, (-13, -36); leg2 starts from the last
// step's end and ends at a pose of its own.
const fixture = (): Auto =>
  loadAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 4,
    name: "fixture",
    alliance: "RED",
    start: { pose: { ref: "start" } },
    steps: [
      {
        id: "driveOut",
        kind: "path",
        segments: [{ kind: "line", from: { ref: "start" }, to: { ref: "scoreSouth" } }],
        heading: { mode: "tangent" },
      },
      {
        id: "leg2",
        kind: "path",
        segments: [{ kind: "line", from: "current", to: { xIn: 0, yIn: -36, headingRad: 0, provenance: "MEASURED: tape" } }],
        heading: { mode: "tangent" },
      },
    ],
  });

const open = (withProject: Project = project(), backend: Partial<ProjectBackend> = { kind: "local" }): void => {
  setHost(null);
  openProject(withProject, backend as ProjectBackend);
  const auto = fixture();
  openAuto("fixture.auto.json", auto, canonicalize("auto", auto));
  clearStatus();
};

const waypoint = (name: string) => getState().project?.waypoints?.waypoints[name];
const step = (id: string): PathStep => {
  const found = getState().auto?.steps.find((candidate) => candidate.id === id);
  if (found?.kind !== "path") throw new Error(`no ${id}`);
  return found;
};
const firstPoint = (): PoseSource | undefined => step("driveOut").segments[0]?.from;
const resolvedStart = () => currentDerived().resolved?.startPose;
const status = () => getState().status;

beforeEach(() => {
  open();
});

describe("moving a waypoint", () => {
  it("moves every point that follows it at once, and the editor owns the new numbers", () => {
    moveWaypoint("start", { xIn: -36 }, "drag");
    expect(waypoint("start")).toMatchObject({ xIn: -36, yIn: -63, headingRad: 1.5708, provenance: EDITOR_PROVENANCE });
    // The auto still follows the waypoint; what it resolves to moved with it.
    expect(getState().auto?.start.pose).toEqual({ ref: "start" });
    expect(firstPoint()).toEqual({ ref: "start" });
    expect(resolvedStart()).toMatchObject({ xIn: -36, yIn: -63 });
    expect(waypointsDirty()).toBe(true);
    expect(isDirty()).toBe(true);
  });

  it("is one undo step, which redo puts back", () => {
    const before = getState().undo.length;
    moveWaypoint("start", { xIn: -36 }, "drag");
    expect(getState().undo.length).toBe(before + 1);
    undo();
    expect(waypoint("start")).toMatchObject({ xIn: -13, provenance: expect.stringMatching(/^SET FROM EDITOR: starter example/) as unknown });
    expect(waypointsDirty()).toBe(false);
    redo();
    expect(waypoint("start")?.xIn).toBe(-36);
  });

  it("makes a whole drag one undo step", () => {
    const before = getState().undo.length;
    beginTransaction();
    for (const xIn of [-14, -20, -30, -36]) moveWaypoint("start", { xIn, yIn: -63 }, "drag");
    endTransaction();
    expect(getState().undo.length).toBe(before + 1);
    undo();
    expect(waypoint("start")?.xIn).toBe(-13);
  });

  it("nudges and turns a selected pin with the keys' steps", () => {
    nudgeWaypoint("scoreSouth", 1, 0, false);
    expect(waypoint("scoreSouth")?.xIn).toBeCloseTo(-13 + NUDGE_IN, 9);
    nudgeWaypoint("scoreSouth", 0, -1, true);
    expect(waypoint("scoreSouth")?.yIn).toBeCloseTo(-36 - 4 * NUDGE_IN, 9);
    rotateWaypoint("scoreSouth", 1);
    expect(waypoint("scoreSouth")?.headingRad).toBeCloseTo(1.5708 + (5 * Math.PI) / 180, 6);
  });

  it("keeps the heading in (-180, 180] when R turns a pin past a half turn", () => {
    for (let i = 0; i < 80; i += 1) rotateWaypoint("scoreSouth", 1);
    // 90 degrees plus 80 turns of 5 is 490, which is 130.
    expect(waypoint("scoreSouth")?.headingRad).toBeCloseTo((130 * Math.PI) / 180, 4);
    for (let i = 0; i < 80; i += 1) rotateWaypoint("scoreSouth", -1);
    expect(waypoint("scoreSouth")?.headingRad).toBeCloseTo(Math.PI / 2, 4);
  });

  it("counts as saved once waypoints.json is written, and goes back to the saved file when another auto opens", () => {
    moveWaypoint("start", { xIn: -36 }, "drag");
    markWaypointsSaved();
    expect(isDirty()).toBe(false);
    moveWaypoint("start", { xIn: -40 }, "drag");
    expect(isDirty()).toBe(true);
    // The unsaved-changes question comes before this; Discard is what lets it through.
    const auto = fixture();
    openAuto("fixture.auto.json", auto, canonicalize("auto", auto));
    expect(waypoint("start")?.xIn).toBe(-36);
    expect(isDirty()).toBe(false);
  });
});

describe("saving a pose as a waypoint", () => {
  it("makes one from a pose of its own, which then follows it, as one undo step", () => {
    const before = getState().undo.length;
    const owner = { stepId: "leg2", point: { segmentIndex: 0, pointKind: "to" as const } };
    expect(whyNoWaypointFrom(owner)).toBeNull();
    expect(suggestedWaypointName(owner)).toBe("leg2End");
    expect(addWaypointFrom(owner, "midField")).toBe(true);
    expect(waypoint("midField")).toEqual({ xIn: 0, yIn: -36, headingRad: 0, provenance: "MEASURED: tape" });
    expect(step("leg2").segments[0]?.to).toEqual({ ref: "midField" });
    expect(Object.keys(getState().project?.waypoints?.waypoints ?? {}).at(-1)).toBe("midField");
    expect(status()?.message).toBe("Saved point 1 of leg2 as waypoint midField. Point 1 of leg2 now follows it.");
    expect(getState().undo.length).toBe(before + 1);
    undo();
    expect(waypoint("midField")).toBeUndefined();
    expect(step("leg2").segments[0]?.to).toMatchObject({ xIn: 0, yIn: -36 });
  });

  it("makes one from the last step's end at the spot it resolves to, with the editor's provenance", () => {
    const owner = { stepId: "leg2", point: { segmentIndex: 0, pointKind: "from" as const } };
    expect(addWaypointFrom(owner, "afterDriveOut")).toBe(true);
    expect(waypoint("afterDriveOut")).toMatchObject({ xIn: -13, yIn: -36, provenance: EDITOR_PROVENANCE });
    expect(step("leg2").segments[0]?.from).toEqual({ ref: "afterDriveOut" });
  });

  it("refuses a point that already follows a waypoint, and a name the format would not take", () => {
    expect(whyNoWaypointFrom("start")).toBe("The start already follows waypoint start.");
    const owner = { stepId: "leg2", point: { segmentIndex: 0, pointKind: "to" as const } };
    expect(addWaypointFrom(owner, "park")).toBe(false);
    expect(status()?.message).toBe("There is already a waypoint named park.");
    expect(addWaypointFrom(owner, "mid field")).toBe(false);
    expect(waypoint("mid field")).toBeUndefined();
  });

  it("suggests a name no waypoint has", () => {
    // The start follows `start` here, but the name is what is checked.
    expect(suggestedWaypointName("start")).toBe("start-2");
  });
});

describe("adding a waypoint at a spot on the field", () => {
  it("suggests waypoint1, then the next free number", () => {
    expect(suggestedNewWaypointName()).toBe("waypoint1");
    expect(addWaypointAt({ xIn: 10, yIn: 20, headingRad: 0.5 }, "waypoint1")).toBe(true);
    expect(suggestedNewWaypointName()).toBe("waypoint2");
  });

  it("suggests the step's id and End for a path's end", () => {
    expect(suggestedWaypointName({ stepId: "driveOut", point: { segmentIndex: 0, pointKind: "to" } })).toBe("driveOutEnd");
  });

  it("adds the pin with the editor's provenance, selects it, leaves the auto alone and is one undo step", () => {
    const autoBefore = getState().auto;
    const before = getState().undo.length;
    expect(addWaypointAt({ xIn: 10, yIn: 20, headingRad: 0.5 }, "waypoint1")).toBe(true);
    expect(waypoint("waypoint1")).toEqual({ xIn: 10, yIn: 20, headingRad: 0.5, provenance: EDITOR_PROVENANCE });
    expect(Object.keys(getState().project?.waypoints?.waypoints ?? {}).at(-1)).toBe("waypoint1");
    expect(getState().auto).toBe(autoBefore);
    expect(getState().selection).toEqual({ waypoint: "waypoint1" });
    expect(getState().undo.length).toBe(before + 1);
    expect(waypointsDirty()).toBe(true);
    expect(status()?.message).toBe("Added waypoint waypoint1.");
    undo();
    expect(waypoint("waypoint1")).toBeUndefined();
    expect(getState().selection.waypoint).toBeUndefined();
    expect(waypointsDirty()).toBe(false);
  });

  it("undo says the pin is gone, and redo brings it back selected with the added status", () => {
    expect(addWaypointAt({ xIn: 10, yIn: 20, headingRad: 0.5 }, "waypoint1")).toBe(true);
    undo();
    expect(waypoint("waypoint1")).toBeUndefined();
    expect(status()?.message).toBe("Removed waypoint waypoint1.");
    redo();
    expect(waypoint("waypoint1")).toBeDefined();
    expect(getState().selection).toEqual({ waypoint: "waypoint1" });
    expect(getState().multiSteps).toEqual([]);
    expect(status()?.message).toBe("Added waypoint waypoint1.");
    undo();
    expect(waypoint("waypoint1")).toBeUndefined();
    expect(getState().selection.waypoint).toBeUndefined();
  });

  it("refuses a name the format would not take, and a spot that snapped onto a pin", () => {
    expect(addWaypointAt({ xIn: 10, yIn: 20, headingRad: 0 }, "park")).toBe(false);
    expect(status()?.message).toBe("There is already a waypoint named park.");
    // An empty name and one that starts with a digit are refused by the format check in core.
    const before = Object.keys(getState().project?.waypoints?.waypoints ?? {});
    expect(addWaypointAt({ xIn: 10, yIn: 20, headingRad: 0 }, "")).toBe(false);
    expect(status()?.kind).toBe("error");
    expect(addWaypointAt({ xIn: 10, yIn: 20, headingRad: 0 }, "1bad")).toBe(false);
    expect(status()?.kind).toBe("error");
    expect(Object.keys(getState().project?.waypoints?.waypoints ?? {})).toEqual(before);
    expect(whyNoWaypointAt({ xIn: 1, yIn: 2, headingRad: 0, waypoint: "park" })).toBe("Waypoint park is already here.");
    expect(whyNoWaypointAt({ xIn: 1, yIn: 2, headingRad: 0 })).toBeNull();
    expect(whyNoWaypointAt(undefined)).toBe("There is no spot on the field here.");
  });
});

describe("renaming a waypoint", () => {
  it("renames it in place and points the open auto at the new name, as one undo step", () => {
    setSelection({ waypoint: "start" });
    expect(renameWaypointTo("start", "home")).toBe(true);
    expect(Object.keys(getState().project?.waypoints?.waypoints ?? {})[0]).toBe("home");
    expect(waypoint("start")).toBeUndefined();
    expect(getState().auto?.start.pose).toEqual({ ref: "home" });
    expect(firstPoint()).toEqual({ ref: "home" });
    expect(getState().selection).toEqual({ waypoint: "home" });
    expect(status()?.message).toBe("Renamed waypoint start to home. The 2 points in this auto that followed it follow home now.");
    expect(currentDerived().findings.some((finding) => /No waypoint named/.test(finding.message))).toBe(false);
    undo();
    expect(getState().auto?.start.pose).toEqual({ ref: "start" });
    expect(waypoint("start")).toBeDefined();
  });

  it("refuses a taken name", () => {
    expect(renameWaypointTo("start", "park")).toBe(false);
    expect(getState().auto?.start.pose).toEqual({ ref: "start" });
  });

  it("asks nothing with the Waypoints switch off, from any way in, and says which switch to turn on", () => {
    closeWaypointQuestion();
    setFeatures({ waypoints: false });
    try {
      askRenameWaypoint("park");
      expect(getWaypointQuestion()).toBeNull();
      expect(status()?.kind).toBe("error");
      expect(status()?.message).toBe("Waypoints is off in your settings. Turn it on in Settings, General to rename a waypoint.");
      askDeleteWaypoint("park");
      expect(getWaypointQuestion()).toBeNull();
      expect(status()?.message).toMatch(/to delete a waypoint\.$/);
      expect(waypoint("park")).toBeDefined();
    } finally {
      setFeatures({ waypoints: true });
    }
    askRenameWaypoint("park");
    expect(getWaypointQuestion()).toEqual({ kind: "rename", name: "park" });
    closeWaypointQuestion();
  });
});

describe("deleting a waypoint", () => {
  it("unlinks the open auto's points to poses of their own and says so, and one undo brings it back", () => {
    expect(deleteWaypointNamed("start")).toBe(true);
    expect(waypoint("start")).toBeUndefined();
    const pose = { xIn: -13, yIn: -63, headingRad: 1.5708 };
    expect(getState().auto?.start.pose).toMatchObject(pose);
    expect(firstPoint()).toMatchObject(pose);
    expect((firstPoint() as { provenance: string }).provenance).toMatch(/^SET FROM EDITOR: starter example/);
    expect(status()?.message).toBe(
      "Deleted waypoint start. The start and the first point of driveOut no longer follow waypoint start. Undo links them again.",
    );
    // The robot has not moved, and nothing follows a waypoint that is gone.
    expect(resolvedStart()).toMatchObject({ xIn: -13, yIn: -63 });
    expect(currentDerived().findings.some((finding) => /No waypoint named/.test(finding.message))).toBe(false);
    undo();
    expect(waypoint("start")).toBeDefined();
    expect(getState().auto?.start.pose).toEqual({ ref: "start" });
    expect(firstPoint()).toEqual({ ref: "start" });
  });

  it("clears a selected pin it deletes", () => {
    setSelection({ waypoint: "park" });
    deleteWaypointNamed("park");
    expect(getState().selection).toEqual({});
    expect(status()?.message).toBe("Deleted waypoint park. Undo brings it back.");
  });
});

describe("Delete on a selected pin", () => {
  beforeEach(() => {
    closeWaypointQuestion();
  });

  it("asks through the delete dialog and deletes nothing until it is answered", () => {
    setSelection({ waypoint: "park" });
    deleteSelection();
    expect(getWaypointQuestion()).toEqual({ kind: "delete", name: "park" });
    expect(waypoint("park")).toBeDefined();
    expect(getState().undo).toHaveLength(0);
    closeWaypointQuestion();
  });

  it("is enabled with only a pin selected, and its menu label says Delete waypoint", () => {
    const action = actionById("edit.delete");
    if (action === undefined) throw new Error("no edit.delete");
    setSelection({});
    expect(isEnabled(action, getState())).toBe(false);
    expect(labelOf(action, getState())).toBe("Delete step");
    setSelection({ waypoint: "park" });
    expect(isEnabled(action, getState())).toBe(true);
    expect(labelOf(action, getState())).toBe("Delete waypoint…");
    expect(action.whyDisabled?.(getState())).toMatch(/waypoint/);
  });

  it("undo selects the pin again and says it is back, and redo clears the selection again", () => {
    setSelection({ waypoint: "park" });
    expect(deleteWaypointNamed("park")).toBe(true);
    const said = status()?.message;
    expect(said).toBe("Deleted waypoint park. Undo brings it back.");
    expect(getState().selection).toEqual({});
    undo();
    expect(waypoint("park")).toBeDefined();
    expect(getState().selection).toEqual({ waypoint: "park" });
    expect(status()?.message).toBe("Waypoint park is back.");
    clearStatus();
    redo();
    expect(waypoint("park")).toBeUndefined();
    expect(getState().selection).toEqual({});
    expect(status()?.message).toBe(said);
  });

  it("is disabled, with the sentence that says why, where waypoint editing is off", () => {
    const action = actionById("edit.delete");
    if (action === undefined) throw new Error("no edit.delete");
    open(project({ kind: "directory" } as ProjectSource, { link: { autosDir: "autos", robot: "r.json", field: "f.json" } as Project["link"] }));
    setSelection({ waypoint: "park" });
    expect(isEnabled(action, getState())).toBe(false);
    expect(action.whyDisabled?.(getState())).toMatch(/names no waypoints file/);
    open(project({ kind: "host", hostId: "dsim" }));
    setHost({ id: "dsim", name: "DSIM", phase: "open", closedBy: null, failure: null, label: null, readOnlyRobot: true, simulate: false, running: null, outdated: null });
    setSelection({ waypoint: "park" });
    expect(isEnabled(action, getState())).toBe(false);
    expect(action.whyDisabled?.(getState())).toMatch(/^Waypoints are read only here/);
    // The press itself opens no dialog; it only says why on the status line.
    deleteSelection();
    expect(getWaypointQuestion()).toBeNull();
    expect(status()?.kind).toBe("error");
    setHost(null);
  });

  it("keeps one question, and its followers fetch, when Delete repeats", () => {
    setSelection({ waypoint: "park" });
    deleteSelection();
    const first = getWaypointQuestion();
    deleteSelection();
    deleteSelection();
    expect(getWaypointQuestion()).toBe(first);
    closeWaypointQuestion();
  });

  it("selects the pin on undo even when the delete came from the Inspector's button with nothing selected", () => {
    expect(deleteWaypointNamed("park")).toBe(true);
    undo();
    expect(getState().selection).toEqual({ waypoint: "park" });
  });

  it("leaves the selection alone when an unrelated step edit is undone after a waypoint delete", async () => {
    expect(deleteWaypointNamed("park")).toBe(true);
    // The delete's click ends before the next edit begins.
    await Promise.resolve();
    const auto = getState().auto;
    if (auto === null) throw new Error("no auto");
    commit({ ...auto, name: "renamed" });
    setSelection({ stepId: "leg2" });
    clearStatus();
    undo();
    expect(getState().auto?.name).toBe("fixture");
    expect(getState().selection).toEqual({ stepId: "leg2" });
    // The rename wrote no line, so its undo says the general one (UI_GUIDE 9.15).
    expect(status()?.message).toBe("Undid the last change.");
    // The delete's own undo still selects the pin.
    undo();
    expect(getState().selection).toEqual({ waypoint: "park" });
  });
});

describe("which autos follow a waypoint", () => {
  it("names the open auto's points and the other autos that follow it", async () => {
    const followers = await followersOf("start");
    expect(followers).toEqual({
      here: ["the start", "the first point of driveOut"],
      others: ["cycle-and-park.auto.json", "first-auto.auto.json"],
      unreadable: [],
    });
    expect(followersLines("start", followers, "delete")).toEqual([
      "In this auto, the start and the first point of driveOut follow start.",
      "They keep the waypoint's pose as their own.",
      "cycle-and-park.auto.json and first-auto.auto.json follow start too, and are not changed here: they still name it and show an error until each is opened and changed.",
    ]);
    expect((await followersOf("parkLoadingZone")).others).toEqual(["cycle-and-park.auto.json"]);
    expect(followersLines("flowerNorthPickup", await followersOf("flowerNorthPickup"), "rename")).toEqual([
      "No auto in this project follows flowerNorthPickup.",
    ]);
  });

  it("reads the other autos through the backend when the project holds no text of them, and says which it could not read", async () => {
    const files: Record<string, string> = { "autos/first-auto.auto.json": text("first-auto.auto.json") };
    const backend = {
      kind: "local",
      readText: (path: string) => (files[path] === undefined ? Promise.reject(new Error("gone")) : Promise.resolve(files[path])),
    } as Partial<ProjectBackend>;
    open(project({ kind: "directory" } as ProjectSource, { autoTexts: {} }), backend);
    const followers = await followersOf("start");
    expect(followers.others).toEqual(["first-auto.auto.json"]);
    expect(followers.unreadable).toEqual(["cycle-and-park.auto.json"]);
    expect(followersLines("start", followers, "rename").at(-1)).toBe(
      "Zenith could not read cycle-and-park.auto.json, so it cannot say whether it follows start.",
    );
  });
});

describe("where waypoint editing is off", () => {
  it("is on for the example, picked files and a folder", () => {
    expect(waypointEditingOff()).toBeNull();
    open(project({ kind: "files" }));
    expect(waypointEditingOff()).toBeNull();
    open(project({ kind: "directory" } as ProjectSource));
    expect(waypointEditingOff()).toBeNull();
  });

  it("is off in host mode, which sends back autos only, and refuses the edit with that sentence", () => {
    open(project({ kind: "host", hostId: "dsim" }));
    setHost({ id: "dsim", name: "DSIM", phase: "open", closedBy: null, failure: null, label: null, readOnlyRobot: true, simulate: false, running: null, outdated: null });
    const why = "Waypoints are read only here: DSIM takes back only the autos, so a change to waypoints.json could not be saved.";
    expect(waypointEditingOff()).toBe(why);
    moveWaypoint("start", { xIn: -36 }, "drag");
    expect(waypoint("start")?.xIn).toBe(-13);
    expect(status()).toMatchObject({ kind: "error", message: why });
    setHost(null);
  });

  it("is off where zenith.json names no waypoints file", () => {
    open(project({ kind: "directory" } as ProjectSource, { link: { autosDir: "autos", robot: "r.json", field: "f.json" } as Project["link"] }));
    expect(waypointEditingOff()).toMatch(/names no waypoints file/);
  });

  it("is off in a desktop app that cannot write waypoints.json", () => {
    open(project({ kind: "desktop", root: "C:\\robot" }));
    expect(waypointEditingOff()).toMatch(/desktop app cannot write waypoints.json/);
    open(project({ kind: "desktop", root: "C:\\robot" }), { kind: "local", writeWaypoints: () => Promise.resolve("") });
    expect(waypointEditingOff()).toBeNull();
  });

  it("is off on GitHub when waypoints.json is outside the folders Zenith may commit to", () => {
    const github = { kind: "github", owner: "o", repo: "r", base: "main", branch: "main", login: "u" } as const;
    open(project(github));
    expect(waypointEditingOff()).toBeNull();
    open(project(github, { link: { autosDir: "autos", robot: "r.json", field: "f.json", waypoints: "config/waypoints.json" } as Project["link"] }));
    expect(waypointEditingOff()).toMatch(/config\/waypoints.json is outside them/);
  });
});

/** Waits until a status line other than `before` is on the bar, which the async follower read writes. */
async function nextStatus(before: unknown): Promise<string | undefined> {
  for (let tries = 0; tries < 200 && status() === before; tries += 1) await Promise.resolve();
  return status()?.message;
}

describe("what moving a pin says (issue #191)", () => {
  it("names the old label and the other autos that follow, and offers Ctrl+Z, when a drag ends", async () => {
    const before = status();
    beginTransaction();
    for (const xIn of [-14, -20, -30]) dragWaypoint("start", { xIn, yIn: -63 });
    endTransaction();
    expect(status()).toBe(before);
    endWaypointDrag();
    const message = await nextStatus(before);
    expect(message).toMatch(/^Moved waypoint start, which was SET FROM EDITOR: starter example, against the south wall/);
    expect(message).toContain("it is now SET FROM EDITOR.");
    expect(message).toContain("cycle-and-park and first-auto follow it too, so they move with it.");
    expect(message).toMatch(/Ctrl\+Z puts it back\.$/);
  });

  it("leaves the label out when it was already the editor's, and the autos out when none follows", async () => {
    moveWaypoint("flowerNorthPickup", { xIn: -22 }, "drag");
    clearStatus();
    const before = status();
    beginTransaction();
    dragWaypoint("flowerNorthPickup", { xIn: -20, yIn: 57 });
    endTransaction();
    endWaypointDrag();
    expect(await nextStatus(before)).toBe("Moved waypoint flowerNorthPickup. Ctrl+Z puts it back.");
  });

  it("says nothing when the drag was cancelled", async () => {
    const before = status();
    beginTransaction();
    dragWaypoint("start", { xIn: -30, yIn: -63 });
    cancelTransaction();
    endWaypointDrag();
    expect(await nextStatus(before)).toBeUndefined();
    expect(waypoint("start")?.xIn).toBe(-13);
  });

  it("says it on the first key of a nudge run only", async () => {
    const before = status();
    nudgeWaypoint("parkLoadingZone", 1, 0, false);
    const first = await nextStatus(before);
    expect(first).toMatch(/^Moved waypoint parkLoadingZone, which was PLACEHOLDER/);
    expect(first).toContain("cycle-and-park follows it too, so it moves with it.");
    const spoken = status();
    nudgeWaypoint("parkLoadingZone", 1, 0, false);
    nudgeWaypoint("parkLoadingZone", 0, 1, false);
    await nextStatus(spoken);
    expect(status()).toBe(spoken);
  });
});

/**
 * Decision D12, "select first" (spec 15 section 13): every caller of `moveWaypoint` (a first press, a
 * second press-drag, a nudge, `R`, a typed number and an accepted proposal) through the rule.
 */
describe("protecting a measured pin (D12)", () => {
  const measured = "MEASURED: tape, 2026-09-30";
  const wasBytes = (): string => canonicalize("waypoints", getState().project?.waypoints as never);

  /** Labels a pin by hand, then starts the status line clean. */
  const measure = (name = "scoreSouth", label = measured): void => {
    writeWaypointProvenance(name, label);
    clearStatus();
  };

  afterEach(() => {
    setSetting("editing.protectMeasuredPins", true);
  });

  it("holds back a first press: dragging an unselected measured pin leaves waypoints.json as it was and says why", () => {
    measure();
    setSelection({});
    const bytes = wasBytes();
    const undoDepth = getState().undo.length;
    expect(moveWaypoint("scoreSouth", { xIn: -20, yIn: -30 }, "drag")).toEqual({ moved: false, replaced: null });
    expect(wasBytes()).toBe(bytes);
    expect(getState().undo.length).toBe(undoDepth);
    expect(status()?.message).toBe("Waypoint scoreSouth is MEASURED, so the first press only selected it. Press and drag it again to move it.");
  });

  it("holds back an arrow key and R on a measured pin that is not selected", () => {
    measure();
    setSelection({});
    const bytes = wasBytes();
    nudgeWaypoint("scoreSouth", 1, 0, false);
    rotateWaypoint("scoreSouth", 1);
    expect(wasBytes()).toBe(bytes);
    expect(status()?.message).toContain("Select it first.");
  });

  it("moves it on the second press-drag, once it is selected, and stamps SET FROM EDITOR", () => {
    measure();
    setSelection({ waypoint: "scoreSouth" });
    expect(moveWaypoint("scoreSouth", { xIn: -20 }, "drag").moved).toBe(true);
    expect(waypoint("scoreSouth")).toMatchObject({ xIn: -20, provenance: EDITOR_PROVENANCE });
    undo();
    expect(waypoint("scoreSouth")?.provenance).toBe(measured);
  });

  it("nudges and turns a selected measured pin", () => {
    measure();
    setSelection({ waypoint: "scoreSouth" });
    nudgeWaypoint("scoreSouth", 1, 0, false);
    expect(waypoint("scoreSouth")?.xIn).toBeCloseTo(-13 + NUDGE_IN, 9);
    expect(waypoint("scoreSouth")?.provenance).toBe(EDITOR_PROVENANCE);
    undo();
    setSelection({ waypoint: "scoreSouth" });
    rotateWaypoint("scoreSouth", 1);
    expect(waypoint("scoreSouth")?.headingRad).toBeCloseTo(1.5708 + (5 * Math.PI) / 180, 6);
  });

  it("protects CALIBRATED FROM ROBOT as well", () => {
    measure("scoreSouth", "CALIBRATED FROM ROBOT: 3 runs");
    setSelection({});
    expect(moveWaypoint("scoreSouth", { xIn: -20 }, "drag").moved).toBe(false);
    expect(status()?.message).toContain("is CALIBRATED FROM ROBOT");
  });

  it("lets a typed number through, stamps SET FROM EDITOR and warns, selected or not", () => {
    for (const selected of [false, true]) {
      measure();
      setSelection(selected ? { waypoint: "scoreSouth" } : {});
      expect(writeWaypointNumbers("scoreSouth", { xIn: -25 })).toBe("MEASURED");
      expect(waypoint("scoreSouth")).toMatchObject({ xIn: -25, provenance: EDITOR_PROVENANCE });
      expect(status()?.message).toContain("This changes MEASURED to SET FROM EDITOR on waypoint scoreSouth.");
      undo();
      undo();
    }
  });

  it("reports what a typed move replaced", () => {
    measure();
    expect(moveWaypoint("scoreSouth", { yIn: -30 }, "typed")).toEqual({ moved: true, replaced: "MEASURED" });
    expect(waypoint("scoreSouth")?.provenance).toBe(EDITOR_PROVENANCE);
  });

  it("lets an accepted proposal through with the same line", () => {
    measure();
    setSelection({});
    expect(moveWaypoint("scoreSouth", { xIn: -22 }, "proposal")).toEqual({ moved: true, replaced: "MEASURED" });
    expect(waypoint("scoreSouth")).toMatchObject({ xIn: -22, provenance: EDITOR_PROVENANCE });
    expect(status()?.message).toContain("This changes MEASURED to SET FROM EDITOR on waypoint scoreSouth.");
  });

  it("moves every other pin at once, selected or not", () => {
    setSelection({});
    expect(moveWaypoint("parkLoadingZone", { xIn: -50 }, "drag").moved).toBe(true);
    expect(waypoint("parkLoadingZone")?.xIn).toBe(-50);
  });

  it("is main's behaviour with the setting off: a first press drags a measured pin at once", () => {
    setSetting("editing.protectMeasuredPins", false);
    measure();
    setSelection({});
    expect(moveWaypoint("scoreSouth", { xIn: -20 }, "drag").moved).toBe(true);
    expect(waypoint("scoreSouth")).toMatchObject({ xIn: -20, provenance: EDITOR_PROVENANCE });
    undo();
    nudgeWaypoint("scoreSouth", 1, 0, false);
    expect(waypoint("scoreSouth")?.xIn).toBeCloseTo(-13 + NUDGE_IN, 9);
  });

  it("is never written into waypoints.json", () => {
    measure();
    expect(wasBytes()).not.toMatch(/protect/i);
  });
});
