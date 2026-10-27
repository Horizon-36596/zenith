import { parseAuto, parseRobot, SCHEMA_ID, type Auto, type Robot } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { runLedger } from "./ledger.js";
import { plan } from "./plan.js";
import { resolve } from "./resolve.js";
import type { SeasonRules, SeasonState } from "./season.js";
import { testField, testRobot, testWaypoints } from "./testing/fixtures.js";

/**
 * A stand-in season that records what the core asked it to do. The point of these tests is the
 * order of trust site/docs/seasons.md describes, not any real game; the
 * BIOBUZZ rules are tested against the real field file in `packages/season-biobuzz`.
 */
type Counting = {
  held: number;
  launched: number;
  collected: string[];
  tips: number;
  /** Where each launch came from, in order. */
  shots: { target: string; xIn: number; yIn: number }[];
};

const counting: SeasonRules = {
  id: "counting",
  initialState: () => ({ held: 0, launched: 0, collected: [], tips: 0, shots: [] }) as unknown as SeasonState,
  start: (state, holds) =>
    ({ ...(state as unknown as Counting), held: holds["pollen"] ?? 0 }) as unknown as SeasonState,
  holds: (state) => ({ pollen: (state as unknown as Counting).held }),
  onLaunch: (state, target, count, pose) => {
    const current = state as unknown as Counting;
    return {
      ...current,
      held: current.held - count,
      launched: current.launched + count,
      shots: [...current.shots, { target, xIn: pose.xIn, yIn: pose.yIn }],
    } as unknown as SeasonState;
  },
  onCollect: (state, containerId, count) => {
    const current = state as unknown as Counting;
    return {
      ...current,
      held: current.held + count,
      collected: [...current.collected, containerId],
    } as unknown as SeasonState;
  },
  onTip: (state) => {
    const current = state as unknown as Counting;
    return { ...current, tips: current.tips + 1 } as unknown as SeasonState;
  },
  currentTarget: () => "theTarget",
  legalApproach: () => true,
  startLegal: () => [],
  describe: (before, after) =>
    `held ${String((after as unknown as Counting).held)} after ${String((before as unknown as Counting).held)}`,
  summary: (state) => [
    { stepId: "end", label: "robot", detail: `${String((state as unknown as Counting).held)} pollen` },
    { stepId: "end", label: "tips", detail: String((state as unknown as Counting).tips) },
  ],
};

const robot: Robot = parseRobot({
  ...JSON.parse(JSON.stringify(testRobot)),
  commands: [
    { name: "shootAll", estimateS: "1", stationary: true, ledger: { launches: "count" } },
    { name: "assumeTipped", estimateS: "0", ledger: { tip: "own" } },
    { name: "setIntake", estimateS: "0" },
  ],
});

const auto = (steps: unknown[]): Auto =>
  parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "ledger-fixture",
    alliance: "RED",
    start: { pose: { xIn: 0, yIn: -60, headingRad: 0 }, holds: { pollen: 4 } },
    steps,
  });

const run = (steps: unknown[]) => {
  const planned = plan(resolve(auto(steps), testWaypoints), robot, testField);
  return runLedger(planned, testField, counting);
};

const leg = (id: string, expectAnnotation?: Record<string, unknown>): Record<string, unknown> => ({
  id,
  kind: "path",
  segments: [{ kind: "line", from: { xIn: 0, yIn: -60, headingRad: 0 }, to: { xIn: 20, yIn: -60 } }],
  heading: { mode: "tangent" },
  ...(expectAnnotation === undefined ? {} : { expect: expectAnnotation }),
});

describe("ledger", () => {
  it("seeds the robot with what the auto says it starts holding", () => {
    const result = run([leg("drive")]);
    expect(result.entries[0]?.holds).toEqual({ pollen: 4 });
  });

  it("launches from a command's registry hint, reading the count out of the arguments", () => {
    const result = run([{ id: "volley", kind: "command", name: "shootAll", args: { count: 3 } }]);
    expect(result.entries[0]?.launched).toBe(3);
    expect(result.entries[0]?.holds).toEqual({ pollen: 1 });
    expect(result.entries[0]?.target).toBe("theTarget");
  });

  it("takes a tip from a command's registry hint", () => {
    const result = run([{ id: "tip", kind: "command", name: "assumeTipped" }]);
    expect(result.entries[0]?.tipped).toBe("own");
    expect((result.finalState as unknown as Counting).tips).toBe(1);
  });

  it("collects from a step's expect annotation", () => {
    const result = run([leg("retrieve", { collectFrom: "flower0", count: 2 })]);
    expect(result.entries[0]?.collected).toEqual({ containerId: "flower0", count: 2 });
    expect(result.entries[0]?.holds).toEqual({ pollen: 6 });
  });

  it("lets a step's expect annotation override the command's registry hint", () => {
    const result = run([
      { id: "volley", kind: "command", name: "shootAll", args: { count: 3 }, expect: { count: 1 } },
    ]);
    expect(result.entries[0]?.launched).toBe(1);
  });

  it("records a row only for a step that changed the ledger, and the summary at the end", () => {
    const result = run([
      leg("drive"),
      { id: "volley", kind: "command", name: "shootAll", args: { count: 2 } },
    ]);
    expect(result.rows.map((row) => row.stepId)).toEqual(["volley", "end", "end"]);
    expect(result.rows[0]?.label).toBe("volley: launched 2");
  });

  it("walks into a parallel group's children", () => {
    const result = run([
      {
        id: "group",
        kind: "parallel",
        mode: "all",
        steps: [leg("drive"), { id: "volley", kind: "command", name: "shootAll", args: { count: 2 } }],
      },
    ]);
    expect(result.byStepId["volley"]?.launched).toBe(2);
  });

  it("follows only the then side of a branch, the same side resolve takes the end pose from", () => {
    const result = run([
      {
        id: "maybe",
        kind: "branch",
        condition: "hopperFull",
        then: [{ id: "yes", kind: "command", name: "shootAll", args: { count: 1 } }],
        else: [{ id: "no", kind: "command", name: "shootAll", args: { count: 4 } }],
      },
    ]);
    expect(result.byStepId["yes"]?.launched).toBe(1);
    expect(result.byStepId["no"]).toBeUndefined();
    expect((result.finalState as unknown as Counting).launched).toBe(1);
  });

  it("issue #373 finding 2: after a known else side, a launch is judged from where that side left the robot", () => {
    // hopperEmpty reads false with 4 aboard, so the else side runs and drives to (0, -30).
    const result = run([
      {
        id: "fork",
        kind: "branch",
        condition: "hopperEmpty",
        then: [leg("toTheRight")],
        else: [
          {
            ...leg("upField"),
            segments: [{ kind: "line", from: "current", to: { xIn: 0, yIn: -30 } }],
          },
        ],
      },
      { id: "volley", kind: "command", name: "shootAll", args: { count: 1 } },
    ]);
    expect(result.byStepId["fork"]?.branch).toMatchObject({ known: true, then: false });
    expect(result.byStepId["upField"]).toBeDefined();
    expect(result.byStepId["toTheRight"]).toBeUndefined();
    const shots = (result.finalState as unknown as Counting).shots;
    expect(shots).toHaveLength(1);
    expect(shots[0]?.xIn).toBeCloseTo(0, 6);
    expect(shots[0]?.yIn).toBeCloseTo(-30, 6);
    expect(result.byStepId["volley"]?.launchPose?.yIn).toBeCloseTo(-30, 6);
  });

  it("issue #373 finding 3: a count beside collectFrom on a command with no launches hint only collects", () => {
    const result = run([
      { id: "grab", kind: "command", name: "setIntake", expect: { collectFrom: "gardenRed", count: 3 } },
    ]);
    expect(result.entries[0]?.launched).toBe(0);
    expect(result.entries[0]?.collected).toEqual({ containerId: "gardenRed", count: 3 });
    expect(result.entries[0]?.holds).toEqual({ pollen: 7 });
    expect(result.entries[0]?.row?.label).toBe("grab: collected 3 from gardenRed");
  });

  it("issue #373 finding 3: a command with no hint still launches when its expect says where", () => {
    const result = run([
      { id: "lob", kind: "command", name: "setIntake", expect: { launchesInto: "theTarget", count: 2 } },
    ]);
    expect(result.entries[0]?.launched).toBe(2);
    expect((result.finalState as unknown as Counting).shots[0]?.target).toBe("theTarget");
  });

  it("issue #373 finding 4: a deadline group cancels a member that would start after its deadline", () => {
    const group = (deadlineS: number): unknown => ({
      id: "group",
      kind: "parallel",
      mode: "deadline",
      deadline: "short",
      steps: [
        { id: "short", kind: "wait", seconds: deadlineS },
        {
          id: "late",
          kind: "sequence",
          steps: [
            { id: "settle", kind: "wait", seconds: 2 },
            { id: "volley", kind: "command", name: "shootAll", args: { count: 3 } },
          ],
        },
      ],
    });
    const cut = run([group(1)]);
    expect(cut.byStepId["settle"]).toBeDefined();
    expect(cut.byStepId["volley"]).toBeUndefined();
    expect((cut.finalState as unknown as Counting).launched).toBe(0);

    const inTime = run([group(3)]);
    expect(inTime.byStepId["volley"]?.launched).toBe(3);
  });

  it("issue #373 finding 4: the member that sets a group's end is never cut by that end", () => {
    // The deadline member's own last step starts exactly as the group ends, and still runs.
    const deadline = run([
      {
        id: "group",
        kind: "parallel",
        mode: "deadline",
        deadline: "lead",
        steps: [
          {
            id: "lead",
            kind: "sequence",
            steps: [
              { id: "settle", kind: "wait", seconds: 2 },
              { id: "volley", kind: "command", name: "assumeTipped" },
              { id: "flick", kind: "command", name: "setIntake", expect: { launchesInto: "theTarget", count: 1 } },
            ],
          },
          { id: "beside", kind: "wait", seconds: 1 },
        ],
      },
    ]);
    expect(deadline.byStepId["flick"]?.launched).toBe(1);
    expect(deadline.byStepId["volley"]?.tipped).toBe("own");

    // The same for the quickest member of a race.
    const race = run([
      {
        id: "race",
        kind: "parallel",
        mode: "race",
        steps: [
          {
            id: "quick",
            kind: "sequence",
            steps: [
              { id: "settle", kind: "wait", seconds: 1 },
              { id: "flick", kind: "command", name: "setIntake", expect: { launchesInto: "theTarget", count: 1 } },
            ],
          },
          { id: "slow", kind: "wait", seconds: 3 },
        ],
      },
    ]);
    expect(race.byStepId["flick"]?.launched).toBe(1);
  });

  it("issue #373 finding 4: a race ends with its quickest member and cancels what would start later", () => {
    const result = run([
      {
        id: "race",
        kind: "parallel",
        mode: "race",
        steps: [
          { id: "quick", kind: "wait", seconds: 1 },
          {
            id: "slow",
            kind: "sequence",
            steps: [
              { id: "settle", kind: "wait", seconds: 2 },
              { id: "volley", kind: "command", name: "shootAll", args: { count: 3 } },
            ],
          },
        ],
      },
    ]);
    expect(result.byStepId["volley"]).toBeUndefined();
    expect((result.finalState as unknown as Counting).launched).toBe(0);
  });

  it("issue #373 finding 4: an all group cancels nothing", () => {
    const result = run([
      {
        id: "group",
        kind: "parallel",
        mode: "all",
        steps: [
          { id: "short", kind: "wait", seconds: 1 },
          {
            id: "late",
            kind: "sequence",
            steps: [
              { id: "settle", kind: "wait", seconds: 2 },
              { id: "volley", kind: "command", name: "shootAll", args: { count: 3 } },
            ],
          },
        ],
      },
    ]);
    expect(result.byStepId["volley"]?.launched).toBe(3);
  });

  it("issue #373 finding 5: a path's markers launch through their commands' hints, at the marker's pose", () => {
    const result = run([
      {
        ...leg("drive"),
        markers: [{ at: { t: 0.5 }, command: { name: "shootAll", args: { count: 3 } } }],
      },
    ]);
    const entry = result.byStepId["drive"];
    expect(entry?.launched).toBe(3);
    expect(entry?.holds).toEqual({ pollen: 1 });
    expect(entry?.launchedFromMarker).toBe(true);
    expect(entry?.launchPose?.xIn).toBeCloseTo(10, 0);
    expect(entry?.row?.label).toBe("drive: launched 3");
  });

  it("issue #373 finding 5: markers run in the order they sit along the path", () => {
    const result = run([
      {
        ...leg("drive"),
        markers: [
          { at: { distanceFromEndIn: 2 }, command: { name: "shootAll", args: { count: 1 } } },
          { at: { distanceIn: 2 }, command: { name: "shootAll", args: { count: 2 } } },
        ],
      },
    ]);
    const shots = (result.finalState as unknown as Counting).shots;
    expect(shots.map((shot) => Math.round(shot.xIn))).toEqual([2, 18]);
  });

  it("is deterministic and leaves the state it was given alone", () => {
    const first = run([leg("retrieve", { collectFrom: "flower0", count: 2 })]);
    const second = run([leg("retrieve", { collectFrom: "flower0", count: 2 })]);
    expect(second.rows).toEqual(first.rows);
    expect((first.initialState as unknown as Counting).held).toBe(4);
  });
});
