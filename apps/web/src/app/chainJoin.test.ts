/**
 * The rest of decision D5 (issue #204): Extend this chain makes the add-path tool, Add a path to
 * here and Insert a path add to the selected path step's chain, and Join with next path makes two
 * path steps that follow each other one chain. The fixture's driveOut runs 27 in north from
 * (-12, -63) and park 24 in east from where it ends.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, loadAuto, loadField, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import type { Auto, PathStep } from "@horizon36596/zenith-schema";
import { SCHEMA_ID } from "@horizon36596/zenith-schema";
import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectBackend } from "../project/backend";
import type { Project } from "../project/types";
import { getState, openAuto, openProject, selectStep, setPrefs, undo } from "../state/store";
import { addPathStep, addPathStepTo, chainToExtend, joinNextReason, joinWithNext } from "./edits";
import { actionById } from "./actions";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

const project: Project = {
  source: { kind: "example" },
  name: "join-fixture",
  link: { autosDir: "autos", robot: "robot.json", field: "field.json" } as Project["link"],
  robot: loadRobot(read("robot.json")),
  field: loadField(read("field/biobuzz.field.json")),
  waypoints: loadWaypoints(read("waypoints.json")),
  autoFiles: [],
  autoTexts: {},
};

const fixture = (parkExtra: Record<string, unknown> = {}): Auto =>
  loadAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "join-fixture",
    alliance: "RED",
    start: { pose: { xIn: -12, yIn: -63, headingRad: 1.5708 } },
    steps: [
      {
        id: "driveOut",
        kind: "path",
        segments: [{ kind: "line", from: { xIn: -12, yIn: -63, headingRad: 1.5708 }, to: { xIn: -12, yIn: -36 } }],
        heading: { mode: "tangent" },
      },
      {
        id: "park",
        kind: "path",
        segments: [{ kind: "line", from: "current", to: { xIn: 12, yIn: -36 } }],
        heading: { mode: "constant", headingRad: 0 },
        markers: [{ at: { distanceIn: 12 }, command: { name: "score" } }],
        ...parkExtra,
      },
    ],
  });

const pathStep = (id: string): PathStep => {
  const step = getState().auto?.steps.find((candidate) => candidate.id === id);
  if (step?.kind !== "path") throw new Error(`no path ${id}`);
  return step;
};

const open = (auto: Auto) => {
  openProject(project, { kind: "local" } as unknown as ProjectBackend);
  openAuto("join-fixture.auto.json", auto, canonicalize("auto", auto));
};

beforeEach(() => {
  setPrefs({ addPathExtends: false });
  open(fixture());
});

describe("Extend this chain", () => {
  it("is off by default, so an add-path click makes a new step after the selected one", () => {
    selectStep("driveOut");
    expect(chainToExtend()).toBeNull();
    const id = addPathStepTo({ xIn: 0, yIn: -12 });
    expect(id).not.toBe("driveOut");
    expect(getState().auto?.steps.map((step) => step.id)).toEqual(["driveOut", id, "park"]);
  });

  it("on, an add-path click adds a path to the selected step's chain and makes no new step", () => {
    setPrefs({ addPathExtends: true });
    selectStep("driveOut");
    expect(addPathStepTo({ xIn: 0, yIn: -12 })).toBe("driveOut");
    expect(getState().auto?.steps.map((step) => step.id)).toEqual(["driveOut", "park"]);
    expect(pathStep("driveOut").segments[1]).toEqual({
      kind: "line",
      from: "current",
      to: { xIn: 0, yIn: -12, provenance: "SET FROM EDITOR" },
    });
    expect(getState().selection).toEqual({ stepId: "driveOut", point: { segmentIndex: 1, pointKind: "to" } });
    expect(getState().status?.message).toContain("Added a path to driveOut.");
  });

  it("on, Insert a path adds to the chain too, and with nothing selected it makes a new step", () => {
    setPrefs({ addPathExtends: true });
    selectStep("driveOut");
    expect(addPathStep()).toBe("driveOut");
    expect(pathStep("driveOut").segments).toHaveLength(2);
    // With nothing selected there is no chain to extend, so the click makes a new step as always.
    selectStep(undefined);
    expect(chainToExtend()).toBeNull();
  });

  it("on, a selected step that is not a path has no chain to extend, so the click makes a new step after it", () => {
    setPrefs({ addPathExtends: true });
    const withCommand = loadAuto({
      ...(JSON.parse(canonicalize("auto", fixture())) as Record<string, unknown>),
      steps: [
        {
          id: "driveOut",
          kind: "path",
          segments: [{ kind: "line", from: { xIn: -12, yIn: -63, headingRad: 1.5708 }, to: { xIn: -12, yIn: -36 } }],
          heading: { mode: "tangent" },
        },
        { id: "scoreIt", kind: "command", name: "scorePreload" },
      ],
    });
    open(withCommand);
    selectStep("scoreIt");
    expect(chainToExtend()).toBeNull();
    const id = addPathStepTo({ xIn: 0, yIn: -12 });
    expect(id).not.toBe("driveOut");
    expect(getState().auto?.steps.map((step) => step.id)).toEqual(["driveOut", "scoreIt", id]);
    expect(pathStep("driveOut").segments).toHaveLength(1);
  });

  it("on, a click that lands on the chain's own end adds nothing and says so", () => {
    setPrefs({ addPathExtends: true });
    selectStep("driveOut");
    expect(addPathStepTo({ xIn: -12, yIn: -36 })).toBeNull();
    expect(pathStep("driveOut").segments).toHaveLength(1);
    expect(getState().status?.message).toContain("already ends there");
  });
});

describe("the Extend this chain toggle (0.1.2 UX sweep, W1-13)", () => {
  const toggle = (): void => {
    void actionById("tool.extendChain")?.run();
  };

  it("turned on with nothing selected says on the status line why it changes nothing yet", () => {
    selectStep(undefined);
    toggle();
    expect(getState().prefs.addPathExtends).toBe(true);
    expect(getState().status?.message).toBe("Extend this chain is on, and no path step is selected.");
    expect(getState().status?.hint).toBe("Select a path step to add to its chain.");
  });

  it("turned on with a path step selected, or turned off, says nothing", () => {
    selectStep("driveOut");
    const before = getState().status;
    toggle();
    expect(getState().prefs.addPathExtends).toBe(true);
    expect(getState().status).toBe(before);
    selectStep(undefined);
    toggle();
    expect(getState().prefs.addPathExtends).toBe(false);
    expect(getState().status).toBe(before);
  });
});

describe("Join with next path", () => {
  it("leaves one step of two paths, and one undo restores both", () => {
    selectStep("driveOut");
    expect(joinNextReason(getState().auto, "driveOut")).toBeNull();
    joinWithNext();
    expect(getState().auto?.steps.map((step) => step.id)).toEqual(["driveOut"]);
    expect(pathStep("driveOut").segments).toHaveLength(2);
    expect(pathStep("driveOut").heading?.mode).toBe("piecewise");
    expect(pathStep("driveOut").markers?.[0]?.at).toEqual({ distanceIn: 39 });
    const status = getState().status?.message ?? "";
    expect(status).toContain("Joined park onto driveOut");
    expect(status).toContain("1 marker was rewritten");
    undo();
    expect(getState().auto?.steps.map((step) => step.id)).toEqual(["driveOut", "park"]);
  });

  it("says why it cannot join, on the disabled item and on the status line", () => {
    open(fixture({ speedFraction: 0.5 }));
    selectStep("driveOut");
    expect(joinNextReason(getState().auto, "driveOut")).toMatch(/speedFraction/);
    joinWithNext();
    expect(getState().auto?.steps).toHaveLength(2);
    expect(getState().status?.kind).toBe("error");
    expect(getState().status?.message).toMatch(/speedFraction/);
    expect(joinNextReason(getState().auto, "park")).toMatch(/Nothing comes after park/);
  });
});
