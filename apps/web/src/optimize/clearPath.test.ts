/**
 * Add a clear path here (issue #310): the field's right-click item builds a path step from where the
 * robot is to the point, or from the end of the selected chain with Extend this chain on, and opens it
 * in the Optimize card in Route around mode with both ends fixed. Nothing is written until Apply, which
 * adds the chosen route as one undo step: a new step, or paths appended to the chain. The card's
 * switcher steps through the pick and its alternatives.
 *
 * The host is replaced by a fake that records each start, as in `state.test.ts`; the result it
 * hands back is a real one, from `runOptimize` on the request the card sent, with a small budget.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  canonicalize,
  ledgerStateAfter,
  legalApproachEnd,
  loadAuto,
  loadField,
  loadRobot,
  loadWaypoints,
  runOptimize,
  setSpeed,
  wrapAngle,
  type OptimizedRoute,
  type OptimizeOptions,
  type OptimizeResult,
} from "@horizon36596/zenith-core";
import type { Auto, PathStep } from "@horizon36596/zenith-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectBackend } from "../project/backend";
import type { Project } from "../project/types";
import { canvasActions } from "../app/canvasMenu";
import { anchorEndPose, tryEdit } from "../app/edits";
import { currentDerived, getState, openAuto, openProject, selectStep, setSetting, undo } from "../state/store";
import { inputOf } from "./driver";
import type { OptimizeEvents, OptimizeRun } from "./host";
import type { OptimizeRequest } from "./protocol";
import {
  applyOptimize,
  canApply,
  chooseOptimizeRoute,
  discardOptimize,
  getOptimizeCard,
  openClearPath,
  optimizeRoutes,
  runOptimizeCard,
  setOptimizeStarter,
  stepOptimizeRoute,
} from "./state";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

const project: Project = {
  source: { kind: "example" },
  name: "clear-path-fixture",
  link: { autosDir: "autos", robot: "robot.json", field: "field.json" } as Project["link"],
  robot: loadRobot(read("robot.json")),
  field: loadField(read("field/biobuzz.field.json")),
  waypoints: loadWaypoints(read("waypoints.json")),
  autoFiles: [],
  autoTexts: {},
};

/** Past the hive from where the routine ends, at scoreNorth: the straight line drives into the frame. */
const PAST_THE_HIVE = { xIn: -45, yIn: -10 };

interface Start {
  request: OptimizeRequest;
  options: OptimizeOptions;
  events: OptimizeEvents;
  run: OptimizeRun & { calls: string[] };
}

let starts: Start[] = [];

beforeEach(() => {
  starts = [];
  setOptimizeStarter((request, options, events) => {
    const calls: string[] = [];
    const run = {
      engine: "slices" as const,
      state: "running" as const,
      calls,
      stop: () => calls.push("stop"),
      continue: () => calls.push("continue"),
      cancel: () => calls.push("cancel"),
    };
    starts.push({ request, options, events, run });
    return run;
  });
  const auto = loadAuto(read("collect-and-score.auto.json"));
  openProject(project, { kind: "local" } as unknown as ProjectBackend);
  openAuto("collect-and-score.auto.json", auto, canonicalize("auto", auto));
  setSetting("features.optimizer", true);
  setSetting("editing.addPathExtends", false);
  setSetting("editing.defaultHeading", "linear");
  setSetting("editing.newPathKeepsHeading", false);
});

afterEach(() => {
  discardOptimize();
  setOptimizeStarter(null);
});

const last = (): Start => {
  const start = starts[starts.length - 1];
  if (start === undefined) throw new Error("no run was started");
  return start;
};

const pathStep = (auto: Auto | null, id: string): PathStep => {
  const step = auto?.steps.find((candidate) => candidate.id === id);
  if (step?.kind !== "path") throw new Error(`${id} is not a top-level path step`);
  return step;
};

/** The draft step the card was opened on, as the run was asked to optimize it. */
const draftStep = (start: Start): PathStep => pathStep(start.request.auto, start.request.stepId);

/** A real result for the request the card sent, with a small budget so the test stays quick. */
const realResult = (start: Start): OptimizeResult => runOptimize(inputOf(start.request), { ...start.options, budget: 150 });

/** A result whose pick and alternatives are the given routes, each a straight chain through `via`. */
function resultWith(start: Start, vias: { xIn: number; yIn: number }[][]): OptimizeResult {
  const original = draftStep(start);
  const end = original.segments[0]?.to;
  if (end === undefined) throw new Error("the draft has no end");
  const routes: OptimizedRoute[] = vias.map((via) => {
    const step: PathStep = {
      ...original,
      segments: [...via.map((point) => ({ kind: "line" as const, from: "current" as const, to: point })), { kind: "line", from: "current", to: end }],
    };
    return {
      step,
      label: null,
      t0: { before: { windowEndS: 3, ownS: 3 }, after: { windowEndS: 4, ownS: 4 } },
      t1: { before: { windowEndS: 3, ownS: 3 }, after: { windowEndS: 4.2, ownS: 4.2 } },
      gainS: null,
      closest: { kind: "structure", id: "frameBarWest", clearanceIn: 2 },
      movedMarkers: [],
      findingsAdded: [],
      findingsRemoved: [],
      changes: [`Through ${JSON.stringify(via)}.`],
      note: null,
    };
  });
  const [pick, ...alternatives] = routes;
  return {
    status: "improved",
    stepId: start.request.stepId,
    mode: "routeAndHeading",
    step: pick?.step ?? null,
    pick: pick ?? null,
    alternatives,
    scorer: "sim",
    scorerReason: null,
    marginIn: 1,
    movedMarkers: [],
    findingsAdded: [],
    findingsRemoved: [],
    changes: pick?.changes ?? [],
    notes: [],
    evaluations: 150,
    budget: 150,
    inputKey: "test",
    closest: null,
    originalBlocked: null,
  };
}

describe("the right-click item", () => {
  const item = () => canvasActions({ kind: "field", atIn: PAST_THE_HIVE }).find((action) => action.id === "field.addClearPathHere");

  it("is offered on an empty field point after Add a path to here and Add waypoint here, and opens the card on the point", () => {
    const ids = canvasActions({ kind: "field", atIn: PAST_THE_HIVE }).map((action) => action.id);
    expect(ids.indexOf("field.addClearPathHere")).toBe(ids.indexOf("field.addWaypointHere") + 1);
    expect(item()?.label).toBe("Add a clear path here");
    expect(item()?.enabled).toBe(true);
    item()?.run();
    expect(getOptimizeCard()?.draft).not.toBeNull();
  });

  it("is gone with the Optimize path switch off", () => {
    setSetting("features.optimizer", false);
    expect(item()).toBeUndefined();
  });
});

describe("opening the card on a clear path", () => {
  it("runs at once in Route around mode on a new path from where the robot is to the point, and writes nothing", () => {
    const auto = getState().auto;
    expect(openClearPath(PAST_THE_HIVE)).toBe(true);
    const card = getOptimizeCard();
    expect(card?.phase).toBe("running");
    expect(card?.action).toEqual({ label: "Add a clear path here", routeAround: true });
    const start = last();
    expect(start.options.routeAround).toBe(true);
    expect(start.request.auto.steps).toHaveLength((auto?.steps.length ?? 0) + 1);
    const step = draftStep(start);
    expect(card?.stepId).toBe(step.id);
    expect(start.request.auto.steps[start.request.auto.steps.length - 1]).toBe(step);
    expect(step.segments).toEqual([{ kind: "line", from: "current", to: { ...PAST_THE_HIVE, provenance: "SET FROM EDITOR" } }]);
    expect(getState().auto).toBe(auto);
  });

  it("ends on the heading the person's default mode gives, Linear facing the way it drives unless set", () => {
    openClearPath(PAST_THE_HIVE);
    // The routine ends at scoreNorth, (-13, 44), facing about south, as driveBack arrives there.
    const arrival = anchorEndPose().headingRad;
    const bearing = Math.atan2(PAST_THE_HIVE.yIn - 44, PAST_THE_HIVE.xIn + 13);
    expect(draftStep(last()).heading).toEqual({ mode: "linear", fromRad: arrival, toRad: arrival + wrapAngle(bearing - arrival) });
    discardOptimize();
    setSetting("editing.defaultHeading", "constant");
    openClearPath(PAST_THE_HIVE);
    expect(draftStep(last()).heading).toEqual({ mode: "constant", headingRad: arrival });
  });

  it("starts at the heading the robot has and ends there with Start a new path with the previous path's end heading on (issue #435)", () => {
    setSetting("editing.newPathKeepsHeading", true);
    openClearPath(PAST_THE_HIVE);
    const arrival = anchorEndPose().headingRad;
    expect(draftStep(last()).heading).toEqual({ mode: "linear", fromRad: arrival, toRad: arrival });
    discardOptimize();
    setSetting("editing.defaultHeading", "tangent");
    openClearPath(PAST_THE_HIVE);
    expect(draftStep(last()).heading).toEqual({ mode: "tangent" });
  });

  it("ends facing the season's target when the point is a legal approach to it", () => {
    const point = { xIn: -36, yIn: -36 };
    const derived = currentDerived();
    const run = derived.ledgerRun;
    if (run === null) throw new Error("the starter has a ledger");
    const expected = legalApproachEnd(derived.season, ledgerStateAfter(run, () => true), "RED", point, 0, project.robot);
    if (expected === null) throw new Error("the point should be a legal approach to the up cell");
    openClearPath(point);
    const heading = draftStep(last()).heading;
    if (heading?.mode !== "linear") throw new Error("expected a linear heading to the approach");
    expect(wrapAngle(heading.toRad - expected.headingRad)).toBeCloseTo(0, 9);
  });

  it("still ends facing the season's target at a legal approach with Start a new path with the previous path's end heading on, but starts at the arrival heading (issue #435)", () => {
    setSetting("editing.newPathKeepsHeading", true);
    const point = { xIn: -36, yIn: -36 };
    const derived = currentDerived();
    const run = derived.ledgerRun;
    if (run === null) throw new Error("the starter has a ledger");
    const expected = legalApproachEnd(derived.season, ledgerStateAfter(run, () => true), "RED", point, 0, project.robot);
    if (expected === null) throw new Error("the point should be a legal approach to the up cell");
    openClearPath(point);
    const heading = draftStep(last()).heading;
    if (heading?.mode !== "linear") throw new Error("expected a linear heading to the approach");
    expect(heading.fromRad).toBeCloseTo(anchorEndPose().headingRad, 9);
    expect(wrapAngle(heading.toRad - expected.headingRad)).toBeCloseTo(0, 9);
  });

  it("refuses a spot inside a structure at once, before any search, and says where to right-click instead (0.1.2 UX review)", () => {
    const auto = getState().auto;
    // On the hive frame's west base bar, which stands on the floor.
    expect(openClearPath({ xIn: -23.65, yIn: 0 })).toBe(false);
    expect(starts).toHaveLength(0);
    expect(getOptimizeCard()).toBeNull();
    expect(getState().status).toMatchObject({ kind: "warn" });
    expect(getState().status?.message).toMatch(/^That spot is inside .*hive frame.*\. Right-click somewhere clear of it\.$/);
    expect(getState().auto).toBe(auto);
  });

  it("says what the right-click item does in its tooltip", () => {
    const item = canvasActions({ kind: "field", atIn: PAST_THE_HIVE }).find((action) => action.id === "field.addClearPathHere");
    expect(item?.hint).toMatch(/goes round the structures\. Nothing changes until you apply it\.$/);
  });

  it("does nothing with the switch off, and opens nothing", () => {
    setSetting("features.optimizer", false);
    expect(openClearPath(PAST_THE_HIVE)).toBe(false);
    expect(getOptimizeCard()).toBeNull();
    expect(starts).toHaveLength(0);
  });
});

describe("Apply on a clear path", () => {
  it("adds the route as one new step in one undo step, and one Undo restores the identical auto", () => {
    const before = getState().auto;
    const beforeText = canonicalize("auto", before);
    const undoDepth = getState().undo.length;
    openClearPath(PAST_THE_HIVE);
    const start = last();
    const result = realResult(start);
    expect(result.step).not.toBeNull();
    start.events.done?.(result);
    expect(canApply(getOptimizeCard())).toBe(true);
    applyOptimize();

    expect(getOptimizeCard()).toBeNull();
    const after = getState();
    expect(after.undo.length).toBe(undoDepth + 1);
    expect(after.auto?.steps).toHaveLength((before?.steps.length ?? 0) + 1);
    const added = pathStep(after.auto, start.request.stepId);
    expect(added.segments).toEqual(result.step?.segments);
    expect(added.heading).toEqual(result.step?.heading);
    expect(after.selection.stepId).toBe(start.request.stepId);
    expect(after.status?.message).toMatch(new RegExp(`^Added ${start.request.stepId}, a clear path to here`));

    undo();
    expect(canonicalize("auto", getState().auto)).toBe(beforeText);
  }, 120_000);

  it("adds the straight path as it is when it is already clear and nothing is faster", () => {
    const before = getState().auto;
    // Clear of the centre line: a spot over it is refused before any run.
    openClearPath({ xIn: -12, yIn: 56 });
    const start = last();
    start.events.done?.({ ...resultWith(start, []), status: "noBetter", changes: ["No faster route was found that keeps the margin, so the original stays as it is."] });
    expect(canApply(getOptimizeCard())).toBe(true);
    applyOptimize();
    const added = pathStep(getState().auto, start.request.stepId);
    expect(added).toEqual(draftStep(start));
    expect(getState().auto?.steps).toHaveLength((before?.steps.length ?? 0) + 1);
  });

  it("with Extend this chain on, appends the route as paths of the selected chain and adds no step", () => {
    setSetting("editing.addPathExtends", true);
    selectStep("sweepGarden");
    const before = getState().auto;
    const chain = pathStep(before, "sweepGarden");
    const undoDepth = getState().undo.length;
    openClearPath({ xIn: -40, yIn: -40 });
    const start = last();
    // The draft runs from the chain's end, straight after it.
    const draft = draftStep(start);
    const ids = start.request.auto.steps.map((step) => step.id);
    expect(ids[ids.indexOf("sweepGarden") + 1]).toBe(draft.id);
    expect(draft.segments[0]?.from).toBe("current");
    start.events.done?.(resultWith(start, [[{ xIn: -50, yIn: -50 }]]));
    applyOptimize();

    const after = getState();
    expect(after.undo.length).toBe(undoDepth + 1);
    expect(after.auto?.steps.map((step) => step.id)).toEqual(before?.steps.map((step) => step.id));
    const extended = pathStep(after.auto, "sweepGarden");
    expect(extended.segments).toHaveLength(chain.segments.length + 2);
    expect(extended.segments.slice(0, chain.segments.length)).toEqual(chain.segments);
    expect(extended.segments.slice(chain.segments.length).map((segment) => segment.to)).toEqual([{ xIn: -50, yIn: -50 }, draft.segments[0]?.to]);
    expect(after.status?.message).toMatch(/^Added 2 paths to sweepGarden, a clear path to here/);
    expect(after.selection.stepId).toBe("sweepGarden");
  });

  it("refuses Extend this chain on a path inside a parallel group before any run, since Apply could not join it", () => {
    const grouped = loadAuto(read("all-step-kinds.auto.json"));
    openAuto("all-step-kinds.auto.json", grouped, canonicalize("auto", grouped));
    setSetting("editing.addPathExtends", true);
    selectStep("driveToGarden");
    expect(openClearPath({ xIn: -40, yIn: -40 })).toBe(false);
    expect(getOptimizeCard()).toBeNull();
    expect(starts).toHaveLength(0);
    expect(getState().auto).toBe(grouped);
    expect(getState().status?.message).toBe(
      "driveToGarden runs in the parallel group toGarden, so Extend this chain cannot add a clear path after it. Select a step outside the group, or turn Extend this chain off.",
    );
  });

  it("keeps the card and its result open when the edit is refused, and writes nothing", () => {
    const before = getState().auto;
    openClearPath(PAST_THE_HIVE);
    const start = last();
    const result = resultWith(start, [[{ xIn: -40, yIn: 40 }]]);
    // A route that ends somewhere else, which setRoute refuses.
    const moved: PathStep = { ...(result.step as PathStep), segments: [{ kind: "line", from: "current", to: { xIn: 0, yIn: 0 } }] };
    const refused: OptimizeResult = { ...result, step: moved, pick: { ...(result.pick as OptimizedRoute), step: moved } };
    start.events.done?.(refused);
    applyOptimize();
    expect(getState().auto).toBe(before);
    expect(getState().status).toMatchObject({ kind: "error" });
    expect(getState().status?.message).toContain("A new route keeps both ends.");
    expect(getOptimizeCard()).toMatchObject({ phase: "result", result: refused });
  });

  it("goes stale on an edit to the open auto, and then writes nothing", () => {
    openClearPath(PAST_THE_HIVE);
    const start = last();
    expect(getOptimizeCard()?.stale).toBe(false);
    start.events.done?.(resultWith(start, [[{ xIn: -40, yIn: 40 }]]));
    expect(getOptimizeCard()?.stale).toBe(false);
    tryEdit((auto) => setSpeed(auto, "driveOut", 0.5));
    const edited = getState().auto;
    expect(getOptimizeCard()).toMatchObject({ stale: true });
    applyOptimize();
    expect(getState().auto).toBe(edited);
  });

  it("Discard leaves the auto at the same object", () => {
    const auto = getState().auto;
    openClearPath(PAST_THE_HIVE);
    last().events.done?.(resultWith(last(), [[{ xIn: -40, yIn: 40 }]]));
    discardOptimize();
    expect(getOptimizeCard()).toBeNull();
    expect(getState().auto).toBe(auto);
  });
});

describe("Run again on a clear path after an edit", () => {
  it("builds the draft afresh on the open auto as it is now, and Apply adds the route to it", () => {
    openClearPath(PAST_THE_HIVE);
    const first = last();
    tryEdit((auto) => setSpeed(auto, "driveOut", 0.5));
    const edited = getState().auto as Auto;
    expect(getOptimizeCard()?.stale).toBe(true);

    runOptimizeCard();
    expect(first.run.calls).toContain("cancel");
    expect(starts).toHaveLength(2);
    const again = last();
    const card = getOptimizeCard();
    expect(card?.draft?.base).toBe(edited);
    expect(card?.stepId).toBe(again.request.stepId);
    expect(card?.draft?.stepId).toBe(again.request.stepId);
    expect(card?.draft?.target).toEqual(PAST_THE_HIVE);
    // The run optimizes the edited auto with the new draft in it, not the old draft.
    expect(again.request.auto).not.toBe(first.request.auto);
    expect(pathStep(again.request.auto, "driveOut").speedFraction).toBe(0.5);
    expect(again.request.auto.steps).toHaveLength(edited.steps.length + 1);

    again.events.done?.(resultWith(again, [[{ xIn: -40, yIn: 40 }]]));
    expect(getOptimizeCard()?.stale).toBe(false);
    applyOptimize();
    expect(getOptimizeCard()).toBeNull();
    expect(getState().auto?.steps).toHaveLength(edited.steps.length + 1);
    expect(pathStep(getState().auto, "driveOut").speedFraction).toBe(0.5);
    expect(pathStep(getState().auto, again.request.stepId).segments[0]?.to).toEqual({ xIn: -40, yIn: 40 });
  });

  it("fails with a sentence, and starts nothing, when the draft can no longer be built", () => {
    setSetting("editing.addPathExtends", true);
    selectStep("toScoreNorth");
    openClearPath(PAST_THE_HIVE);
    const first = last();
    expect(getOptimizeCard()?.draft?.chainId).toBe("toScoreNorth");
    // The chain now ends on the point itself, so a clear path to it would have no length.
    tryEdit((auto) => ({
      ...auto,
      steps: auto.steps.map((step) =>
        step.id === "toScoreNorth" && step.kind === "path"
          ? { ...step, segments: [{ kind: "line" as const, from: "current" as const, to: { ...PAST_THE_HIVE } }] }
          : step,
      ),
    }));
    runOptimizeCard();
    expect(starts).toHaveLength(1);
    expect(first.run.calls).toContain("cancel");
    expect(getOptimizeCard()).toMatchObject({ phase: "failed", message: "A clear path cannot be added here now.", result: null });
  });
});

describe("the alternatives switcher", () => {
  it("steps through the pick and its alternatives, and Apply writes the one shown", () => {
    openClearPath(PAST_THE_HIVE);
    const start = last();
    const result = resultWith(start, [[{ xIn: -40, yIn: 40 }], [{ xIn: 0, yIn: -40 }], [{ xIn: -60, yIn: 30 }]]);
    start.events.done?.(result);
    const card = getOptimizeCard();
    expect(optimizeRoutes(card)).toHaveLength(3);
    expect(card?.choice).toBe(0);
    stepOptimizeRoute(1);
    expect(getOptimizeCard()?.choice).toBe(1);
    stepOptimizeRoute(1);
    stepOptimizeRoute(1);
    expect(getOptimizeCard()?.choice).toBe(0);
    stepOptimizeRoute(-1);
    expect(getOptimizeCard()?.choice).toBe(2);
    chooseOptimizeRoute(1);
    applyOptimize();
    expect(pathStep(getState().auto, start.request.stepId).segments).toEqual(result.alternatives[0]?.step.segments);
  });

  it("starts from the pick on every new result", () => {
    openClearPath(PAST_THE_HIVE);
    const start = last();
    start.events.done?.(resultWith(start, [[{ xIn: -40, yIn: 40 }], [{ xIn: 0, yIn: -40 }]]));
    chooseOptimizeRoute(1);
    start.events.done?.(resultWith(start, [[{ xIn: -40, yIn: 40 }], [{ xIn: 0, yIn: -40 }]]));
    expect(getOptimizeCard()?.choice).toBe(0);
  });
});
