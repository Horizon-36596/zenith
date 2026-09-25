import { parseAuto, parseRobot, SCHEMA_ID, type Auto, type Robot } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { check } from "./check.js";
import { estimate } from "./estimate.js";
import { applyFix } from "./fix.js";
import { plan } from "./plan.js";
import { resolve } from "./resolve.js";
import type { SeasonRules, SeasonState } from "./season.js";
import { testField, testRobot, testWaypoints } from "./testing/fixtures.js";
import type { Finding, FindingCode } from "./types.js";

/**
 * The core checks site/docs/checks-and-findings.md lists. The season-shaped ones
 * (LEGAL_APPROACH, TURRET_RANGE, CAPACITY, EMPTY_SHOT) are driven through a stand-in plugin here
 * and against the real BIOBUZZ rules in `packages/season-biobuzz`.
 */

const robot: Robot = parseRobot({
  ...(JSON.parse(JSON.stringify(testRobot)) as Record<string, unknown>),
  capacity: { elementKind: "pollen", max: 4, provenance: "PLACEHOLDER: test fixture" },
  shooter: {
    kind: "turret",
    turretRangeRad: { minRad: -1, maxRad: 1, provenance: "PLACEHOLDER: test fixture" },
  },
  mouths: [
    {
      id: "front",
      side: "FRONT",
      offsetIn: { xIn: 8, yIn: 0 },
      widthIn: 14,
      depthIn: 4,
      provenance: "PLACEHOLDER: test fixture",
    },
    {
      id: "back",
      side: "BACK",
      offsetIn: { xIn: -8, yIn: 0 },
      widthIn: 14,
      depthIn: 4,
      provenance: "PLACEHOLDER: test fixture",
    },
  ],
  commands: [
    {
      name: "shootAll",
      params: { count: { type: "integer", min: 1, max: 4 } },
      estimateS: "1",
      requires: ["launcher"],
      stationary: true,
      ledger: { launches: "count" },
    },
    {
      name: "setIntake",
      params: {
        side: { type: "enum", values: ["FRONT", "BACK", "BOTH"] },
        state: { type: "enum", values: ["STOP", "FORWARD", "REVERSE"] },
      },
      estimateS: "0",
      requires: ["intake"],
    },
    {
      name: "collectNearestPollen",
      estimateS: "unknown",
      requires: ["drive", "intake"],
      movesRobot: true,
    },
  ],
  conditions: [{ name: "hopperFull" }],
});

const holdsSeason = (holds: Record<string, number>, legal = true): SeasonRules => ({
  id: "test",
  initialState: () => ({ holds }) as unknown as SeasonState,
  start: (state, given) => ({ ...(state as object), holds: { ...given } }) as unknown as SeasonState,
  holds: (state) => ({ ...(state as { holds: Record<string, number> }).holds }),
  onLaunch: (state, target, count) => {
    void target;
    const current = state as { holds: Record<string, number> };
    return {
      ...current,
      holds: { pollen: Math.max((current.holds["pollen"] ?? 0) - count, 0) },
    } as unknown as SeasonState;
  },
  onCollect: (state) => state,
  currentTarget: () => "theTarget",
  legalApproach: () => legal,
  nearestLegalApproach: () => ({ xIn: -30, yIn: -30, headingRad: 0 }),
  targetPoint: () => ({ xIn: 0, yIn: 0 }),
  startLegal: () => [],
  summary: () => [],
});

const auto = (steps: unknown[], startHolds?: Record<string, number>): Auto =>
  parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "checks-fixture",
    alliance: "RED",
    start: {
      pose: { xIn: -40, yIn: -60, headingRad: 0 },
      ...(startHolds === undefined ? {} : { holds: startHolds }),
    },
    steps,
  });

const run = (
  steps: unknown[],
  options: { season?: SeasonRules; startHolds?: Record<string, number>; withEstimate?: boolean } = {},
): Finding[] => {
  const document = auto(steps, options.startHolds);
  const planned = plan(resolve(document, testWaypoints), robot, testField);
  const timing = options.withEstimate === false ? null : estimate(planned, robot);
  return check(planned, timing, robot, testField, options.season ?? holdsSeason({ pollen: 4 }));
};

const codes = (findings: readonly Finding[]): FindingCode[] => findings.map((f) => f.code);
const of = (findings: readonly Finding[], code: FindingCode): Finding[] =>
  findings.filter((finding) => finding.code === code);

const leg = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  kind: "path",
  segments: [{ kind: "line", from: "current", to: { xIn: -40, yIn: -20 } }],
  heading: { mode: "tangent" },
  ...extra,
});

describe("STRAFE_FRACTION", () => {
  it("fires with the fraction and the cost in seconds, and offers both fixes", () => {
    const findings = of(
      run([leg("sideways", { heading: { mode: "constant", headingRad: 0 } })]),
      "STRAFE_FRACTION",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("100 %");
    expect(findings[0]?.message).toMatch(/costs \d+\.\d\d s/);
    expect(findings[0]?.fixes?.map((fix) => fix.kind)).toEqual(["makeTangent"]);
  });

  it("stays quiet on a tangent leg", () => {
    expect(of(run([leg("straight")]), "STRAFE_FRACTION")).toEqual([]);
  });

  it("finding 17: fires for a leg inside a parallel group", () => {
    const sideways = leg("sideways", { heading: { mode: "constant", headingRad: 0 } });
    const wrapped = of(
      run([{ id: "group", kind: "parallel", mode: "all", steps: [sideways] }]),
      "STRAFE_FRACTION",
    );
    expect(wrapped.map((finding) => finding.stepId)).toEqual(["sideways"]);
  });

  it("finding 17: fires for a leg inside a branch arm", () => {
    const sideways = leg("sideways", { heading: { mode: "constant", headingRad: 0 } });
    const wrapped = of(
      run([{ id: "maybe", kind: "branch", condition: "hopperFull", then: [sideways] }]),
      "STRAFE_FRACTION",
    );
    expect(wrapped.map((finding) => finding.stepId)).toEqual(["sideways"]);
  });

  it("finding 17: the turn fix looks at the list the leg actually sits in", () => {
    const findings = of(
      run([
        leg("before"),
        {
          id: "group",
          kind: "parallel",
          mode: "all",
          steps: [
            leg("firstInGroup"),
            {
              id: "sideways",
              kind: "path",
              segments: [{ kind: "line", from: "current", to: { xIn: -40, yIn: 20 } }],
              heading: { mode: "constant", headingRad: 0 },
            },
          ],
        },
      ]),
      "STRAFE_FRACTION",
    );
    const turn = findings
      .find((finding) => finding.stepId === "sideways")
      ?.fixes?.find((fix) => fix.kind === "turnAtPreviousStop");
    expect(turn?.params.turnInStepId).toBe("firstInGroup");
  });

  it("offers the turn-at-the-previous-stop fix once there is a previous leg", () => {
    const findings = of(
      run([
        leg("first"),
        {
          id: "sideways",
          kind: "path",
          segments: [{ kind: "line", from: "current", to: { xIn: -40, yIn: 20 } }],
          heading: { mode: "constant", headingRad: 0 },
        },
      ]),
      "STRAFE_FRACTION",
    );
    const kinds = findings[0]?.fixes?.map((fix) => fix.kind);
    expect(kinds).toEqual(["makeTangent", "turnAtPreviousStop"]);
  });
});

describe("MOUTH_LEADING and SWEEP_SPEED", () => {
  const intaking = (state: string, side: string): Record<string, unknown> => ({
    id: `intake-${state}`,
    kind: "command",
    name: "setIntake",
    args: { side, state },
  });

  it("warns when the running mouth points away from the direction of travel", () => {
    const findings = run([
      intaking("FORWARD", "FRONT"),
      leg("sweep", { heading: { mode: "constant", headingRad: Math.PI }, speedFraction: 0.3 }),
    ]);
    const leading = of(findings, "MOUTH_LEADING");
    expect(leading).toHaveLength(1);
    expect(leading[0]?.message).toContain("front");
    expect(leading[0]?.fixes?.map((fix) => fix.kind)).toEqual(["makeTangent", "makeTangent"]);
  });

  it("stays quiet when the back mouth leads on a reversed-tangent leg", () => {
    const findings = run([
      intaking("FORWARD", "BACK"),
      leg("sweep", { heading: { mode: "tangentReversed" }, speedFraction: 0.3 }),
    ]);
    expect(of(findings, "MOUTH_LEADING")).toEqual([]);
  });

  it("warns about a sweep driven faster than the robot's sweep speed, and offers to slow it", () => {
    const findings = of(
      run([intaking("FORWARD", "BOTH"), leg("sweep", { speedFraction: 0.9 })]),
      "SWEEP_SPEED",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fixes?.[0]).toMatchObject({
      kind: "slowSweep",
      params: { speedFraction: 0.4 },
    });
  });

  it("stops warning once the intake is stopped again", () => {
    const findings = run([
      intaking("FORWARD", "BOTH"),
      intaking("STOP", "BOTH"),
      leg("sweep", { speedFraction: 0.9 }),
    ]);
    expect(of(findings, "SWEEP_SPEED")).toEqual([]);
  });

  it("counts a marker that starts the intake part way along the leg", () => {
    const findings = run([
      leg("sweep", {
        speedFraction: 0.9,
        markers: [
          { at: { t: 0 }, command: { name: "setIntake", args: { side: "BOTH", state: "FORWARD" } } },
        ],
      }),
    ]);
    expect(of(findings, "SWEEP_SPEED")).toHaveLength(1);
  });
});

describe("the season checks", () => {
  const volley = { id: "volley", kind: "command", name: "shootAll", args: { count: 3 } };

  it("reports LEGAL_APPROACH with a fix that moves the leg before it", () => {
    const findings = of(
      run([leg("approach"), volley], { season: holdsSeason({ pollen: 4 }, false) }),
      "LEGAL_APPROACH",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.fixes?.[0]).toMatchObject({
      kind: "moveToLegalApproach",
      stepId: "approach",
      params: { xIn: -30, yIn: -30 },
    });
  });

  it("warns about TURRET_RANGE when the target is behind the robot", () => {
    // The robot starts at (-40, -60) facing +x; the stand-in target sits at the origin, which is
    // 56 degrees off the nose, inside the +-57 degree range, so nothing fires.
    expect(of(run([volley]), "TURRET_RANGE")).toEqual([]);
    const behind = run([
      leg("turn", { heading: { mode: "constant", headingRad: Math.PI } }),
      volley,
    ]);
    expect(of(behind, "TURRET_RANGE")).toHaveLength(1);
  });

  it("warns about an empty shot", () => {
    const findings = of(run([volley], { season: holdsSeason({}), startHolds: {} }), "EMPTY_SHOT");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("holding nothing");
  });

  it("errors when the auto starts over capacity", () => {
    const findings = of(run([volley], { startHolds: { pollen: 6 } }), "CAPACITY");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.stepId).toBe("start");
  });

  it("errors when a step collects more than the robot can hold", () => {
    const findings = of(
      run([leg("retrieve", { expect: { collectFrom: "flower0", count: 3 } })], {
        startHolds: { pollen: 4 },
      }),
      "CAPACITY",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("capacity of 4");
  });
});

describe("the schedule checks", () => {
  it("warns when the routine is over the period and errors when even the optimistic end is", () => {
    const many = Array.from({ length: 26 }, (_, index) => ({
      id: `wait${String(index)}`,
      kind: "wait",
      seconds: 1.2,
    }));
    const warning = of(run(many), "TIME_BUDGET");
    expect(warning[0]?.severity).toBe("warning");

    const lots = Array.from({ length: 40 }, (_, index) => ({
      id: `wait${String(index)}`,
      kind: "wait",
      seconds: 1.2,
    }));
    expect(of(run(lots), "TIME_BUDGET")[0]?.severity).toBe("error");
  });

  it("notes a timeout under 1.2 times the step's own estimate", () => {
    const findings = of(run([{ id: "pause", kind: "wait", seconds: 2, timeoutS: 2.1 }]), "TIMEOUT_TIGHT");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("info");
  });

  it("warns about a stationary command hung on a moving path", () => {
    const findings = of(
      run([
        leg("drive", {
          markers: [{ at: { t: 0.5 }, command: { name: "shootAll", args: { count: 1 } } }],
        }),
      ]),
      "STATIONARY_MARKER",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.t).toBe(0.5);
  });

  it("errors when a step after a movesRobot command does not start from current", () => {
    const findings = of(
      run([
        { id: "hunt", kind: "command", name: "collectNearestPollen" },
        {
          id: "after",
          kind: "path",
          segments: [{ kind: "line", from: { xIn: -40, yIn: -60 }, to: { xIn: -20, yIn: -60 } }],
          heading: { mode: "tangent" },
        },
      ]),
      "MOVES_ROBOT",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("error");
  });

  it("accepts the same pair when the next step does start from current", () => {
    const findings = of(
      run([{ id: "hunt", kind: "command", name: "collectNearestPollen" }, leg("after")]),
      "MOVES_ROBOT",
    );
    expect(findings).toEqual([]);
  });

  it("notes inline poses that carry no provenance", () => {
    const findings = of(run([leg("drive")]), "PROVENANCE");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("SET FROM EDITOR");
  });
});

describe("CONTINUITY inside a parallel group", () => {
  it("checks each child against where the group started, not against the child before it", () => {
    const findings = run([
      {
        id: "group",
        kind: "parallel",
        mode: "all",
        steps: [
          {
            id: "a",
            kind: "path",
            segments: [{ kind: "line", from: { xIn: -40, yIn: -60 }, to: { xIn: -20, yIn: -60 } }],
            heading: { mode: "tangent" },
          },
          {
            id: "b",
            kind: "path",
            segments: [{ kind: "line", from: { xIn: -40, yIn: -60 }, to: { xIn: -40, yIn: -40 } }],
            heading: { mode: "tangent" },
          },
        ],
      },
    ]);
    expect(codes(findings)).not.toContain("CONTINUITY");
  });

  it("still reports a child that starts somewhere else entirely", () => {
    const findings = run([
      {
        id: "group",
        kind: "parallel",
        mode: "all",
        steps: [
          {
            id: "a",
            kind: "path",
            segments: [{ kind: "line", from: { xIn: 40, yIn: 60 }, to: { xIn: 20, yIn: 60 } }],
            heading: { mode: "tangent" },
          },
        ],
      },
    ]);
    expect(of(findings, "CONTINUITY")).toHaveLength(1);
  });
});

describe("every finding", () => {
  it("names a step, says something in a full sentence, and carries geometry where it can", () => {
    const findings = run([
      leg("sideways", { heading: { mode: "constant", headingRad: 0 } }),
      { id: "volley", kind: "command", name: "shootAll", args: { count: 3 } },
    ]);
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.stepId.length).toBeGreaterThan(0);
      expect(finding.message.endsWith(".")).toBe(true);
      expect(finding.message[0]).toBe(finding.message[0]?.toUpperCase());
    }
  });
});

describe("applyFix", () => {
  const document = auto([
    leg("first"),
    leg("second", { heading: { mode: "constant", headingRad: 0 }, speedFraction: 0.9 }),
  ]);

  it("makes a leg tangent without touching anything else", () => {
    const next = applyFix(document, {
      kind: "makeTangent",
      stepId: "second",
      label: "x",
      params: {},
    });
    expect(next.steps[1]).toMatchObject({ heading: { mode: "tangent" } });
    expect(next.steps[0]).toEqual(document.steps[0]);
    expect(document.steps[1]).toMatchObject({ heading: { mode: "constant" } });
  });

  it("moves the turn into the previous leg", () => {
    const next = applyFix(document, {
      kind: "turnAtPreviousStop",
      stepId: "second",
      label: "x",
      params: { headingRad: 1.5, fromRad: 0, turnInStepId: "first" },
    });
    expect(next.steps[0]).toMatchObject({ heading: { mode: "linear", fromRad: 0, toRad: 1.5 } });
    expect(next.steps[1]).toMatchObject({ heading: { mode: "tangent" } });
  });

  it("slows a sweep", () => {
    const next = applyFix(document, {
      kind: "slowSweep",
      stepId: "second",
      label: "x",
      params: { speedFraction: 0.4 },
    });
    expect(next.steps[1]).toMatchObject({ speedFraction: 0.4 });
  });

  it("moves the end of a leg to a legal approach", () => {
    const next = applyFix(document, {
      kind: "moveToLegalApproach",
      stepId: "first",
      label: "x",
      params: { xIn: -30, yIn: -30, headingRad: 1 },
    });
    const step = next.steps[0] as { segments: { to: { xIn: number; yIn: number } }[] };
    expect(step.segments[0]?.to).toEqual({ xIn: -30, yIn: -30, headingRad: 1 });
  });

  it("splits a segment into two that meet where it was cut", () => {
    const curved = auto([
      {
        id: "curve",
        kind: "path",
        segments: [
          {
            kind: "bezier",
            from: { xIn: 0, yIn: 0 },
            control: [{ xIn: 10, yIn: 20 }],
            to: { xIn: 20, yIn: 0 },
          },
        ],
        heading: { mode: "tangent" },
      },
    ]);
    const next = applyFix(curved, {
      kind: "splitSegment",
      stepId: "curve",
      label: "x",
      params: { segmentIndex: 0, u: 0.5 },
    });
    const step = next.steps[0] as {
      segments: { kind: string; from: unknown; to: { xIn: number; yIn: number } }[];
    };
    expect(step.segments).toHaveLength(2);
    expect(step.segments[0]?.to).toEqual({ xIn: 10, yIn: 10 });
    expect(step.segments[1]?.from).toEqual({ xIn: 10, yIn: 10 });
    expect(step.segments[0]?.kind).toBe("bezier");
  });

  it("leaves the document alone when the fix points at a step that is not there", () => {
    const next = applyFix(document, {
      kind: "makeTangent",
      stepId: "nowhere",
      label: "x",
      params: {},
    });
    expect(next.steps).toEqual(document.steps);
  });
});

describe("TIME_BUDGET and a step that ends on a condition", () => {
  it("finding 18: says the total is an upper bound rather than a firm number", () => {
    const findings = of(
      run([leg("collect", { endCondition: { condition: "hopperFull" } })]),
      "TIME_BUDGET",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("info");
    expect(findings[0]?.message).toContain("upper bound");
  });

  it("finding 18: still says lower bound when a step has no estimate at all", () => {
    const findings = of(
      run([
        leg("collect", { endCondition: { condition: "hopperFull" } }),
        { id: "grab", kind: "command", name: "collectNearestPollen" },
      ]),
      "TIME_BUDGET",
    );
    expect(findings[0]?.message).toContain("lower bound");
  });
});

describe("applyFix on a step without an explicit id", () => {
  /** Two unnamed legs, so the findings name them positionally: step1 and step2. */
  const unnamed = auto([
    {
      kind: "path",
      segments: [{ kind: "line", from: "current", to: { xIn: -40, yIn: -20 } }],
      heading: { mode: "tangent" },
    },
    {
      kind: "path",
      segments: [{ kind: "line", from: "current", to: { xIn: -40, yIn: 20 } }],
      heading: { mode: "constant", headingRad: 0 },
    },
  ]);

  it("finding 19: the STRAFE_FRACTION fix its own finding offers actually applies", () => {
    const finding = of(
      check(
        plan(resolve(unnamed, testWaypoints), robot, testField),
        estimate(plan(resolve(unnamed, testWaypoints), robot, testField), robot),
        robot,
        testField,
      ),
      "STRAFE_FRACTION",
    )[0];
    expect(finding?.stepId).toBe("step2");
    const fix = finding?.fixes?.[0];
    if (fix === undefined) throw new Error("expected a fix");
    const next = applyFix(unnamed, fix);
    expect(next.steps[1]).toMatchObject({ heading: { mode: "tangent" } });
    expect(next).not.toEqual(unnamed);
  });

  it("finding 19: a fix inside a parallel group finds its nested step", () => {
    const nested = auto([
      {
        id: "group",
        kind: "parallel",
        mode: "all",
        steps: [
          {
            kind: "path",
            segments: [{ kind: "line", from: "current", to: { xIn: -40, yIn: -20 } }],
            heading: { mode: "constant", headingRad: 0 },
          },
        ],
      },
    ]);
    const next = applyFix(nested, {
      kind: "makeTangent",
      stepId: "group.1",
      label: "x",
      params: {},
    });
    const group = next.steps[0];
    if (group?.kind !== "parallel") throw new Error("expected parallel");
    expect(group.steps[0]).toMatchObject({ heading: { mode: "tangent" } });
  });
});
