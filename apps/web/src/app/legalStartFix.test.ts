/**
 * Issue #155: "Move the start to the nearest legal spot" leaves a runnable auto. Of the legal starts
 * nearest the planned one it takes the first where the whole auto, as the fix writes it, gains no
 * new error, preferring one where the first path leaves facing the way the robot starts. Sweep
 * finding N25: on main, a start dragged to (-40, -40) went to (-42, -63) facing 90 degrees, and the
 * tangent driveOut then turned the robot about 48 degrees against the south wall, swapping
 * START_ILLEGAL for PERIMETER. When no start is clean, it turns each to its first path's start
 * tangent; when none of those is either, it keeps the nearest and the status line names the error.
 *
 * Opening the finding selects the start, pauses and puts the playhead at 0.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { angleDelta, canonicalize, footprintAt, loadAuto, loadField, loadRobot, loadWaypoints, type Finding } from "@horizon36596/zenith-core";
import { SCHEMA_ID, type Auto, type Pose, type PoseSource, type Robot } from "@horizon36596/zenith-schema";
import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectBackend } from "../project/backend";
import type { Project } from "../project/types";
import { clearStatus, currentDerived, getState, openAuto, openProject, setPlayback, setPlaying, undo } from "../state/store";
import { openFinding } from "../panels/FindingsPanel";
import { moveStartToLegal, writeStartPose } from "./edits";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

const projectWith = (robot: Robot = loadRobot(read("robot.json"))): Project => ({
  source: { kind: "example" },
  name: "legal-start-fixture",
  link: { autosDir: "autos", robot: "robot.json", field: "field.json" } as Project["link"],
  robot,
  field: loadField(read("field/biobuzz.field.json")),
  waypoints: loadWaypoints(read("waypoints.json")),
  autoFiles: [],
  autoTexts: {},
});

const open = (auto: Auto, project: Project = projectWith()): void => {
  openProject(project, { kind: "local" } as unknown as ProjectBackend);
  openAuto("legal-start-fixture.auto.json", auto, canonicalize("auto", auto));
  clearStatus();
};

/** The starter example the editor opens, collect-and-score, whose driveOut leaves from the start. */
const collectAndScore = (): Auto => loadAuto(read("collect-and-score.auto.json"));

/** A one-path auto that starts at `start` and drives a tangent line from there to `to`. */
const onePath = (start: Pose, to: { xIn: number; yIn: number }): Auto =>
  loadAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "legal-start-fixture",
    alliance: "RED",
    start: { pose: start },
    steps: [
      {
        id: "leg",
        kind: "path",
        segments: [{ kind: "line", from: "current", to: { ...to, provenance: "SET BY HAND: test" } }],
        heading: { mode: "tangent" },
      },
    ],
  });

const findings = (): Finding[] => currentDerived().findings;
const errors = (): string[] => findings().filter((finding) => finding.severity === "error").map((finding) => `${finding.code} ${finding.stepId}`);
const startPose = (): Pose => {
  const pose = getState().auto?.start.pose;
  if (pose === undefined || "ref" in pose) throw new Error("the start has no pose of its own");
  return pose;
};
const fromOf = (stepId: string): PoseSource | undefined => {
  const step = getState().auto?.steps.find((candidate) => candidate.id === stepId);
  return step?.kind === "path" ? step.segments[0]?.from : undefined;
};

/** How far the body's nearest corner is from the nearest wall of the 144 in BIOBUZZ field. */
const wallGapIn = (pose: Pose): number =>
  Math.min(
    ...footprintAt({ xIn: pose.xIn, yIn: pose.yIn, headingRad: pose.headingRad ?? 0 }, projectWith().robot, "startIn").bodyIn.map((corner) =>
      Math.min(72 - Math.abs(corner.xIn), 72 - Math.abs(corner.yIn)),
    ),
  );

/** The heading the first path of the open auto has where it starts. */
const firstPathHeading = (): number | undefined => currentDerived().plan?.steps.find((step) => step.kind === "path")?.samples[0]?.pose.headingRad;

describe("issue #155: Move the start to the nearest legal spot leaves a runnable auto", () => {
  it("moves a start dragged to (-40, -40) where driveOut neither leaves the field nor turns against the wall (N25)", () => {
    open(collectAndScore());
    // The canvas drag: the start and driveOut's first point, which sits on it, move together.
    writeStartPose({ xIn: -40, yIn: -40 });
    expect(errors()).toEqual(["START_ILLEGAL start"]);
    expect(fromOf("driveOut")).toMatchObject({ xIn: -40, yIn: -40 });
    const undoBefore = getState().undo.length;

    moveStartToLegal();

    expect(errors()).toEqual([]);
    expect(findings().filter((finding) => finding.code === "PERIMETER" && finding.stepId === "driveOut")).toEqual([]);
    const start = startPose();
    expect(start.provenance).toMatch(/^SET FROM EDITOR: the nearest legal start Zenith found, touching the wall at /);
    expect(wallGapIn(start)).toBeLessThan(0.05);
    // driveOut still leaves from the start, and leaves facing the way the robot starts.
    expect(fromOf("driveOut")).toMatchObject({ xIn: start.xIn, yIn: start.yIn });
    expect(Math.abs(angleDelta(start.headingRad ?? 0, firstPathHeading() ?? Number.NaN))).toBeLessThan(0.035);
    expect(getState().status).toMatchObject({ kind: "ok", message: expect.stringMatching(/^Moved the start to the nearest legal spot, touching the wall at /) as unknown });
    expect(getState().undo.length).toBe(undoBefore + 1);
    undo();
    expect(startPose()).toMatchObject({ xIn: -40, yIn: -40 });
  });

  it("turns the start to its first path's start tangent when no start nearby leaves the path facing its way", () => {
    // From every wall spot near (-50, -50) facing along or across a wall, the line to (-21, -33)
    // leaves at an angle, so the robot would turn on the spot against the wall.
    open(onePath({ xIn: -50, yIn: -50, headingRad: Math.PI / 2, provenance: "SET BY HAND: test" }, { xIn: -21, yIn: -33 }));
    expect(errors()).toEqual(["START_ILLEGAL start"]);

    moveStartToLegal();

    expect(errors()).toEqual([]);
    const start = startPose();
    expect(wallGapIn(start)).toBeLessThan(0.05);
    const heading = start.headingRad ?? 0;
    // Neither along nor across a wall: turned to the line's own heading from where it starts.
    expect(Math.abs(Math.sin(2 * heading))).toBeGreaterThan(0.5);
    expect(heading).toBeCloseTo(Math.atan2(-33 - start.yIn, -21 - start.xIn), 3);
    expect(Math.abs(angleDelta(heading, firstPathHeading() ?? Number.NaN))).toBeLessThan(0.001);
    expect(getState().status?.kind).toBe("ok");
  });

  it("keeps the nearest legal start and names the error when every start it tries gains one", () => {
    // A robot that unfolds 2 in past its start footprint on every side: wherever it starts touching
    // a wall, its expanded outline is through that wall.
    const starter = loadRobot(read("robot.json"));
    const unfolds: Robot = {
      ...starter,
      footprint: {
        ...starter.footprint,
        expandedIn: { lengthIn: 22, widthIn: 22, provenance: "PLACEHOLDER: test fixture, unfolds 2 in past the frame" },
      },
    };
    open(onePath({ xIn: -40, yIn: -40, headingRad: Math.PI / 2, provenance: "SET BY HAND: test" }, { xIn: -42, yIn: -20 }), projectWith(unfolds));
    expect(errors()).toEqual(["START_ILLEGAL start"]);

    moveStartToLegal();

    expect(errors()).toEqual(["PERIMETER leg"]);
    expect(startPose()).toMatchObject({ xIn: -42, yIn: -63, headingRad: 1.5708 });
    expect(getState().status).toMatchObject({
      kind: "error",
      message: expect.stringMatching(
        /^Moved the start to the nearest legal spot, touching the wall at y = -72 in\. Every legal start Zenith tried gives the auto a new error, so this is the nearest; it still has PERIMETER on leg: The robot leaves the field past the \w+ wall by 2\.00 in/,
      ) as unknown,
    });
  });
});

describe("issue #155: opening a START_ILLEGAL finding", () => {
  beforeEach(() => {
    open(collectAndScore());
    writeStartPose({ xIn: -40, yIn: -40 });
  });

  it("selects the start, pauses and puts the playhead at 0", () => {
    setPlayback(3.5);
    setPlaying(true);
    const finding = findings().find((candidate) => candidate.code === "START_ILLEGAL");
    if (finding === undefined) throw new Error("no START_ILLEGAL");
    openFinding(finding);
    expect(getState().selection).toEqual({ start: true });
    expect(getState().playing).toBe(false);
    expect(getState().playbackS).toBe(0);
  });
});
