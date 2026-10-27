/**
 * Splitting a segment (QA-10): double-click and "Split path here" split any segment, whatever its
 * start is. Core splits only inline ends, so the editor resolves `"current"` and waypoint ends first
 * and puts them back afterwards; only the new middle point is an explicit pose.
 *
 * That middle point is written twice, as the first half's `to` and the second half's `from`, and
 * the editor moves it as one joint (issue #146).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EDITOR_PROVENANCE, canonicalize, loadAuto, loadField, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import type { Auto, PathStep } from "@horizon36596/zenith-schema";
import { SCHEMA_ID } from "@horizon36596/zenith-schema";
import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectBackend } from "../project/backend";
import type { Project } from "../project/types";
import { planPointDrag } from "../canvas/pointDrag";
import { currentDerived, getState, openAuto, openProject, setSelection, undo } from "../state/store";
import { jointMoves, nudge, rotateHeading, splitSegmentAt, writePoses } from "./edits";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

const project: Project = {
  source: { kind: "example" },
  name: "split-fixture",
  link: { autosDir: "autos", robot: "robot.json", field: "field.json" } as Project["link"],
  robot: loadRobot(read("robot.json")),
  field: loadField(read("field/biobuzz.field.json")),
  waypoints: loadWaypoints(read("waypoints.json")),
  autoFiles: [],
  autoTexts: {},
};

// park is (-40, -36) in the example's waypoints.json.
const fixture = (): Auto =>
  loadAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "split-fixture",
    title: "Split fixture",
    alliance: "RED",
    start: { pose: { xIn: -60, yIn: 0, headingRad: 0 } },
    steps: [
      {
        id: "chained",
        kind: "path",
        segments: [{ kind: "line", from: "current", to: { xIn: -20, yIn: 0, headingRad: 0 } }],
        heading: { mode: "tangent" },
      },
      {
        id: "fromWaypoint",
        kind: "path",
        segments: [{ kind: "line", from: { ref: "park" }, to: { xIn: -23, yIn: -36, headingRad: 0 } }],
        heading: { mode: "tangent" },
      },
      {
        id: "fromPose",
        kind: "path",
        segments: [
          {
            kind: "line",
            from: { xIn: -23, yIn: -36, headingRad: 0 },
            to: { xIn: -23, yIn: 4, headingRad: 0 },
          },
        ],
        heading: { mode: "tangent" },
      },
      {
        id: "curve",
        kind: "path",
        segments: [
          {
            kind: "bezier",
            from: { xIn: -23, yIn: 4, headingRad: 0 },
            control: [
              { xIn: 0, yIn: 4 },
              { xIn: 0, yIn: 30 },
            ],
            to: { xIn: 20, yIn: 30, headingRad: 0 },
          },
        ],
        heading: { mode: "tangent" },
      },
    ],
  });

const path = (id: string): PathStep => {
  const step = getState().auto?.steps.find((candidate) => candidate.id === id);
  if (step?.kind !== "path") throw new Error(`no path ${id}`);
  return step;
};

beforeEach(() => {
  openProject(project, { kind: "local" } as unknown as ProjectBackend);
  openAuto("split-fixture.auto.json", fixture(), canonicalize("auto", fixture()));
});

describe("splitting a segment", () => {
  it("splits a segment that starts where the last step ended, and keeps that start", () => {
    splitSegmentAt("chained", 0, 0.5);
    const [first, second] = path("chained").segments;
    expect(path("chained").segments).toHaveLength(2);
    expect(first?.from).toBe("current");
    expect(first?.to).toMatchObject({ xIn: -40, yIn: 0, provenance: EDITOR_PROVENANCE });
    expect(second?.from).toMatchObject({ xIn: -40, yIn: 0 });
    expect(second?.to).toMatchObject({ xIn: -20, yIn: 0 });
  });

  it("splits a segment that starts at a waypoint, and keeps the waypoint", () => {
    splitSegmentAt("fromWaypoint", 0, 0.25);
    const [first, second] = path("fromWaypoint").segments;
    expect(first?.from).toEqual({ ref: "park" });
    expect(first?.to).toMatchObject({ xIn: -35.75, yIn: -36 });
    expect(second?.from).toMatchObject({ xIn: -35.75, yIn: -36 });
  });

  it("splits a segment between two poses", () => {
    splitSegmentAt("fromPose", 0, 0.5);
    const [first, second] = path("fromPose").segments;
    expect(first?.from).toMatchObject({ xIn: -23, yIn: -36 });
    expect(first?.to).toMatchObject({ xIn: -23, yIn: -16 });
    expect(second?.to).toMatchObject({ xIn: -23, yIn: 4 });
  });

  it("leaves the document alone when asked to split at an end of the segment", () => {
    const before = getState().auto;
    splitSegmentAt("chained", 0, 1);
    expect(getState().auto).toBe(before);
  });

  it("splits a curve, and the controls it makes carry SET FROM EDITOR", () => {
    splitSegmentAt("curve", 0, 0.5);
    const halves = path("curve").segments;
    expect(halves).toHaveLength(2);
    for (const half of halves) {
      if (half.kind !== "bezier") throw new Error("expected both halves to stay curves");
      for (const control of half.control) expect(control.provenance).toBe(EDITOR_PROVENANCE);
    }
  });
});

/** CONTINUITY on fromPose. (fromWaypoint starts at park, away from where chained ends, on purpose.) */
const continuity = () =>
  currentDerived().findings.filter((finding) => finding.code === "CONTINUITY" && finding.stepId === "fromPose");

/** The split's new point, as the canvas draws and selects it: the first half's end. */
const joint = { segmentIndex: 0, pointKind: "to" } as const;

describe("a split's new point is one joint (issue #146)", () => {
  it("moves both halves' ends when it moves, and one undo puts both back", () => {
    splitSegmentAt("fromPose", 0, 0.5);
    const depth = getState().undo.length;
    writePoses(jointMoves("fromPose", joint, { xIn: 1, yIn: -16, headingRad: 0, provenance: EDITOR_PROVENANCE }));
    const [first, second] = path("fromPose").segments;
    expect(first?.to).toMatchObject({ xIn: 1, yIn: -16, provenance: EDITOR_PROVENANCE });
    expect(second?.from).toEqual(first?.to);
    expect(continuity()).toEqual([]);
    expect(getState().undo.length).toBe(depth + 1);

    undo();
    const [before, after] = path("fromPose").segments;
    expect(before?.to).toMatchObject({ xIn: -23, yIn: -16 });
    expect(after?.from).toMatchObject({ xIn: -23, yIn: -16 });
  });

  it("nudges both ends together", () => {
    splitSegmentAt("fromPose", 0, 0.5);
    setSelection({ stepId: "fromPose", point: joint });
    for (let press = 0; press < 4; press += 1) nudge(1, 0, true);
    const [first, second] = path("fromPose").segments;
    expect(first?.to).toMatchObject({ xIn: -15, yIn: -16 });
    expect(second?.from).toEqual(first?.to);
    expect(continuity()).toEqual([]);
  });

  it("is not turned by R, which says the step's heading mode decides the heading there (issue #147)", () => {
    splitSegmentAt("fromPose", 0, 0.5);
    setSelection({ stepId: "fromPose", point: joint });
    const before = getState().auto;
    rotateHeading(1);
    expect(getState().auto).toBe(before);
    const [first, second] = path("fromPose").segments;
    expect(second?.from).toEqual(first?.to);
    expect(getState().status?.message).toMatch(/heading mode/i);
  });
});

describe("a Bezier control keeps no heading (N82)", () => {
  const controlOf = (index: number): Record<string, unknown> => {
    const auto = getState().auto;
    if (auto === null) throw new Error("no auto");
    const written = JSON.parse(canonicalize("auto", auto)) as {
      steps: Array<{ id: string; segments: Array<{ control?: Array<Record<string, unknown>> }> }>;
    };
    const control = written.steps.find((step) => step.id === "curve")?.segments[0]?.control?.[index];
    if (control === undefined) throw new Error(`no control ${String(index)}`);
    return control;
  };

  it("writes none when a control is dragged or nudged", () => {
    const target = { segmentIndex: 0, pointKind: "control", controlIndex: 0 } as const;
    // The canvas holds a control's pose at heading 0, as `poseOfPoint` does.
    const moves = planPointDrag({
      leader: { stepId: "curve", point: target, pose: { xIn: 0, yIn: 4, headingRad: 0 } },
      leaderPose: { xIn: -2, yIn: 6, headingRad: 0 },
      followers: [],
      polygonsOf: () => null,
      nodeKinds: new Map(),
      breakMirror: false,
    });
    writePoses(moves);
    expect(controlOf(0)).toEqual({ xIn: -2, yIn: 6, provenance: EDITOR_PROVENANCE });

    setSelection({ stepId: "curve", point: { segmentIndex: 0, pointKind: "control", controlIndex: 1 } });
    nudge(1, 0, false);
    expect(controlOf(1)).toEqual({ xIn: 0.5, yIn: 30, provenance: EDITOR_PROVENANCE });
  });
});
