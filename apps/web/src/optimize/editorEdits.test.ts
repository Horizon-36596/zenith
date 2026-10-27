import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, loadAuto, loadField, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import type { Auto } from "@horizon36596/zenith-schema";
import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectBackend } from "../project/backend";
import type { Project } from "../project/types";
import { commitWithWaypoints, getState, openAuto, openProject, replaceProjectRobot, selectStep, setAutoOverrides } from "../state/store";
import { editsSince } from "./editorEdits";
import type { OptimizeRequest } from "./protocol";

/**
 * Cancel on an edit (issue #306), with a project open: an edit to the robot, the field or the project's
 * waypoints that the run is checked against counts as an edit, as an edit to the open auto does, and a
 * selection does not.
 */

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

const waypoints = loadWaypoints(read("waypoints.json"));

const project: Project = {
  source: { kind: "example" },
  name: "edits-since-fixture",
  link: { autosDir: "autos", robot: "robot.json", field: "field.json" } as Project["link"],
  robot: loadRobot(read("robot.json")),
  field: loadField(read("field/biobuzz.field.json")),
  waypoints,
  autoFiles: [],
  autoTexts: {},
};

/** The request the card builds from the store: the open auto and what it is checked against. */
const requestNow = (): OptimizeRequest => {
  const state = getState();
  if (state.auto === null || state.project === null) throw new Error("no auto is open");
  return {
    auto: state.auto,
    robot: state.autoRobot ?? state.project.robot,
    field: state.autoField ?? state.project.field,
    waypoints: state.project.waypoints,
    stepId: "toOtherSide",
  };
};

beforeEach(() => {
  const auto = loadAuto(read("collect-and-score.auto.json"));
  openProject(project, { kind: "local" } as unknown as ProjectBackend);
  openAuto("collect-and-score.auto.json", auto, canonicalize("auto", auto));
});

describe("editsSince with a project open", () => {
  it("is false until something changes, and a selection is not a change", () => {
    const watch = editsSince(requestNow());
    expect(watch.changed()).toBe(false);
    selectStep("toOtherSide");
    expect(watch.changed()).toBe(false);
  });

  it("counts a new robot as an edit", () => {
    const watch = editsSince(requestNow());
    replaceProjectRobot(structuredClone(project.robot));
    expect(getState().auto).toBe(requestNow().auto);
    expect(watch.changed()).toBe(true);
  });

  it("counts a new field as an edit", () => {
    const watch = editsSince(requestNow());
    const state = getState();
    setAutoOverrides(state.autoRobot ?? project.robot, structuredClone(project.field));
    expect(watch.changed()).toBe(true);
  });

  it("counts an edit to the project's waypoints as an edit, even when the auto stays the same object", () => {
    const request = requestNow();
    const watch = editsSince(request);
    commitWithWaypoints(request.auto, structuredClone(waypoints));
    expect(getState().auto).toBe(request.auto);
    expect(getState().project?.waypoints).not.toBe(request.waypoints);
    expect(watch.changed()).toBe(true);
  });

  it("on a draft, compares the open auto with the base it was built from", () => {
    const base = requestNow();
    const draft: OptimizeRequest = { ...base, auto: { ...base.auto, steps: [...base.auto.steps] } as Auto };
    const watch = editsSince(draft, base.auto);
    expect(watch.changed()).toBe(false);
    commitWithWaypoints({ ...base.auto } as Auto, waypoints);
    expect(watch.changed()).toBe(true);
  });
});
