import { parseAuto, parseField, SCHEMA_ID, type Auto, type Field } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { check } from "./check.js";
import { estimate } from "./estimate.js";
import { applyFix } from "./fix.js";
import { plan } from "./plan.js";
import { resolve } from "./resolve.js";
import { noSeasonRules, type SeasonRules } from "./season.js";
import { testField, testRobot, testWaypoints } from "./testing/fixtures.js";
import type { Finding, FindingCode, Fix } from "./types.js";

/**
 * Finding actions (issue #309): STRUCTURE, CLEARANCE, PERIMETER and KEEPOUT on a path step carry the
 * `optimizeRoute` fix, "Route around <label>", and STRAFE_FRACTION carries "Find a faster heading"
 * (`headingOnly`). The fix is only a request for the editor to open the card: `check()` never runs the
 * optimizer, and `applyFix` writes nothing.
 */

const autoWith = (start: { xIn: number; yIn: number; headingRad: number }, steps: unknown[]): Auto =>
  parseAuto({ $schema: SCHEMA_ID.auto, formatVersion: 4, name: "finding-actions", alliance: "RED", start: { pose: start }, steps });

const findingsFor = (auto: Auto, field: Field = testField, season: SeasonRules = noSeasonRules): Finding[] => {
  const planned = plan(resolve(auto, testWaypoints), testRobot, field);
  return check(planned, estimate(planned, testRobot), testRobot, field, season);
};

const of = (findings: readonly Finding[], code: FindingCode): Finding[] => findings.filter((finding) => finding.code === code);

const optimizeFixes = (finding: Finding | undefined): Fix[] => (finding?.fixes ?? []).filter((fix) => fix.kind === "optimizeRoute");

/** The test robot is 14 in across, so east along y puts its south edge at y - 7, and `hiveRedBase` ends at y 6. */
const eastAt = (yIn: number): Auto =>
  autoWith({ xIn: -40, yIn, headingRad: 0 }, [
    { id: "pastTheHive", kind: "path", segments: [{ kind: "line", from: "current", to: { xIn: 10, yIn, headingRad: 0 } }], heading: { mode: "tangent" } },
  ]);

describe("Route around on STRUCTURE", () => {
  it("is offered on a path step, named for the obstacle by its id when the season has no label", () => {
    const [finding] = of(findingsFor(eastAt(0)), "STRUCTURE");
    expect(finding?.stepId).toBe("pastTheHive");
    const fixes = optimizeFixes(finding);
    expect(fixes).toEqual([
      { kind: "optimizeRoute", stepId: "pastTheHive", label: `Route around ${String(finding?.geometry?.obstacleId)}`, params: { obstacleId: finding?.geometry?.obstacleId } },
    ]);
  });

  it("uses the season's own words for the obstacle, without the id after them", () => {
    const season: SeasonRules = { ...noSeasonRules, obstacleLabel: (id) => (id === "hiveRedBase" ? "the RED hive" : null) };
    const structure = of(findingsFor(eastAt(0), testField, season), "STRUCTURE").find((finding) => finding.geometry?.obstacleId === "hiveRedBase");
    expect(optimizeFixes(structure).map((fix) => fix.label)).toEqual(["Route around the RED hive"]);
    expect(optimizeFixes(structure)[0]?.params).toEqual({ obstacleId: "hiveRedBase" });
  });

  it("keeps the fixes the finding already had, with Route around after them", () => {
    // Ending 0.9 in into the hive's base, an inline pose, also offers the push-back fix.
    const auto = autoWith({ xIn: -40, yIn: 0, headingRad: 0 }, [
      { id: "intoIt", kind: "path", segments: [{ kind: "line", from: "current", to: { xIn: -8, yIn: 0, headingRad: 0 } }], heading: { mode: "tangent" } },
    ]);
    const [finding] = of(findingsFor(auto), "STRUCTURE");
    const kinds = (finding?.fixes ?? []).map((fix) => fix.kind);
    expect(kinds[kinds.length - 1]).toBe("optimizeRoute");
    expect(kinds.filter((kind) => kind === "optimizeRoute")).toHaveLength(1);
  });

  it("is not offered on a step that is not a path, where the robot only stands", () => {
    // The start is inside the hive's base, so the wait is where the robot stands in it.
    const auto = autoWith({ xIn: -12, yIn: 0, headingRad: 0 }, [{ id: "stand", kind: "wait", seconds: 1 }]);
    const structure = of(findingsFor(auto), "STRUCTURE");
    expect(structure.length).toBeGreaterThan(0);
    for (const finding of structure) expect(optimizeFixes(finding)).toEqual([]);
  });
});

describe("Route around on CLEARANCE", () => {
  it("is offered on a path step that passes within the margin, and names the obstacle", () => {
    const [finding] = of(findingsFor(eastAt(13.5)), "CLEARANCE");
    expect(finding?.geometry?.obstacleId).toBe("hiveRedBase");
    expect(optimizeFixes(finding)).toEqual([
      { kind: "optimizeRoute", stepId: "pastTheHive", label: "Route around hiveRedBase", params: { obstacleId: "hiveRedBase" } },
    ]);
  });
});

describe("Route around on PERIMETER", () => {
  const throughTheWall = (): Auto =>
    autoWith({ xIn: 0, yIn: 40, headingRad: 0 }, [
      { id: "pastTheWall", kind: "path", segments: [{ kind: "line", from: "current", to: { xIn: 0, yIn: 90 } }], heading: { mode: "constant", headingRad: 0 } },
    ]);

  it("is offered on a path step that leaves the field, as Route around the field wall", () => {
    const [finding] = of(findingsFor(throughTheWall()), "PERIMETER");
    expect(finding?.stepId).toBe("pastTheWall");
    expect(optimizeFixes(finding)).toEqual([{ kind: "optimizeRoute", stepId: "pastTheWall", label: "Route around the field wall", params: {} }]);
  });
});

describe("Route around on KEEPOUT", () => {
  const field = parseField({
    ...testField,
    zones: [{ id: "noGo", kind: "rect", minXIn: 20, maxXIn: 30, minYIn: -40, maxYIn: 2, appliesInAuto: true }],
  });
  const auto = (): Auto =>
    autoWith({ xIn: 0, yIn: 30, headingRad: 0 }, [
      {
        id: "dip",
        kind: "path",
        segments: [{ kind: "bezier", from: "current", control: [{ xIn: 20, yIn: -10 }, { xIn: 30, yIn: -10 }], to: { xIn: 50, yIn: 30 } }],
        heading: { mode: "constant", headingRad: 0 },
      },
    ]);

  it("is offered on a path step that enters a zone, named for the zone", () => {
    const [finding] = of(findingsFor(auto(), field), "KEEPOUT");
    expect(finding?.geometry?.zoneId).toBe("noGo");
    expect(optimizeFixes(finding)).toEqual([{ kind: "optimizeRoute", stepId: "dip", label: "Route around noGo", params: { zoneId: "noGo" } }]);
  });
});

describe("Find a faster heading on STRAFE_FRACTION", () => {
  const sideways = autoWith({ xIn: -40, yIn: 0, headingRad: 0 }, [
    { id: "sideways", kind: "path", segments: [{ kind: "line", from: "current", to: { xIn: -40, yIn: -30 } }], heading: { mode: "constant", headingRad: 0 } },
  ]);

  it("offers headingOnly beside the fixes it already had", () => {
    const [finding] = of(findingsFor(sideways), "STRAFE_FRACTION");
    expect(finding?.stepId).toBe("sideways");
    expect(optimizeFixes(finding)).toEqual([
      { kind: "optimizeRoute", stepId: "sideways", label: "Find a faster heading", params: { mode: "headingOnly" } },
    ]);
    expect((finding?.fixes ?? []).some((fix) => fix.kind === "makeTangent")).toBe(true);
  });

  it("writes nothing when applied: the editor opens the card, and the heading is the person's to preview", () => {
    const [finding] = of(findingsFor(sideways), "STRAFE_FRACTION");
    const fix = optimizeFixes(finding)[0];
    if (fix === undefined) throw new Error("expected the fix");
    expect(applyFix(sideways, fix)).toBe(sideways);
  });
});
