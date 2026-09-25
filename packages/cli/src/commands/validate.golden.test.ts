import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  check,
  estimate,
  loadAuto,
  loadField,
  loadRobot,
  loadWaypoints,
  plan,
  resolve,
  type Finding,
} from "@horizon36596/zenith-core";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import { describe, expect, it, vi } from "vitest";
import { runValidate } from "./validate.js";

/**
 * `zenith validate` must report exactly what the editor would: `check()` fed the real `estimate()`,
 * not `null` (the bug this test guards against — see `packages/mcp/src/findings.ts` and
 * `apps/web/src/state/derived.ts` for the other two callers that have to agree).
 */
const examplesDir = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));

const read = (relative: string): unknown => JSON.parse(readFileSync(`${examplesDir}${relative}`, "utf8"));

const codeMultiset = (findings: readonly Finding[]): string[] => findings.map((finding) => finding.code).sort();

/** Core's findings for one starter auto, computed the editor's way: the real estimate and the season's rules. */
function editorFindings(auto: ReturnType<typeof loadAuto>): Finding[] {
  const robot = loadRobot(read("autos/robot.json"));
  const field = loadField(read("autos/field/biobuzz.field.json"));
  const waypoints = loadWaypoints(read("autos/waypoints.json"));
  const season = resolveSeason(field);
  const planned = plan(resolve(auto, waypoints), robot, field);
  return check(planned, estimate(planned, robot), robot, field, season.rules);
}

describe("zenith validate against examples/starter/autos/collect-and-score.auto.json", () => {
  it("finds the same codes, in the same counts, as core computed the editor's way", () => {
    const expected = editorFindings(loadAuto(read("autos/collect-and-score.auto.json")));

    const bySeverity = (severity: Finding["severity"]): number =>
      expected.filter((finding) => finding.severity === severity).length;
    // Pinned so a change to this count is a deliberate one. The one info is TIME_BUDGET on `total`,
    // the lower-bound note that fires because `sweepGarden` ends when the hopper reads full, so its
    // contribution to the total is unknown (finding 18). It fires only once the real estimate is in
    // play, which is what this test is here to prove.
    expect({ errors: bySeverity("error"), warnings: bySeverity("warning"), infos: bySeverity("info") }).toEqual({
      errors: 0,
      warnings: 0,
      infos: 1,
    });

    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    let code: number;
    try {
      code = runValidate([`${examplesDir}autos/collect-and-score.auto.json`], { json: true, project: examplesDir });
    } finally {
      spy.mockRestore();
    }

    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("")) as { files: { findings: Finding[] }[] };
    const actual = parsed.files[0]?.findings ?? [];
    expect(codeMultiset(actual)).toEqual(codeMultiset(expected));
  });
});

/**
 * Every starter auto validates with no errors and no warnings, with the BIOBUZZ season rules and
 * the real estimate in force, the way `zenith validate` and the editor compute it.
 */
describe("every auto in examples/starter", () => {
  const autos = readdirSync(`${examplesDir}autos`).filter((name) => name.endsWith(".auto.json")).sort();

  // What is left, pinned so a change is deliberate. The TIME_BUDGET infos fire because a step ends
  // on a condition (hopperFull), so the total is a lower bound.
  const remaining: Record<string, string[]> = {
    "all-step-kinds.auto.json": ["info TIME_BUDGET total"],
    "collect-and-score.auto.json": ["info TIME_BUDGET total"],
    "cycle-and-park.auto.json": ["info TIME_BUDGET total"],
    "first-auto.auto.json": [],
  };

  it("finds the four starter autos", () => {
    expect(autos).toEqual([
      "all-step-kinds.auto.json",
      "collect-and-score.auto.json",
      "cycle-and-park.auto.json",
      "first-auto.auto.json",
    ]);
  });

  it.each(autos)("%s validates with no errors and no warnings", (name) => {
    const findings = editorFindings(loadAuto(read(`autos/${name}`)));
    expect(findings.filter((finding) => finding.severity === "error")).toEqual([]);
    expect(findings.filter((finding) => finding.severity === "warning")).toEqual([]);
    expect(findings.map((finding) => `${finding.severity} ${finding.code} ${finding.stepId}`).sort()).toEqual(
      remaining[name],
    );
  });

  it("warns SWEEP_SPEED when the garden sweep runs faster than the robot's sweep speed", () => {
    // The starter sweeps at 0.3, under the default sweep speed of 0.4. Raise it past that on purpose.
    const raw = read("autos/collect-and-score.auto.json") as { steps: { id: string; speedFraction?: number }[] };
    const sweep = raw.steps.find((step) => step.id === "sweepGarden");
    expect(sweep?.speedFraction).toBe(0.3);
    if (sweep !== undefined) sweep.speedFraction = 0.8;
    const findings = editorFindings(loadAuto(raw));
    expect(findings.map((finding) => `${finding.severity} ${finding.code} ${finding.stepId}`).sort()).toEqual([
      "info TIME_BUDGET total",
      "warning SWEEP_SPEED sweepGarden",
    ]);
  });
});
