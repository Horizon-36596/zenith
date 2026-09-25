import { parseAuto, SCHEMA_ID, type Auto } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { check } from "./check.js";
import { estimate } from "./estimate.js";
import { FINDING_HELP } from "./findingHelp.js";
import { plan } from "./plan.js";
import { resolve } from "./resolve.js";
import { testField, testRobot, testWaypoints } from "./testing/fixtures.js";
import type { Finding } from "./types.js";

/**
 * The heading mismatch ruling: core's `linear` heading turns the short way, as Pedro does on the
 * robot, everywhere core uses it; a sweep that asks one segment for more than half a turn raises a
 * HEADING warning; a `facePoint` offset the runtime ignores raises a HEADING info.
 */

const auto = (heading: unknown, segments?: unknown[]): Auto =>
  parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 2,
    name: "heading-fixture",
    alliance: "RED",
    start: { pose: { xIn: 0, yIn: -40, headingRad: 0 } },
    steps: [
      {
        id: "turn",
        kind: "path",
        segments: segments ?? [{ kind: "line", from: "current", to: { xIn: 24, yIn: -40 } }],
        heading,
      },
    ],
  });

const planOf = (a: Auto) => plan(resolve(a, testWaypoints), testRobot, testField);
const headingFindings = (a: Auto): Finding[] => {
  const planned = planOf(a);
  return check(planned, estimate(planned, testRobot), testRobot, testField).filter(
    (finding) => finding.code === "HEADING",
  );
};

describe("heading: the preview turns the way the robot turns", () => {
  it("samples a sweep of more than half a turn the short way, and times it the same as the short turn", () => {
    const long = planOf(auto({ mode: "linear", fromRad: 0, toRad: 3.5 }));
    const short = planOf(auto({ mode: "linear", fromRad: 0, toRad: 3.5 - 2 * Math.PI }));
    const middle = long.steps[0]?.samples[Math.floor((long.steps[0]?.samples.length ?? 0) / 2)];
    expect(middle?.pose.headingRad).toBeLessThan(0);
    const longHeadings = long.steps[0]?.samples.map((sample) => sample.pose.headingRad) ?? [];
    const shortHeadings = short.steps[0]?.samples.map((sample) => sample.pose.headingRad) ?? [];
    expect(longHeadings.length).toBe(shortHeadings.length);
    longHeadings.forEach((heading, index) => expect(heading).toBeCloseTo(shortHeadings[index] as number, 9));
    expect(estimate(long, testRobot).nominalS).toBeCloseTo(estimate(short, testRobot).nominalS as number, 9);
  });
});

describe("heading: findings", () => {
  it("warns about a linear sweep over half a turn on one segment, with the turn the robot makes", () => {
    const findings = headingFindings(auto({ mode: "linear", fromRad: 0, toRad: 3.5 }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "warning", stepId: "turn" });
    expect(findings[0]?.message).toBe(
      "This turn is over half a turn; the robot takes the short way (-159°). Split the path or use a waypoint heading if you want the long way.",
    );
  });

  it("stays quiet when the same sweep is split so no segment turns more than half a turn", () => {
    const findings = headingFindings(
      auto({ mode: "linear", fromRad: 0, toRad: 3.5 }, [
        { kind: "line", from: "current", to: { xIn: 12, yIn: -40 } },
        { kind: "line", from: "current", to: { xIn: 24, yIn: -40 } },
      ]),
    );
    expect(findings).toEqual([]);
  });

  it("stays quiet on the editor's half turn and on a quarter turn", () => {
    expect(headingFindings(auto({ mode: "linear", fromRad: 0, toRad: 3.1416 }))).toEqual([]);
    expect(headingFindings(auto({ mode: "linear", fromRad: 0, toRad: -3.1416 }))).toEqual([]);
    expect(headingFindings(auto({ mode: "linear", fromRad: 0, toRad: 1.5708 }))).toEqual([]);
  });

  it("notes a facePoint offset the runtime ignores, and nothing for a zero offset", () => {
    const withOffset = headingFindings(auto({ mode: "facePoint", xIn: 0, yIn: 0, offsetRad: 0.5 }));
    expect(withOffset).toEqual([
      { severity: "info", stepId: "turn", code: "HEADING", message: "The robot runtime ignores offsetRad for now." },
    ]);
    expect(headingFindings(auto({ mode: "facePoint", xIn: 0, yIn: 0, offsetRad: 0 }))).toEqual([]);
    expect(headingFindings(auto({ mode: "facePoint", xIn: 0, yIn: 0 }))).toEqual([]);
  });

  it("has plain-language help", () => {
    expect(FINDING_HELP.HEADING.title.length).toBeGreaterThan(0);
  });
});
