import { readFileSync } from "node:fs";
import type { Auto, PathStep, Segment } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { canonicalize } from "./canonicalize.js";
import { check } from "./check.js";
import { appendPath, removePath } from "./edit/chain.js";
import { loadAuto, loadWaypoints } from "./load.js";
import { plan } from "./plan.js";
import { resolve } from "./resolve.js";
import { testField, testRobot } from "./testing/fixtures.js";

/**
 * The contract that decision D5 (issue #185) gives a later segment's `"current"`: inside one path
 * step it is the pose the segment before it ended at (site/docs/file-format.md, "Segments"). The schema
 * already allowed it, so there is no `formatVersion` bump, and these fixtures are what pins it.
 *
 * `chain-current.auto.json` is a robot conformance fixture, run by both Java runtimes in
 * `ConformanceTest` next to it. Its companion, `chain-refs.auto.json`, is the same auto with each
 * later segment's `"current"` written as the end of the segment before it; the runtime test asserts
 * that both drive and log the same, and this file asserts that core resolves them the same and
 * keeps the companion in step with the fixture.
 */
const conformance = new URL("../../../robot/auto-runtime/src/test/resources/conformance/", import.meta.url);
const read = (file: string): unknown => JSON.parse(readFileSync(new URL(file, conformance), "utf8"));

const waypoints = loadWaypoints(read("waypoints.json"));
const fixture = (): Auto => loadAuto(read("chain-current.auto.json"));
const companion = (): Auto => loadAuto(read("chain-refs.auto.json"));

/** The fixture with each later segment's `"current"` replaced by the segment before it's `to`. */
function written(auto: Auto): Auto {
  const steps = auto.steps.map((step) => {
    if (step.kind !== "path") return step;
    const segments = step.segments.map((segment, index): Segment => {
      const before = step.segments[index - 1];
      if (index === 0 || segment.from !== "current" || before === undefined) return segment;
      return { ...segment, from: before.to };
    });
    return { ...step, segments };
  });
  return { ...auto, name: "chain-refs", title: companion().title, steps };
}

const pathOf = (auto: Auto, id: string): PathStep => {
  const step = auto.steps.find((candidate) => candidate.id === id);
  if (step?.kind !== "path") throw new Error(`expected a path step ${id}`);
  return step;
};

describe("a later segment from current (decision D5, issue #185)", () => {
  it("is in the fixture: every later segment of both chains starts from current", () => {
    for (const id of ["chain", "back"]) {
      const later = pathOf(fixture(), id).segments.slice(1);
      expect(later.length, id).toBeGreaterThan(0);
      for (const segment of later) expect(segment.from, id).toBe("current");
    }
  });

  it("is the companion with each later current written as the end of the segment before it", () => {
    expect(canonicalize("auto", written(fixture()))).toBe(canonicalize("auto", companion()));
  });

  it("resolves to the end of the segment before it, so core plans the fixture as its companion", () => {
    const ours = resolve(fixture(), waypoints);
    const theirs = resolve(companion(), waypoints);
    expect(ours.findings).toEqual([]);
    expect(ours.steps.map((step) => step.segments)).toEqual(theirs.steps.map((step) => step.segments));
    const chain = ours.steps[0]?.segments ?? [];
    for (let index = 1; index < chain.length; index++) {
      expect(chain[index]?.fromPose).toEqual(chain[index - 1]?.toPose);
    }
  });

  it("cannot tear, so the fixture has no CONTINUITY finding", () => {
    const findings = check(plan(resolve(fixture(), waypoints), testRobot, testField), null, testRobot, testField);
    expect(findings.filter((finding) => finding.code === "CONTINUITY")).toEqual([]);
  });

  it("is what the editor writes when it adds or removes a path of a chain", () => {
    const appended = pathOf(appendPath(fixture(), "chain").auto, "chain");
    expect(appended.segments.at(-1)?.from).toBe("current");
    const removed = pathOf(removePath(companion(), "chain", 1).auto, "chain");
    expect(removed.segments[1]?.from).toBe("current");
  });
});
