/**
 * Issue #315: after any undo or redo the selection is checked against the documents it lands on, so
 * it never names a step, point, marker or waypoint they no longer have. Undoing an Add path click
 * clears the selection on the path it removed, and undoing a rename of the selected waypoint takes
 * the selection back to the old name, while redo takes it on to the new one.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, loadAuto, loadField, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import type { Auto } from "@horizon36596/zenith-schema";
import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectBackend } from "../project/backend";
import type { Project } from "../project/types";
import { addPathStepTo } from "../app/edits";
import { renameWaypointTo } from "../app/waypointEdits";
import { commit, getState, openAuto, openProject, redo, setPrefs, setSelection, toggleMultiStep, undo } from "./store";

const starter = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${starter}${relative}`, "utf8"));
const collectAndScore = (): Auto => loadAuto(read("autos/collect-and-score.auto.json"));

const example = (): Project => ({
  source: { kind: "example" },
  name: "examples/starter",
  link: { autosDir: "autos", robot: "autos/robot.json", field: "autos/field.json", waypoints: "autos/waypoints.json" } as Project["link"],
  robot: loadRobot(read("autos/robot.json")),
  field: loadField(read("autos/field/biobuzz.field.json")),
  waypoints: loadWaypoints(read("autos/waypoints.json")),
  autoFiles: ["collect-and-score.auto.json"],
  autoTexts: {},
});

beforeEach(() => {
  setPrefs({ waypointPins: "all", waypointPinOverrides: {} });
  openProject(example(), { kind: "local" } as unknown as ProjectBackend);
  const auto = collectAndScore();
  openAuto("collect-and-score.auto.json", auto, canonicalize("auto", auto));
});

describe("the selection after an undo or redo", () => {
  it("is cleared when the undo removes the step an Add path click added and selected", () => {
    const id = addPathStepTo({ xIn: 30, yIn: -30, headingRad: 0 });
    expect(id).not.toBeNull();
    expect(getState().selection).toEqual({ stepId: id });

    undo();
    expect(getState().auto?.steps.some((step) => step.id === id)).toBe(false);
    expect(getState().selection).toEqual({});

    // Redo brings the step back; nothing was selected, so nothing is selected now.
    redo();
    expect(getState().auto?.steps.some((step) => step.id === id)).toBe(true);
    expect(getState().selection).toEqual({});
  });

  it("drops a removed step from the multi-selection and keeps the rest", () => {
    const id = addPathStepTo({ xIn: 30, yIn: -30, headingRad: 0 });
    if (id === null) throw new Error("expected the path to be added");
    setSelection({ stepId: "driveOut" });
    toggleMultiStep(id);
    expect(getState().multiSteps).toEqual(["driveOut", id]);

    undo();
    expect(getState().multiSteps).toEqual([]);
    expect(getState().selection).toEqual({});
  });

  it("drops a selected point whose segment the undo removed, and keeps its step", () => {
    const before = getState().auto;
    if (before === null) throw new Error("expected an open auto");
    const driveOut = before.steps.find((step) => step.id === "driveOut");
    if (driveOut?.kind !== "path") throw new Error("expected driveOut to be a path");
    const last = driveOut.segments[driveOut.segments.length - 1]!;
    commit({
      ...before,
      steps: before.steps.map((step) =>
        step === driveOut ? { ...driveOut, segments: [...driveOut.segments, { kind: "line", from: "current", to: last.to }] } : step,
      ),
    });
    setSelection({ stepId: "driveOut", point: { segmentIndex: driveOut.segments.length, pointKind: "to" } });

    undo();
    expect(getState().selection).toEqual({ stepId: "driveOut" });
  });

  it("follows a selected waypoint's rename back on undo and forward again on redo", () => {
    setSelection({ waypoint: "scoreSouth" });
    expect(renameWaypointTo("scoreSouth", "southSpot")).toBe(true);
    expect(getState().selection).toEqual({ waypoint: "southSpot" });

    undo();
    expect(getState().project?.waypoints?.waypoints["scoreSouth"]).toBeDefined();
    expect(getState().selection).toEqual({ waypoint: "scoreSouth" });

    redo();
    expect(getState().project?.waypoints?.waypoints["southSpot"]).toBeDefined();
    expect(getState().selection).toEqual({ waypoint: "southSpot" });
  });

  it("leaves a selection that still exists alone, the same object as before", () => {
    expect(renameWaypointTo("scoreSouth", "southSpot")).toBe(true);
    setSelection({ waypoint: "park" });
    const selection = getState().selection;

    undo();
    expect(getState().selection).toBe(selection);
  });
});
