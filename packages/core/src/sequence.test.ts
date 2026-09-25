import { parseAuto, parseRobot, SCHEMA_ID, type Auto, type Step } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { canonicalize } from "./canonicalize.js";
import { check } from "./check.js";
import { diff } from "./diff.js";
import { childPrefix, effectiveId, listIds } from "./edit/ids.js";
import { estimate } from "./estimate.js";
import { applyFix } from "./fix.js";
import { ledger } from "./ledger.js";
import { mirrorAuto } from "./mirror.js";
import { flattenSteps, plan } from "./plan.js";
import { render } from "./render.js";
import { resolve } from "./resolve.js";
import { testField, testRobot, testWaypoints } from "./testing/fixtures.js";
import type { Finding } from "./types.js";

/**
 * Item 2 of the v2 format workstream: the `sequence` step through every stage of core. A sequence
 * must behave exactly like the same steps written straight into the list that holds it, except
 * that it is one member of a group.
 */

const auto = (steps: unknown[]): Auto =>
  parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 2,
    name: "sequence-fixture",
    alliance: "RED",
    start: { pose: { xIn: 0, yIn: -60, headingRad: 0 } },
    steps,
  });

const leg = (id: string | undefined, toX: number, toY: number, from: unknown = "current"): Step =>
  ({
    ...(id === undefined ? {} : { id }),
    kind: "path",
    segments: [{ kind: "line", from, to: { xIn: toX, yIn: toY } }],
    heading: { mode: "tangent" },
  }) as Step;

const intake = (id: string, state: "FORWARD" | "STOP"): Step => ({
  id,
  kind: "command",
  name: "setIntake",
  args: { side: "FRONT", state },
});

const planOf = (a: Auto, robot = testRobot) => plan(resolve(a, testWaypoints), robot, testField);
const findingsOf = (a: Auto): Finding[] => {
  const planned = planOf(a);
  return check(planned, estimate(planned, testRobot), testRobot, testField);
};

/** The test robot with the follower not holding the end pose, so speed carries between steps. */
const coastingRobot = parseRobot({
  ...testRobot,
  kinematics: {
    ...testRobot.kinematics,
    follower: { ...testRobot.kinematics.follower, holdEnd: false },
  },
});

describe("sequence: ids", () => {
  it("names positional members grp.1, grp.2 under the group's id", () => {
    const steps: Step[] = [{ id: "grp", kind: "sequence", steps: [intake("a", "FORWARD"), leg(undefined, 20, -60)] }];
    expect(listIds(steps)).toEqual(["grp", "a", "grp.2"]);
    expect(childPrefix("grp", 1, 0)).toBe("grp.");
    expect(effectiveId(leg(undefined, 0, 0), 0, childPrefix("grp", 1, 0))).toBe("grp.1");
  });

  it("names nested sequences inside parallel groups the same way resolve does", () => {
    const a = auto([
      {
        kind: "parallel",
        mode: "all",
        steps: [{ kind: "sequence", steps: [intake("on", "FORWARD"), { kind: "wait", seconds: 1 }] }],
      },
    ]);
    const ids = flattenSteps(planOf(a).steps).map((step) => step.id);
    expect(ids).toEqual(["step1", "step1.1", "on", "step1.1.2"]);
    expect(listIds(a.steps)).toEqual(ids);
  });
});

describe("sequence: resolve and plan", () => {
  it('resolves "current" through a sequence: each member starts where the one before ended', () => {
    const a = auto([
      { id: "grp", kind: "sequence", steps: [leg("one", 20, -60), leg("two", 20, -40)] },
      leg("after", 40, -40),
    ]);
    const resolved = resolve(a, testWaypoints);
    const group = resolved.steps[0];
    expect(group?.children?.map((child) => child.id)).toEqual(["one", "two"]);
    expect(group?.children?.[1]?.startPose).toMatchObject({ xIn: 20, yIn: -60 });
    expect(group?.endPose).toMatchObject({ xIn: 20, yIn: -40 });
    expect(resolved.steps[1]?.startPose).toMatchObject({ xIn: 20, yIn: -40 });
    expect(resolved.findings).toEqual([]);
  });

  it("plans a sequence's members with samples and the group without", () => {
    const planned = planOf(auto([{ id: "grp", kind: "sequence", steps: [leg("one", 20, -60)] }]));
    const group = planned.steps[0];
    expect(group?.samples).toEqual([]);
    expect(group?.children?.[0]?.samples.length).toBeGreaterThan(2);
    expect(group?.lengthIn).toBeCloseTo(20, 3);
  });

  it("ends a parallel group where the sequence member that drives ends", () => {
    const a = auto([
      {
        id: "par",
        kind: "parallel",
        mode: "all",
        steps: [{ id: "seq", kind: "sequence", steps: [leg("drive", 30, -60)] }, intake("on", "FORWARD")],
      },
      leg("next", 30, -30),
    ]);
    const resolved = resolve(a, testWaypoints);
    expect(resolved.steps[0]?.endPose).toMatchObject({ xIn: 30, yIn: -60 });
    expect(findingsOf(a).filter((finding) => finding.code === "CONTINUITY")).toEqual([]);
  });

  it("starts every member of a parallel group, a sequence included, where the group started", () => {
    // Before format version 2, resolve chained a parallel group's members like a sequence, so a
    // member written after the drive was placed at the drive's end even though it runs alongside it.
    const a = auto([
      {
        id: "sweep",
        kind: "parallel",
        mode: "deadline",
        deadline: "drive",
        steps: [
          leg("drive", 30, -60),
          { id: "cycle", kind: "sequence", steps: [intake("on", "FORWARD"), { id: "run", kind: "wait", seconds: 1 }] },
          leg("second", 0, -40),
        ],
      },
    ]);
    const children = resolve(a, testWaypoints).steps[0]?.children ?? [];
    const entry = { xIn: 0, yIn: -60 };
    for (const id of ["drive", "cycle", "second"]) {
      expect(children.find((child) => child.id === id)?.startPose, id).toMatchObject(entry);
    }
    const cycle = children.find((child) => child.id === "cycle");
    expect(cycle?.children?.map((child) => child.startPose)).toEqual([
      expect.objectContaining(entry),
      expect.objectContaining(entry),
    ]);
    expect(resolve(a, testWaypoints).steps[0]?.endPose).toMatchObject({ xIn: 30, yIn: -60 });
    expect(findingsOf(a).filter((finding) => finding.code === "CONTINUITY")).toEqual([]);
  });
});

describe("sequence: estimate", () => {
  it("costs the sum of its members", () => {
    const a = auto([
      {
        id: "grp",
        kind: "sequence",
        steps: [{ id: "w1", kind: "wait", seconds: 0.5 }, { id: "w2", kind: "wait", seconds: 1.25 }],
      },
    ]);
    const result = estimate(planOf(a), testRobot);
    expect(result.byStepId["grp"]?.nominalS).toBeCloseTo(1.75, 6);
    expect(result.nominalS).toBeCloseTo(1.75, 6);
    expect(result.byStepId["grp"]?.children?.map((child) => child.stepId)).toEqual(["w1", "w2"]);
  });

  it("carries the velocity through the sequence exactly as the flat list does", () => {
    const flat = auto([leg("one", 30, -60), leg("two", 60, -60), leg("three", 90 - 30, -30)]);
    const grouped = auto([
      leg("one", 30, -60),
      { id: "grp", kind: "sequence", steps: [leg("two", 60, -60), leg("three", 90 - 30, -30)] },
    ]);
    const a = estimate(planOf(flat, coastingRobot), coastingRobot);
    const b = estimate(planOf(grouped, coastingRobot), coastingRobot);
    for (const id of ["one", "two", "three"]) {
      expect(b.byStepId[id]?.nominalS, id).toBeCloseTo(a.byStepId[id]?.nominalS as number, 9);
    }
    // The carry is real: the second leg starts moving, so it is quicker than from a standstill.
    expect(a.byStepId["two"]?.nominalS as number).toBeLessThan(a.byStepId["one"]?.nominalS as number);
    expect(b.nominalS).toBeCloseTo(a.nominalS as number, 9);
    expect(b.byStepId["grp"]?.exitVelocityInPerS).toBeCloseTo(a.byStepId["three"]?.exitVelocityInPerS as number, 9);
  });

  it("is unknown when a member is, and counts the known members", () => {
    const a = auto([
      {
        id: "grp",
        kind: "sequence",
        steps: [{ id: "w", kind: "wait", seconds: 1 }, { id: "until", kind: "wait", until: "hopperFull" }],
      },
    ]);
    const result = estimate(planOf(a), testRobot);
    expect(result.byStepId["grp"]?.unknown).toBe(true);
    expect(result.byStepId["grp"]?.nominalS).toBeCloseTo(1, 6);
  });

  it("times a deadline group by a sequence it names as the deadline", () => {
    const a = auto([
      {
        id: "par",
        kind: "parallel",
        mode: "deadline",
        deadline: "seq",
        steps: [
          { id: "seq", kind: "sequence", steps: [{ id: "w1", kind: "wait", seconds: 2 }, { id: "w2", kind: "wait", seconds: 1 }] },
          { id: "short", kind: "wait", seconds: 0.5 },
        ],
      },
    ]);
    const result = estimate(planOf(a), testRobot);
    expect(result.byStepId["par"]?.nominalS).toBeCloseTo(3, 6);
    expect(findingsOf(a).filter((finding) => finding.code === "SCHEMA")).toEqual([]);
  });
});

describe("sequence: check", () => {
  it("raises CONTINUITY on a member that does not start where the member before it ended", () => {
    const a = auto([
      {
        id: "grp",
        kind: "sequence",
        steps: [leg("one", 20, -60), leg("jump", 40, -40, { xIn: 30, yIn: -40 })],
      },
    ]);
    const continuity = findingsOf(a).filter((finding) => finding.code === "CONTINUITY");
    expect(continuity.map((finding) => finding.stepId)).toEqual(["jump"]);
    expect(continuity[0]?.message).toMatch(/starts 22\.36 in from where the robot was/);
  });

  it("raises CONTINUITY on a sequence's first member that does not start where the robot was", () => {
    const a = auto([
      leg("before", 20, -60),
      { id: "grp", kind: "sequence", steps: [leg("first", 40, -40, { xIn: 0, yIn: -60 })] },
    ]);
    expect(
      findingsOf(a).filter((finding) => finding.code === "CONTINUITY").map((finding) => finding.stepId),
    ).toEqual(["first"]);
  });

  it("counts an intake sequence running alongside a deadline drive as intaking on that drive", () => {
    const group = (members: unknown[]): Auto =>
      auto([{ id: "sweep", kind: "parallel", mode: "deadline", deadline: "drive", steps: members }]);
    const cycle = {
      id: "cycle",
      kind: "sequence",
      steps: [intake("on", "FORWARD"), { id: "run", kind: "wait", seconds: 1 }, intake("off", "STOP")],
    };
    const fast = { ...leg("drive", 30, -60), speedFraction: 0.9 };
    const mouth = { widthIn: 14, depthIn: 4, provenance: "PLACEHOLDER: test fixture" };
    const withMouths = parseRobot({
      ...testRobot,
      commands: testRobot.commands.map((command) =>
        command.name === "setIntake" ? { ...command, requires: ["intake"] } : command,
      ),
      mouths: [
        { id: "front", side: "FRONT", offsetIn: { xIn: 7, yIn: 0 }, ...mouth },
        { id: "back", side: "BACK", offsetIn: { xIn: -7, yIn: 0 }, ...mouth },
      ],
    });
    const sweepSpeed = (a: Auto): string[] => {
      const planned = planOf(a, withMouths);
      return check(planned, estimate(planned, withMouths), withMouths, testField)
        .filter((finding) => finding.code === "SWEEP_SPEED")
        .map((finding) => finding.stepId);
    };

    expect(sweepSpeed(group([fast, cycle]))).toEqual(["drive"]);
    expect(sweepSpeed(group([cycle, fast]))).toEqual(["drive"]);
    // The sequence turns the intake off before the group ends, so a drive after the group is dry.
    const after = auto([
      { id: "sweep", kind: "parallel", mode: "deadline", deadline: "drive", steps: [leg("drive", 30, -60), cycle] },
      { ...leg("home", 0, -60), speedFraction: 0.9 },
    ]);
    expect(sweepSpeed(after)).toEqual(["drive"]);
  });

  it("checks command names, geometry and the heading inside a sequence", () => {
    const a = auto([
      {
        id: "grp",
        kind: "sequence",
        steps: [
          { id: "bogus", kind: "command", name: "noSuchCommand" },
          leg("intoHive", -12, 0),
          { id: "noHeading", kind: "path", segments: [{ kind: "line", from: "current", to: { xIn: -12, yIn: 20 } }] },
        ],
      },
    ]);
    const codes = findingsOf(a).map((finding) => `${finding.code}:${finding.stepId}`);
    expect(codes).toContain("SCHEMA:bogus");
    expect(codes).toContain("HEADING_MISSING:noHeading");
    expect(codes.some((code) => code.startsWith("STRUCTURE:"))).toBe(true);
  });
});

describe("sequence: ledger, diff, render, mirror, fix", () => {
  const a = auto([
    { id: "grp", kind: "sequence", steps: [intake("on", "FORWARD"), leg("sweep", 30, -60), intake("off", "STOP")] },
  ]);

  it("walks the ledger through a sequence", () => {
    const rows = ledger(planOf(a), testField);
    expect(Array.isArray(rows)).toBe(true);
  });

  it("diffs a change inside a sequence against the member's id", () => {
    const moved = auto([
      { id: "grp", kind: "sequence", steps: [intake("on", "FORWARD"), leg("sweep", 36, -60), intake("off", "STOP")] },
    ]);
    const changes = diff(a, moved).changes;
    expect(changes.map((change) => `${change.kind}:${change.stepId}`)).toEqual(["changed:sweep"]);
  });

  it("renders a routine with a sequence in it, path included", () => {
    const planned = planOf(a);
    const svg = render(planned, estimate(planned, testRobot), [], []);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("sweep");
  });

  it("mirrors the members of a sequence, and mirroring twice is the identity", () => {
    const mirrored = mirrorAuto(a);
    const group = mirrored.steps[0];
    expect(group?.kind).toBe("sequence");
    const sweep = group?.kind === "sequence" ? group.steps[1] : undefined;
    expect(sweep?.kind === "path" ? sweep.segments[0]?.to : undefined).toMatchObject({ xIn: -30, yIn: 60 });
    expect(canonicalize("auto", mirrorAuto(mirrored))).toBe(canonicalize("auto", a));
  });

  it("applies a fix to a path inside a sequence", () => {
    const fixed = applyFix(a, { kind: "slowSweep", stepId: "sweep", label: "Slow down", params: { speedFraction: 0.3 } });
    const group = fixed.steps[0];
    const sweep = group?.kind === "sequence" ? group.steps[1] : undefined;
    expect(sweep?.kind === "path" ? sweep.speedFraction : undefined).toBe(0.3);
  });
});
