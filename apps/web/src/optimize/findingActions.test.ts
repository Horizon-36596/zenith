/**
 * The finding actions' way into the Optimize card (issue #309): a finding's `optimizeRoute` fix opens
 * the card on its step, selects the step, and runs at once, in Route around mode, or as Find a faster
 * heading (`headingOnly`) for STRAFE_FRACTION. The fix writes nothing, and with the Optimize path
 * switch off it opens nothing. The Problems list leaves Route around off a collision whose own step
 * ends inside the obstacle, where the optimizer could only say the end overlaps (issue #413).
 *
 * The host is replaced by a fake that records each start, as `state.test.ts` does.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, loadAuto, loadField, loadRobot, loadWaypoints, type Fix, type OptimizeOptions, type OptimizeResult } from "@horizon36596/zenith-core";
import type { Auto } from "@horizon36596/zenith-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectBackend } from "../project/backend";
import type { Project } from "../project/types";
import { derive } from "../state/derived";
import { offeredFixes, stepsEndingInside } from "../panels/findingRows";
import { clearStatus, getState, openAuto, openProject, setSetting } from "../state/store";
import type { OptimizeEvents, OptimizeRun } from "./host";
import type { OptimizeRequest } from "./protocol";
import { ACTIONS } from "../app/actions";
import { discardOptimize, getOptimizeCard, openOptimizeFix, setOptimizeStarter } from "./state";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

const project: Project = {
  source: { kind: "example" },
  name: "finding-actions-fixture",
  link: { autosDir: "autos", robot: "robot.json", field: "field.json" } as Project["link"],
  robot: loadRobot(read("robot.json")),
  field: loadField(read("field/biobuzz.field.json")),
  waypoints: loadWaypoints(read("waypoints.json")),
  autoFiles: [],
  autoTexts: {},
};

const STEP = "toOtherSide";

const routeAround: Fix = {
  kind: "optimizeRoute",
  stepId: STEP,
  label: "Route around the north-west leg of the hive frame",
  params: { obstacleId: "frameLegNorthWest" },
};
const fasterHeading: Fix = { kind: "optimizeRoute", stepId: STEP, label: "Find a faster heading", params: { mode: "headingOnly" } };

let starts: { request: OptimizeRequest; options: OptimizeOptions }[] = [];

beforeEach(() => {
  starts = [];
  setOptimizeStarter((request, options) => {
    starts.push({ request, options });
    return { engine: "slices", state: "running", stop: () => undefined, continue: () => undefined, cancel: () => undefined } as OptimizeRun;
  });
  const auto = loadAuto(read("collect-and-score.auto.json"));
  openProject(project, { kind: "local" } as unknown as ProjectBackend);
  openAuto("collect-and-score.auto.json", auto, canonicalize("auto", auto));
  setSetting("features.optimizer", true);
});

afterEach(() => {
  discardOptimize();
  setOptimizeStarter(null);
});

describe("a finding's optimizeRoute fix", () => {
  it("opens the card on its step in Route around mode, selects the step and runs at once", () => {
    expect(openOptimizeFix(routeAround)).toBe(true);
    const card = getOptimizeCard();
    expect(card?.stepId).toBe(STEP);
    expect(card?.phase).toBe("running");
    expect(card?.action).toEqual({ label: "Route around the north-west leg of the hive frame", routeAround: true });
    expect(getState().selection.stepId).toBe(STEP);
    expect(starts).toHaveLength(1);
    expect(starts[0]?.request.stepId).toBe(STEP);
    expect(starts[0]?.options).toMatchObject({ mode: "routeAndHeading", routeAround: true });
  });

  it("opens as Find a faster heading for headingOnly, which never asks to route around", () => {
    expect(openOptimizeFix(fasterHeading)).toBe(true);
    const card = getOptimizeCard();
    expect(card?.mode).toBe("headingOnly");
    expect(card?.action).toEqual({ label: "Find a faster heading", routeAround: false });
    expect(starts[0]?.options.mode).toBe("headingOnly");
    expect(starts[0]?.options.routeAround).toBeFalsy();
  });

  it("a plain open from the palette is not in either mode, even right after a fix opened the card", () => {
    const optimize = ACTIONS.find((action) => action.id === "path.optimize");
    if (optimize === undefined) throw new Error("the palette has no Optimize path");
    expect(openOptimizeFix(routeAround)).toBe(true);
    expect(getOptimizeCard()?.action?.routeAround).toBe(true);
    void optimize.run();
    const card = getOptimizeCard();
    expect(card?.stepId).toBe(STEP);
    expect(card?.action).toBeNull();
    expect(card?.mode).toBe("routeAndHeading");
    expect(starts).toHaveLength(2);
    expect(starts[1]?.options.mode).toBe("routeAndHeading");
    expect(starts[1]?.options.routeAround).toBeFalsy();

    // And after Find a faster heading, a plain open moves the geometry again.
    expect(openOptimizeFix(fasterHeading)).toBe(true);
    void optimize.run();
    expect(getOptimizeCard()?.mode).toBe("routeAndHeading");
    expect(getOptimizeCard()?.action).toBeNull();
    expect(starts[3]?.options.mode).toBe("routeAndHeading");
  });

  it("opens nothing while the Optimize path switch is off", () => {
    setSetting("features.optimizer", false);
    expect(openOptimizeFix(routeAround)).toBe(false);
    expect(getOptimizeCard()).toBeNull();
    expect(starts).toHaveLength(0);
  });

  it("opens nothing for a step that is not a path in the open auto", () => {
    expect(openOptimizeFix({ ...routeAround, stepId: "nowhere" })).toBe(false);
    expect(getOptimizeCard()).toBeNull();
  });

  it("opens nothing for another kind of fix", () => {
    expect(openOptimizeFix({ kind: "makeTangent", stepId: STEP, label: "Point the nose along the path", params: {} })).toBe(false);
    expect(getOptimizeCard()).toBeNull();
  });

  it("writes nothing to the auto", () => {
    const before = getState().auto;
    openOptimizeFix(routeAround);
    expect(getState().auto).toBe(before);
  });
});

describe("Route around on a collision", () => {
  /** One path along the hive frame's west base bar, from south of it to `endYIn`. */
  const alongTheBar = (endYIn: number): Auto =>
    loadAuto({
      $schema: "https://libraries.horizon36596.org/zenith/schema/v1/auto.json",
      formatVersion: 4,
      name: "along-the-bar",
      alliance: "RED",
      start: { pose: { xIn: -23.65, yIn: -40, headingRad: 1.5708 } },
      steps: [
        {
          id: "pastTheHive",
          kind: "path",
          segments: [{ kind: "line", from: "current", to: { xIn: -23.65, yIn: endYIn, provenance: "SET FROM EDITOR" } }],
          heading: { mode: "constant", headingRad: 1.5708 },
        },
      ],
    });
  const structures = (auto: Auto) =>
    derive(auto, project.robot, project.field, project.waypoints).findings.filter((finding) => finding.code === "STRUCTURE");

  it("is offered when the path goes through the obstacle and out the other side", () => {
    const through = structures(alongTheBar(40));
    expect(through.length).toBeGreaterThan(0);
    for (const finding of through) {
      expect(offeredFixes(finding).some((fix) => fix.kind === "optimizeRoute")).toBe(true);
    }
  });

  it("is not offered when the step's own end lies inside the obstacle, though core still lists it", () => {
    const inside = structures(alongTheBar(0)).filter((finding) => finding.geometry?.tRange?.[1] === 1);
    expect(inside.length).toBeGreaterThan(0);
    for (const finding of inside) {
      expect(finding.fixes?.some((fix) => fix.kind === "optimizeRoute")).toBe(true);
      expect(offeredFixes(finding).some((fix) => fix.kind === "optimizeRoute")).toBe(false);
    }
    // Nor on the step's other collisions, which the optimizer could only answer the same way.
    const all = structures(alongTheBar(0));
    const endsInside = stepsEndingInside(all);
    expect([...endsInside]).toEqual(["pastTheHive"]);
    for (const finding of all) expect(offeredFixes(finding, endsInside).some((fix) => fix.kind === "optimizeRoute")).toBe(false);
  });
});

describe("Discard on a result (UI_GUIDE 9.15)", () => {
  it("says the route was discarded and the auto is unchanged, and says nothing while nothing was found", () => {
    let events: OptimizeEvents | null = null;
    setOptimizeStarter((_request, _options, given) => {
      events = given;
      return { engine: "slices", state: "running", stop: () => undefined, continue: () => undefined, cancel: () => undefined } as OptimizeRun;
    });
    clearStatus();
    expect(openOptimizeFix(routeAround)).toBe(true);
    discardOptimize();
    expect(getState().status).toBeNull();

    expect(openOptimizeFix(routeAround)).toBe(true);
    const before = getState().auto;
    (events as OptimizeEvents | null)?.done?.({} as OptimizeResult);
    expect(getOptimizeCard()?.phase).toBe("result");
    discardOptimize();
    expect(getOptimizeCard()).toBeNull();
    expect(getState().auto).toBe(before);
    expect(getState().status).toMatchObject({ kind: "info", message: "Discarded the route. The auto is unchanged." });
  });
});
