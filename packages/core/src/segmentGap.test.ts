import { parseAuto, SCHEMA_ID, type Auto } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { check } from "./check.js";
import { FINDING_HELP, SEGMENT_GAP_HELP, helpForFinding } from "./findingHelp.js";
import { applyFix } from "./fix.js";
import { plan } from "./plan.js";
import { resolve } from "./resolve.js";
import { testField, testRobot, testWaypoints } from "./testing/fixtures.js";
import type { Finding } from "./types.js";

/**
 * A CONTINUITY gap between two segments of one path step (issue #146): the one-click fix "Join
 * path N to path N-1" sets the later segment's `from` to the earlier one's `to`, and the finding
 * has its own help, since the step-start advice ("set the path's start to current") is about the
 * other kind of gap.
 */

const autoWith = (secondFrom: unknown): Auto =>
  parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "segment-gap",
    alliance: "RED",
    start: { pose: { xIn: -40, yIn: -60, headingRad: 1.5708 } },
    steps: [
      {
        id: "driveOut",
        kind: "path",
        segments: [
          { kind: "line", from: "current", to: { xIn: -40, yIn: -40, headingRad: 1.5708 } },
          { kind: "line", from: secondFrom, to: { xIn: -40, yIn: -20, headingRad: 1.5708 } },
        ],
        heading: { mode: "tangent" },
      },
    ],
  });

const continuity = (auto: Auto): Finding[] =>
  check(plan(resolve(auto, testWaypoints), testRobot, testField), null, testRobot, testField).filter(
    (finding) => finding.code === "CONTINUITY",
  );

describe("a segment-gap CONTINUITY finding", () => {
  it("offers Join path 2 to path 1, and applying it leaves no CONTINUITY finding", () => {
    const gapped = autoWith({ xIn: -16, yIn: -40, headingRad: 1.5708 });
    const [finding, ...rest] = continuity(gapped);
    expect(rest).toEqual([]);
    expect(finding?.message).toMatch(/^Path 2 of this chain starts/);
    const fix = finding?.fixes?.find((candidate) => candidate.kind === "joinSegments");
    expect(fix).toEqual({
      kind: "joinSegments",
      stepId: "driveOut",
      label: "Join path 2 to path 1",
      params: { segmentIndex: 1 },
    });
    if (fix === undefined) throw new Error("expected the join fix");

    const joined = applyFix(gapped, fix);
    expect(continuity(joined)).toEqual([]);
    const step = joined.steps[0];
    if (step?.kind !== "path") throw new Error("expected the path");
    expect(step.segments[1]?.from).toEqual(step.segments[0]?.to);
  });

  it("joins a later segment to a waypoint the earlier one ends on by following it too", () => {
    const auto = parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 1,
      name: "segment-gap-waypoint",
      alliance: "RED",
      start: { pose: { xIn: -40, yIn: -60, headingRad: 1.5708 } },
      steps: [
        {
          id: "driveOut",
          kind: "path",
          segments: [
            // startTile is (-40, -63) in the test waypoints.
            { kind: "line", from: "current", to: { ref: "startTile" } },
            { kind: "line", from: { xIn: -20, yIn: -63 }, to: { xIn: -20, yIn: -40 } },
          ],
          heading: { mode: "tangent" },
        },
      ],
    });
    const fix = continuity(auto)
      .flatMap((finding) => finding.fixes ?? [])
      .find((candidate) => candidate.kind === "joinSegments");
    if (fix === undefined) throw new Error("expected the join fix");
    const joined = applyFix(auto, fix);
    const step = joined.steps[0];
    if (step?.kind !== "path") throw new Error("expected the path");
    expect(step.segments[1]?.from).toEqual({ ref: "startTile" });
    expect(continuity(joined)).toEqual([]);
  });

  it("gives a step-start gap Start from where the robot is rather than the join fix (issue #186)", () => {
    const auto = parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 1,
      name: "step-gap",
      alliance: "RED",
      start: { pose: { xIn: -40, yIn: -60, headingRad: 1.5708 } },
      steps: [
        {
          id: "driveOut",
          kind: "path",
          segments: [{ kind: "line", from: { xIn: 0, yIn: 0 }, to: { xIn: 0, yIn: 20 } }],
          heading: { mode: "tangent" },
        },
      ],
    });
    const [finding] = continuity(auto);
    expect(finding?.fixes?.map((fix) => [fix.kind, fix.label])).toEqual([["startFromCurrent", "Start from where the robot is"]]);
    expect(helpForFinding(finding as Finding)).toBe(FINDING_HELP.CONTINUITY);
  });

  it("has its own help, which talks about the segments meeting rather than the step's start", () => {
    const [finding] = continuity(autoWith({ xIn: -16, yIn: -40 }));
    const help = helpForFinding(finding as Finding);
    expect(help).toBe(SEGMENT_GAP_HELP);
    expect(help.title).toBe(FINDING_HELP.CONTINUITY.title);
    expect(help.fix).toMatch(/Join/);
    expect(help.fix).not.toMatch(/current/);
    // The same rules FINDING_HELP keeps: one or two sentences each, short, ending in a full stop.
    for (const text of [help.means, help.fix]) {
      expect(text.split(/(?<=[.!?])\s+/).length).toBeLessThanOrEqual(2);
      expect(text.length).toBeLessThanOrEqual(200);
      expect(text.endsWith(".")).toBe(true);
    }
    expect(helpForFinding({ code: "PERIMETER" })).toBe(FINDING_HELP.PERIMETER);
  });
});
