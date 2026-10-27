/**
 * Deleting one point of a path chain, and adding or removing a path from the Inspector (issue
 * #185): the chain stays joined, the status line says what went, and one undo puts it back. The
 * fixture's driveOut runs north from (-12, -63) to (-12, -36), as the starter example's does.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, loadAuto, loadField, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import type { Auto, PathStep } from "@horizon36596/zenith-schema";
import { SCHEMA_ID } from "@horizon36596/zenith-schema";
import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectBackend } from "../project/backend";
import type { Project } from "../project/types";
import { currentDerived, getState, openAuto, openProject, setSelection, undo } from "../state/store";
import { appendPathToChain, chainEditNotes, deleteSelection, pointDeletePlan, removePathFromChain, splitSegmentAt } from "./edits";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

const project: Project = {
  source: { kind: "example" },
  name: "chain-fixture",
  link: { autosDir: "autos", robot: "robot.json", field: "field.json" } as Project["link"],
  robot: loadRobot(read("robot.json")),
  field: loadField(read("field/biobuzz.field.json")),
  waypoints: loadWaypoints(read("waypoints.json")),
  autoFiles: [],
  autoTexts: {},
};

const fixture = (): Auto =>
  loadAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "chain-fixture",
    alliance: "RED",
    start: { pose: { xIn: -12, yIn: -63, headingRad: 1.5708 } },
    steps: [
      {
        id: "driveOut",
        kind: "path",
        segments: [
          { kind: "line", from: { xIn: -12, yIn: -63, headingRad: 1.5708 }, to: { xIn: -12, yIn: -36 } },
        ],
        heading: { mode: "tangent" },
      },
    ],
  });

const driveOut = (): PathStep => {
  const step = getState().auto?.steps.find((candidate) => candidate.id === "driveOut");
  if (step?.kind !== "path") throw new Error("no driveOut");
  return step;
};

const continuity = () => currentDerived().findings.filter((finding) => finding.code === "CONTINUITY");

beforeEach(() => {
  openProject(project, { kind: "local" } as unknown as ProjectBackend);
  openAuto("chain-fixture.auto.json", fixture(), canonicalize("auto", fixture()));
});

describe("deleting one point of a path chain", () => {
  it("joins the two paths at a split's point, and one undo restores the split", () => {
    splitSegmentAt("driveOut", 0, 0.5);
    expect(driveOut().segments).toHaveLength(2);
    setSelection({ stepId: "driveOut", point: { segmentIndex: 0, pointKind: "to" } });
    deleteSelection();
    expect(driveOut().segments).toEqual([
      { kind: "line", from: { xIn: -12, yIn: -63, headingRad: 1.5708 }, to: { xIn: -12, yIn: -36 } },
    ]);
    expect(getState().status?.message).toContain("they are one path now");
    expect(continuity()).toEqual([]);
    undo();
    expect(driveOut().segments).toHaveLength(2);
  });

  it("says what each point's delete does, and why the first point takes the step with it", () => {
    splitSegmentAt("driveOut", 0, 0.5);
    const auto = getState().auto as Auto;
    expect(pointDeletePlan(auto, "driveOut", { segmentIndex: 1, pointKind: "from" })).toEqual({ kind: "join", nodeIndex: 1 });
    expect(pointDeletePlan(auto, "driveOut", { segmentIndex: 1, pointKind: "to" })).toEqual({ kind: "removeLast", segmentIndex: 1 });
    expect(pointDeletePlan(auto, "driveOut", { segmentIndex: 0, pointKind: "from" })).toMatchObject({ kind: "step" });
    expect(pointDeletePlan(fixture(), "driveOut", { segmentIndex: 0, pointKind: "to" })).toMatchObject({ kind: "step" });
  });

  it("deletes the step, as before, for the end of a one-path chain", () => {
    openAuto(
      "chain-fixture.auto.json",
      loadAuto({ ...fixture(), steps: [...fixture().steps, { id: "wait", kind: "wait", seconds: 1 }] }),
      canonicalize("auto", fixture()),
    );
    setSelection({ stepId: "driveOut", point: { segmentIndex: 0, pointKind: "to" } });
    deleteSelection();
    expect(getState().auto?.steps.map((step) => step.id)).toEqual(["wait"]);
    expect(getState().status?.message).toContain("Deleted driveOut.");
  });
});

describe("adding and removing a path from the Inspector", () => {
  it("adds a path from the chain's end and selects its end, and removing it leaves the chain joined", () => {
    appendPathToChain("driveOut");
    expect(driveOut().segments).toHaveLength(2);
    expect(driveOut().segments[1]?.from).toBe("current");
    expect(getState().selection).toEqual({ stepId: "driveOut", point: { segmentIndex: 1, pointKind: "to" } });
    expect(getState().status?.message).toContain("Added a path to driveOut.");
    removePathFromChain("driveOut", 0);
    expect(driveOut().segments).toHaveLength(1);
    expect(driveOut().segments[0]?.from).toEqual({ xIn: -12, yIn: -63, headingRad: 1.5708 });
    expect(continuity()).toEqual([]);
  });

  it("names the rescaled markers and the waypoints the chain no longer follows", () => {
    expect(chainEditNotes({ movedMarkers: 1, movedRanges: 0, droppedWaypoints: [] }, "driveOut")).toEqual([
      "1 marker stays where it was on the unchanged part of the chain.",
    ]);
    expect(chainEditNotes({ movedMarkers: 2, movedRanges: 1, droppedWaypoints: ["middle"] }, "driveOut")).toEqual([
      "2 markers and 1 heading range stay where they were on the unchanged part of the chain.",
      "driveOut no longer follows waypoint middle.",
    ]);
  });
});
