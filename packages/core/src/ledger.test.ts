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
};

const counting: SeasonRules = {
  id: "counting",
  initialState: () => ({ held: 0, launched: 0, collected: [], tips: 0 }) as unknown as SeasonState,
  start: (state, holds) =>
    ({ ...(state as unknown as Counting), held: holds["pollen"] ?? 0 }) as unknown as SeasonState,
  holds: (state) => ({ pollen: (state as unknown as Counting).held }),
  onLaunch: (state, target, count) => {
    void target;
    const current = state as unknown as Counting;
    return {
      ...current,
      held: current.held - count,
      launched: current.launched + count,
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

  it("is deterministic and leaves the state it was given alone", () => {
    const first = run([leg("retrieve", { collectFrom: "flower0", count: 2 })]);
    const second = run([leg("retrieve", { collectFrom: "flower0", count: 2 })]);
    expect(second.rows).toEqual(first.rows);
    expect((first.initialState as unknown as Counting).held).toBe(4);
  });
});
