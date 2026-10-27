import { parseAuto, parseField, parseRobot, SCHEMA_ID, type Auto, type Field, type Robot } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { testField, testRobot } from "../testing/fixtures.js";
import { canonicalAuto } from "./candidate.js";
import { optimizeRoute, runOptimize, type OptimizeCommand, type OptimizeOptions, type OptimizeResult } from "./index.js";
import type { ObjectiveInput } from "./objective.js";

/**
 * The generator's `{ snapshot: true }` command (issue #306), which the editor's worker host sends for
 * Stop and the safety stop: the generator answers with the result a stop at that point would return,
 * and then goes on exactly as if nothing had been asked, so Continue ends on the same result as a run
 * that was never stopped.
 */

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const robot: Robot = parseRobot({ ...clone(testRobot), heightIn: { value: 12, provenance: "PLACEHOLDER: test fixture" } });

const field: Field = parseField({
  ...clone(testField),
  obstacles: [
    {
      id: "post",
      kind: "box",
      minXIn: -4,
      maxXIn: 4,
      minYIn: -3,
      maxYIn: 3,
      minZIn: 0,
      maxZIn: 10,
      solidToRobot: true,
      provenance: "PLACEHOLDER: test fixture",
    },
  ],
  zones: [],
});

/** A slow detour north of a post, which leaves room for a faster route. */
const auto: Auto = canonicalAuto(
  parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 4,
    name: "snapshot-fixture",
    alliance: "RED",
    start: { pose: { xIn: -48, yIn: 0, headingRad: 0 } },
    steps: [
      {
        id: "route",
        kind: "path",
        segments: [{ kind: "bezier", from: "current", control: [{ xIn: 0, yIn: 56 }], to: { xIn: 48, yIn: 0 } }],
        heading: { mode: "constant", headingRad: 0 },
      },
    ],
  }),
).auto;

const input: ObjectiveInput = { auto, robot, field, stepId: "route" };
const options: OptimizeOptions = { budget: 100, batchSize: 10 };

/** Drains a run, sending `command(evaluations)` back after each report, and returns the snapshots it answered with. */
function drive(command: (evaluations: number, phase: string) => OptimizeCommand | undefined): { result: OptimizeResult; snapshots: OptimizeResult[] } {
  const run = optimizeRoute(input, options);
  const snapshots: OptimizeResult[] = [];
  let next = run.next();
  while (next.done !== true) {
    if (next.value.snapshot !== undefined) snapshots.push(next.value.snapshot);
    next = run.next(next.value.snapshot === undefined ? command(next.value.evaluations, next.value.phase) : undefined);
  }
  return { result: next.value, snapshots };
}

describe("the snapshot command", () => {
  it("answers with the result a stop at the same point returns", () => {
    const { snapshots } = drive((evaluations) => (evaluations === 40 ? { snapshot: true } : undefined));
    expect(snapshots).toHaveLength(1);
    const stopped = drive((evaluations) => (evaluations === 40 ? { stop: true } : undefined)).result;
    expect(stopped.status).toBe("stoppedEarly");
    expect(stopped.evaluations).toBe(40);
    expect(snapshots[0]).toStrictEqual(stopped);
  }, 120_000);

  it("goes on afterwards to the same result as a run that was never asked", () => {
    const unstopped = runOptimize(input, options);
    const { result, snapshots } = drive((evaluations) => (evaluations === 20 || evaluations === 60 ? { snapshot: true } : undefined));
    expect(snapshots.map((snapshot) => snapshot.evaluations)).toEqual([20, 60]);
    expect(result).toStrictEqual(unstopped);
    expect(result.status).not.toBe("stoppedEarly");
  }, 120_000);

  it("is ignored once the search is done, so the run goes on to its own result", () => {
    const unstopped = runOptimize(input, options);
    const { result, snapshots } = drive((_evaluations, phase) => (phase === "final" ? { snapshot: true } : undefined));
    expect(snapshots).toHaveLength(0);
    expect(result).toStrictEqual(unstopped);
  }, 120_000);
});
