/**
 * Issue #245: the Inspector's one compact Waypoints list. Each row edits its waypoint's x, y and
 * heading in place, through `writeWaypointNumbers`, so a typed number keeps the label the waypoint
 * had, except on a MEASURED or CALIBRATED FROM ROBOT one, which it relabels SET FROM EDITOR and warns
 * about (decision measured-typed, option b, issue #273). The header counts the waypoints and the hidden pins, the
 * selected row's one "Used by" line is short and its hint holds the full lists, and the row's ⋯ menu
 * has exactly the items a right-click on the pin has.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, loadAuto, loadField, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canvasActions, pinMenuItems } from "../app/canvasMenu";
import { CANVAS_ZOOM_EVENT, type CanvasZoom } from "../canvas/zoomRequest";
import type { Impact } from "../app/waypointImpact";
import type { ProjectBackend } from "../project/backend";
import type { Project } from "../project/types";
import { writeWaypointProvenance } from "../app/waypointEdits";
import { clearStatus, getState, openAuto, openProject, setPrefs, undo } from "../state/store";
import { pinsHint, rowValues, splitName, usedByLine, waypointsTitle, writeRowNumber } from "./waypointList";

const starter = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${starter}${relative}`, "utf8"));

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

const waypoint = (name: string) => getState().project?.waypoints?.waypoints[name];

beforeEach(() => {
  setPrefs({ waypointPins: "all", waypointPinOverrides: {} });
  openProject(example(), { kind: "local" } as unknown as ProjectBackend);
  const auto = loadAuto(read("autos/collect-and-score.auto.json"));
  openAuto("collect-and-score.auto.json", auto, canonicalize("auto", auto));
});

describe("a row's numbers", () => {
  it("move park when x = -30 is typed in its row, and keep its PLACEHOLDER label", () => {
    const before = waypoint("park");
    expect(before?.provenance).toMatch(/^PLACEHOLDER/);
    const undoBefore = getState().undo.length;
    writeRowNumber("park", "x", -30);
    expect(waypoint("park")).toMatchObject({ xIn: -30, yIn: before?.yIn, headingRad: before?.headingRad, provenance: before?.provenance });
    expect(getState().undo.length).toBe(undoBefore + 1);
    undo();
    expect(waypoint("park")?.xIn).toBe(before?.xIn);
  });

  it("take the heading in degrees and write it in radians", () => {
    writeRowNumber("park", "h", 90);
    expect(waypoint("park")?.headingRad).toBeCloseTo(Math.PI / 2, 9);
    writeRowNumber("park", "y", -20);
    expect(waypoint("park")?.yIn).toBe(-20);
  });

  it("show the heading in degrees", () => {
    expect(rowValues({ xIn: -12, yIn: -36, headingRad: Math.PI / 2 })).toEqual({ x: -12, y: -36, h: 90 });
  });
});

/**
 * Owner ruling 2026-10-10 (issue #273), measured-typed (b): a number typed in a row of a MEASURED or
 * CALIBRATED FROM ROBOT waypoint warns and relabels it SET FROM EDITOR; the chip sets it back.
 */
describe("a row's number typed on a measured waypoint", () => {
  it("warns, relabels it SET FROM EDITOR, and is one undo step that brings MEASURED back", () => {
    writeWaypointProvenance("scoreSouth", "MEASURED: tape, 2026-09-30");
    const before = waypoint("scoreSouth");
    const undoBefore = getState().undo.length;
    expect(writeRowNumber("scoreSouth", "x", -30)).toBe("MEASURED");

    expect(waypoint("scoreSouth")).toMatchObject({ xIn: -30, yIn: before?.yIn, headingRad: before?.headingRad, provenance: "SET FROM EDITOR" });
    expect(getState().undo.length).toBe(undoBefore + 1);
    expect(getState().status).toMatchObject({ kind: "warn" });
    expect(getState().status?.message).toContain("This changes MEASURED to SET FROM EDITOR on waypoint scoreSouth.");

    undo();
    expect(waypoint("scoreSouth")).toMatchObject({ xIn: before?.xIn, provenance: "MEASURED: tape, 2026-09-30" });
  });

  it("is relabelled by a typed y and a typed heading too, and CALIBRATED FROM ROBOT is treated as MEASURED is", () => {
    writeWaypointProvenance("park", "CALIBRATED FROM ROBOT");
    expect(writeRowNumber("park", "h", 90)).toBe("CALIBRATED FROM ROBOT");
    expect(waypoint("park")?.provenance).toBe("SET FROM EDITOR");
    expect(getState().status?.message).toContain("This changes CALIBRATED FROM ROBOT to SET FROM EDITOR on waypoint park.");

    writeWaypointProvenance("start", "MEASURED");
    expect(writeRowNumber("start", "y", -60)).toBe("MEASURED");
    expect(waypoint("start")?.provenance).toBe("SET FROM EDITOR");
  });

  it("goes back to MEASURED in one step from the chip, keeping the typed number, and then warns again", () => {
    writeWaypointProvenance("scoreSouth", "MEASURED");
    writeRowNumber("scoreSouth", "x", -30);
    const undoBefore = getState().undo.length;
    writeWaypointProvenance("scoreSouth", "MEASURED");
    expect(waypoint("scoreSouth")).toMatchObject({ xIn: -30, provenance: "MEASURED" });
    expect(getState().undo.length).toBe(undoBefore + 1);
    expect(writeRowNumber("scoreSouth", "x", -29)).toBe("MEASURED");
  });

  it("says nothing for a number typed on any other label, which is kept", () => {
    clearStatus();
    expect(writeRowNumber("park", "x", -30)).toBeNull();
    expect(waypoint("park")?.provenance).toMatch(/^PLACEHOLDER/);
    expect(getState().status).toBeNull();
    writeWaypointProvenance("park", "SET BY HAND: chosen");
    expect(writeRowNumber("park", "y", -20)).toBeNull();
    expect(waypoint("park")?.provenance).toBe("SET BY HAND: chosen");
  });
});

describe("the list's header", () => {
  it("counts the waypoints once, and never says hidden", () => {
    expect(waypointsTitle(11)).toBe("Waypoints (11)");
    expect(waypointsTitle(0)).toBe("Waypoints (0)");
  });

  it("says how many pins are hidden only in the Pins row's hint", () => {
    expect(pinsHint(0, 9)).toContain("No pins are hidden now.");
    expect(pinsHint(2, 9)).toContain("2 of 9 pins are hidden now.");
    expect(pinsHint(1, 1)).toContain("1 of 1 pin is hidden now.");
  });
});

describe("a long name cut short in the middle", () => {
  it("keeps the last word as the tail, so flowerNorthApproach and flowerNorthPickup stay apart", () => {
    expect(splitName("flowerNorthApproach")).toEqual({ head: "flowerNorth", tail: "Approach" });
    expect(splitName("flowerNorthPickup")).toEqual({ head: "flowerNorth", tail: "Pickup" });
  });

  it("keeps the last six characters of a long name with no word boundary, and a short name whole", () => {
    expect(splitName("averylongnamewithnocase")).toEqual({ head: "averylongnamewith", tail: "nocase" });
    expect(splitName("scoreNorth")).toEqual({ head: "scoreNorth", tail: "" });
    for (const name of ["flowerNorthApproach", "park", "averylongnamewithnocase", "a_long_waypoint_name"]) {
      const { head, tail } = splitName(name);
      expect(head + tail).toBe(name);
    }
  });
});

const impact = (followers: Array<{ name: string; newErrors?: number }>, unreadable: string[] = []): Impact => ({
  followers: followers.map((row) => ({ file: `${row.name}.auto.json`, name: row.name, newErrors: row.newErrors ?? null, errorsNow: null })),
  unreadable,
  unchecked: [],
});

describe("the selected row's Used by line", () => {
  it("names one point and counts the other autos, and its hint has the full lists", () => {
    const line = usedByLine(["point 1 of driveOut"], impact([{ name: "all-step-kinds" }, { name: "cycle-and-park" }, { name: "first-auto" }]));
    expect(line.here).toBe("point 1 of driveOut");
    expect(line.others).toBe("3 other autos");
    expect(line.hint).toBe("In this auto: point 1 of driveOut. In other autos: all-step-kinds, cycle-and-park and first-auto.");
  });

  it("counts several points, says when nothing follows it, and is still checking before the other autos are read", () => {
    expect(usedByLine(["the start", "the first point of driveOut"], null)).toEqual({
      here: "2 points here",
      others: "checking…",
      hint: "In this auto: the start and the first point of driveOut. In other autos: checking…",
    });
    const none = usedByLine([], impact([]));
    expect(none.here).toBe("nothing here");
    expect(none.others).toBe("no other auto");
    expect(none.hint).toBe("In this auto: nothing follows it. In other autos: no other auto follows it.");
  });

  it("adds the new errors an unsaved move gives the other autos", () => {
    const line = usedByLine([], impact([{ name: "collect-and-score" }, { name: "cycle-and-park", newErrors: 1 }]));
    expect(line.others).toBe("2 other autos, 1 new error");
    expect(line.hint).toContain("cycle-and-park (1 new error) and collect-and-score");
  });
});

describe("the row's ⋯ menu", () => {
  it("has the items a right-click on the pin has, in the same order, then the two zooms", () => {
    const pose = waypoint("park");
    if (pose === undefined) throw new Error("no park");
    const right = canvasActions({ kind: "waypoint", waypoint: "park", atIn: { xIn: pose.xIn, yIn: pose.yIn } });
    const menu = pinMenuItems("park");
    expect(menu.map((item) => item.label)).toEqual([...right.map((item) => item.label), "Zoom to it", "Zoom to fit"]);
    expect(menu.map((item) => item.id).slice(0, right.length)).toEqual(right.map((item) => item.id));
    expect(menu.map((item) => item.enabled).slice(0, right.length)).toEqual(right.map((item) => item.enabled));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks the canvas for the zoom each zoom item names", () => {
    const asked: CanvasZoom[] = [];
    const events = new EventTarget();
    events.addEventListener(CANVAS_ZOOM_EVENT, (event) => {
      asked.push((event as CustomEvent<CanvasZoom>).detail);
    });
    vi.stubGlobal("window", events);
    const menu = pinMenuItems("park");
    const zoom = (label: string): void => {
      const found = menu.find((item) => item.label === label);
      if (found === undefined) throw new Error(`no ${label}`);
      found.run();
    };
    zoom("Zoom to it");
    expect(asked).toEqual(["selection"]);
    zoom("Zoom to fit");
    expect(asked).toEqual(["selection", "fit"]);
  });
});
