/**
 * Issue #241: one SourceSelect per path end replaces the From or To kind select and the Waypoint
 * select. Its options are the previous end (for a From), "This pose", then every waypoint. Choosing a
 * waypoint makes the end follow that waypoint, choosing "This pose" writes a pose of its own where
 * the end stands now, and choosing the previous end writes `"current"`. Each choice is one undo step,
 * and choosing what the end already is writes nothing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, loadAuto, loadField, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import { SCHEMA_ID, type Auto, type PathStep, type PoseSource } from "@horizon36596/zenith-schema";
import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectBackend } from "../project/backend";
import type { Project } from "../project/types";
import { clearStatus, getState, openAuto, openProject, undo } from "../state/store";
import { chooseEndSource, endChoiceOf, endChoices } from "./endSource";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));
const waypointsFile = read("waypoints.json") as { waypoints: Record<string, { provenance?: string }> };

const project: Project = {
  source: { kind: "example" },
  name: "end-source-fixture",
  link: { autosDir: "autos", robot: "robot.json", field: "field.json" } as Project["link"],
  robot: loadRobot(read("robot.json")),
  field: loadField(read("field/biobuzz.field.json")),
  waypoints: loadWaypoints(read("waypoints.json")),
  autoFiles: [],
  autoTexts: {},
};

// In the starter's waypoints.json, start is (-13, -63) and scoreSouth is (-13, -36), both facing
// 1.5708 rad. driveOut drives from one to the other, and leg2 starts where driveOut ends.
const fixture = (): Auto =>
  loadAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "end-source-fixture",
    title: "End source fixture",
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
        segments: [{ kind: "line", from: "current", to: { xIn: 0, yIn: -36, headingRad: 0 } }],
        heading: { mode: "tangent" },
      },
    ],
  });

const path = (id: string): PathStep => {
  const step = getState().auto?.steps.find((candidate) => candidate.id === id);
  if (step?.kind !== "path") throw new Error(`no ${id}`);
  return step;
};
const end = (id: string, pointKind: "from" | "to"): PoseSource | undefined => path(id).segments[0]?.[pointKind];
const owner = (stepId: string, pointKind: "from" | "to") => ({ stepId, point: { segmentIndex: 0, pointKind } });
const undoDepth = (): number => getState().undo.length;

beforeEach(() => {
  openProject(project, { kind: "local" } as unknown as ProjectBackend);
  const auto = fixture();
  openAuto("end-source-fixture.auto.json", auto, canonicalize("auto", auto));
  clearStatus();
});

describe("the choice a path end shows", () => {
  it("names a waypoint it follows, a pose of its own, or the previous end", () => {
    expect(endChoiceOf({ ref: "scoreSouth" })).toBe("ref:scoreSouth");
    expect(endChoiceOf({ xIn: 0, yIn: -36, headingRad: 0 })).toBe("pose");
    expect(endChoiceOf("current")).toBe("current");
  });

  it("offers the previous end only to a From, named for the step or the path before, then This pose, then the waypoints", () => {
    const names = ["park", "scoreSouth", "start"];
    expect(endChoices("from", 0, names, "current").ends).toEqual([
      { value: "current", label: "Last step's end" },
      { value: "pose", label: "This pose" },
    ]);
    expect(endChoices("from", 1, names, "current").ends[0]).toEqual({ value: "current", label: "Previous path's end" });
    expect(endChoices("to", 0, names, { ref: "scoreSouth" }).ends).toEqual([{ value: "pose", label: "This pose" }]);
    expect(endChoices("to", 0, names, { ref: "scoreSouth" }).waypoints).toEqual([
      { value: "ref:park", label: "park" },
      { value: "ref:scoreSouth", label: "scoreSouth" },
      { value: "ref:start", label: "start" },
    ]);
  });

  it("still lists the previous end for a To that holds it, so the select value matches an option", () => {
    const { ends } = endChoices("to", 0, ["start"], "current");
    expect(ends.map((option) => option.value)).toContain(endChoiceOf("current"));
  });

  it("keeps a followed waypoint that waypoints.json no longer has, so the select still shows it", () => {
    expect(endChoices("to", 0, ["start"], { ref: "gone" }).waypoints).toEqual([
      { value: "ref:start", label: "start" },
      { value: "ref:gone", label: "gone" },
    ]);
  });
});

describe("choosing in a path end's SourceSelect", () => {
  it("makes an end that followed one waypoint follow the waypoint chosen, as one undo step", () => {
    const before = undoDepth();
    chooseEndSource(owner("driveOut", "to"), "ref:scoreNorth");
    expect(end("driveOut", "to")).toEqual({ ref: "scoreNorth" });
    expect(undoDepth()).toBe(before + 1);
    undo();
    expect(end("driveOut", "to")).toEqual({ ref: "scoreSouth" });
  });

  it("makes a pose of its own follow the waypoint chosen", () => {
    chooseEndSource(owner("leg2", "to"), "ref:park");
    expect(end("leg2", "to")).toEqual({ ref: "park" });
  });

  it("makes a From written as the last step's end follow the waypoint chosen", () => {
    chooseEndSource(owner("leg2", "from"), "ref:scoreSouth");
    expect(end("leg2", "from")).toEqual({ ref: "scoreSouth" });
  });

  it("writes This pose where a followed waypoint stands, with the waypoint's provenance", () => {
    chooseEndSource(owner("driveOut", "to"), "pose");
    expect(end("driveOut", "to")).toEqual({
      xIn: -13,
      yIn: -36,
      headingRad: 1.5708,
      provenance: waypointsFile.waypoints.scoreSouth?.provenance,
    });
    expect(getState().status?.message).toMatch(/no longer follows waypoint scoreSouth/);
  });

  it("writes This pose for a From that was the last step's end, where that end resolves to", () => {
    chooseEndSource(owner("leg2", "from"), "pose");
    expect(end("leg2", "from")).toMatchObject({ xIn: -13, yIn: -36 });
  });

  it("writes the previous end for a From, and never for a To", () => {
    chooseEndSource(owner("driveOut", "from"), "current");
    expect(end("driveOut", "from")).toBe("current");
    const before = undoDepth();
    chooseEndSource(owner("driveOut", "to"), "current");
    expect(end("driveOut", "to")).toEqual({ ref: "scoreSouth" });
    expect(undoDepth()).toBe(before);
  });

  it("writes nothing when the choice is what the end already is", () => {
    const before = undoDepth();
    chooseEndSource(owner("driveOut", "to"), "ref:scoreSouth");
    chooseEndSource(owner("leg2", "to"), "pose");
    chooseEndSource(owner("leg2", "from"), "current");
    expect(undoDepth()).toBe(before);
  });
});
