/**
 * Issue #412: the field's right-click menus show only what applies to what was right-clicked. The
 * canvas asks `canvasActions` for the shell's items and adds its own few (Split path here and Split
 * heading here on a path, Make smooth or Make corner on a curve point), so these tests ask it for
 * each kind of target on the starter example and count what the canvas adds by hand.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, loadAuto, loadField, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectBackend } from "../project/backend";
import type { Project } from "../project/types";
import type { CanvasAction, CanvasMenuTarget } from "../canvas/types";
import { CLEAR_PATH_LABEL } from "../optimize/clearPath";
import { ALL_FEATURES, NO_FEATURES, setFeatures } from "../state/features";
import { getState, openAuto, openProject, setHost, setPrefs, setSelection } from "../state/store";
import { canvasActions } from "./canvasMenu";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

const project = (): Project => ({
  source: { kind: "example" },
  name: "canvas-menu-fixture",
  link: { autosDir: "autos", robot: "autos/robot.json", field: "autos/field.json", waypoints: "autos/waypoints.json" } as Project["link"],
  robot: loadRobot(read("robot.json")),
  field: loadField(read("field/biobuzz.field.json")),
  waypoints: loadWaypoints(read("waypoints.json")),
  autoFiles: ["collect-and-score.auto.json"],
  autoTexts: {},
});

const at = { xIn: 0, yIn: 0 };
const menu = (target: Omit<CanvasMenuTarget, "atIn">): CanvasAction[] => canvasActions({ ...target, atIn: at });
const labels = (items: CanvasAction[]): string[] => items.map((item) => item.label);
const ids = (items: CanvasAction[]): string[] => items.map((item) => item.id);

/** What the canvas adds to a path's menu: Split path here and Split heading here. */
const CANVAS_PATH_ROWS = 2;

beforeEach(() => {
  setFeatures(ALL_FEATURES);
  setHost(null);
  setPrefs({ waypointPins: "used", waypointPinOverrides: {} });
  openProject(project(), { kind: "local" } as unknown as ProjectBackend);
  const auto = loadAuto(read("collect-and-score.auto.json"));
  openAuto("collect-and-score.auto.json", auto, canonicalize("auto", auto));
});

afterEach(() => {
  setFeatures(NO_FEATURES);
});

describe("the path menu", () => {
  it("has at most 11 rows with the canvas's own, and no tool, zoom or Optimize rows", () => {
    setSelection({ stepId: "driveOut" });
    const items = menu({ kind: "path", stepId: "driveOut", t: 0.5 });
    expect(items.length + CANVAS_PATH_ROWS).toBeLessThanOrEqual(11);
    expect(ids(items)).not.toContain("tool.marker");
    expect(ids(items)).not.toContain("path.optimize");
    expect(ids(items).some((id) => id.startsWith("canvas."))).toBe(false);
    expect(items.map((item) => item.shortcut ?? "")).not.toContain("Double-click");
  });

  it("offers Make curve on a straight line and Make straight line on a curve, never both", () => {
    setSelection({ stepId: "driveOut" });
    const line = labels(menu({ kind: "path", stepId: "driveOut", t: 0.5 }));
    expect(line).toContain("Make curve");
    expect(line).not.toContain("Make straight line");
    setSelection({ stepId: "toOtherSide" });
    const curve = labels(menu({ kind: "path", stepId: "toOtherSide", t: 0.5 }));
    expect(curve).toContain("Make straight line");
    expect(curve).not.toContain("Make curve");
  });

  it("offers Unwrap group only on a path inside a group, and it unwraps that group", () => {
    setSelection({ stepId: "driveOut" });
    expect(labels(menu({ kind: "path", stepId: "driveOut", t: 0.5 }))).not.toContain("Unwrap group");
    setSelection({ stepId: "driveBack" });
    const inGroup = menu({ kind: "path", stepId: "driveBack", t: 0.5 });
    const unwrap = inGroup.find((item) => item.label === "Unwrap group");
    expect(unwrap?.enabled).toBe(true);
    expect(inGroup.length + CANVAS_PATH_ROWS).toBeLessThanOrEqual(11);
    unwrap?.run();
    expect(getState().auto?.steps.some((step) => step.id === "returnToScore")).toBe(false);
    expect(getState().auto?.steps.some((step) => step.id === "driveBack")).toBe(true);
  });

  it("shows Del only on the item Del runs", () => {
    setSelection({ stepId: "driveOut" });
    const items = menu({ kind: "path", stepId: "driveOut", t: 0.5 });
    expect(items.filter((item) => item.shortcut === "Del").map((item) => item.label)).toEqual(["Delete step"]);
  });
});

describe("the empty field's menu", () => {
  const spot = { xIn: 30, yIn: -20, headingRad: 1.2 };

  it("starts with the three adds, the clear path's label imported, and has no tool items", () => {
    const items = menu({ kind: "field", snappedIn: spot });
    expect(labels(items).slice(0, 3)).toEqual(["Add a path here", "Add a waypoint here", CLEAR_PATH_LABEL]);
    expect(ids(items)).not.toContain("tool.addPath");
    expect(ids(items)).not.toContain("tool.measure");
    expect(ids(items)).not.toContain("view.snap");
  });

  it("leaves out Field view and Field style on a field with no picture", () => {
    const items = menu({ kind: "field", snappedIn: spot });
    expect(ids(items)).not.toContain("view.fieldView");
    expect(ids(items)).not.toContain("view.fieldStyle");
  });

  it("offers the pins as All, This auto's and None under a Show waypoint pins label, with a check on the current one", () => {
    const items = menu({ kind: "field", snappedIn: spot });
    const pins = items.filter((item) => item.id.startsWith("pins."));
    expect(labels(pins)).toEqual(["All", "This auto's", "None"]);
    expect(pins[0]?.groupLabel).toBe("Show waypoint pins");
    expect(pins.map((item) => item.checked)).toEqual([false, true, false]);
    pins[2]?.run();
    expect(getState().prefs.waypointPins).toBe("none");
    expect(menu({ kind: "field", snappedIn: spot }).filter((item) => item.checked === true).map((item) => item.label)).toEqual(["None"]);
  });
});

describe("a curve's control point menu", () => {
  it("offers only Delete point from the shell; the canvas adds Make smooth or Make corner", () => {
    setSelection({ stepId: "toOtherSide", point: { segmentIndex: 0, pointKind: "control", controlIndex: 0 } });
    const items = menu({ kind: "point", stepId: "toOtherSide", point: { segmentIndex: 0, pointKind: "control", controlIndex: 0 } });
    expect(labels(items)).toEqual(["Delete point"]);
  });
});

describe("a greyed item", () => {
  it("carries its reason, which the menu shows in the row", () => {
    // driveOut has one segment, so its end cannot go alone: Delete point stays, greyed, with why.
    setSelection({ stepId: "driveOut", point: { segmentIndex: 0, pointKind: "to" } });
    const items = menu({ kind: "point", stepId: "driveOut", point: { segmentIndex: 0, pointKind: "to" } });
    const del = items.find((item) => item.label === "Delete point");
    expect(del?.enabled).toBe(false);
    expect((del?.disabledReason ?? "").length).toBeGreaterThan(5);
  });
});
