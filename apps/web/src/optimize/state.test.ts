/**
 * The Optimize card's state (issue #308): opening it on a path chain, a run's progress and result,
 * Apply as one undo step with its status line, Discard leaving the auto at the same object identity
 * with the plan memo's hits unchanged, a result going stale on an edit, the margin field's re-run after
 * a 300 ms debounce, and the feature switch.
 *
 * The host is replaced by a fake that records each start, so the test drives the run's events
 * itself; the result it hands back is a real one, from `runOptimize` on the starter's
 * `toOtherSide` with a small budget.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  canonicalize,
  flattenSteps,
  loadAuto,
  loadField,
  loadRobot,
  loadWaypoints,
  plan,
  resolve,
  robotClearanceIn,
  runOptimize,
  setSpeed,
  type OptimizeOptions,
  type OptimizeResult,
} from "@horizon36596/zenith-core";
import type { Auto, PathStep } from "@horizon36596/zenith-schema";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectBackend } from "../project/backend";
import type { Project } from "../project/types";
import { closeProject, currentDerived, getState, openAuto, openProject, selectStep, setSetting, undo } from "../state/store";
import { tryEdit } from "../app/edits";
import type { OptimizeEvents, OptimizeRun } from "./host";
import type { OptimizeRequest } from "./protocol";
import {
  MARGIN_RERUN_MS,
  allTotalLine,
  canRetryOptimizeStep,
  appliedAllLine,
  appliedLine,
  applyOptimize,
  clearedCount,
  continueOptimize,
  discardOptimize,
  getOptimizeCard,
  canApply,
  openOptimize,
  openOptimizeAll,
  optimizeAllBlockedReason,
  optimizeBlockedReason,
  pathStepIds,
  savedS,
  setOptimizeAllAccepted,
  totalSavedS,
  setOptimizeMargin,
  setOptimizeStarter,
  retryOptimizeStep,
  stopOptimize,
  type OptimizeAllStep,
} from "./state";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

/** collect-and-score with a toOtherSide round the west of the hive frame that has a faster way round (issues #365 and #367). */
const wideAuto = (): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL("../../../../packages/core/test-fixtures/wide-collect-and-score.auto.json", import.meta.url)), "utf8"));

const project: Project = {
  source: { kind: "example" },
  name: "optimize-card-fixture",
  link: { autosDir: "autos", robot: "robot.json", field: "field.json" } as Project["link"],
  robot: loadRobot(read("robot.json")),
  field: loadField(read("field/biobuzz.field.json")),
  waypoints: loadWaypoints(read("waypoints.json")),
  autoFiles: [],
  autoTexts: {},
};

const STEP = "toOtherSide";

interface Start {
  request: OptimizeRequest;
  options: OptimizeOptions;
  events: OptimizeEvents;
  run: OptimizeRun & { calls: string[] };
}

let starts: Start[] = [];
let improved: OptimizeResult;
/** A second step's real result, for Optimize every path. */
const SECOND = "collectFlower";
let improvedSecond: OptimizeResult;

beforeAll(() => {
  const auto = loadAuto(wideAuto());
  // With the season's rules, as the editor runs it (issue #365).
  const season = resolveSeason(project.field).rules;
  improved = runOptimize({ auto, robot: project.robot, field: project.field, waypoints: project.waypoints, season, stepId: STEP }, { budget: 200 });
  improvedSecond = runOptimize({ auto, robot: project.robot, field: project.field, waypoints: project.waypoints, season, stepId: SECOND }, { budget: 200 });
}, 60_000);

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
  const auto = loadAuto(wideAuto());
  openProject(project, { kind: "local" } as unknown as ProjectBackend);
  openAuto("collect-and-score.auto.json", auto, canonicalize("auto", auto));
  setSetting("features.optimizer", true);
});

afterEach(() => {
  discardOptimize();
  setOptimizeStarter(null);
  vi.useRealTimers();
});

const last = (): Start => {
  const start = starts[starts.length - 1];
  if (start === undefined) throw new Error("no run was started");
  return start;
};

const pathStep = (auto: Auto | null, id: string): PathStep => {
  const step = auto?.steps.find((candidate) => candidate.id === id);
  if (step?.kind !== "path") throw new Error(`${id} is not a path step`);
  return step;
};

describe("opening the card", () => {
  it("with options shows them, with the robot's clearance as the margin, and starts nothing", () => {
    expect(openOptimize({ stepId: STEP, withOptions: true })).toBe(true);
    const card = getOptimizeCard();
    expect(card?.phase).toBe("options");
    expect(card?.stepId).toBe(STEP);
    expect(card?.marginIn).toBe(robotClearanceIn(project.robot));
    expect(starts).toHaveLength(0);
  });

  it("without options runs at once on the open auto, with the remembered options and the margin", () => {
    setSetting("optimizer.scorer", "estimate");
    setSetting("optimizer.allowRanges", false);
    openOptimize({ stepId: STEP });
    expect(getOptimizeCard()?.phase).toBe("running");
    const start = last();
    expect(start.request.auto).toBe(getState().auto);
    expect(start.request.stepId).toBe(STEP);
    expect(start.request.withSeason).toBe(true);
    expect(start.options).toMatchObject({ scorer: "estimate", allowRanges: false, allowSplit: true, marginIn: robotClearanceIn(project.robot) });
  });

  it("passes the remembered heading holds only when they are on (issue #448)", () => {
    openOptimize({ stepId: STEP });
    expect(last().options).not.toHaveProperty("holdStartHeadingIn");
    expect(last().options).not.toHaveProperty("holdEndHeadingIn");
    setSetting("optimizer.holdEndHeadingIn", 12);
    openOptimize({ stepId: STEP });
    expect(last().options).toMatchObject({ holdEndHeadingIn: 12 });
    expect(last().options).not.toHaveProperty("holdStartHeadingIn");
  });

  it("refuses a step that is not a path, and does nothing with the switch off", () => {
    expect(openOptimize({ stepId: "shootPreloads" })).toBe(false);
    expect(getOptimizeCard()).toBeNull();
    setSetting("features.optimizer", false);
    expect(openOptimize({ stepId: STEP })).toBe(false);
    expect(getOptimizeCard()).toBeNull();
    expect(starts).toHaveLength(0);
  });

  it("closes when the switch is turned off while it is open, and cancels the run", () => {
    openOptimize({ stepId: STEP });
    setSetting("features.optimizer", false);
    expect(getOptimizeCard()).toBeNull();
    expect(last().run.calls).toContain("cancel");
  });
});

describe("a run", () => {
  it("shows progress, then the result, and Stop and Continue reach the host", () => {
    openOptimize({ stepId: STEP });
    const { events, run } = last();
    events.progress?.({ evaluations: 25, budget: 1150, bestJ: 6.9, phase: "seeds" });
    expect(getOptimizeCard()?.progress?.evaluations).toBe(25);
    stopOptimize();
    expect(run.calls).toEqual(["stop"]);
    expect(getOptimizeCard()?.phase).toBe("stopping");
    events.stopped?.({ ...improved, status: "stoppedEarly" }, "stop");
    expect(getOptimizeCard()).toMatchObject({ phase: "result", paused: true, stopReason: "stop" });
    continueOptimize();
    expect(run.calls).toEqual(["stop", "continue"]);
    expect(getOptimizeCard()).toMatchObject({ phase: "running", paused: false });
    events.done?.(improved);
    expect(getOptimizeCard()).toMatchObject({ phase: "result", paused: false, result: improved });
  });

  it("says why it failed", () => {
    openOptimize({ stepId: STEP });
    last().events.failed?.("The optimizer stopped with an error. Run it again.");
    expect(getOptimizeCard()).toMatchObject({ phase: "failed", message: "The optimizer stopped with an error. Run it again." });
  });
});

describe("Apply", () => {
  it("writes the route in one undo step, says so on the status line, and one Undo restores the identical auto", () => {
    const before = getState().auto;
    const beforeText = canonicalize("auto", before);
    const undoDepth = getState().undo.length;
    openOptimize({ stepId: STEP });
    last().events.done?.(improved);
    applyOptimize();

    expect(getOptimizeCard()).toBeNull();
    const after = getState();
    expect(after.undo.length).toBe(undoDepth + 1);
    const step = pathStep(after.auto, STEP);
    expect(step.segments).toEqual(improved.step?.segments);
    expect(step.heading).toEqual(improved.step?.heading);
    expect(step.id).toBe(STEP);
    const t1 = improved.pick?.t1;
    if (t1 === null || t1 === undefined) throw new Error("the fixture's pick has no instant sim times");
    expect(after.status?.message).toBe(`Optimized ${STEP}: ${t1.before.ownS.toFixed(2)} s → ${t1.after.ownS.toFixed(2)} s (instant sim). Press Ctrl Z to undo.`);

    undo();
    expect(canonicalize("auto", getState().auto)).toBe(beforeText);
    expect(getState().auto).toEqual(before);
  });

  it("does nothing once the auto has changed since the run, and the card says to run again", () => {
    openOptimize({ stepId: STEP });
    last().events.done?.(improved);
    tryEdit((auto) => setSpeed(auto, "driveOut", 0.5));
    const edited = getState().auto;
    expect(getOptimizeCard()).toMatchObject({ stale: true, message: "The auto changed. Run again." });
    applyOptimize();
    expect(getState().auto).toBe(edited);
    expect(getOptimizeCard()).not.toBeNull();
  });

  it("says a route round a blocked original is clear of what it went through, with its time (issue #388)", () => {
    const blocked = blockedResult(SECOND);
    const t1 = blocked.pick?.t1;
    if (t1 === null || t1 === undefined) throw new Error("the blocked fixture has no instant sim times");
    expect(appliedLine(blocked)).toBe(
      `Routed ${SECOND} clear of the west base bar of the hive frame: ${t1.before.ownS.toFixed(2)} s → ${t1.after.ownS.toFixed(2)} s (instant sim).`,
    );
    expect(appliedLine(improved)).toMatch(new RegExp(`^Optimized ${STEP}: `));
  });

  it("does nothing without a pick", () => {
    const before = getState().auto;
    openOptimize({ stepId: STEP });
    last().events.done?.({ ...improved, status: "noBetter", step: null, pick: null });
    applyOptimize();
    expect(getState().auto).toBe(before);
  });
});

describe("Discard", () => {
  it("leaves the auto at the same object identity, the undo history alone and every plan memo hit unchanged", () => {
    const state = getState();
    const auto = state.auto;
    const undoDepth = state.undo.length;
    const derived = currentDerived();
    const resolved = resolve(auto as Auto, project.waypoints, project.robot);
    const planned = flattenSteps(plan(resolved, project.robot, project.field).steps);

    openOptimize({ stepId: STEP });
    last().events.done?.(improved);
    discardOptimize();

    expect(getOptimizeCard()).toBeNull();
    expect(getState().auto).toBe(auto);
    expect(getState().undo.length).toBe(undoDepth);
    expect(currentDerived()).toBe(derived);
    // Planning the same auto again hands back the very same steps: every one a memo hit.
    const again = flattenSteps(plan(resolve(auto as Auto, project.waypoints, project.robot), project.robot, project.field).steps);
    expect(again).toHaveLength(planned.length);
    again.forEach((step, index) => expect(step).toBe(planned[index]));
  });

  it("cancels a run still going, and a late answer from it opens nothing", () => {
    const auto = getState().auto;
    openOptimize({ stepId: STEP });
    discardOptimize();
    expect(last().run.calls).toEqual(["cancel"]);
    last().events.done?.(improved);
    expect(getOptimizeCard()).toBeNull();
    expect(getState().auto).toBe(auto);
  });
});

describe("the margin field", () => {
  it("only sets the margin before a run", () => {
    vi.useFakeTimers();
    openOptimize({ stepId: STEP, withOptions: true });
    setOptimizeMargin(2);
    vi.advanceTimersByTime(MARGIN_RERUN_MS * 2);
    expect(getOptimizeCard()?.marginIn).toBe(2);
    expect(starts).toHaveLength(0);
  });

  it("starts nothing after Discard, or on another step opened at once, when a re-run was still waiting", () => {
    vi.useFakeTimers();
    openOptimize({ stepId: STEP });
    expect(starts).toHaveLength(1);
    setOptimizeMargin(2);
    discardOptimize();
    vi.advanceTimersByTime(MARGIN_RERUN_MS * 2);
    expect(starts).toHaveLength(1);
    expect(getOptimizeCard()).toBeNull();

    openOptimize({ stepId: STEP });
    expect(starts).toHaveLength(2);
    setOptimizeMargin(2);
    // Another step, opened within the 300 ms, runs once, at once, and the old step's re-run never comes.
    openOptimize({ stepId: "collectFlower" });
    expect(starts).toHaveLength(3);
    expect(last().request.stepId).toBe("collectFlower");
    vi.advanceTimersByTime(MARGIN_RERUN_MS * 2);
    expect(starts).toHaveLength(3);
    expect(getOptimizeCard()).toMatchObject({ stepId: "collectFlower", phase: "running" });
  });

  it("re-runs 300 ms after the last change once a run has started, keeping to 0 to 6 in by 0.25 in", () => {
    vi.useFakeTimers();
    openOptimize({ stepId: STEP });
    // A change while it runs cancels that run at once.
    setOptimizeMargin(1.6);
    expect(starts[0]?.run.calls).toContain("cancel");
    vi.advanceTimersByTime(MARGIN_RERUN_MS - 1);
    setOptimizeMargin(9);
    expect(getOptimizeCard()?.marginIn).toBe(6);
    vi.advanceTimersByTime(MARGIN_RERUN_MS - 1);
    expect(starts).toHaveLength(1);
    // The cancelled run's late answer changes nothing.
    starts[0]?.events.done?.(improved);
    expect(getOptimizeCard()?.result).toBeNull();
    vi.advanceTimersByTime(1);
    expect(starts).toHaveLength(2);
    expect(last().options.marginIn).toBe(6);
    // A change after a result takes the result away until the new run answers.
    last().events.done?.(improved);
    setOptimizeMargin(1.6);
    expect(getOptimizeCard()).toMatchObject({ phase: "running", result: null, marginIn: 1.5 });
    vi.advanceTimersByTime(MARGIN_RERUN_MS);
    expect(starts).toHaveLength(3);
    expect(last().options.marginIn).toBe(1.5);
  });
});

describe("an auto with no robot", () => {
  it("is blocked with a reason that says so, and the card does not open", () => {
    closeProject();
    const auto = loadAuto(wideAuto());
    openAuto("collect-and-score.auto.json", auto, canonicalize("auto", auto));
    selectStep(STEP);
    expect(getState().autoRobot).toBeNull();
    expect(optimizeBlockedReason(getState())).toBe("Open a project with a robot first.");
    expect(openOptimize()).toBe(false);
    expect(getOptimizeCard()).toBeNull();
    expect(getState().status?.message).toBe("Open a project with a robot first.");
    expect(starts).toHaveLength(0);
  });
});

/** A result for `stepId` that found nothing faster: no pick, so Apply would not write it. */
const noBetter = (stepId: string): OptimizeResult => ({ ...improved, stepId, status: "noBetter", pick: null, alternatives: [], step: null });

/**
 * A result for a step whose original goes through the hive frame (issue #388): the second step's
 * real pick, made 0.4 s slower than its original under both models, as the fastest clear route
 * round a blocked original may be.
 */
function blockedResult(stepId: string): OptimizeResult {
  const pick = improvedSecond.pick;
  if (pick === null || pick.t1 === null) throw new Error("the fixture's second pick has no instant sim times");
  const slower = (times: { before: { windowEndS: number; ownS: number }; after: { windowEndS: number; ownS: number } }) => ({
    before: times.before,
    after: { windowEndS: times.before.windowEndS + 0.4, ownS: times.before.ownS + 0.4 },
  });
  const route = { ...pick, t0: slower(pick.t0), t1: slower(pick.t1), gainS: -0.4 };
  return {
    ...improvedSecond,
    stepId,
    pick: route,
    step: route.step,
    alternatives: [],
    originalBlocked: { step: 4, code: "STRUCTURE", label: "the west base bar of the hive frame", phrase: "goes through the west base bar of the hive frame" },
    changes: ["The original goes through the west base bar of the hive frame, so this is the fastest clear route found: it is 0.40 s slower in the instant sim."],
  };
}

/** Answers every run Optimize every path starts, in order, with the real results for the two fixture steps. */
function answerAll(): void {
  for (let index = 0; index < 100 && getOptimizeCard()?.phase === "running"; index += 1) {
    const { request, events } = last();
    events.done?.(request.stepId === STEP ? improved : request.stepId === SECOND ? improvedSecond : noBetter(request.stepId));
  }
}

describe("Optimize every path (issue #366)", () => {
  it("runs every path step of the open auto in document order, one at a time, against the open auto", () => {
    const auto = getState().auto;
    if (auto === null) throw new Error("no auto");
    const ids = pathStepIds(auto);
    expect(ids).toEqual(["driveOut", "toOtherSide", "collectFlower", "toScoreNorth", "toGarden", "sweepGarden", "driveBack"]);
    expect(openOptimizeAll()).toBe(true);
    expect(starts).toHaveLength(1);
    expect(getOptimizeCard()).toMatchObject({ phase: "running", stepId: "driveOut" });
    answerAll();
    expect(starts.map((start) => start.request.stepId)).toEqual(ids);
    for (const start of starts) expect(start.request.auto).toBe(auto);
    const card = getOptimizeCard();
    expect(card?.phase).toBe("result");
    expect(card?.all?.results.map((step) => step.stepId)).toEqual(ids);
    expect(card?.all?.results.filter((step) => step.accepted).map((step) => step.stepId)).toEqual([STEP, SECOND]);
    expect(getState().auto).toBe(auto);
  });

  it("applies every accepted pick in one undo step, says the time saved, and one Undo restores the identical auto", () => {
    expect(improvedSecond.pick).not.toBeNull();
    const before = getState().auto;
    const beforeText = canonicalize("auto", before);
    const undoDepth = getState().undo.length;
    openOptimizeAll();
    answerAll();
    const saved = totalSavedS(getOptimizeCard());
    expect(saved).toBeGreaterThan(0);
    expect(canApply(getOptimizeCard())).toBe(true);
    applyOptimize();

    expect(getOptimizeCard()).toBeNull();
    const after = getState();
    expect(after.undo.length).toBe(undoDepth + 1);
    expect(pathStep(after.auto, STEP).segments).toEqual(improved.pick?.step.segments);
    expect(pathStep(after.auto, SECOND).segments).toEqual(improvedSecond.pick?.step.segments);
    expect(pathStep(after.auto, "driveOut")).toEqual(pathStep(before, "driveOut"));
    // check() passes collectFlower's original, so it is not blocked, whatever the instant sim's
    // tracking does near the foot of flower1, and its pick counts as time saved (PR #395).
    expect(improvedSecond.originalBlocked).toBeNull();
    expect(after.status?.message).toBe(`Optimized 2 paths: ${saved.toFixed(2)} s faster in all. Press Ctrl Z to undo.`);
    undo();
    expect(canonicalize("auto", getState().auto)).toBe(beforeText);
  });

  it("leaves out a step the person unticks, and with none accepted Apply does nothing", () => {
    const before = getState().auto;
    openOptimizeAll();
    answerAll();
    setOptimizeAllAccepted(STEP, false);
    applyOptimize();
    expect(pathStep(getState().auto, STEP)).toEqual(pathStep(before, STEP));
    expect(pathStep(getState().auto, SECOND).segments).toEqual(improvedSecond.pick?.step.segments);

    undo();
    openOptimizeAll();
    answerAll();
    setOptimizeAllAccepted(STEP, false);
    setOptimizeAllAccepted(SECOND, false);
    expect(canApply(getOptimizeCard())).toBe(false);
    // A step without a pick cannot be ticked.
    setOptimizeAllAccepted("driveOut", true);
    expect(getOptimizeCard()?.all?.results.find((step) => step.stepId === "driveOut")?.accepted).toBe(false);
  });

  it("goes on after a safety stop, and Stop ends the run with the results it has", () => {
    openOptimizeAll();
    last().events.stopped?.({ ...noBetter("driveOut"), status: "stoppedEarly" }, "safety");
    expect(getOptimizeCard()).toMatchObject({ phase: "running", stepId: STEP });
    stopOptimize();
    expect(last().run.calls).toEqual(["stop"]);
    last().events.stopped?.({ ...improved, status: "stoppedEarly" }, "stop");
    expect(starts).toHaveLength(2);
    const card = getOptimizeCard();
    expect(card).toMatchObject({ phase: "result", paused: false });
    expect(card?.all?.results.map((step) => step.stepId)).toEqual(["driveOut", STEP]);
    expect(canApply(card)).toBe(true);
  });

  it("goes stale on an edit, and is off with the switch", () => {
    openOptimizeAll();
    last().events.done?.(noBetter("driveOut"));
    tryEdit((auto: Auto) => setSpeed(auto, "driveOut", 0.5));
    expect(getOptimizeCard()?.stale).toBe(true);
    discardOptimize();

    setSetting("features.optimizer", false);
    expect(openOptimizeAll()).toBe(false);
    expect(getOptimizeCard()).toBeNull();
  });

  it("says why it cannot run on an auto with no path step", () => {
    const state = getState();
    if (state.auto === null) throw new Error("no auto");
    expect(optimizeAllBlockedReason(state)).toBeNull();
    expect(optimizeAllBlockedReason({ ...state, auto: { ...state.auto, steps: [] } })).toBe("This auto has no path step.");
  });

  it("ends the run stale when the auto is edited during a step, without starting the next step", () => {
    openOptimizeAll();
    expect(starts).toHaveLength(1);
    tryEdit((auto: Auto) => setSpeed(auto, "driveOut", 0.5));
    expect(getOptimizeCard()?.stale).toBe(true);
    last().events.done?.(noBetter("driveOut"));
    expect(starts).toHaveLength(1);
    const card = getOptimizeCard();
    expect(card).toMatchObject({ phase: "result", stale: true, message: "The auto changed. Run again." });
    expect(card?.all?.results.map((step) => step.stepId)).toEqual(["driveOut"]);
    expect(canApply(card)).toBe(false);
  });

  it("records a failed step with its message and goes on to the next", () => {
    openOptimizeAll();
    last().events.failed?.("The worker stopped.");
    expect(starts).toHaveLength(2);
    expect(getOptimizeCard()).toMatchObject({ phase: "running", stepId: STEP });
    expect(getOptimizeCard()?.all?.results).toEqual([{ stepId: "driveOut", result: null, message: "The worker stopped.", accepted: false, stopReason: null }]);
  });

  it("counts a failed path apart from the searched ones, and Try again runs it alone and replaces its row (0.1.2 UX review)", () => {
    openOptimizeAll();
    last().events.failed?.("The optimizer stopped answering, so it was ended. Run it again.");
    for (let index = 0; index < 100 && getOptimizeCard()?.phase === "running"; index += 1) {
      const { request, events } = last();
      events.done?.(request.stepId === STEP ? improved : noBetter(request.stepId));
    }
    let card = getOptimizeCard();
    expect(allTotalLine(card)).toMatch(/^6 of 7 paths searched, 1 failed\. The ticked ones save /);
    expect(canRetryOptimizeStep(card, "driveOut")).toBe(true);
    expect(canRetryOptimizeStep(card, STEP)).toBe(false);
    const ticked = card?.all?.results.filter((step) => step.accepted).map((step) => step.stepId);

    const before = starts.length;
    retryOptimizeStep("driveOut");
    expect(starts).toHaveLength(before + 1);
    expect(last().request.stepId).toBe("driveOut");
    expect(getOptimizeCard()).toMatchObject({ phase: "running", stepId: "driveOut" });
    last().events.done?.(noBetter("driveOut"));
    // Only that row changed, and the run ends there without searching the others again.
    expect(starts).toHaveLength(before + 1);
    card = getOptimizeCard();
    expect(card?.phase).toBe("result");
    expect(card?.all?.results.map((step) => step.stepId)).toEqual(pathStepIds(getState().auto as Auto));
    expect(card?.all?.results.find((step) => step.stepId === "driveOut")?.result).not.toBeNull();
    expect(card?.all?.results.filter((step) => step.accepted).map((step) => step.stepId)).toEqual(ticked);
    expect(allTotalLine(card)).toMatch(/^7 of 7 paths searched\. /);
    expect(canRetryOptimizeStep(card, "driveOut")).toBe(false);
  });

  it("says only how many failed when every path failed", () => {
    openOptimizeAll();
    for (let index = 0; index < 100 && getOptimizeCard()?.phase === "running"; index += 1) last().events.failed?.("The worker stopped.");
    expect(allTotalLine(getOptimizeCard())).toBe("0 of 7 paths searched, 7 failed.");
  });

  it("keeps why each path's search stopped: the safety stop's time box or the person's Stop", () => {
    openOptimizeAll();
    last().events.stopped?.({ ...noBetter("driveOut"), status: "stoppedEarly" }, "safety");
    stopOptimize();
    last().events.stopped?.({ ...improved, status: "stoppedEarly" }, "stop");
    expect(getOptimizeCard()?.all?.results.map((step) => step.stopReason)).toEqual(["safety", "stop"]);
  });

  it("ends the run with the results so far when a run is cancelled", () => {
    openOptimizeAll();
    last().events.done?.(noBetter("driveOut"));
    last().events.cancelled?.("Something cancelled it.");
    expect(starts).toHaveLength(2);
    const card = getOptimizeCard();
    expect(card).toMatchObject({ phase: "result", message: "Something cancelled it.", stale: false });
    expect(card?.all?.results.map((step) => step.stepId)).toEqual(["driveOut"]);
  });

  it("says why it cannot run in review mode, with no robot and with no auto, and then does not open", () => {
    const state = getState();
    expect(optimizeAllBlockedReason({ ...state, auto: null })).toBe("Open an auto first.");
    expect(optimizeAllBlockedReason({ ...state, review: {} as NonNullable<typeof state.review> })).toBe("Review mode is read only.");
    closeProject();
    const auto = loadAuto(read("collect-and-score.auto.json"));
    openAuto("collect-and-score.auto.json", auto, canonicalize("auto", auto));
    expect(optimizeAllBlockedReason(getState())).toBe("Open a project with a robot first.");
    expect(openOptimizeAll()).toBe(false);
    expect(getOptimizeCard()).toBeNull();
    expect(getState().status?.message).toBe("Open a project with a robot first.");
    expect(starts).toHaveLength(0);
  });

  it("counts a step that went through something and is now clear as cleared, not as time saved (issue #388)", () => {
    const blocked = blockedResult(SECOND);
    openOptimizeAll();
    for (let index = 0; index < 100 && getOptimizeCard()?.phase === "running"; index += 1) {
      const { request, events } = last();
      events.done?.(request.stepId === STEP ? improved : request.stepId === SECOND ? blocked : noBetter(request.stepId));
    }
    const card = getOptimizeCard();
    const cleared = card?.all?.results.find((step) => step.stepId === SECOND);
    if (cleared === undefined) throw new Error("no result for the blocked step");
    // It has a pick to apply, ticked, but its slower time is never counted against the savings.
    expect(cleared.accepted).toBe(true);
    expect(savedS(cleared)).toBe(0);
    const saved = totalSavedS(card);
    expect(saved).toBeCloseTo(savedS(card?.all?.results.find((step) => step.stepId === STEP) as OptimizeAllStep), 9);
    expect(clearedCount(card)).toBe(1);
    expect(allTotalLine(card)).toBe(`7 of 7 paths searched. The ticked ones save ${saved.toFixed(2)} s in all and clear 1 blocked path.`);
    expect(appliedAllLine(card)).toBe(`Optimized 2 paths: ${saved.toFixed(2)} s faster in all, and 1 blocked path cleared.`);
    // Without the faster step, only the cleared one is left.
    setOptimizeAllAccepted(STEP, false);
    expect(allTotalLine(getOptimizeCard())).toBe("7 of 7 paths searched. The ticked ones save 0.00 s in all and clear 1 blocked path.");
    expect(appliedAllLine(getOptimizeCard())).toBe("Optimized 1 path: 1 blocked path cleared.");
    applyOptimize();
    expect(pathStep(getState().auto, SECOND).segments).toEqual(blocked.pick?.step.segments);
    expect(getState().status?.message).toBe("Optimized 1 path: 1 blocked path cleared. Press Ctrl Z to undo.");
  });

  it("says no faster routes were found, not that the ticked ones save 0.00 s, when no path has a pick (W2-13)", () => {
    openOptimizeAll();
    for (let index = 0; index < 100 && getOptimizeCard()?.phase === "running"; index += 1) {
      const { request, events } = last();
      events.done?.(noBetter(request.stepId));
    }
    const card = getOptimizeCard();
    expect(card?.all?.results.every((step) => !step.accepted)).toBe(true);
    expect(allTotalLine(card)).toBe("7 of 7 paths searched. No faster routes found.");
  });

  it("says 'path', not 'paths', when one step changed", () => {
    openOptimizeAll();
    answerAll();
    setOptimizeAllAccepted(SECOND, false);
    const saved = totalSavedS(getOptimizeCard());
    applyOptimize();
    expect(getState().status?.message).toBe(`Optimized 1 path: ${saved.toFixed(2)} s faster in all. Press Ctrl Z to undo.`);
  });
});
