/**
 * Issue #233: a waypoint pin has its own right-click menu, a rename on a double-click or F2, and the
 * dot or start mark that covers a pin reaches it. The canvas selects what it right-clicks and then
 * asks `canvasActions` for the items, so these tests ask it for each kind of target and run the
 * items against the store, as the menu does.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, loadAuto, loadField, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import { SCHEMA_ID, type Auto } from "@horizon36596/zenith-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectBackend } from "../project/backend";
import type { Project } from "../project/types";
import type { CanvasAction, CanvasMenuTarget } from "../canvas/types";
import { ALL_FEATURES, NO_FEATURES, setFeatures } from "../state/features";
import { clearStatus, getState, hiddenWaypoints, openAuto, openProject, setHost, setPrefs, setReview, setSelection, setTool } from "../state/store";
import { getUi, stopWaypointPlacement } from "../state/ui";
import { actionById, isEnabled, shortcutOf } from "./actions";
import { canvasActions } from "./canvasMenu";
import { actionForKey } from "./keymap";
import { armWaypointPlacement, askAddWaypointAt, closeWaypointQuestion, getWaypointQuestion } from "./waypointDialog";
import { copyWaypointPosition, selectFollowersOf, waypointPoseText } from "./waypointEdits";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

const project = (): Project => ({
  source: { kind: "example" },
  name: "waypoint-menu-fixture",
  link: { autosDir: "autos", robot: "autos/robot.json", field: "autos/field.json", waypoints: "autos/waypoints.json" } as Project["link"],
  robot: loadRobot(read("robot.json")),
  field: loadField(read("field/biobuzz.field.json")),
  waypoints: loadWaypoints(read("waypoints.json")),
  autoFiles: ["fixture.auto.json"],
  autoTexts: {},
});

// The start and driveOut's first point follow the waypoint start; driveOut ends on scoreSouth; leg2
// starts from the last step's end and ends at a pose of its own.
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

const at = { xIn: 0, yIn: 0 };
const menu = (target: Omit<CanvasMenuTarget, "atIn">): CanvasAction[] => canvasActions({ ...target, atIn: at });
const labels = (items: CanvasAction[]): string[] => items.map((item) => item.label);
const item = (items: CanvasAction[], label: string): CanvasAction => {
  const found = items.find((candidate) => candidate.label === label);
  if (found === undefined) throw new Error(`no "${label}" in ${JSON.stringify(labels(items))}`);
  return found;
};

beforeEach(() => {
  setFeatures(ALL_FEATURES);
  setHost(null);
  setPrefs({ waypointPins: "all", waypointPinOverrides: {} });
  openProject(project(), { kind: "local" } as unknown as ProjectBackend);
  const auto = fixture();
  openAuto("fixture.auto.json", auto, canonicalize("auto", auto));
  clearStatus();
  closeWaypointQuestion();
});

afterEach(() => {
  closeWaypointQuestion();
  stopWaypointPlacement();
  setReview(null);
  setTool("select");
  setFeatures(NO_FEATURES);
  vi.unstubAllGlobals();
});

describe("the menu of a waypoint pin", () => {
  it("offers Rename, Delete, Hide, Copy position and the points that follow it, and never Add a path to here", () => {
    const items = menu({ kind: "waypoint", waypoint: "scoreSouth" });
    expect(labels(items)).toEqual(["Rename…", "Delete…", "Hide", "Copy position", "Select the points that follow it"]);
    expect(items.map((entry) => entry.shortcut)).toEqual(["F2", "Del", undefined, undefined, undefined]);
    expect(items.every((entry) => entry.enabled)).toBe(true);
    expect(labels(items)).not.toContain("Add a path to here");
  });

  it("hides the pin with Hide and offers Show for a hidden one, never changing waypoints.json (issue #236)", () => {
    const before = getState().project?.waypoints;
    item(menu({ kind: "waypoint", waypoint: "scoreSouth" }), "Hide").run();
    expect(hiddenWaypoints().has("scoreSouth")).toBe(true);
    item(menu({ kind: "waypoint", waypoint: "scoreSouth" }), "Show").run();
    expect(hiddenWaypoints().has("scoreSouth")).toBe(false);
    expect(getState().project?.waypoints).toBe(before);
    expect(getState().undo).toHaveLength(0);
  });

  it("opens the rename and delete questions for the pin, and changes nothing until they are answered", () => {
    const items = menu({ kind: "waypoint", waypoint: "scoreSouth" });
    item(items, "Rename…").run();
    expect(getWaypointQuestion()).toEqual({ kind: "rename", name: "scoreSouth" });
    closeWaypointQuestion();
    item(items, "Delete…").run();
    expect(getWaypointQuestion()).toEqual({ kind: "delete", name: "scoreSouth" });
    expect(getState().project?.waypoints?.waypoints["scoreSouth"]).toBeDefined();
    expect(getState().undo).toHaveLength(0);
  });

  it("greys Rename and Delete out with the reason where waypoints cannot be saved", () => {
    expect(item(menu({ kind: "waypoint", waypoint: "scoreSouth" }), "Rename…").enabled).toBe(true);
    openProject({ ...project(), source: { kind: "host", hostId: "dsim" } }, { kind: "local" } as unknown as ProjectBackend);
    const auto = fixture();
    openAuto("fixture.auto.json", auto, canonicalize("auto", auto));
    const hosted = menu({ kind: "waypoint", waypoint: "scoreSouth" });
    expect(item(hosted, "Rename…").enabled).toBe(false);
    expect(item(hosted, "Delete…").disabledReason).toMatch(/read only/);
  });

  it("copies the pose as the files write it", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    item(menu({ kind: "waypoint", waypoint: "scoreSouth" }), "Copy position").run();
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    expect(writeText).toHaveBeenCalledWith('{"xIn":-13,"yIn":-36,"headingRad":1.5708}');
    expect(getState().status?.message).toContain('{"xIn":-13,"yIn":-36,"headingRad":1.5708}');
  });

  it("says the copy failed, with the pose, when there is no clipboard or it refuses", async () => {
    const pose = '{"xIn":-13,"yIn":-36,"headingRad":1.5708}';
    vi.stubGlobal("navigator", {});
    item(menu({ kind: "waypoint", waypoint: "scoreSouth" }), "Copy position").run();
    await vi.waitFor(() => {
      expect(getState().status?.message).toContain("did not let Zenith copy the position of scoreSouth");
    });
    expect(getState().status?.message).toContain(pose);
    clearStatus();
    const writeText = vi.fn(() => Promise.reject(new Error("denied")));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    item(menu({ kind: "waypoint", waypoint: "scoreSouth" }), "Copy position").run();
    await vi.waitFor(() => {
      expect(getState().status?.message).toContain("did not let Zenith copy the position of scoreSouth");
    });
    expect(getState().status?.message).toContain(pose);
    expect(getState().status?.message).not.toContain("Copied");
    expect(getState().status?.kind).toBe("error");
  });

  it("writes nothing and says so for a name waypoints.json does not have", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await copyWaypointPosition("nowhere");
    expect(writeText).not.toHaveBeenCalled();
    expect(getState().status?.kind).toBe("error");
    expect(getState().status?.message).toBe("waypoints.json has no waypoint named nowhere.");
  });

  it("rounds a pose to four places and names an unknown waypoint as nothing", () => {
    expect(waypointPoseText("scoreSouth")).toBe('{"xIn":-13,"yIn":-36,"headingRad":1.5708}');
    expect(waypointPoseText("nowhere")).toBeNull();
  });

  it("selects the points that follow it, across steps, and says when nothing does", () => {
    const items = menu({ kind: "waypoint", waypoint: "scoreSouth" });
    item(items, "Select the points that follow it").run();
    expect(getState().selection).toEqual({ stepId: "driveOut", point: { segmentIndex: 0, pointKind: "to" } });
    expect(selectFollowersOf("start")).toBe(true);
    expect(getState().selection).toEqual({ stepId: "driveOut", point: { segmentIndex: 0, pointKind: "from" } });

    const park = item(menu({ kind: "waypoint", waypoint: "park" }), "Select the points that follow it");
    expect(park.enabled).toBe(false);
    expect(park.disabledReason).toBe("Nothing in this auto follows park.");
  });
});

describe("the menu of a dot or the start mark that covers a pin", () => {
  it("puts the pin a point follows under a 'Waypoint X' label, with Select, Rename, Hide and Select the points that follow it (issue #412)", () => {
    const items = menu({ kind: "point", stepId: "driveOut", point: { segmentIndex: 0, pointKind: "to" } });
    const at = items.findIndex((entry) => entry.groupLabel === "Waypoint scoreSouth");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(items.slice(at, at + 4).map((entry) => entry.label)).toEqual(["Select", "Rename…", "Hide", "Select the points that follow it"]);
    expect(items.slice(at + 1, at + 4).every((entry) => entry.groupLabel === undefined)).toBe(true);
    expect(labels(items)).not.toContain("Save as waypoint…");
    item(items, "Select").run();
    expect(getState().selection).toEqual({ waypoint: "scoreSouth" });
    item(items, "Rename…").run();
    expect(getWaypointQuestion()).toEqual({ kind: "rename", name: "scoreSouth" });
  });

  it("also offers each other pin the dot covers, once, so a pin nothing follows can be reached", () => {
    const items = menu({
      kind: "point",
      stepId: "driveOut",
      point: { segmentIndex: 0, pointKind: "to" },
      nearWaypoints: ["scoreSouth", "park"],
    });
    // The pin it follows is its group, not a second "Select waypoint scoreSouth".
    expect(labels(items)).not.toContain("Select waypoint scoreSouth");
    expect(items.filter((entry) => entry.groupLabel === "Waypoint scoreSouth")).toHaveLength(1);
    item(items, "Select waypoint park").run();
    expect(getState().selection).toEqual({ waypoint: "park" });
    // The start, which follows start, names a neighbour the same way.
    expect(labels(menu({ kind: "start", nearWaypoints: ["start", "park"] }))).toEqual(expect.arrayContaining(["Select waypoint park"]));
  });

  it("gives the start the same group and keeps the field's items", () => {
    const items = menu({ kind: "start" });
    expect(items[0]?.groupLabel).toBe("Waypoint start");
    expect(labels(items).slice(0, 2)).toEqual(["Select", "Rename…"]);
    expect(labels(items)).toContain("Add a path here");
    item(items, "Select").run();
    expect(getState().selection).toEqual({ waypoint: "start" });
  });

  it("offers Save as waypoint… on a point with a pose of its own, which opens the add dialog", () => {
    const items = menu({ kind: "point", stepId: "leg2", point: { segmentIndex: 0, pointKind: "to" } });
    expect(labels(items)).toContain("Save as waypoint…");
    expect(labels(items).some((label) => label.startsWith("Select waypoint"))).toBe(false);
    item(items, "Save as waypoint…").run();
    expect(getWaypointQuestion()).toEqual({ kind: "add", owner: { stepId: "leg2", point: { segmentIndex: 0, pointKind: "to" } } });
  });

  it("offers neither on a curve's control point", () => {
    const items = menu({ kind: "point", stepId: "leg2", point: { segmentIndex: 0, pointKind: "control", controlIndex: 0 } });
    expect(labels(items).some((label) => /waypoint/i.test(label))).toBe(false);
  });

  it("names no covered pin on a curve's control point either, even with pins near it", () => {
    const items = menu({
      kind: "point",
      stepId: "leg2",
      point: { segmentIndex: 0, pointKind: "control", controlIndex: 0 },
      nearWaypoints: ["park", "start"],
    });
    expect(labels(items).some((label) => /waypoint/i.test(label))).toBe(false);
  });
});

describe("the palette actions and F2", () => {
  it("Rename waypoint and Delete waypoint are on only with a pin selected, and open the dialogs", () => {
    const rename = actionById("waypoint.rename");
    const del = actionById("waypoint.delete");
    if (rename === undefined || del === undefined) throw new Error("the waypoint actions are missing");
    setSelection({});
    expect(isEnabled(rename, getState())).toBe(false);
    expect(isEnabled(del, getState())).toBe(false);
    expect(rename.whyDisabled?.(getState())).toMatch(/pin/);
    setSelection({ waypoint: "scoreSouth" });
    expect(isEnabled(rename, getState())).toBe(true);
    expect(isEnabled(del, getState())).toBe(true);
    void rename.run();
    expect(getWaypointQuestion()).toEqual({ kind: "rename", name: "scoreSouth" });
    expect(isEnabled(rename, getState())).toBe(false);
    expect(rename.whyDisabled?.(getState())).toMatch(/question/);
    closeWaypointQuestion();
    void del.run();
    expect(getWaypointQuestion()).toEqual({ kind: "delete", name: "scoreSouth" });
  });

  it("runs Rename waypoint from F2, and the shortcut sheet adds no row for it", () => {
    const press = { key: "F2", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };
    const rename = actionById("waypoint.rename");
    expect(actionForKey(press)?.id).toBe("waypoint.rename");
    expect(rename === undefined ? undefined : shortcutOf(rename)).toBe("F2");
    expect(rename?.sheetRow).toBe(false);
  });
});

describe("Add waypoint here on the field", () => {
  const snapped = { xIn: 30, yIn: -20, headingRad: 1.2 };

  it("follows Add a path here and opens the add-at question at the snapped spot", () => {
    const items = menu({ kind: "field", snappedIn: snapped });
    const names = labels(items);
    expect(names.indexOf("Add a waypoint here")).toBe(names.indexOf("Add a path here") + 1);
    const here = item(items, "Add a waypoint here");
    expect(here.enabled).toBe(true);
    here.run();
    expect(getWaypointQuestion()).toEqual({ kind: "addAt", pose: snapped });
    expect(getState().undo).toHaveLength(0);
  });

  it("is greyed with the waypoint's name where the spot snaps onto a pin", () => {
    const here = item(menu({ kind: "field", snappedIn: { ...snapped, waypoint: "park" } }), "Add a waypoint here");
    expect(here.enabled).toBe(false);
    expect(here.disabledReason).toBe("Waypoint park is already here.");
  });

  it("is greyed where waypoints cannot be saved", () => {
    openProject({ ...project(), source: { kind: "host", hostId: "dsim" } }, { kind: "local" } as unknown as ProjectBackend);
    const auto = fixture();
    openAuto("fixture.auto.json", auto, canonicalize("auto", auto));
    expect(item(menu({ kind: "field", snappedIn: snapped }), "Add a waypoint here").enabled).toBe(false);
  });

  it("has a palette action that is enabled where waypoints can be saved", () => {
    const action = actionById("waypoint.add");
    expect(action?.label).toBe("Add waypoint");
    expect(action !== undefined && isEnabled(action, getState())).toBe(true);
  });
});

describe("the canvas menus with a switch off", () => {
  const ids = (items: CanvasAction[]): string[] => items.map((entry) => entry.id);
  const spot = { xIn: 30, yIn: -20, headingRad: 1.2 };
  const point = { kind: "point", stepId: "driveOut", point: { segmentIndex: 0, pointKind: "to" } } as const;

  it("leaves out the items of the switch, and only those", () => {
    const field = ids(menu({ kind: "field", snappedIn: spot }));
    expect(field).toContain("field.addWaypointHere");
    expect(field).toContain("field.addClearPathHere");
    expect(ids(menu(point))).toContain("waypoint.followRename");
    const path = ids(menu({ kind: "path", stepId: "driveOut" }));
    expect(path).toContain("edit.wrapSequence");

    setFeatures({ ...ALL_FEATURES, waypoints: false });
    const noWaypoints = ids(menu({ kind: "field", snappedIn: spot }));
    expect(noWaypoints).not.toContain("field.addWaypointHere");
    expect(noWaypoints).toContain("field.addClearPathHere");
    // Renaming is the switch's; selecting the waypoint a point follows is not, and stays.
    const followed = ids(menu(point));
    expect(followed).not.toContain("waypoint.followRename");
    expect(followed).toContain("waypoint.followSelect");

    setFeatures({ ...ALL_FEATURES, optimizer: false });
    expect(ids(menu({ kind: "field", snappedIn: spot }))).not.toContain("field.addClearPathHere");

    setFeatures({ ...ALL_FEATURES, commands: false, groups: false });
    const plain = ids(menu({ kind: "path", stepId: "driveOut" }));
    expect(plain).not.toContain("edit.wrapSequence");
    expect(plain).not.toContain("edit.wrapParallel");
    expect(plain).toContain("edit.duplicate");
  });
});

describe("the palette's armed Add waypoint", () => {
  it("disarms when another tool is picked, so the next click measures rather than asking for a name", () => {
    armWaypointPlacement();
    expect(getUi().placingWaypoint).toBe(true);
    setTool("measure");
    expect(getUi().placingWaypoint).toBe(false);
  });

  it("disarms when review mode turns waypoint editing off", () => {
    armWaypointPlacement();
    setReview({} as Parameters<typeof setReview>[0]);
    expect(getUi().placingWaypoint).toBe(false);
  });

  it("disarms when another auto opens", () => {
    armWaypointPlacement();
    const auto = fixture();
    openAuto("other.auto.json", auto, canonicalize("auto", auto));
    expect(getUi().placingWaypoint).toBe(false);
  });

  it("stays armed through a selection change, and says why a click with no spot places nothing", () => {
    armWaypointPlacement();
    setSelection({ stepId: "leg2" });
    expect(getUi().placingWaypoint).toBe(true);
    askAddWaypointAt(undefined);
    expect(getState().status?.message).toBe("There is no spot on the field here.");
    expect(getWaypointQuestion()).toBeNull();
    expect(getUi().placingWaypoint).toBe(true);
  });
});
