import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { flattenSteps, loadAuto, loadField, loadRobot, loadWaypoints, plan, resolve } from "@horizon36596/zenith-core";
import type { Auto, Field } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { derive, severityCounts } from "../src/state/derived";

/**
 * The editor computes `check` and `ledger` against the season the project's `field.json` names,
 * through `@horizon36596/zenith-seasons`. Without that wiring the routine still plans and estimates, so the
 * regression is silent: the season checks simply never fire and the ledger is empty. These tests
 * are the alarm.
 */
const examples = fileURLToPath(new URL("../../../examples/starter/", import.meta.url));
const read = (relative: string): unknown =>
  JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

const robot = loadRobot(read("autos/robot.json"));
const field = loadField(read("autos/field/biobuzz.field.json"));
const waypoints = loadWaypoints(read("autos/waypoints.json"));
const auto = (): Auto => loadAuto(read("autos/collect-and-score.auto.json"));

describe("the editor's derived state", () => {
  it("keeps every sampled footprint of collect-and-score on RED's side of the centre line (issue #367)", () => {
    // The starter robot is 18 in wide, so a route that is not clear of the hive frame's west legs and
    // the centre line at once crosses x = 0. The tolerance is the season's own OWN_HALF_TOLERANCE_IN.
    const planned = plan(resolve(auto(), waypoints, robot), robot, field);
    let eastmostIn = -Infinity;
    for (const step of flattenSteps(planned.steps)) {
      for (const sample of step.samples) {
        for (const corner of sample.footprintIn) eastmostIn = Math.max(eastmostIn, corner.xIn);
      }
    }
    expect(eastmostIn).toBeLessThanOrEqual(0.05);
  });

  it("reports the example's findings with the BIOBUZZ rules in force", () => {
    const derived = derive(auto(), robot, field, waypoints);
    // collect-and-score has no errors and no warnings: its routes stay on RED's side of the centre
    // line (OPPONENT_SIDE, issue #365), round the west of the hive frame and clear of its legs. The
    // one info is TIME_BUDGET on `total`: sweepGarden ends on a condition, so the estimate is only a
    // bound.
    expect(severityCounts(derived.findings)).toEqual({ error: 0, warning: 0, info: 1 });
    expect(derived.findings.map((finding) => [finding.code, finding.stepId ?? null])).toEqual([["TIME_BUDGET", "total"]]);
    expect(derived.seasonWarnings).toEqual([]);
  });

  it("fills the ledger with what the season says is where", () => {
    const derived = derive(auto(), robot, field, waypoints);
    expect(derived.ledger.length).toBeGreaterThan(0);
    expect(derived.ledger.map((row) => row.label).join("\n")).toContain("launched");
  });

  it("fires START_ILLEGAL when the start pose leaves the season's start zone", () => {
    const document = auto();
    const moved = loadAuto({
      ...(JSON.parse(JSON.stringify(document)) as Record<string, unknown>),
      start: { ...document.start, pose: { xIn: 0, yIn: 0, headingRad: 0 } },
    });
    const codes = derive(moved, robot, field, waypoints).findings.map((finding) => finding.code);
    expect(codes).toContain("START_ILLEGAL");
  });

  it("says so, once, when the field names a season plugin this build does not carry", () => {
    const unknown = { ...field, rules: { ...field.rules, plugin: "season-elsewhere" } } as Field;
    const derived = derive(auto(), robot, unknown, waypoints);
    expect(derived.seasonWarnings).toHaveLength(1);
    expect(derived.seasonWarnings[0]).toContain("season-elsewhere");
    expect(derived.ledger).toEqual([]);
  });
});
