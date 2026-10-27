import { describe, expect, it } from "vitest";
import { canonicalize, check, estimate, loadAuto, plan, resolve } from "@horizon36596/zenith-core";
import type { Auto, PathStep, Pose } from "@horizon36596/zenith-schema";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import { ImportError } from "../errors.js";
import { fixtureFiles, fixturePath, readJson, starterField, starterRobot } from "../testSupport.js";
import { importTrajectory } from "./importTrajectory.js";
import { importTrajectoryAsAuto, TRAJECTORY_AUTO_PROVENANCE } from "./trajectoryAuto.js";

const field = starterField();
const robot = starterRobot();

/** An auto after the canonical writer's rounding, read back the way the CLI reads a file. */
const roundTrip = (auto: Auto): Auto => loadAuto(JSON.parse(canonicalize("auto", auto)));

/** Every line of every path step, as field points, in step order. */
function polyline(auto: Auto): { xIn: number; yIn: number }[][] {
  const start = auto.start.pose as Pose;
  let cursor = { xIn: start.xIn, yIn: start.yIn };
  const lines: { xIn: number; yIn: number }[][] = [];
  for (const step of auto.steps) {
    if (step.kind !== "path") continue;
    for (const segment of step.segments) {
      const to = segment.to as Pose;
      lines.push([cursor, { xIn: to.xIn, yIn: to.yIn }]);
      cursor = { xIn: to.xIn, yIn: to.yIn };
    }
  }
  return lines;
}

function distanceToLines(p: { xIn: number; yIn: number }, lines: readonly { xIn: number; yIn: number }[][]): number {
  let best = Infinity;
  for (const [a, b] of lines) {
    if (a === undefined || b === undefined) continue;
    const dx = b.xIn - a.xIn;
    const dy = b.yIn - a.yIn;
    const length2 = dx * dx + dy * dy;
    const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.xIn - a.xIn) * dx + (p.yIn - a.yIn) * dy) / length2));
    best = Math.min(best, Math.hypot(p.xIn - (a.xIn + t * dx), p.yIn - (a.yIn + t * dy)));
  }
  return best;
}

const good = fixtureFiles("trajectory", ".trajectory.json");

describe("importTrajectoryAsAuto: a trajectory.json becomes an auto that can be shared", () => {
  it("has fixtures to hold it to", () => {
    expect(good.length).toBeGreaterThanOrEqual(3);
  });

  for (const name of good) {
    describe(name, () => {
      const doc = readJson(fixturePath(`trajectory/${name}`));
      const result = importTrajectoryAsAuto(doc, field, { name: "imported" });
      const auto = roundTrip(result.auto);

      it("loads and plans with no finding about the file's own form: its steps join and its headings are whole", () => {
        // A fixture's route need not be a legal auto on the starter's field (one leaves the field
        // on purpose); what the import owns is that every step is well formed and joins the next.
        const planned = plan(resolve(auto, undefined), robot, field);
        const findings = check(planned, estimate(planned, robot), robot, field, resolveSeason(field).rules);
        const FORM = ["SCHEMA", "STRUCTURE", "CONTINUITY", "HEADING_RANGES"];
        expect(findings.filter((finding) => FORM.includes(finding.code))).toEqual([]);
      });

      it("lies within 0.5 in of every sample the alliance view would show", () => {
        const lines = polyline(auto);
        const projection = importTrajectory(doc, field);
        for (const [xIn, yIn] of projection.trajectory.poses) {
          expect(distanceToLines({ xIn, yIn }, lines)).toBeLessThanOrEqual(0.5 + 1e-6);
        }
      });

      it("labels every pose it wrote as carried over from the trajectory.json import", () => {
        const poses: Pose[] = [auto.start.pose as Pose];
        for (const step of auto.steps) {
          if (step.kind !== "path") continue;
          for (const segment of step.segments) {
            if (typeof segment.from === "object" && "xIn" in segment.from) poses.push(segment.from);
            poses.push(segment.to as Pose);
          }
        }
        expect(poses.every((pose) => pose.provenance === TRAJECTORY_AUTO_PROVENANCE)).toBe(true);
      });
    });
  }

  it("cuts the MeepMeep line and turn into a drive, a wait and a turn in place, and says so", () => {
    const { auto, warnings, robotFootprint, totalS } = importTrajectoryAsAuto(
      readJson(fixturePath("trajectory/meepmeep-line-and-turn.trajectory.json")),
      field,
      { name: "meepmeep" },
    );
    expect(auto.steps.map((step) => [step.id, step.kind])).toEqual([
      ["drive1", "path"],
      ["wait1", "wait"],
      ["turn1", "path"],
    ]);
    expect(auto.alliance).toBe("RED");
    expect(auto.title).toBe("MeepMeep line and turn");
    expect(totalS).toBeCloseTo(5, 9);
    const wait = auto.steps[1];
    // The file stands still for 0.5 s; the 0.5 in rounding adds the last crawl of the line and the
    // first of the turn, which repeat a sample, so the wait comes out a little longer.
    const waitS = wait?.kind === "wait" ? (wait.seconds ?? 0) : 0;
    expect(waitS).toBeGreaterThanOrEqual(0.5);
    expect(waitS).toBeLessThanOrEqual(0.8);
    const drive = auto.steps[0] as PathStep;
    expect(drive.segments).toHaveLength(1);
    expect(drive.heading).toMatchObject({ mode: "constant" });
    const turn = auto.steps[2] as PathStep;
    expect(turn.heading?.mode).toBe("linear");
    if (turn.heading?.mode === "linear") expect(turn.heading.toRad - turn.heading.fromRad).toBeCloseTo(Math.PI / 2, 1);
    expect(warnings.join("\n")).toMatch(/turns 90 degrees without moving; it became the step turn1/);
    expect(warnings.join("\n")).toMatch(/The trajectory runs 5\.0 s\. The auto is timed from this project's robot\.json/);
    expect(robotFootprint).toEqual({ lengthIn: 18, widthIn: 18 });
  });

  it("follows a curve that turns as it drives with line segments and a piecewise heading", () => {
    // A quarter circle of radius 30 in, counter-clockwise about (-40, -30), facing along it, in 3 s.
    const poses = Array.from({ length: 31 }, (_, k) => {
      const a = -Math.PI / 2 + (Math.PI / 2) * (k / 30);
      return [-40 + 30 * Math.cos(a), -30 + 30 * Math.sin(a), a + Math.PI / 2];
    });
    const doc = {
      formatVersion: 1,
      kind: "trajectory",
      season: "biobuzz",
      alliance: "RED",
      frame: { preset: "zenith" },
      rateHz: 10,
      poses,
      boundingBox: { lengthIn: 18, widthIn: 18 },
    };
    const { auto } = importTrajectoryAsAuto(doc, field);
    expect(auto.steps).toHaveLength(1);
    const step = roundTrip(auto).steps[0] as PathStep;
    expect(step.segments.length).toBeGreaterThan(2);
    expect(step.segments.every((segment) => segment.kind === "line")).toBe(true);
    expect(step.heading?.mode).toBe("piecewise");
    if (step.heading?.mode === "piecewise") {
      expect(step.heading.ranges[0]?.startT).toBe(0);
      expect(step.heading.ranges[step.heading.ranges.length - 1]?.endT).toBe(1);
      step.heading.ranges.forEach((range, i) => {
        if (i > 0) expect(range.startT).toBe(step.heading?.mode === "piecewise" ? step.heading.ranges[i - 1]?.endT : NaN);
        expect(range.endT).toBeGreaterThan(range.startT);
      });
    }
    const lines = polyline(roundTrip(auto));
    for (const [xIn, yIn] of importTrajectory(doc, field).trajectory.poses) {
      expect(distanceToLines({ xIn, yIn }, lines)).toBeLessThanOrEqual(0.5 + 1e-6);
    }
    const planned = plan(resolve(roundTrip(auto), undefined), robot, field);
    const findings = check(planned, estimate(planned, robot), robot, field, resolveSeason(field).rules);
    expect(findings.filter((finding) => ["SCHEMA", "STRUCTURE", "CONTINUITY", "HEADING_RANGES"].includes(finding.code))).toEqual([]);
  });

  it("refuses a broken file with the same fields readTrajectory names", () => {
    expect(() => importTrajectoryAsAuto(readJson(fixturePath("trajectory/broken/pose-row-too-short.trajectory.json")), field)).toThrow(ImportError);
  });

  it("refuses an auto name the CLI could not use", () => {
    expect(() =>
      importTrajectoryAsAuto(readJson(fixturePath("trajectory/meepmeep-line-and-turn.trajectory.json")), field, { name: "../x" }),
    ).toThrow(ImportError);
  });
});
