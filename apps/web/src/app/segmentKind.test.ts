/**
 * Issue #143: turning a line into a curve. The control point used to land at the field centre,
 * with no provenance, whenever either end of the segment was `"current"` or a waypoint, which is
 * every path the editor makes and almost every starter segment. `setSegmentKindAt` resolves the ends
 * through the same resolve the canvas draws from and puts the one control point at their midpoint,
 * with the editor's provenance, so the curve starts on the line and the switch changes nothing the
 * checks or the estimate see. Switching back to a line gives back the segment as it was written.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EDITOR_PROVENANCE, canonicalize, loadAuto, loadField, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import { SCHEMA_ID, type Auto, type PathStep } from "@horizon36596/zenith-schema";
import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectBackend } from "../project/backend";
import type { Project } from "../project/types";
import { currentDerived, getState, openAuto, openProject, setSelection, undo } from "../state/store";
import { setSegmentKindAt } from "./edits";
import { paletteSegment } from "./segmentKind";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

const project: Project = {
  source: { kind: "example" },
  name: "curve-fixture",
  link: { autosDir: "autos", robot: "robot.json", field: "field.json" } as Project["link"],
  robot: loadRobot(read("robot.json")),
  field: loadField(read("field/biobuzz.field.json")),
  waypoints: loadWaypoints(read("waypoints.json")),
  autoFiles: [],
  autoTexts: {},
};

const open = (auto: Auto): void => {
  openProject(project, { kind: "local" } as unknown as ProjectBackend);
  openAuto(`${auto.name}.auto.json`, auto, canonicalize("auto", auto));
};

const starter = (): Auto => loadAuto(read("collect-and-score.auto.json"));

const path = (id: string): PathStep => {
  const step = getState().auto?.steps.find((candidate) => candidate.id === id);
  if (step?.kind !== "path") throw new Error(`no path ${id}`);
  return step;
};

/** Every finding, as one comparable line each. */
const findings = (): string[] =>
  currentDerived().findings.map((finding) => `${finding.severity} ${finding.code} ${finding.stepId}: ${finding.message}`);

beforeEach(() => {
  open(starter());
});

describe("turning a line into a curve", () => {
  it("puts the control on collectFlower's own line, from where the last step ended to its waypoint", () => {
    // collectFlower runs from "current", which resolves to flowerNorthApproach (-24, 46), to the
    // waypoint flowerNorthPickup (-24, 57).
    setSegmentKindAt("collectFlower", 0, "bezier");
    const segment = path("collectFlower").segments[0];
    expect(segment).toEqual({
      kind: "bezier",
      from: "current",
      control: [{ xIn: -24, yIn: 51.5, provenance: EDITOR_PROVENANCE }],
      to: { ref: "flowerNorthPickup" },
    });
  });

  it("puts it between two waypoints when both ends follow one", () => {
    // driveOut runs from the waypoint start (-13, -63) to the waypoint scoreSouth (-13, -36).
    setSegmentKindAt("driveOut", 0, "bezier");
    const segment = path("driveOut").segments[0];
    expect(segment?.kind === "bezier" ? segment.control : null).toEqual([
      { xIn: -13, yIn: -49.5, provenance: EDITOR_PROVENANCE },
    ]);
  });

  it("adds no finding and keeps the estimate, because the new curve lies on the line", () => {
    const before = findings();
    const totalS = currentDerived().totalS;
    expect(totalS).not.toBeNull();
    setSegmentKindAt("collectFlower", 0, "bezier");
    setSegmentKindAt("driveOut", 0, "bezier");
    expect(findings()).toEqual(before);
    expect(currentDerived().totalS).toBeCloseTo(totalS ?? 0, 3);
  });

  it("switching back to a line restores the segment as it was written, and each switch is one undo", () => {
    const original = structuredClone(path("collectFlower").segments[0]);
    setSegmentKindAt("collectFlower", 0, "bezier");
    setSegmentKindAt("collectFlower", 0, "line");
    expect(path("collectFlower").segments[0]).toEqual(original);
    undo();
    expect(path("collectFlower").segments[0]?.kind).toBe("bezier");
    undo();
    expect(path("collectFlower").segments[0]).toEqual(original);
  });

  it("says how to bend the new curve", () => {
    setSegmentKindAt("collectFlower", 0, "bezier");
    expect(getState().status?.message).toMatch(/hollow square/);
  });

  it("leaves a segment that is already that kind alone", () => {
    const before = getState().auto;
    setSegmentKindAt("toOtherSide", 0, "bezier");
    expect(getState().auto).toBe(before);
  });

  describe("when resolve can only guess where the segment is", () => {
    const broken = (start: Auto["start"]["pose"], to: PathStep["segments"][number]["to"]): Auto =>
      loadAuto({
        $schema: SCHEMA_ID.auto,
        formatVersion: 1,
        name: "broken",
        title: "Broken",
        alliance: "RED",
        start: { pose: start },
        steps: [
          {
            id: "lost",
            kind: "path",
            segments: [{ kind: "line", from: "current", to }],
            heading: { mode: "tangent" },
          },
          {
            id: "known",
            kind: "path",
            segments: [{ kind: "line", from: { ref: "scoreSouth" }, to: { ref: "park" } }],
            heading: { mode: "tangent" },
          },
        ],
      });

    it("refuses in a plain sentence for an end that follows a waypoint the project does not have", () => {
      open(broken({ xIn: -12, yIn: -63, headingRad: 1.5708 }, { ref: "nowhere" }));
      const before = getState().auto;
      setSegmentKindAt("lost", 0, "bezier");
      expect(getState().auto).toBe(before);
      expect(getState().status?.kind).toBe("error");
      expect(getState().status?.message).toMatch(/^Zenith cannot work out where path 1 of lost starts and ends yet/);
      expect(getState().status?.message).toMatch(/No waypoint named "nowhere"/);
    });

    it("never puts the control at the field centre, where resolve stands in a start it cannot find", () => {
      open(broken({ ref: "nowhere" }, { xIn: -24, yIn: 0, headingRad: 0 }));
      const before = getState().auto;
      setSegmentKindAt("lost", 0, "bezier");
      expect(getState().auto).toBe(before);
      expect(getState().status?.kind).toBe("error");
    });

    it("still curves a later segment whose own ends are known", () => {
      open(broken({ ref: "nowhere" }, { xIn: -24, yIn: 0, headingRad: 0 }));
      setSegmentKindAt("known", 0, "bezier");
      const segment = path("known").segments[0];
      // scoreSouth is (-13, -36) and park (-40, -36).
      expect(segment?.kind === "bezier" ? segment.control : null).toEqual([
        { xIn: -26.5, yIn: -36, provenance: EDITOR_PROVENANCE },
      ]);
    });
  });
});

describe("the segment the palette's Make curve and Make straight line act on", () => {
  it("is the selected point's segment, or the path's first one of the other kind", () => {
    setSelection({ stepId: "collectFlower" });
    expect(paletteSegment(getState(), "bezier")).toEqual({ stepId: "collectFlower", segmentIndex: 0 });
    expect(paletteSegment(getState(), "line")).toEqual(
      "Path 1 of collectFlower is already a straight line.",
    );
    setSelection({ stepId: "toOtherSide", point: { segmentIndex: 0, pointKind: "control", controlIndex: 1 } });
    expect(paletteSegment(getState(), "line")).toEqual({ stepId: "toOtherSide", segmentIndex: 0 });
  });

  it("asks for a path when none is selected", () => {
    setSelection({});
    expect(paletteSegment(getState(), "bezier")).toBe("Select a path first.");
    setSelection({ stepId: "shootPreloads" });
    expect(paletteSegment(getState(), "bezier")).toBe("Select a path first.");
  });
});
