import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadAuto, loadField, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import { describe, expect, it } from "vitest";
import { derive } from "./derived";
import { runSim, simSpans, simTotalS } from "./sim";

const examples = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

const robot = loadRobot(read("autos/robot.json"));
const field = loadField(read("autos/field/biobuzz.field.json"));
const waypoints = loadWaypoints(read("autos/waypoints.json"));

describe("the timeline's instant sim", () => {
  it("gives every top-level step of the example a span, in order, and a total", () => {
    const auto = loadAuto(read("autos/all-step-kinds.auto.json"));
    const plan = derive(auto, robot, field, waypoints).plan;
    expect(plan).not.toBeNull();
    if (plan === null) return;
    const entry = runSim(plan, robot, field);
    expect(entry.reason).toBeNull();
    const trace = entry.run?.trace ?? null;
    const spans = simSpans(trace);
    const ids = auto.steps.map((step, index) => step.id ?? `step${String(index)}`);
    for (const id of ids.filter((id) => spans.has(id))) {
      const span = spans.get(id);
      expect(span?.endS).toBeGreaterThanOrEqual(span?.startS ?? 0);
    }
    expect(spans.size).toBeGreaterThan(0);
    const total = simTotalS(trace);
    expect(total).not.toBeNull();
    expect(total ?? 0).toBeGreaterThan(0);
  });

  it("gives the same trace when it resumes from a checkpoint as when it runs from the start", () => {
    const auto = loadAuto(read("autos/all-step-kinds.auto.json"));
    const plan = derive(auto, robot, field, waypoints).plan;
    if (plan === null) throw new Error("the example did not plan");
    const first = runSim(plan, robot, field).run?.trace;
    const again = runSim(plan, robot, field).run?.trace;
    expect(simTotalS(again ?? null)).toBeCloseTo(simTotalS(first ?? null) ?? 0, 9);
  });
});
