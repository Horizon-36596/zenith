import { parseAuto, SCHEMA_ID, type Auto, type Step } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { check } from "./check.js";
import { estimate } from "./estimate.js";
import { clearPlanCache, plan } from "./plan.js";
import { resolve } from "./resolve.js";
import { testField, testRobot, testWaypoints } from "./testing/fixtures.js";

/**
 * The editor's performance budget (site/docs/editor.md): a routine the size of a real one is
 * checked well inside a frame, so the editor can check on every drag rather than on a debounce.
 *
 * The number is printed either way. A machine under load can miss the budget without anything being
 * wrong with the code, so the assertion is generous and the print is what a change is read against.
 */

const BUDGET_MS = 50;

/** Twenty steps that wander the field: ten legs, five curves and five commands between them. */
const syntheticAuto = (): Auto => {
  const steps: Step[] = [];
  for (let index = 0; index < 10; index += 1) {
    const angle = (index / 10) * Math.PI * 2;
    const x = Math.cos(angle) * 50;
    const y = Math.sin(angle) * 50;
    steps.push({
      id: `leg${String(index)}`,
      kind: "path",
      segments:
        index % 2 === 0
          ? [{ kind: "line", from: "current", to: { xIn: x, yIn: y } }]
          : [
              {
                kind: "bezier",
                from: "current",
                control: [
                  { xIn: x * 0.4, yIn: y * 1.2 },
                  { xIn: x * 0.9, yIn: y * 0.6 },
                ],
                to: { xIn: x, yIn: y },
              },
            ],
      heading: index % 4 === 0 ? { mode: "tangent" } : { mode: "constant", headingRad: angle },
    });
    steps.push({ id: `volley${String(index)}`, kind: "command", name: "shootAll", args: { count: 2 } });
  }
  return parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "bench",
    alliance: "RED",
    start: { pose: { xIn: -50, yIn: 0, headingRad: 0 } },
    steps,
  });
};

const run = (auto: Auto, memoize: boolean): number => {
  const resolved = resolve(auto, testWaypoints);
  const started = performance.now();
  const planned = plan(resolved, testRobot, testField, { memoize });
  const timing = estimate(planned, testRobot);
  check(planned, timing, testRobot, testField);
  return performance.now() - started;
};

describe("performance", () => {
  it("plans, estimates and checks a twenty-step auto inside the frame budget", () => {
    const auto = syntheticAuto();
    clearPlanCache();
    const cold = run(auto, false);
    clearPlanCache();
    run(auto, true);
    const warm = run(auto, true);
    // eslint-disable-next-line no-console
    console.log(
      `check over 20 steps: ${cold.toFixed(1)} ms cold, ${warm.toFixed(1)} ms with the plan memo (budget ${String(BUDGET_MS)} ms)`,
    );
    expect(warm).toBeLessThan(BUDGET_MS);
  });

  it("hands back the same step objects when nothing structural changed", () => {
    const auto = syntheticAuto();
    const first = plan(resolve(auto, testWaypoints), testRobot, testField);
    const second = plan(resolve(auto, testWaypoints), testRobot, testField);
    expect(second.steps[0]).toBe(first.steps[0]);
    expect(second.findings).toEqual(first.findings);
  });

  it("replans the step that changed and only that one", () => {
    const auto = syntheticAuto();
    const first = plan(resolve(auto, testWaypoints), testRobot, testField);
    const edited = parseAuto({
      ...auto,
      steps: auto.steps.map((step, index) =>
        index === 0 && step.kind === "path"
          ? { ...step, segments: [{ kind: "line", from: "current", to: { xIn: 44, yIn: 3 } }] }
          : step,
      ),
    });
    const second = plan(resolve(edited, testWaypoints), testRobot, testField);
    expect(second.steps[0]).not.toBe(first.steps[0]);
    // Every later step starts where the one before ended, so the second leg moved too; the third
    // onwards are untouched and come straight back out of the memo.
    expect(second.steps[3]).toBe(first.steps[3]);
  });

  it("gives the same plan with the memo off as with it on", () => {
    const auto = syntheticAuto();
    const warm = plan(resolve(auto, testWaypoints), testRobot, testField);
    const cold = plan(resolve(auto, testWaypoints), testRobot, testField, { memoize: false });
    expect(JSON.stringify(cold.steps.map((step) => step.samples))).toBe(
      JSON.stringify(warm.steps.map((step) => step.samples)),
    );
  });
});
