/**
 * Issue #148: Escape during a canvas drag, or a pointer the browser cancels, cancels the drag.
 * `cancelTransaction` puts back what the drag changed since `beginTransaction`: the auto, the
 * project's waypoints and the redo stack the drag's commits emptied. It pushes no undo entry and
 * sends the tour no signal, since nothing was dragged. `endTransaction({ tourSignal: false })` closes
 * a transaction that is not a drag on the field (a number field's scrub), which the tour's "drag one
 * of the dots" stop must not count.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, loadAuto, loadField, loadRobot, loadWaypoints, setPose } from "@horizon36596/zenith-core";
import { SCHEMA_ID, type Auto, type Waypoints } from "@horizon36596/zenith-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectBackend } from "../project/backend";
import type { Project } from "../project/types";
import type { TourSignal } from "../tour/model";
import { setTourSink } from "../tour/signals";
import {
  beginTransaction,
  cancelTransaction,
  commit,
  commitWithWaypoints,
  endTransaction,
  getState,
  openAuto,
  openProject,
  redo,
  undo,
} from "./store";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

const project = (): Project => ({
  source: { kind: "example" },
  name: "cancel-fixture",
  link: { autosDir: "autos", robot: "autos/robot.json", field: "autos/field.json", waypoints: "autos/waypoints.json" } as Project["link"],
  robot: loadRobot(read("robot.json")),
  field: loadField(read("field/biobuzz.field.json")),
  waypoints: loadWaypoints(read("waypoints.json")),
  autoFiles: ["fixture.auto.json"],
  autoTexts: {},
});

// driveOut ends on the waypoint scoreSouth, (-12, -36), as in the starter autos.
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
    ],
  });

const signals: TourSignal[] = [];

beforeEach(() => {
  openProject(project(), { kind: "local" } as ProjectBackend);
  const auto = fixture();
  openAuto("fixture.auto.json", auto, canonicalize("auto", auto));
  signals.length = 0;
  setTourSink((signal) => {
    signals.push(signal);
  });
});

afterEach(() => {
  setTourSink(() => undefined);
});

/** One drag frame that gives driveOut's end a pose of its own, as `writePose` would. */
const dragEndTo = (xIn: number, yIn: number): void => {
  const current = getState().auto;
  if (current === null) throw new Error("expected an open auto");
  commit(setPose(current, "driveOut", { segmentIndex: 0, pointKind: "to", controlIndex: 0 }, { xIn, yIn, headingRad: 0 }));
};

/** One drag frame of a waypoint pin, as `moveWaypoint` would. */
const dragWaypointTo = (name: string, xIn: number): void => {
  const state = getState();
  const waypoints = state.project?.waypoints;
  const auto = state.auto;
  if (waypoints === undefined || auto === null) throw new Error("expected waypoints and an open auto");
  const moved = waypoints.waypoints[name];
  if (moved === undefined) throw new Error(`no waypoint ${name}`);
  const next: Waypoints = { ...waypoints, waypoints: { ...waypoints.waypoints, [name]: { ...moved, xIn } } };
  commitWithWaypoints(auto, next);
};

const driveOutTo = (): unknown => {
  const step = getState().auto?.steps.find((candidate) => candidate.id === "driveOut");
  return step?.kind === "path" ? step.segments[0]?.to : undefined;
};

describe("cancelTransaction", () => {
  it("puts back the auto and the waypoints as the drag found them, with no undo entry", () => {
    const auto = getState().auto;
    const waypoints = getState().project?.waypoints;
    beginTransaction();
    for (const xIn of [-6, 0, 6, 20]) dragEndTo(xIn, -20);
    for (const xIn of [-14, -20]) dragWaypointTo("start", xIn);
    expect(driveOutTo()).toMatchObject({ xIn: 20, yIn: -20 });
    expect(getState().project?.waypoints?.waypoints["start"]?.xIn).toBe(-20);

    cancelTransaction();
    expect(driveOutTo()).toEqual({ ref: "scoreSouth" });
    expect(canonicalize("auto", getState().auto)).toBe(canonicalize("auto", auto));
    expect(getState().auto).toBe(auto);
    expect(getState().project?.waypoints).toBe(waypoints);
    expect(getState().undo).toHaveLength(0);
    expect(signals).toEqual([]);
  });

  it("keeps the redo stack the drag's frames emptied", () => {
    dragEndTo(10, -30);
    undo();
    expect(getState().redo).toHaveLength(1);
    const redoStack = getState().redo;

    beginTransaction();
    dragEndTo(20, -20);
    expect(getState().redo).toHaveLength(0);
    cancelTransaction();

    expect(getState().redo).toBe(redoStack);
    expect(getState().undo).toHaveLength(0);
    redo();
    expect(driveOutTo()).toMatchObject({ xIn: 10, yIn: -30 });
  });

  it("closes the transaction, so the next edit is an undo step of its own", () => {
    beginTransaction();
    dragEndTo(20, -20);
    cancelTransaction();
    dragEndTo(5, -30);
    expect(getState().undo).toHaveLength(1);
    undo();
    expect(driveOutTo()).toEqual({ ref: "scoreSouth" });
  });

  it("does nothing with no transaction open", () => {
    dragEndTo(10, -30);
    const before = getState();
    cancelTransaction();
    expect(getState()).toBe(before);
  });
});

describe("endTransaction's tour signal", () => {
  it("tells the tour a point was dragged when the transaction changed something", () => {
    beginTransaction();
    dragEndTo(20, -20);
    endTransaction();
    expect(signals).toEqual(["pointDragged"]);
    expect(getState().undo).toHaveLength(1);
  });

  it("keeps the redo stack when the drag ends where it began (issue #401)", () => {
    dragEndTo(10, -30);
    undo();
    const redoStack = getState().redo;
    expect(redoStack).toHaveLength(1);
    const start = getState().auto;
    if (start === null) throw new Error("expected an open auto");

    beginTransaction();
    dragEndTo(20, -20);
    commit(start);
    endTransaction();

    expect(getState().undo).toHaveLength(0);
    expect(getState().redo).toBe(redoStack);
    redo();
    expect(driveOutTo()).toMatchObject({ xIn: 10, yIn: -30 });
  });

  it("sends nothing with tourSignal false, and still pushes the one undo entry", () => {
    beginTransaction();
    dragEndTo(20, -20);
    endTransaction({ tourSignal: false });
    expect(signals).toEqual([]);
    expect(getState().undo).toHaveLength(1);
  });
});
