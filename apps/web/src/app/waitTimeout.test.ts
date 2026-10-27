/**
 * Insert, Wait, Until a condition writes a wait with no timeout (issue #154), which on the robot can
 * wait forever. WAIT_NO_TIMEOUT says so on the new step, and its fix writes no number of its own:
 * the person types one in the Timeout field. A path that ends on a condition does not raise it,
 * because codegen races the condition against the path, so the path's own end bounds it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, loadAuto, loadField, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectBackend } from "../project/backend";
import type { Project } from "../project/types";
import { currentDerived, getState, openAuto, openProject, selectStep } from "../state/store";
import { addWaitUntil } from "./edits";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

const project: Project = {
  source: { kind: "example" },
  name: "wait-timeout-fixture",
  link: { autosDir: "autos", robot: "robot.json", field: "field.json" } as Project["link"],
  robot: loadRobot(read("robot.json")),
  field: loadField(read("field/biobuzz.field.json")),
  waypoints: loadWaypoints(read("waypoints.json")),
  autoFiles: [],
  autoTexts: {},
};

beforeEach(() => {
  const auto = loadAuto(read("collect-and-score.auto.json"));
  openProject(project, { kind: "local" } as unknown as ProjectBackend);
  openAuto("collect-and-score.auto.json", auto, canonicalize("auto", auto));
});

const waitNoTimeout = (): Array<{ stepId: string; severity: string }> =>
  currentDerived()
    .findings.filter((finding) => finding.code === "WAIT_NO_TIMEOUT")
    .map((finding) => ({ stepId: finding.stepId, severity: finding.severity }));

describe("Insert, Wait, Until hopperFull", () => {
  it("raises WAIT_NO_TIMEOUT on the new step, which has no timeout", () => {
    expect(waitNoTimeout()).toEqual([]);
    selectStep("stopIntake");
    const id = addWaitUntil("hopperFull");
    if (id === null) throw new Error("the wait was not inserted");

    const step = getState().auto?.steps.find((candidate) => candidate.id === id);
    expect(step).toEqual({ id, kind: "wait", until: "hopperFull" });
    expect(waitNoTimeout()).toEqual([{ stepId: id, severity: "warning" }]);

    const finding = currentDerived().findings.find((candidate) => candidate.code === "WAIT_NO_TIMEOUT");
    expect(finding?.fixes?.map((fix) => fix.kind)).toEqual(["focusTimeout"]);
  });

  it("does not raise it on collectFlower or sweepGarden, which end on a condition", () => {
    selectStep("stopIntake");
    addWaitUntil("hopperFull");
    const ids = waitNoTimeout().map((finding) => finding.stepId);
    expect(ids).not.toContain("collectFlower");
    expect(ids).not.toContain("sweepGarden");
    expect(ids).not.toContain("waitForFull");
  });
});
