/**
 * Setting a value's provenance by hand from the inspector's chip menu (#87). Each edit writes only
 * the provenance, leaves the numbers alone, is one undo step, and a later move on the field still
 * stamps SET FROM EDITOR, as it did before the menu existed.
 */
import { canonicalize, EDITOR_PROVENANCE, loadAuto } from "@horizon36596/zenith-core";
import { SCHEMA_ID, type Auto } from "@horizon36596/zenith-schema";
import { beforeEach, describe, expect, it } from "vitest";
import {
  movePoint,
  writePose,
  writeEnvelopeProvenance,
  writePointNumbers,
  writePointProvenance,
  writeRejoinProvenance,
  writeStartNumbers,
  writeStartProvenance,
} from "./edits";
import { clearStatus, getState, openAuto, setSelection, undo } from "../state/store";
import { joinProvenance, splitProvenance } from "../lib/provenance";

const ENVELOPE = {
  polygon: [
    { xIn: -10, yIn: -10 },
    { xIn: 10, yIn: -10 },
    { xIn: 10, yIn: 10 },
  ],
  maxDurationS: 2,
  provenance: "PLACEHOLDER: fixture",
};

const fixture = (): Auto =>
  loadAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "provenance-fixture",
    title: "Provenance fixture",
    alliance: "RED",
    start: { pose: { xIn: -36, yIn: -60, headingRad: 1.5708, provenance: "PLACEHOLDER: fixture" } },
    steps: [
      {
        id: "leg1",
        kind: "path",
        segments: [
          {
            kind: "bezier",
            from: "current",
            control: [{ xIn: -30, yIn: -40 }],
            to: { xIn: -12, yIn: -36, headingRad: 1.5708, provenance: "SET FROM EDITOR" },
          },
        ],
        heading: { mode: "tangent" },
      },
      { id: "spin", kind: "command", name: "spinUp", envelope: ENVELOPE },
      {
        id: "leg2",
        kind: "path",
        rejoinFrom: { xIn: -12, yIn: -30, headingRad: 0 },
        segments: [{ kind: "line", from: "current", to: { xIn: 0, yIn: -30, headingRad: 0 } }],
        heading: { mode: "tangent" },
      },
    ],
  });

const auto = (): Auto => {
  const current = getState().auto;
  if (current === null) throw new Error("No auto is open.");
  return current;
};

const segment = () => {
  const step = auto().steps[0];
  if (step?.kind !== "path") throw new Error("leg1 is not a path.");
  const first = step.segments[0];
  if (first?.kind !== "bezier") throw new Error("leg1 is not a curve.");
  return first;
};

describe("splitting and joining a provenance string", () => {
  it("finds the longest label and the note after it, with or without a colon", () => {
    expect(splitProvenance("SET FROM EDITOR: dragged")).toEqual({ label: "SET FROM EDITOR", note: "dragged" });
    expect(splitProvenance("MEASURED 2026-01-15 ForwardVelocityTuner")).toEqual({
      label: "MEASURED",
      note: "2026-01-15 ForwardVelocityTuner",
    });
    expect(splitProvenance("SPEC (R102)")).toEqual({ label: "SPEC", note: "(R102)" });
    expect(splitProvenance("CALIBRATED FROM ROBOT")).toEqual({ label: "CALIBRATED FROM ROBOT", note: "" });
  });

  it("keeps a string with no vocabulary label whole, as its note", () => {
    expect(splitProvenance("SET FROM TeamCode/MyRobot.java")).toEqual({ label: null, note: "SET FROM TeamCode/MyRobot.java" });
    expect(splitProvenance(undefined)).toEqual({ label: null, note: "" });
  });

  it("writes the label alone, or the label, a colon and the note", () => {
    expect(joinProvenance("MEASURED", "")).toBe("MEASURED");
    expect(joinProvenance("MEASURED", "  tape,\n2026-09-30 ")).toBe("MEASURED: tape, 2026-09-30");
  });
});

describe("setting a provenance by hand", () => {
  beforeEach(() => {
    const doc = fixture();
    openAuto("provenance-fixture.auto.json", doc, canonicalize("auto", doc));
  });

  it("changes only a path point's provenance, as one undo step that Ctrl+Z takes back", () => {
    const before = canonicalize("auto", auto());
    const undoBefore = getState().undo.length;
    writePointProvenance("leg1", { segmentIndex: 0, pointKind: "to" }, "MEASURED: tape, 2026-09-30");

    expect(segment().to).toEqual({ xIn: -12, yIn: -36, headingRad: 1.5708, provenance: "MEASURED: tape, 2026-09-30" });
    expect(getState().undo.length).toBe(undoBefore + 1);
    // The file differs from before only on the provenance line.
    const changed = canonicalize("auto", auto())
      .split("\n")
      .filter((line, index) => line !== before.split("\n")[index]);
    expect(changed).toEqual([expect.stringContaining('"provenance": "MEASURED: tape, 2026-09-30"')]);

    undo();
    expect(segment().to).toEqual({ xIn: -12, yIn: -36, headingRad: 1.5708, provenance: "SET FROM EDITOR" });
    expect(canonicalize("auto", auto())).toBe(before);
  });

  it("labels a curve's control point", () => {
    writePointProvenance("leg1", { segmentIndex: 0, pointKind: "control", controlIndex: 0 }, "SET BY HAND");
    expect(segment().control[0]).toEqual({ xIn: -30, yIn: -40, provenance: "SET BY HAND" });
  });

  it("refuses a point that follows the last step's end, and says why", () => {
    const undoBefore = getState().undo.length;
    writePointProvenance("leg1", { segmentIndex: 0, pointKind: "from" }, "MEASURED");
    expect(segment().from).toBe("current");
    expect(getState().undo.length).toBe(undoBefore);
    expect(getState().status?.message).toMatch(/no provenance of its own/);
  });

  it("labels the start pose and keeps its numbers", () => {
    writeStartProvenance("MEASURED");
    expect(auto().start.pose).toEqual({ xIn: -36, yIn: -60, headingRad: 1.5708, provenance: "MEASURED" });
    undo();
    expect(auto().start.pose).toEqual({ xIn: -36, yIn: -60, headingRad: 1.5708, provenance: "PLACEHOLDER: fixture" });
  });

  it("labels an envelope and a rejoin pose", () => {
    writeEnvelopeProvenance("spin", "SET BY HAND: stays by the wall");
    const spin = auto().steps[1];
    expect(spin?.kind === "command" && spin.envelope).toEqual({ ...ENVELOPE, provenance: "SET BY HAND: stays by the wall" });

    writeRejoinProvenance("leg2", "APPROX");
    const leg2 = auto().steps[2];
    expect(leg2?.kind === "path" && leg2.rejoinFrom).toEqual({ xIn: -12, yIn: -30, headingRad: 0, provenance: "APPROX" });
  });

  it("is replaced by SET FROM EDITOR when the point is then moved on the field, as before", () => {
    writePointProvenance("leg1", { segmentIndex: 0, pointKind: "to" }, "MEASURED");
    // One frame of the canvas's point drag, which hands over a pose without a provenance.
    writePose("leg1", { segmentIndex: 0, pointKind: "to" }, { xIn: -11, yIn: -36, headingRad: 1.5708 });
    expect(segment().to).toMatchObject({ xIn: -11, yIn: -36, provenance: EDITOR_PROVENANCE });

    writeStartProvenance("MEASURED");
    setSelection({ start: true });
    movePoint(1, 0);
    expect(auto().start.pose).toMatchObject({ xIn: -35, provenance: EDITOR_PROVENANCE });
  });
});

/**
 * Owner ruling 2026-10-10 (issue #273), measured-typed (b): typing a number for a point or the start
 * whose label is MEASURED or CALIBRATED FROM ROBOT warns and relabels it SET FROM EDITOR; the chip
 * then sets it back in one step. Every other label is kept, as before.
 */
describe("typing a number on a measured value", () => {
  const TO = { segmentIndex: 0, pointKind: "to" } as const;
  const CONTROL = { segmentIndex: 0, pointKind: "control", controlIndex: 0 } as const;

  beforeEach(() => {
    const doc = fixture();
    openAuto("provenance-fixture.auto.json", doc, canonicalize("auto", doc));
    clearStatus();
  });

  it("warns, relabels a MEASURED path point, and is one undo step that brings the label back", () => {
    writePointProvenance("leg1", TO, "MEASURED: tape, 2026-09-30");
    clearStatus();
    const undoBefore = getState().undo.length;
    writePointNumbers("leg1", TO, { xIn: -10 });

    expect(segment().to).toEqual({ xIn: -10, yIn: -36, headingRad: 1.5708, provenance: EDITOR_PROVENANCE });
    expect(getState().undo.length).toBe(undoBefore + 1);
    expect(getState().status).toMatchObject({ kind: "warn" });
    expect(getState().status?.message).toContain("This changes MEASURED to SET FROM EDITOR on point 1 of leg1.");

    undo();
    expect(segment().to).toEqual({ xIn: -12, yIn: -36, headingRad: 1.5708, provenance: "MEASURED: tape, 2026-09-30" });
  });

  it("goes back to MEASURED in one step from the chip, which keeps the typed number", () => {
    writePointProvenance("leg1", TO, "MEASURED");
    writePointNumbers("leg1", TO, { yIn: -33 });
    expect(segment().to).toMatchObject({ provenance: EDITOR_PROVENANCE });
    const undoBefore = getState().undo.length;
    writePointProvenance("leg1", TO, "MEASURED");
    expect(segment().to).toMatchObject({ xIn: -12, yIn: -33, provenance: "MEASURED" });
    expect(getState().undo.length).toBe(undoBefore + 1);
    // A second number typed on it is the editor's already, so nothing is replaced and nothing warns.
    writePointProvenance("leg1", TO, EDITOR_PROVENANCE);
    clearStatus();
    writePointNumbers("leg1", TO, { yIn: -32 });
    expect(getState().status).toBeNull();
  });

  it("does the same for CALIBRATED FROM ROBOT and for a curve's control point", () => {
    writePointProvenance("leg1", CONTROL, "CALIBRATED FROM ROBOT");
    clearStatus();
    writePointNumbers("leg1", CONTROL, { xIn: -28 });
    expect(segment().control[0]).toEqual({ xIn: -28, yIn: -40, provenance: EDITOR_PROVENANCE });
    expect(getState().status?.kind).toBe("warn");
    expect(getState().status?.message).toContain("This changes CALIBRATED FROM ROBOT to SET FROM EDITOR on control 1 of leg1.");
  });

  it("keeps every other label and says nothing", () => {
    for (const label of ["SET BY HAND: chosen", "PLACEHOLDER: fixture", "SPEC", "APPROX"]) {
      writePointProvenance("leg1", TO, label);
      clearStatus();
      writePointNumbers("leg1", TO, { xIn: -11 });
      expect(segment().to, label).toMatchObject({ xIn: -11, provenance: label });
      expect(getState().status, label).toBeNull();
    }
  });

  it("moves both ends of a joint, and both carry the editor's label", () => {
    const doc = loadAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 1,
      name: "joint",
      title: "Joint",
      alliance: "RED",
      start: { pose: { xIn: -36, yIn: -60, headingRad: 1.5708, provenance: "PLACEHOLDER: fixture" } },
      steps: [
        {
          id: "chain",
          kind: "path",
          segments: [
            { kind: "line", from: "current", to: { xIn: -36, yIn: -36, headingRad: 1.5708, provenance: "MEASURED" } },
            { kind: "line", from: { xIn: -36, yIn: -36, headingRad: 1.5708, provenance: "MEASURED" }, to: { xIn: -12, yIn: -36, headingRad: 0, provenance: "SET BY HAND" } },
          ],
          heading: { mode: "tangent" },
        },
      ],
    });
    openAuto("joint.auto.json", doc, canonicalize("auto", doc));
    writePointNumbers("chain", { segmentIndex: 0, pointKind: "to" }, { xIn: -30 });
    const step = auto().steps[0];
    if (step?.kind !== "path") throw new Error("chain is not a path.");
    expect(step.segments[0]?.to).toMatchObject({ xIn: -30, provenance: EDITOR_PROVENANCE });
    expect(step.segments[1]?.from).toMatchObject({ xIn: -30, provenance: EDITOR_PROVENANCE });
  });

  it("warns and relabels a MEASURED start, whether x, y or the heading is typed", () => {
    writeStartProvenance("MEASURED");
    clearStatus();
    const undoBefore = getState().undo.length;
    writeStartNumbers({ xIn: -40 });
    expect(auto().start.pose).toEqual({ xIn: -40, yIn: -60, headingRad: 1.5708, provenance: EDITOR_PROVENANCE });
    expect(getState().undo.length).toBe(undoBefore + 1);
    expect(getState().status?.kind).toBe("warn");
    expect(getState().status?.message).toContain("This changes MEASURED to SET FROM EDITOR on the start.");

    undo();
    expect(auto().start.pose).toEqual({ xIn: -36, yIn: -60, headingRad: 1.5708, provenance: "MEASURED" });
    writeStartNumbers({ headingRad: 0 });
    expect(auto().start.pose).toMatchObject({ headingRad: 0, provenance: EDITOR_PROVENANCE });
  });

  it("keeps a start's other labels and says nothing", () => {
    clearStatus();
    writeStartNumbers({ yIn: -58 });
    expect(auto().start.pose).toMatchObject({ yIn: -58, provenance: "PLACEHOLDER: fixture" });
    expect(getState().status).toBeNull();
  });
});
