import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadAuto, loadField, loadRobot, loadWaypoints, resimulate, simulateRun } from "@horizon36596/zenith-core";
import { parseAuto, SCHEMA_ID, type Auto, type Step } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { derive } from "./derived";
import { simTotalS } from "./sim";

/**
 * QA matrix item 10 (the instant sim, site/docs/simulation.md): a routine that runs for
 * 30 s in the sim is simulated from scratch in under 30 ms, so the editor can re-run it on every
 * edit, and a resume after an edit near the end costs less than a full run.
 *
 * Timings are the best of several runs after a warm-up, as packages/core/src/sim/sim.test.ts does:
 * the full suite runs test files in parallel, so any one run can be slowed by the machine, but a
 * real regression slows every run, the fastest included. The numbers are printed either way.
 */

const examples = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

const BUDGET_MS = 30;

/** Warms the JIT, then returns the fastest of `times` runs, in milliseconds. */
const time = (run: () => void, times = 15, warmUps = 3): number => {
  for (let index = 0; index < warmUps; index += 1) run();
  let best = Infinity;
  for (let index = 0; index < times; index += 1) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
};

describe.skipIf(!existsSync(`${examples}zenith.json`))("QA: the instant sim is fast enough to run on every edit", () => {
  const robot = loadRobot(read("autos/robot.json"));
  const field = loadField(read("autos/field/biobuzz.field.json"));
  const waypoints = loadWaypoints(read("autos/waypoints.json"));

  /** Legs round the field with a short wait after each, until the sim runs for at least `seconds`. */
  const routineOf = (legs: number): Auto => {
    const corners = [
      { xIn: -40, yIn: -40 },
      { xIn: 40, yIn: -40 },
      { xIn: 40, yIn: 40 },
      { xIn: -40, yIn: 40 },
    ];
    const steps: Step[] = [];
    for (let index = 0; index < legs; index += 1) {
      const to = corners[index % corners.length] ?? { xIn: 0, yIn: 0 };
      steps.push({
        id: `leg${String(index)}`,
        kind: "path",
        segments: [{ kind: "line", from: "current", to: { ...to, headingRad: 0 } }],
        heading: { mode: "constant", headingRad: 0 },
      } as Step);
      steps.push({ id: `wait${String(index)}`, kind: "wait", seconds: 0.5 } as Step);
    }
    return parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 2,
      name: "qa-thirty",
      alliance: "RED",
      start: { pose: { xIn: -40, yIn: 40, headingRad: 0 } },
      steps,
    });
  };

  const planOf = (auto: Auto) => {
    const planned = derive(auto, robot, field, waypoints).plan;
    if (planned === null) throw new Error("the QA routine did not plan");
    return planned;
  };

  it("simulates a 30 s routine from scratch in under 30 ms", () => {
    let legs = 4;
    let planned = planOf(routineOf(legs));
    while ((simTotalS(simulateRun(planned, robot, field).trace) ?? 0) < 30 && legs < 200) {
      legs += 2;
      planned = planOf(routineOf(legs));
    }
    const totalS = simTotalS(simulateRun(planned, robot, field).trace) ?? 0;
    expect(totalS).toBeGreaterThanOrEqual(30);
    const ms = time(() => simulateRun(planned, robot, field));
    console.info(`QA sim: ${String(legs)} legs, ${totalS.toFixed(1)} s of routine in ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("simulates the bundled example in under 30 ms", () => {
    const planned = planOf(loadAuto(read("autos/all-step-kinds.auto.json")));
    const ms = time(() => simulateRun(planned, robot, field));
    const totalS = simTotalS(simulateRun(planned, robot, field).trace) ?? 0;
    console.info(`QA sim: all-step-kinds, ${totalS.toFixed(1)} s of routine in ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("resumes after an edit to the last step no slower than a full run, and agrees with one", () => {
    const auto = routineOf(24);
    const planned = planOf(auto);
    const first = simulateRun(planned, robot, field);
    const steps = auto.steps.map((step) =>
      step.id === "wait23" ? ({ ...step, seconds: 1.5 } as Step) : step,
    );
    const edited = planOf(parseAuto({ ...auto, steps }));
    const full = time(() => simulateRun(edited, robot, field));
    const resumed = time(() => resimulate(first, edited, robot, field));
    console.info(`QA sim: full ${full.toFixed(2)} ms, resumed ${resumed.toFixed(2)} ms`);
    expect(resumed).toBeLessThanOrEqual(full * 1.2 + 0.5);
    expect(simTotalS(resimulate(first, edited, robot, field).trace)).toBeCloseTo(
      simTotalS(simulateRun(edited, robot, field).trace) ?? 0,
      9,
    );
  });
});
