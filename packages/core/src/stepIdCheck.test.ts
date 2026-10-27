import { SCHEMA_ID, type Auto } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { check } from "./check.js";
import { applyFix, applyFixes } from "./fix.js";
import { loadAuto } from "./load.js";
import { plan } from "./plan.js";
import { resolve } from "./resolve.js";
import { testField, testRobot, testWaypoints } from "./testing/fixtures.js";
import type { Finding } from "./types.js";

/**
 * STEP_ID: a step id written before ids followed the waypoint name rule still loads, and `check`
 * warns about it with a one-click rename that carries every reference to the old id.
 */
const oldIds = (): Auto =>
  loadAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "old-ids",
    alliance: "RED",
    start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
    steps: [
      { id: "shoot preload", kind: "wait", seconds: 0.5 },
      {
        id: "park",
        kind: "parallel",
        mode: "deadline",
        deadline: "drive.out",
        steps: [
          { id: "drive.out", kind: "wait", seconds: 1 },
          { kind: "wait", seconds: 0.2 },
        ],
      },
      { id: "shootPreload", kind: "wait", seconds: 0.1 },
      { id: "2nd", kind: "wait", seconds: 0.1 },
    ],
  });

const stepIdFindings = (auto: Auto): Finding[] =>
  check(plan(resolve(auto, testWaypoints), testRobot, testField), null, testRobot, testField).filter(
    (finding) => finding.code === "STEP_ID",
  );

describe("STEP_ID", () => {
  it("warns about each explicit id outside the rule, and never about a positional one", () => {
    const findings = stepIdFindings(oldIds());
    expect(findings.map((finding) => [finding.severity, finding.stepId, finding.message])).toEqual([
      ["warning", "shoot preload", 'Step id "shoot preload" has a space. Ids start with a letter and hold only letters, digits, _ and -.'],
      ["warning", "drive.out", 'Step id "drive.out" has a ".". Ids start with a letter and hold only letters, digits, _ and -.'],
      ["warning", "2nd", 'Step id "2nd" does not start with a letter. Ids start with a letter and hold only letters, digits, _ and -.'],
    ]);
  });

  it("offers a rename to an id inside the rule that no other step has", () => {
    const fixes = stepIdFindings(oldIds()).map((finding) => finding.fixes);
    expect(fixes).toEqual([
      [{ kind: "renameStep", stepId: "shoot preload", label: "Rename to shootPreload-2", params: { newId: "shootPreload-2" } }],
      [{ kind: "renameStep", stepId: "drive.out", label: "Rename to driveOut", params: { newId: "driveOut" } }],
      [{ kind: "renameStep", stepId: "2nd", label: "Rename to step2nd", params: { newId: "step2nd" } }],
    ]);
  });

  it("renames through renameStep, so the deadline that named the old id follows it", () => {
    const fixes = stepIdFindings(oldIds()).flatMap((finding) => finding.fixes ?? []);
    const fixed = applyFixes(oldIds(), fixes);
    expect(stepIdFindings(fixed)).toEqual([]);
    const park = fixed.steps[1];
    if (park?.kind !== "parallel") throw new Error("expected parallel");
    expect(park.deadline).toBe("driveOut");
    expect(park.steps.map((step) => step.id)).toEqual(["driveOut", undefined]);
    expect(fixed.steps.map((step) => step.id)).toEqual(["shootPreload-2", "park", "shootPreload", "step2nd"]);
  });

  it("leaves the auto as it is when the fix has gone stale", () => {
    const auto = oldIds();
    const fix = stepIdFindings(auto)[0]?.fixes?.[0];
    if (fix?.kind !== "renameStep") throw new Error("expected a rename");
    expect(applyFix(auto, { ...fix, params: { newId: "park" } })).toBe(auto);
    expect(applyFix(auto, { ...fix, stepId: "nowhere" })).toBe(auto);
  });
});
