/**
 * Issue #133: a point that follows a waypoint is unlinked when it is moved. Dragging, turning or
 * nudging the routine's start when it follows a waypoint makes it a pose of its own where it is
 * dropped, and so does "Move the start to the nearest legal spot". A path's first point that sits on
 * the start goes with it, so the route stays joined. A path point that followed a waypoint is
 * unlinked the same way when it is dragged or nudged. Each time the status line says what no longer
 * follows which waypoint, once per gesture, and one undo links it again.
 *
 * In the inspector, for the start and for either end of a segment alike, "this pose" keeps the pose
 * the point stands at, with the waypoint's provenance when it followed one, and "a waypoint" picks
 * the waypoint at the point's spot, or the nearest one.
 *
 * Issue #150: the other way round, a path end that snaps onto a waypoint, by a drag or by an
 * Add path click, follows it, and the status line says so. An end that already followed it keeps
 * following it, and a Bezier handle, which cannot follow a waypoint, keeps the waypoint's provenance.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, EDITOR_PROVENANCE, loadAuto, loadField, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import { SCHEMA_ID, type Auto, type PathStep, type PoseSource } from "@horizon36596/zenith-schema";
import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectBackend } from "../project/backend";
import type { Project } from "../project/types";
import {
  beginTransaction,
  clearStatus,
  endTransaction,
  getState,
  openAuto,
  openProject,
  setSelection,
  undo,
} from "../state/store";
import {
  addPathStepTo,
  followNearestWaypoint,
  movePoint,
  moveStartToLegal,
  pathPointsOnStart,
  rotateHeading,
  writeOwnPose,
  writePoses,
  writeStartPose,
} from "./edits";
import { NUDGE_IN } from "./shortcuts";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));
const waypointsFile = read("waypoints.json") as { waypoints: Record<string, { provenance?: string }> };

const project: Project = {
  source: { kind: "example" },
  name: "unlink-fixture",
  link: { autosDir: "autos", robot: "robot.json", field: "field.json" } as Project["link"],
  robot: loadRobot(read("robot.json")),
  field: loadField(read("field/biobuzz.field.json")),
  waypoints: loadWaypoints(read("waypoints.json")),
  autoFiles: [],
  autoTexts: {},
};

// In the starter's waypoints.json, start is (-13, -63) facing 1.5708 rad and scoreSouth is
// (-13, -36) facing 1.5708 rad. Like the starter autos, the routine starts at the start waypoint and
// its first path is written from that same waypoint.
const fixture = (start: Auto["start"]["pose"] = { ref: "start" }): Auto =>
  loadAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "unlink-fixture",
    title: "Unlink fixture",
    alliance: "RED",
    start: { pose: start },
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
        segments: [{ kind: "line", from: "current", to: { xIn: 0, yIn: -36, headingRad: 0 } }],
        heading: { mode: "tangent" },
      },
    ],
  });

const open = (start?: Auto["start"]["pose"], withProject: Project = project): void => {
  openProject(withProject, { kind: "local" } as unknown as ProjectBackend);
  const auto = fixture(start);
  openAuto("unlink-fixture.auto.json", auto, canonicalize("auto", auto));
  clearStatus();
};

const startPose = () => getState().auto?.start.pose;
const driveOut = (): PathStep => {
  const step = getState().auto?.steps.find((candidate) => candidate.id === "driveOut");
  if (step?.kind !== "path") throw new Error("no driveOut");
  return step;
};
const firstPoint = (): PoseSource | undefined => driveOut().segments[0]?.from;
const status = () => getState().status;

const FIRST_POINT = { stepId: "driveOut", point: { segmentIndex: 0, pointKind: "from" as const } };

describe("dragging a start that follows a waypoint", () => {
  beforeEach(() => {
    open();
  });

  it("makes it a pose of its own where it is dropped, says so once, and one undo links it again", () => {
    const undoBefore = getState().undo.length;
    beginTransaction();
    writeStartPose({ xIn: -24, yIn: -63 }, {}, []);
    expect(status()).toMatchObject({ kind: "info", message: "The start no longer follows waypoint start. Undo links it again." });
    clearStatus();
    writeStartPose({ xIn: -30, yIn: -63 }, {}, []);
    endTransaction();

    // The second frame moves a pose of its own: the status line does not repeat.
    expect(status()).toBeNull();
    expect(startPose()).toEqual({ xIn: -30, yIn: -63, headingRad: 1.5708, provenance: EDITOR_PROVENANCE });
    expect(getState().undo.length).toBe(undoBefore + 1);
    undo();
    expect(startPose()).toEqual({ ref: "start" });
  });

  it("carries the path that starts on it, so the route stays joined, and names both", () => {
    expect(pathPointsOnStart()).toEqual([FIRST_POINT]);
    beginTransaction();
    for (const xIn of [-20, -26, -30]) writeStartPose({ xIn, yIn: -63 }, {}, [FIRST_POINT]);
    endTransaction();

    expect(startPose()).toEqual({ xIn: -30, yIn: -63, headingRad: 1.5708, provenance: EDITOR_PROVENANCE });
    expect(firstPoint()).toEqual({ xIn: -30, yIn: -63, headingRad: 1.5708, provenance: EDITOR_PROVENANCE });
    expect(driveOut().segments[0]?.to).toEqual({ ref: "scoreSouth" });
    expect(status()?.message).toBe(
      "The start and the first point of driveOut no longer follow waypoint start. Undo links them again.",
    );
    undo();
    expect(startPose()).toEqual({ ref: "start" });
    expect(firstPoint()).toEqual({ ref: "start" });
  });

  it("turns it at the waypoint's spot, leaving the path's first point where it is", () => {
    writeStartPose({ headingRad: 0 });
    expect(startPose()).toEqual({ xIn: -13, yIn: -63, headingRad: 0, provenance: EDITOR_PROVENANCE });
    expect(firstPoint()).toEqual({ ref: "start" });
    expect(status()?.message).toBe("The start no longer follows waypoint start. Undo links it again.");
    undo();
    expect(startPose()).toEqual({ ref: "start" });
  });
});

describe("the keys on a selected start that follows a waypoint", () => {
  beforeEach(() => {
    open();
    setSelection({ start: true });
  });

  it("nudges it off the waypoint, with the path that starts on it, as one undo step", () => {
    const undoBefore = getState().undo.length;
    movePoint(NUDGE_IN, 0);
    expect(startPose()).toEqual({ xIn: -13 + NUDGE_IN, yIn: -63, headingRad: 1.5708, provenance: EDITOR_PROVENANCE });
    expect(firstPoint()).toMatchObject({ xIn: -13 + NUDGE_IN, yIn: -63 });
    expect(status()?.message).toMatch(/^The start and the first point of driveOut no longer follow waypoint start\./);
    expect(getState().undo.length).toBe(undoBefore + 1);
    undo();
    expect(startPose()).toEqual({ ref: "start" });
    expect(firstPoint()).toEqual({ ref: "start" });
  });

  it("turns it off the waypoint", () => {
    rotateHeading(1);
    const pose = startPose();
    expect(pose).toMatchObject({ xIn: -13, yIn: -63, provenance: EDITOR_PROVENANCE });
    expect(pose !== undefined && "headingRad" in pose && (pose.headingRad ?? 0) > 1.5708).toBe(true);
    expect(status()?.message).toBe("The start no longer follows waypoint start. Undo links it again.");
    undo();
    expect(startPose()).toEqual({ ref: "start" });
  });
});

describe("moving a start that follows a waypoint to the nearest legal spot", () => {
  it("unlinks it, says so with where it went, and one undo links it again", () => {
    open({ ref: "scoreSouth" });
    moveStartToLegal();
    const pose = startPose();
    if (pose === undefined || "ref" in pose) throw new Error("the start still follows a waypoint");
    expect(pose.provenance).toMatch(/^SET FROM EDITOR: the nearest legal start Zenith found/);
    expect(status()?.message).toMatch(/^Moved the start to the nearest legal spot, touching the wall at /);
    expect(status()?.message).toMatch(/The start no longer follows waypoint scoreSouth\. Undo links it again\.$/);
    undo();
    expect(startPose()).toEqual({ ref: "scoreSouth" });
  });
});

describe("dragging a path point that follows a waypoint", () => {
  beforeEach(() => {
    open();
  });

  it("says once per drag that the point no longer follows the waypoint, and one undo links it again", () => {
    const to = { segmentIndex: 0, pointKind: "to" as const };
    beginTransaction();
    writePoses([{ stepId: "driveOut", target: to, pose: { xIn: -10, yIn: -34, headingRad: 1.5708 } }]);
    expect(status()).toMatchObject({
      kind: "info",
      message: "Point 1 of driveOut no longer follows waypoint scoreSouth. Undo links it again.",
    });
    clearStatus();
    writePoses([{ stepId: "driveOut", target: to, pose: { xIn: -6, yIn: -30, headingRad: 1.5708 } }]);
    endTransaction();

    expect(status()).toBeNull();
    expect(driveOut().segments[0]?.to).toEqual({ xIn: -6, yIn: -30, headingRad: 1.5708, provenance: EDITOR_PROVENANCE });
    undo();
    expect(driveOut().segments[0]?.to).toEqual({ ref: "scoreSouth" });
  });

  it("names every point a group drag unlinks, and each waypoint", () => {
    writePoses([
      { stepId: "driveOut", target: { segmentIndex: 0, pointKind: "from" }, pose: { xIn: -14, yIn: -63, headingRad: 1.5708 } },
      { stepId: "driveOut", target: { segmentIndex: 0, pointKind: "to" }, pose: { xIn: -14, yIn: -36, headingRad: 1.5708 } },
    ]);
    expect(status()?.message).toBe(
      "The first point of driveOut and point 1 of driveOut no longer follow waypoints start and scoreSouth. Undo links them again.",
    );
  });

  it("says so when the point is nudged off its waypoint", () => {
    setSelection({ stepId: "driveOut", point: { segmentIndex: 0, pointKind: "to" } });
    movePoint(NUDGE_IN, 0);
    expect(driveOut().segments[0]?.to).toMatchObject({ xIn: -13 + NUDGE_IN, yIn: -36 });
    expect(status()?.message).toBe("Point 1 of driveOut no longer follows waypoint scoreSouth. Undo links it again.");
  });
});

describe("the arrow keys on a step with no point picked (issue #161)", () => {
  const leg2To = (): PoseSource | undefined => {
    const step = getState().auto?.steps.find((candidate) => candidate.id === "leg2");
    return step?.kind === "path" ? step.segments[0]?.to : undefined;
  };

  beforeEach(() => {
    open();
  });

  it("leaves an end that follows a waypoint alone, writes no history and says how to move it", () => {
    setSelection({ stepId: "driveOut" });
    const undoBefore = getState().undo.length;
    movePoint(NUDGE_IN, 0);
    expect(driveOut().segments[0]?.to).toEqual({ ref: "scoreSouth" });
    expect(getState().undo.length).toBe(undoBefore);
    expect(status()).toMatchObject({
      kind: "info",
      message: "Select the waypoint to move it, or click the end on the field to give it its own pose.",
    });
  });

  it("leaves an end that is \"current\" alone", () => {
    const withCurrent = loadAuto({
      ...(JSON.parse(canonicalize("auto", fixture())) as object),
      steps: [
        {
          id: "driveOut",
          kind: "path",
          segments: [{ kind: "line", from: { ref: "start" }, to: "current" }],
          heading: { mode: "tangent" },
        },
      ],
    });
    openAuto("unlink-fixture.auto.json", withCurrent, canonicalize("auto", withCurrent));
    clearStatus();
    setSelection({ stepId: "driveOut" });
    movePoint(NUDGE_IN, 0);
    expect(driveOut().segments[0]?.to).toBe("current");
    expect(status()?.message).toMatch(/^Select the waypoint to move it/);
  });

  it("still moves an end that has a pose of its own", () => {
    setSelection({ stepId: "leg2" });
    movePoint(NUDGE_IN, 0);
    expect(leg2To()).toMatchObject({ xIn: NUDGE_IN, yIn: -36 });
  });

  it("does unlink an end that was picked on the field, and a held key is one undo step", () => {
    setSelection({ stepId: "driveOut", point: { segmentIndex: 0, pointKind: "to" } });
    const undoBefore = getState().undo.length;
    movePoint(NUDGE_IN, 0, { history: true });
    for (let repeat = 0; repeat < 30; repeat += 1) movePoint(NUDGE_IN, 0, { history: false });
    expect(driveOut().segments[0]?.to).toMatchObject({ xIn: -13 + 31 * NUDGE_IN, yIn: -36 });
    expect(getState().undo.length).toBe(undoBefore + 1);
    undo();
    expect(driveOut().segments[0]?.to).toEqual({ ref: "scoreSouth" });
  });

  it("makes a held turn of a selected start one undo step too", () => {
    setSelection({ start: true });
    const undoBefore = getState().undo.length;
    rotateHeading(1, { history: true });
    for (let repeat = 0; repeat < 10; repeat += 1) rotateHeading(1, { history: false });
    expect(getState().undo.length).toBe(undoBefore + 1);
    undo();
    expect(startPose()).toEqual({ ref: "start" });
  });
});

describe("the inspector's Start of the routine", () => {
  it("\"this pose\" keeps the pose the start stands at, with the waypoint's provenance", () => {
    open();
    writeOwnPose("start");
    expect(startPose()).toEqual({
      xIn: -13,
      yIn: -63,
      headingRad: 1.5708,
      provenance: waypointsFile.waypoints["start"]?.provenance,
    });
    expect(status()?.message).toBe("The start no longer follows waypoint start. Undo links it again.");
    undo();
    expect(startPose()).toEqual({ ref: "start" });
  });

  it("\"a waypoint\" follows the waypoint at the start's spot, or the nearest one", () => {
    open({ xIn: -12, yIn: -63, headingRad: 1.5708, provenance: "MEASURED" });
    followNearestWaypoint("start");
    expect(startPose()).toEqual({ ref: "start" });

    open({ xIn: -11, yIn: -38, headingRad: 1.5, provenance: "MEASURED" });
    followNearestWaypoint("start");
    expect(startPose()).toEqual({ ref: "scoreSouth" });
  });
});

describe("the inspector's From and To of a segment", () => {
  const driveOutEnd = { stepId: "driveOut", point: { segmentIndex: 0, pointKind: "to" as const } };
  const leg2Start = { stepId: "leg2", point: { segmentIndex: 0, pointKind: "from" as const } };
  const leg2End = { stepId: "leg2", point: { segmentIndex: 0, pointKind: "to" as const } };
  const leg2 = (): PathStep => {
    const step = getState().auto?.steps.find((candidate) => candidate.id === "leg2");
    if (step?.kind !== "path") throw new Error("no leg2");
    return step;
  };

  it("\"this pose\" keeps a point that follows a waypoint where it is, with the waypoint's provenance", () => {
    open();
    const undoBefore = getState().undo.length;
    writeOwnPose(driveOutEnd);
    expect(driveOut().segments[0]?.to).toEqual({
      xIn: -13,
      yIn: -36,
      headingRad: 1.5708,
      provenance: waypointsFile.waypoints["scoreSouth"]?.provenance,
    });
    expect(status()?.message).toBe("Point 1 of driveOut no longer follows waypoint scoreSouth. Undo links it again.");
    expect(getState().undo.length).toBe(undoBefore + 1);
    undo();
    expect(driveOut().segments[0]?.to).toEqual({ ref: "scoreSouth" });
  });

  it("\"this pose\" names the waypoint in the provenance when the waypoint has none", () => {
    const bare = loadWaypoints({
      $schema: SCHEMA_ID.waypoints,
      formatVersion: 1,
      waypoints: { start: { xIn: -12, yIn: -63, headingRad: 1.5708 }, scoreSouth: { xIn: -12, yIn: -36, headingRad: 1.5708 } },
    });
    open(undefined, { ...project, waypoints: bare });
    writeOwnPose(driveOutEnd);
    expect(driveOut().segments[0]?.to).toEqual({
      xIn: -12,
      yIn: -36,
      headingRad: 1.5708,
      provenance: `${EDITOR_PROVENANCE}: copied from waypoint scoreSouth`,
    });
  });

  it("\"this pose\" keeps a point written as the last step's end where that resolves to", () => {
    open();
    writeOwnPose(leg2Start);
    // driveOut ends at the scoreSouth waypoint, (-13, -36).
    expect(leg2().segments[0]?.from).toMatchObject({ xIn: -13, yIn: -36, provenance: EDITOR_PROVENANCE });
    // It followed no waypoint, so nothing was unlinked.
    expect(status()).toBeNull();
    undo();
    expect(leg2().segments[0]?.from).toBe("current");
  });

  it("\"a waypoint\" follows the waypoint at the point's spot, or the nearest one, not the first by name", () => {
    open();
    writeOwnPose(driveOutEnd);
    followNearestWaypoint(driveOutEnd);
    expect(driveOut().segments[0]?.to).toEqual({ ref: "scoreSouth" });

    // The last step's end resolves to scoreSouth's spot.
    followNearestWaypoint(leg2Start);
    expect(leg2().segments[0]?.from).toEqual({ ref: "scoreSouth" });

    // (0, -36) is 13 in from scoreSouth and further from every other waypoint.
    followNearestWaypoint(leg2End);
    expect(leg2().segments[0]?.to).toEqual({ ref: "scoreSouth" });
    undo();
    expect(leg2().segments[0]?.to).toEqual({ xIn: 0, yIn: -36, headingRad: 0 });
  });

  it("\"a waypoint\" says so when there is no waypoint to follow, and changes nothing", () => {
    const none = loadWaypoints({ $schema: SCHEMA_ID.waypoints, formatVersion: 1, waypoints: {} });
    open({ xIn: -12, yIn: -63, headingRad: 1.5708, provenance: "MEASURED" }, { ...project, waypoints: none });
    const before = getState().auto;
    followNearestWaypoint(leg2End);
    expect(getState().auto).toBe(before);
    expect(status()).toMatchObject({ kind: "error", message: "waypoints.json has no waypoints for point 1 of leg2 to follow." });
  });
});

describe("a path end that snaps onto a waypoint follows it (issue #150)", () => {
  const leg2 = (): PathStep => {
    const step = getState().auto?.steps.find((candidate) => candidate.id === "leg2");
    if (step?.kind !== "path") throw new Error("no leg2");
    return step;
  };
  const end = { segmentIndex: 0, pointKind: "to" as const };
  const flowerNorthApproach = { xIn: -24, yIn: 46, headingRad: 0 };

  beforeEach(() => {
    open();
  });

  it("an Add path click on flowerNorthApproach writes to = {ref: 'flowerNorthApproach'}, and says so", () => {
    const id = addPathStepTo(flowerNorthApproach, "flowerNorthApproach");
    expect(id).toBe("path1");
    const added = getState().auto?.steps.find((candidate) => candidate.id === "path1");
    if (added?.kind !== "path") throw new Error("no path1");
    expect(added.segments[0]?.from).toBe("current");
    expect(added.segments[0]?.to).toEqual({ ref: "flowerNorthApproach" });
    expect(status()).toMatchObject({ kind: "info", message: "Point 1 of path1 now follows waypoint flowerNorthApproach." });
    undo();
    expect(getState().auto?.steps.some((candidate) => candidate.id === "path1")).toBe(false);
  });

  it("a drag that snaps an end onto a waypoint writes the ref, says so once, and one undo takes the drag back", () => {
    const undoBefore = getState().undo.length;
    beginTransaction();
    writePoses([{ stepId: "leg2", target: end, pose: { xIn: -40, yIn: -40, headingRad: 0 } }]);
    writePoses([{ stepId: "leg2", target: end, pose: flowerNorthApproach, waypoint: "flowerNorthApproach" }]);
    expect(leg2().segments[0]?.to).toEqual({ ref: "flowerNorthApproach" });
    expect(status()).toMatchObject({ kind: "info", message: "Point 1 of leg2 now follows waypoint flowerNorthApproach." });
    clearStatus();
    // The next frame on the same pin changes nothing, so the status line does not repeat.
    writePoses([{ stepId: "leg2", target: end, pose: flowerNorthApproach, waypoint: "flowerNorthApproach" }]);
    expect(status()).toBeNull();
    endTransaction();

    expect(getState().undo.length).toBe(undoBefore + 1);
    undo();
    expect(leg2().segments[0]?.to).toEqual({ xIn: 0, yIn: -36, headingRad: 0 });
  });

  it("an end that already follows the waypoint keeps its ref and is not unlinked", () => {
    const undoBefore = getState().undo.length;
    beginTransaction();
    writePoses([{ stepId: "driveOut", target: end, pose: { xIn: -12, yIn: -36, headingRad: 1.5708 }, waypoint: "scoreSouth" }]);
    endTransaction();
    expect(driveOut().segments[0]?.to).toEqual({ ref: "scoreSouth" });
    expect(status()).toBeNull();
    expect(getState().undo.length).toBe(undoBefore);
  });

  it("dragged off its waypoint and back onto it in one drag, an end still follows it, and the status line does not say it was unlinked", () => {
    const undoBefore = getState().undo.length;
    beginTransaction();
    writePoses([{ stepId: "driveOut", target: end, pose: { xIn: 12, yIn: -36, headingRad: 1.5708 } }]);
    expect(status()?.message).toBe("Point 1 of driveOut no longer follows waypoint scoreSouth. Undo links it again.");
    writePoses([{ stepId: "driveOut", target: end, pose: { xIn: -12, yIn: -36, headingRad: 1.5708 }, waypoint: "scoreSouth" }]);
    endTransaction();
    expect(driveOut().segments[0]?.to).toEqual({ ref: "scoreSouth" });
    expect(status()?.message ?? "").not.toMatch(/no longer follows/);
    expect(getState().undo.length).toBe(undoBefore);
  });

  it("says nothing about undo linking an end again to a waypoint it only touched during the drag", () => {
    beginTransaction();
    writePoses([{ stepId: "leg2", target: end, pose: flowerNorthApproach, waypoint: "flowerNorthApproach" }]);
    writePoses([{ stepId: "leg2", target: end, pose: { xIn: -50, yIn: -44, headingRad: 0 } }]);
    endTransaction();
    expect(leg2().segments[0]?.to).toEqual({ xIn: -50, yIn: -44, headingRad: 0, provenance: EDITOR_PROVENANCE });
    expect(status()).toBeNull();
  });

  it("a Bezier handle snapped onto a waypoint keeps the waypoint's provenance with its numbers", () => {
    const curved = loadAuto({
      ...(JSON.parse(canonicalize("auto", fixture())) as Record<string, unknown>),
      steps: [
        {
          id: "curve",
          kind: "path",
          segments: [{ kind: "bezier", from: { ref: "start" }, control: [{ xIn: -30, yIn: -50 }], to: { ref: "scoreSouth" } }],
          heading: { mode: "tangent" },
        },
      ],
    });
    openAuto("unlink-fixture.auto.json", curved, canonicalize("auto", curved));
    clearStatus();
    const handle = { segmentIndex: 0, pointKind: "control" as const, controlIndex: 0 };
    writePoses([{ stepId: "curve", target: handle, pose: { xIn: -24, yIn: 46 }, waypoint: "flowerNorthApproach" }]);
    const step = getState().auto?.steps[0];
    const segment = step?.kind === "path" ? step.segments[0] : undefined;
    expect(segment?.kind === "bezier" ? segment.control[0] : undefined).toEqual({
      xIn: -24,
      yIn: 46,
      provenance: waypointsFile.waypoints["flowerNorthApproach"]?.provenance,
    });
  });
});
