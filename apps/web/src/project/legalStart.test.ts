/**
 * The legal start a new host auto gets (hostBackend.ts `newAutoStart`): found by trying poses along
 * the walls and keeping the first the season's own START_ILLEGAL rule accepts. Checked here with the
 * same derive pipeline the Problems panel reads, for the starter robot and the BIOBUZZ example
 * robot on the BIOBUZZ field, and for the fall-backs.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { footprintAt, loadField, loadRobot, loadWaypoints, newAutoFromTemplate, type Finding } from "@horizon36596/zenith-core";
import type { Field, Robot } from "@horizon36596/zenith-schema";
import { derive } from "../state/derived";
import {
  chooseLegalStart,
  findLegalStart,
  LEGAL_START_TRIES,
  legalStartFor,
  nearestLegalStart,
  offersLegalStartFix,
  type LegalStart,
} from "./legalStart";

const examplePath = (path: string): string => fileURLToPath(new URL(`../../../../examples/${path}`, import.meta.url));
const examples = (path: string): unknown => JSON.parse(readFileSync(examplePath(path), "utf8"));

const field: Field = loadField(examples("starter/autos/field/biobuzz.field.json"));
const starter: Robot = loadRobot(examples("starter/autos/robot.json"));

/**
 * The robots every start is checked for. The BIOBUZZ example is Horizon's own robot and stays in the
 * private repository (scripts/public-snapshot.mjs), so the public tree checks the starter robot only.
 */
const robots: [string, Robot][] = [["the starter robot", starter]];
if (existsSync(examplePath("biobuzz/autos/robot.json"))) {
  robots.push(["the BIOBUZZ example robot", loadRobot(examples("biobuzz/autos/robot.json"))]);
}

/** The findings the editor shows for a new auto that starts at `start`, from the app's own pipeline. */
function findingsFor(robot: Robot, start: { xIn: number; yIn: number; headingRad: number }) {
  const auto = newAutoFromTemplate("probe", {
    alliance: field.frame.canonicalAlliance,
    start: { pose: { ...start, provenance: "NEEDS MEASUREMENT: test" } },
  });
  return derive(auto, robot, field, loadWaypoints({ $schema: "https://libraries.horizon36596.org/zenith/schema/v1/waypoints.json", formatVersion: 1, waypoints: {} })).findings;
}

describe("findLegalStart", () => {
  it.each(robots)("finds a start for %s on BIOBUZZ RED with no START_ILLEGAL finding", (_name, robot) => {
    const start = findLegalStart(field, robot, "RED");
    expect(start).not.toBeNull();
    if (start === null) return;
    const findings = findingsFor(robot, start);
    expect(findings.filter((finding) => finding.code === "START_ILLEGAL")).toEqual([]);
    // Touching the audience wall with the robot's body, in RED's own half (x below 0 here).
    const corners = footprintAt(start, robot, "startIn").bodyIn;
    expect(Math.min(...corners.map((corner) => corner.yIn))).toBeCloseTo(-field.sizeIn.yIn / 2, 1);
    expect(Math.max(...corners.map((corner) => corner.xIn))).toBeLessThanOrEqual(0.05);
    expect(start.wall).toBe("y = -72 in");
  });

  it("puts the starter robot at (-12, -63) facing into the field", () => {
    expect(findLegalStart(field, starter, "RED")).toEqual({ xIn: -12, yIn: -63, headingRad: 1.5708, wall: "y = -72 in" });
  });

  it("finds BLUE's start in BLUE's own half when asked for BLUE", () => {
    const start = findLegalStart(field, starter, "BLUE");
    expect(start).not.toBeNull();
    const corners = footprintAt(start ?? { xIn: 0, yIn: 0, headingRad: 0 }, starter, "startIn").bodyIn;
    expect(Math.min(...corners.map((corner) => corner.xIn))).toBeGreaterThanOrEqual(-0.05);
  });

  it("returns null with no start rule, an unknown season, or a robot no pose fits", () => {
    const { startRules: _unused, ...withoutRules } = field;
    expect(findLegalStart(withoutRules as Field, starter, "RED")).toBeNull();
    expect(findLegalStart({ ...field, season: "other", rules: { plugin: "season-other" } } as Field, starter, "RED")).toBeNull();
    const huge: Robot = {
      ...starter,
      footprint: {
        ...starter.footprint,
        startIn: { ...starter.footprint.startIn, lengthIn: 100, widthIn: 100 },
      },
    };
    expect(findLegalStart(field, huge, "RED")).toBeNull();
  });
});

describe("nearestLegalStart", () => {
  it.each(robots)("moves an illegal start for %s to a legal pose close by, not the first one found", (_name, robot) => {
    // In the middle of RED's own half, well off every wall, so touching a wall is what is missing.
    const from = { xIn: -36, yIn: 0, headingRad: 0 };
    expect(findingsFor(robot, from).some((finding) => finding.code === "START_ILLEGAL")).toBe(true);
    const start = nearestLegalStart(field, robot, "RED", from);
    expect(start).not.toBeNull();
    if (start === null) return;
    expect(findingsFor(robot, start).filter((finding) => finding.code === "START_ILLEGAL")).toEqual([]);
    const first = findLegalStart(field, robot, "RED");
    const distance = (pose: { xIn: number; yIn: number }) => Math.hypot(pose.xIn - from.xIn, pose.yIn - from.yIn);
    expect(distance(start)).toBeLessThanOrEqual(distance(first ?? start));
  });

  it("keeps the robot's own heading when a pose that far away allows it", () => {
    // Just off the audience wall, facing into the field: sliding down onto the wall keeps the heading.
    const from = { xIn: -12, yIn: -60, headingRad: Math.PI / 2 };
    expect(nearestLegalStart(field, starter, "RED", from)).toEqual({
      xIn: -12,
      yIn: -63,
      headingRad: 1.5708,
      wall: "y = -72 in",
    });
  });

  it("finds BLUE's nearest start in BLUE's own half", () => {
    const start = nearestLegalStart(field, starter, "BLUE", { xIn: -36, yIn: 0, headingRad: 0 });
    expect(start).not.toBeNull();
    const corners = footprintAt(start ?? { xIn: 0, yIn: 0, headingRad: 0 }, starter, "startIn").bodyIn;
    expect(Math.min(...corners.map((corner) => corner.xIn))).toBeGreaterThanOrEqual(-0.05);
  });

  it("returns null when there is no start rule to be legal against", () => {
    const { startRules: _unused, ...withoutRules } = field;
    expect(nearestLegalStart(withoutRules as Field, starter, "RED", { xIn: 0, yIn: 0, headingRad: 0 })).toBeNull();
  });
});

describe("the Problems panel's one-click fix for START_ILLEGAL", () => {
  const waypoints = () =>
    loadWaypoints({ $schema: "https://libraries.horizon36596.org/zenith/schema/v1/waypoints.json", formatVersion: 1, waypoints: { start: { xIn: -36, yIn: 0, headingRad: 0 } } });
  const deriveFor = (pose: { xIn: number; yIn: number; headingRad: number; provenance: string } | { ref: string }) =>
    derive(newAutoFromTemplate("probe", { alliance: "RED", start: { pose } }), starter, field, waypoints());

  it("is offered for an inline start the rule refuses, and moves it to the nearest legal pose", () => {
    const derived = deriveFor({ xIn: -36, yIn: 0, headingRad: 0, provenance: "NEEDS MEASUREMENT: test" });
    expect(derived.findings.some((finding) => finding.code === "START_ILLEGAL")).toBe(true);
    expect(offersLegalStartFix(derived.plan, derived.findings)).toBe(true);
    if (derived.plan === null) throw new Error("no plan");
    expect(legalStartFor(derived.plan)).toEqual(nearestLegalStart(field, starter, "RED", { xIn: -36, yIn: 0, headingRad: 0 }));
  });

  it("is not offered for a legal start", () => {
    const legal = findLegalStart(field, starter, "RED");
    if (legal === null) throw new Error("no legal start");
    const clean = deriveFor({ xIn: legal.xIn, yIn: legal.yIn, headingRad: legal.headingRad, provenance: "NEEDS MEASUREMENT: test" });
    expect(offersLegalStartFix(clean.plan, clean.findings)).toBe(false);
  });

  describe("chooseLegalStart (issue #155)", () => {
    const planned = () => {
      const plan = deriveFor({ xIn: -36, yIn: 0, headingRad: 0, provenance: "NEEDS MEASUREMENT: test" }).plan;
      if (plan === null) throw new Error("no plan");
      return plan;
    };
    const nearest = () => nearestLegalStart(field, starter, "RED", { xIn: -36, yIn: 0, headingRad: 0 });
    const perimeter: Finding = { severity: "error", stepId: "leg", code: "PERIMETER", message: "The footprint leaves the field by 1.00 in." };

    it("takes the nearest start when the auto gains no error there and the first path leaves facing its way", () => {
      const choice = chooseLegalStart(planned(), [], (start) => ({ findings: [], firstPathHeadingRad: start.headingRad }));
      expect(choice).toEqual({ start: nearest(), remaining: null });
    });

    it("skips a start where the auto gains an error, and counts one the old start already had as not new", () => {
      const first = nearest();
      const tried: LegalStart[] = [];
      const choice = chooseLegalStart(planned(), [], (start) => {
        tried.push(start);
        return { findings: tried.length === 1 ? [perimeter] : [], firstPathHeadingRad: start.headingRad };
      });
      expect(choice?.start).not.toEqual(first);
      expect(choice?.start).toEqual(tried[1]);
      expect(chooseLegalStart(planned(), [perimeter], (start) => ({ findings: [perimeter], firstPathHeadingRad: start.headingRad }))).toEqual({
        start: first,
        remaining: null,
      });
    });

    it("prefers a start turned to the first path's heading, then one the robot turns at, when no start leaves facing its way", () => {
      // Every start turns on the spot by half a radian, turned or not: the first turned one wins.
      const turning = chooseLegalStart(planned(), [], (start) => ({ findings: [], firstPathHeadingRad: start.headingRad + 0.5 }));
      expect(turning?.remaining).toBeNull();
      expect(turning?.start.headingRad).toBeCloseTo((nearest()?.headingRad ?? 0) + 0.5, 4);
      // When no turned start can be planned, the nearest one the robot turns at is kept.
      const first = nearest();
      // The starts tried first face along or across a wall; the turned ones face neither way.
      const plain = chooseLegalStart(planned(), [], (start) =>
        Math.abs(Math.sin(2 * start.headingRad)) < 1e-3 ? { findings: [], firstPathHeadingRad: start.headingRad + 0.5 } : null,
      );
      expect(plain).toEqual({ start: first, remaining: null });
    });

    it("keeps the nearest start and names the error when every start tried gains one", () => {
      const choice = chooseLegalStart(planned(), [], (start) => ({ findings: [perimeter], firstPathHeadingRad: start.headingRad + 0.5 }));
      expect(choice).toEqual({ start: nearest(), remaining: perimeter });
    });

    it("tries at most LEGAL_START_TRIES starts, and turns none when there is no path to turn to", () => {
      let tried = 0;
      chooseLegalStart(planned(), [], () => {
        tried += 1;
        return { findings: [perimeter], firstPathHeadingRad: null };
      });
      expect(tried).toBe(LEGAL_START_TRIES);
    });
  });

  it("is offered for a start that follows a waypoint, from where the waypoint puts it (issue #133)", () => {
    // Taking it unlinks the start from the waypoint, as a drag does; the waypoint itself stays put.
    const followsWaypoint = deriveFor({ ref: "start" });
    expect(followsWaypoint.findings.some((finding) => finding.code === "START_ILLEGAL")).toBe(true);
    expect(offersLegalStartFix(followsWaypoint.plan, followsWaypoint.findings)).toBe(true);
    if (followsWaypoint.plan === null) throw new Error("no plan");
    expect(legalStartFor(followsWaypoint.plan)).toEqual(nearestLegalStart(field, starter, "RED", { xIn: -36, yIn: 0, headingRad: 0 }));
  });
});
