/**
 * Issue #147: a path point's heading is the step's heading mode's, not the point's own `headingRad`,
 * which no heading mode reads. So `R` on a path point turns the angle the heading arrow at that end
 * of the path turns (Constant's angle, Linear's From or To, a piecewise heading's first or last
 * range's) and never writes the point's pose, so no waypoint is unlinked. Where the path or a joint
 * decides the heading, it writes nothing and the status line says what decides it. The hover bubble,
 * the readout and "Save as waypoint" read the planned heading, and the Add path tool no longer
 * writes the travel heading into the new path's end.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, flattenSteps, loadAuto, loadField, loadRobot, loadWaypoints, wrapAngle } from "@horizon36596/zenith-core";
import { SCHEMA_ID, type Auto, type Heading, type PathStep, type Step } from "@horizon36596/zenith-schema";
import { beforeEach, describe, expect, it } from "vitest";
import { buildScene } from "../canvas/scene";
import {
  pathPlaceOf,
  plannedHeadingAt,
  pointHeadingRefusal,
  pointHeadingRule,
  withPointHeading,
} from "../lib/headingModes";
import type { ProjectBackend } from "../project/backend";
import type { Project } from "../project/types";
import { clearStatus, currentDerived, getState, openAuto, openProject, selectStep, setSelection, setSetting, undo } from "../state/store";
import { formatHeading, headingFieldFor } from "../panels/PointHeadingRow";
import { addPathStepTo, plannedPointHeading, rotateHeading, writePointHeading } from "./edits";
// Installs the person's keys behind `keyLabel`, as the editor does.
import "./keymap";
import { addWaypointFrom } from "./waypointEdits";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

const project: Project = {
  source: { kind: "example" },
  name: "heading-row-fixture",
  link: { autosDir: "autos", robot: "robot.json", field: "field.json", waypoints: "waypoints.json" } as Project["link"],
  robot: loadRobot(read("robot.json")),
  field: loadField(read("field/biobuzz.field.json")),
  waypoints: loadWaypoints(read("waypoints.json")),
  autoFiles: [],
  autoTexts: {},
};

const DEG = Math.PI / 180;

// In the starter's waypoints.json, start is (-12, -63) and scoreSouth (-12, -36), both facing
// 1.5708 rad, so driveOut drives north. leg2 drives east, and its end holds a heading of 1 rad that
// Tangent never reads, unless a test gives it another end. bend has two segments: north 12 in, then
// east 12 in.
const LEG2_END: Record<string, unknown> = { xIn: 0, yIn: -36, headingRad: 1, provenance: "SET BY HAND: unit test fixture" };
const fixture = (headings: { driveOut?: Heading; bend?: Heading } = {}, leg2End: Record<string, unknown> = LEG2_END): Auto =>
  loadAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 4,
    name: "heading-row-fixture",
    title: "Heading row fixture",
    alliance: "RED",
    start: { pose: { ref: "start" } },
    steps: [
      {
        id: "driveOut",
        kind: "path",
        segments: [{ kind: "line", from: { ref: "start" }, to: { ref: "scoreSouth" } }],
        heading: headings.driveOut ?? { mode: "tangent" },
      },
      {
        id: "leg2",
        kind: "path",
        segments: [
          { kind: "line", from: "current", to: leg2End },
        ],
        heading: { mode: "tangent" },
      },
      {
        id: "bend",
        kind: "path",
        segments: [
          { kind: "line", from: "current", to: { xIn: 0, yIn: -24, headingRad: 0, provenance: "SET BY HAND: unit test fixture" } },
          {
            kind: "line",
            from: { xIn: 0, yIn: -24, headingRad: 0, provenance: "SET BY HAND: unit test fixture" },
            to: { xIn: 12, yIn: -24, headingRad: 0, provenance: "SET BY HAND: unit test fixture" },
          },
        ],
        heading: headings.bend ?? { mode: "linear", fromRad: Math.PI / 2, toRad: 0 },
      },
    ],
  });

const open = (headings: Parameters<typeof fixture>[0] = {}, leg2End?: Record<string, unknown>): void => {
  openProject(project, { kind: "local" } as unknown as ProjectBackend);
  const auto = fixture(headings, leg2End);
  openAuto("heading-row-fixture.auto.json", auto, canonicalize("auto", auto));
  clearStatus();
};

const path = (id: string): PathStep => {
  const step = getState().auto?.steps.find((candidate) => candidate.id === id);
  if (step?.kind !== "path") throw new Error(`no path ${id}`);
  return step;
};
const status = () => getState().status;
const plannedEnd = (id: string): number | undefined =>
  flattenSteps(currentDerived().plan?.steps ?? []).find((step) => step.id === id)?.endPose?.headingRad;

const END = { segmentIndex: 0, pointKind: "to" as const };
const FIRST = { segmentIndex: 0, pointKind: "from" as const };
const JOINT = { segmentIndex: 0, pointKind: "to" as const };

describe("which value decides the heading at a path point", () => {
  it("names a single segment's two ends the path's first and last points, and every other end a joint", () => {
    expect(pathPlaceOf(1, FIRST)).toBe("first");
    expect(pathPlaceOf(1, END)).toBe("last");
    expect(pathPlaceOf(2, { segmentIndex: 0, pointKind: "to" })).toBe("joint");
    expect(pathPlaceOf(2, { segmentIndex: 1, pointKind: "from" })).toBe("joint");
    expect(pathPlaceOf(2, { segmentIndex: 1, pointKind: "to" })).toBe("last");
  });

  it("is Constant's angle at either end, and Linear's From at the first point and To at the last", () => {
    expect(pointHeadingRule({ mode: "constant", headingRad: 2 }, "first")).toMatchObject({ kind: "value", valueRad: 2, label: "Constant" });
    expect(pointHeadingRule({ mode: "constant", headingRad: 2 }, "last")).toMatchObject({ kind: "value", valueRad: 2 });
    const linear: Heading = { mode: "linear", fromRad: 1, toRad: 3 };
    expect(pointHeadingRule(linear, "first")).toMatchObject({ kind: "value", valueRad: 1, label: "Linear, its From" });
    expect(pointHeadingRule(linear, "last")).toMatchObject({ kind: "value", valueRad: 3, label: "Linear, its To" });
    expect(withPointHeading(linear, "first", 1.5)).toEqual({ mode: "linear", fromRad: 1.5, toRad: 3 });
    expect(withPointHeading(linear, "last", 2.5)).toEqual({ mode: "linear", fromRad: 1, toRad: 2.5 });
  });

  it("is the path's under Tangent, Reverse tangent and Facing point, and nobody's at a joint", () => {
    expect(pointHeadingRule({ mode: "tangent" }, "last")).toEqual({ kind: "path", rangeIndex: null, label: "Tangent" });
    expect(pointHeadingRule({ mode: "tangentReversed" }, "first")).toMatchObject({ kind: "path", label: "Reverse tangent" });
    expect(pointHeadingRule({ mode: "facePoint", xIn: 0, yIn: 0 }, "last")).toMatchObject({ kind: "path", label: "Facing point" });
    expect(pointHeadingRule({ mode: "constant", headingRad: 2 }, "joint")).toEqual({ kind: "joint", label: "Constant" });
    expect(pointHeadingRule(undefined, "last")).toEqual({ kind: "none" });
    const tangent: Heading = { mode: "tangent" };
    expect(withPointHeading(tangent, "last", 1)).toBe(tangent);
  });

  it("is the first or last range's in a piecewise heading", () => {
    const piecewise: Heading = {
      mode: "piecewise",
      ranges: [
        { startT: 0, endT: 0.5, heading: { mode: "constant", headingRad: 1 } },
        { startT: 0.5, endT: 1, heading: { mode: "linear", fromRad: 1, toRad: 2 } },
      ],
    };
    expect(pointHeadingRule(piecewise, "first")).toMatchObject({ kind: "value", rangeIndex: 0, valueRad: 1, label: "Piecewise, range 1 (Constant)" });
    expect(pointHeadingRule(piecewise, "last")).toMatchObject({ kind: "value", rangeIndex: 1, valueRad: 2, label: "Piecewise, range 2 (Linear, its To)" });
    const turned = withPointHeading(piecewise, "last", 2.5);
    expect(turned.mode === "piecewise" && turned.ranges[1]?.heading).toEqual({ mode: "linear", fromRad: 1, toRad: 2.5 });
    expect(turned.mode === "piecewise" && turned.ranges[0]).toEqual(piecewise.ranges[0]);
    const tangentEnd: Heading = { mode: "piecewise", ranges: [{ startT: 0, endT: 1, heading: { mode: "tangent" } }] };
    const rule = pointHeadingRule(tangentEnd, "last");
    expect(rule).toMatchObject({ kind: "path", rangeIndex: 0, label: "Piecewise, range 1 (Tangent)" });
    expect(pointHeadingRefusal("driveOut", rule, "R and Shift R")).toBe(
      "driveOut's heading comes from Piecewise, range 1 (Tangent); switch that range to Linear or Constant to turn it here.",
    );
  });
});

describe("the planned heading at a path point", () => {
  beforeEach(() => {
    open();
  });

  it("is the heading mode's, not the headingRad the point holds", () => {
    // leg2 drives due east, so Tangent faces 0 at its end, whatever its `to` holds.
    expect(plannedPointHeading("leg2", END)).toBeCloseTo(0, 6);
    expect(plannedPointHeading("driveOut", END)).toBeCloseTo(Math.PI / 2, 4);
    // bend turns from north to east along its two segments, so its joint faces between the two.
    const joint = plannedPointHeading("bend", JOINT);
    expect(joint).not.toBeNull();
    expect(joint ?? 0).toBeGreaterThan(0.05);
    expect(joint ?? 0).toBeLessThan(Math.PI / 2 - 0.05);
    expect(plannedPointHeading("bend", { segmentIndex: 1, pointKind: "from" })).toBeCloseTo(joint ?? 0, 9);
    expect(plannedPointHeading("bend", { segmentIndex: 1, pointKind: "to" })).toBeCloseTo(0, 6);
  });

  it("is what the field's dots carry for the hover bubble and the readout", () => {
    const plan = currentDerived().plan;
    if (plan === null) throw new Error("no plan");
    const scene = buildScene({ plan, findings: [], estimate: null });
    const leg2 = scene.steps.find((step) => step.stepId === "leg2");
    const end = leg2?.handles.find((handle) => handle.target.pointKind === "to");
    expect(end?.poseIn.headingRad).toBe(1);
    expect(end?.plannedHeadingRad).toBeCloseTo(0, 6);
    const planStep = flattenSteps(plan.steps).find((step) => step.id === "leg2");
    if (planStep === undefined) throw new Error("no leg2 in the plan");
    expect(plannedHeadingAt(planStep, END)).toBeCloseTo(0, 6);
  });

  it("is what Save as waypoint gives the new waypoint, labelled SET FROM EDITOR when the pose held another heading", () => {
    // leg2's end holds 1 rad under a hand-set label, but Tangent faces the robot 0 rad there. The
    // editor worked that heading out, so the hand-set label is not true of it.
    expect(addWaypointFrom({ stepId: "leg2", point: END }, "leg2End")).toBe(true);
    const saved = getState().project?.waypoints?.waypoints["leg2End"];
    expect(saved).toMatchObject({ xIn: 0, yIn: -36, provenance: "SET FROM EDITOR" });
    expect(saved?.headingRad).toBeCloseTo(0, 6);
  });

  it("labels the saved waypoint SET FROM EDITOR when the pose held no heading", () => {
    open({}, { xIn: 0, yIn: -36, provenance: "MEASURED: unit test fixture" });
    expect(addWaypointFrom({ stepId: "leg2", point: END }, "leg2End")).toBe(true);
    const saved = getState().project?.waypoints?.waypoints["leg2End"];
    expect(saved).toMatchObject({ xIn: 0, yIn: -36, provenance: "SET FROM EDITOR" });
    expect(saved?.headingRad).toBeCloseTo(0, 6);
  });

  it("keeps the pose's own heading and label in the saved waypoint when the plan agrees with it", () => {
    open({}, { xIn: 0, yIn: -36, headingRad: 0, provenance: "MEASURED: unit test fixture" });
    expect(addWaypointFrom({ stepId: "leg2", point: END }, "leg2End")).toBe(true);
    expect(getState().project?.waypoints?.waypoints["leg2End"]).toEqual({
      xIn: 0,
      yIn: -36,
      headingRad: 0,
      provenance: "MEASURED: unit test fixture",
    });
    // bend's last point holds 0 rad and Linear's To is 0.00003 rad, which a file writes as the same
    // 4-decimal number, so the two count as one heading and the hand-set label stays.
    open({ bend: { mode: "linear", fromRad: Math.PI / 2, toRad: 0.00003 } });
    expect(plannedPointHeading("bend", { segmentIndex: 1, pointKind: "to" })).toBeCloseTo(0.00003, 9);
    expect(addWaypointFrom({ stepId: "bend", point: { segmentIndex: 1, pointKind: "to" } }, "bendEnd")).toBe(true);
    expect(getState().project?.waypoints?.waypoints["bendEnd"]).toEqual({
      xIn: 12,
      yIn: -24,
      headingRad: 0,
      provenance: "SET BY HAND: unit test fixture",
    });
  });
});

describe("R on a path point", () => {
  it("writes nothing under Tangent, keeps the waypoint, and says Tangent decides it", () => {
    open();
    setSelection({ stepId: "driveOut", point: END });
    const undoBefore = getState().undo.length;
    rotateHeading(1);
    rotateHeading(1);
    expect(path("driveOut").segments[0]?.to).toEqual({ ref: "scoreSouth" });
    expect(path("driveOut").heading).toEqual({ mode: "tangent" });
    expect(getState().undo.length).toBe(undoBefore);
    expect(status()?.message).toBe("driveOut's heading comes from Tangent; switch to Linear or Constant to turn it here.");
  });

  it("never writes a point's own pose, so its heading and provenance stay as they were", () => {
    open();
    setSelection({ stepId: "leg2", point: END });
    rotateHeading(-1);
    expect(path("leg2").segments[0]?.to).toEqual({ xIn: 0, yIn: -36, headingRad: 1, provenance: "SET BY HAND: unit test fixture" });
  });

  it("turns Linear's To at the last point, as one undo step, and the planned end heading follows", () => {
    open({ driveOut: { mode: "linear", fromRad: Math.PI / 2, toRad: Math.PI / 2 } });
    setSelection({ stepId: "driveOut", point: END });
    const undoBefore = getState().undo.length;
    rotateHeading(1);
    expect(path("driveOut").heading).toEqual({ mode: "linear", fromRad: Math.PI / 2, toRad: Math.PI / 2 + 5 * DEG });
    expect(plannedEnd("driveOut")).toBeCloseTo(wrapAngle(Math.PI / 2 + 5 * DEG), 6);
    expect(path("driveOut").segments[0]?.to).toEqual({ ref: "scoreSouth" });
    expect(getState().undo.length).toBe(undoBefore + 1);
    rotateHeading(-1);
    expect(path("driveOut").heading).toMatchObject({ toRad: expect.closeTo(Math.PI / 2, 9) as number });
    undo();
    undo();
    const back = path("driveOut").heading;
    expect(back?.mode === "linear" && back.toRad).toBeCloseTo(Math.PI / 2, 4);
  });

  it("turns Linear's From at the first point, keeping the start's waypoint", () => {
    open({ driveOut: { mode: "linear", fromRad: Math.PI / 2, toRad: Math.PI / 2 } });
    setSelection({ stepId: "driveOut", point: FIRST });
    rotateHeading(-1);
    expect(path("driveOut").heading).toEqual({ mode: "linear", fromRad: Math.PI / 2 - 5 * DEG, toRad: Math.PI / 2 });
    expect(path("driveOut").segments[0]?.from).toEqual({ ref: "start" });
  });

  it("turns Constant's one angle from either end", () => {
    open({ driveOut: { mode: "constant", headingRad: 0 } });
    setSelection({ stepId: "driveOut", point: FIRST });
    rotateHeading(1);
    setSelection({ stepId: "driveOut", point: END });
    rotateHeading(1);
    const heading = path("driveOut").heading;
    expect(heading?.mode === "constant" && heading.headingRad).toBeCloseTo(10 * DEG, 9);
  });

  it("turns the end of the selected step when no point is selected", () => {
    open({ driveOut: { mode: "constant", headingRad: 0 } });
    selectStep("driveOut");
    rotateHeading(1);
    const heading = path("driveOut").heading;
    expect(heading?.mode === "constant" && heading.headingRad).toBeCloseTo(5 * DEG, 9);
  });

  it("turns the first or last range of a piecewise heading", () => {
    open({
      driveOut: {
        mode: "piecewise",
        ranges: [
          { startT: 0, endT: 0.5, heading: { mode: "constant", headingRad: 1 } },
          { startT: 0.5, endT: 1, heading: { mode: "linear", fromRad: 1, toRad: 2 } },
        ],
      },
    });
    setSelection({ stepId: "driveOut", point: END });
    rotateHeading(1);
    setSelection({ stepId: "driveOut", point: FIRST });
    rotateHeading(1);
    const heading = path("driveOut").heading;
    if (heading?.mode !== "piecewise") throw new Error("not piecewise");
    expect(heading.ranges[0]?.heading).toEqual({ mode: "constant", headingRad: 1 + 5 * DEG });
    expect(heading.ranges[1]?.heading).toEqual({ mode: "linear", fromRad: 1, toRad: 2 + 5 * DEG });
  });

  it("writes nothing where two segments meet, whatever the mode, and says so", () => {
    for (const heading of [{ mode: "linear", fromRad: Math.PI / 2, toRad: 0 }, { mode: "constant", headingRad: 0 }] as Heading[]) {
      open({ bend: heading });
      const before = getState().auto;
      setSelection({ stepId: "bend", point: JOINT });
      rotateHeading(1);
      expect(getState().auto).toBe(before);
      expect(status()?.message).toMatch(/^bend's heading mode, (Linear|Constant), decides which way the robot faces where two paths meet./);
    }
  });

  it("names the person's Turn key where two segments meet, not R", () => {
    try {
      open({ bend: { mode: "constant", headingRad: 0 } });
      setSelection({ stepId: "bend", point: JOINT });
      rotateHeading(1);
      expect(status()?.message).toContain("R and Shift R turn a heading only at a path's first or last point.");
      setSetting("keys.bindings", { "keys.rotate": "T" });
      rotateHeading(1);
      expect(status()?.message).toContain("T and Shift T turn a heading only at a path's first or last point.");
      expect(status()?.message).not.toContain("R and Shift R");
      setSetting("keys.bindings", { "keys.rotate": null });
      rotateHeading(1);
      expect(status()?.message).toContain("A heading turns only at a path's first or last point.");
    } finally {
      setSetting("keys.bindings", {});
    }
  });
});

describe("the inspector's Set it on a path point", () => {
  it("writes the value that decides the heading there, as one undo step, and leaves the point alone", () => {
    open({ driveOut: { mode: "linear", fromRad: Math.PI / 2, toRad: Math.PI / 2 } });
    const undoBefore = getState().undo.length;
    writePointHeading("driveOut", END, Math.PI);
    expect(path("driveOut").heading).toEqual({ mode: "linear", fromRad: Math.PI / 2, toRad: Math.PI });
    expect(path("driveOut").segments[0]?.to).toEqual({ ref: "scoreSouth" });
    expect(getState().undo.length).toBe(undoBefore + 1);
  });

  it("writes nothing for a point the path decides", () => {
    open();
    const before = getState().auto;
    writePointHeading("driveOut", END, Math.PI);
    expect(getState().auto).toBe(before);
  });
});

describe("the Add path tool", () => {
  it("writes no heading into the new path's end, since its heading mode decides it", () => {
    open();
    selectStep("driveOut");
    const id = addPathStepTo({ xIn: 24, yIn: -24, headingRad: 0.8 });
    expect(id).not.toBeNull();
    const auto = getState().auto;
    if (auto === null || id === null) throw new Error("no new path");
    const written = JSON.parse(canonicalize("auto", auto)) as { steps: Array<Step & { segments?: Array<{ to: unknown }> }> };
    const to = written.steps.find((step) => step.id === id)?.segments?.[0]?.to;
    expect(to).toEqual({ xIn: 24, yIn: -24, provenance: "SET FROM EDITOR" });
  });
});

describe("the Inspector's heading readouts (issue #409)", () => {
  it("wrap to (-180, 180] with one decimal and the degree sign tight against the number", () => {
    expect(formatHeading(-Math.PI)).toBe("180.0°");
    expect(formatHeading(Math.PI)).toBe("180.0°");
    expect(formatHeading(-Math.PI + 1e-9)).toBe("180.0°");
    expect(formatHeading(Math.PI / 2)).toBe("90.0°");
    expect(formatHeading(-Math.PI / 2)).toBe("-90.0°");
    expect(formatHeading(3 * Math.PI)).toBe("180.0°");
    expect(formatHeading(-0.0001)).toBe("0.0°");
    expect(formatHeading(270 * DEG)).toBe("-90.0°");
  });

  it("reads a constant heading of -π as 180.0°, and the file still holds -π", () => {
    open({ driveOut: { mode: "constant", headingRad: -Math.PI } });
    const end = plannedEnd("driveOut");
    expect(end).toBeDefined();
    expect(formatHeading(end ?? 0)).toBe("180.0°");
    expect(path("driveOut").heading).toEqual({ mode: "constant", headingRad: -Math.PI });
  });

  it("sends the selected end's pencil to the Heading section's field that decides it", () => {
    expect(headingFieldFor({ mode: "tangent" }, "first")).toBe("inspector-heading-from");
    expect(headingFieldFor({ mode: "tangentReversed" }, "last")).toBe("inspector-heading-to");
    expect(headingFieldFor(undefined, "last")).toBe("inspector-heading-to");
    expect(headingFieldFor({ mode: "constant", headingRad: 1 }, "last")).toBe("inspector-heading-constant");
    expect(headingFieldFor({ mode: "linear", fromRad: 0, toRad: 1 }, "first")).toBe("inspector-heading-from");
    expect(headingFieldFor({ mode: "linear", fromRad: 0, toRad: 1 }, "joint")).toBeNull();
    const piecewise: Heading = {
      mode: "piecewise",
      ranges: [
        { startT: 0, endT: 0.5, heading: { mode: "constant", headingRad: 1 } },
        { startT: 0.5, endT: 1, heading: { mode: "tangent" } },
      ],
    };
    expect(headingFieldFor(piecewise, "first")).toBe("heading-range-0-constant");
    expect(headingFieldFor(piecewise, "last")).toBeNull();
  });
});
