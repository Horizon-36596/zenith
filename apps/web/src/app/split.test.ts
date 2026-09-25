/**
 * Splitting a segment (QA-10): double-click and "Split path here" split any segment, whatever its
 * start is. Core splits only inline ends, so the editor resolves `"current"` and waypoint ends first
 * and puts them back afterwards; only the new middle point is an explicit pose.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EDITOR_PROVENANCE, canonicalize, loadAuto, loadField, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import type { Auto, PathStep } from "@horizon36596/zenith-schema";
import { SCHEMA_ID } from "@horizon36596/zenith-schema";
import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectBackend } from "../project/backend";
import type { Project } from "../project/types";
import { getState, openAuto, openProject } from "../state/store";
import { splitSegmentAt } from "./edits";

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
});
