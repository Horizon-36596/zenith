import { parseAuto, parseField, parseRobot, SCHEMA_ID, type Auto, type Field, type PathStep, type Robot } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { testField, testRobot } from "../testing/fixtures.js";
import { canonicalAuto, canonicalPathStep } from "./candidate.js";
import { resolveOptimizeOptions, runOptimize, timeComparisonSentence } from "./index.js";
import type { ObjectiveInput } from "./objective.js";

/**
 * What the finding actions ask of the optimizer (issue #309):
 *
 * - "Find a faster heading" runs `headingOnly`, and the step it emits keeps the original's segments
 *   byte for byte.
 * - "Route around": when the original collides, a route that clears every structure, keep-out and
 *   the wall is accepted whatever its time, because the straight route through the obstacle was
 *   never a fair one to beat. Since issue #388 every run applies that rule on its own to a collision
 *   `check()` reports, so a plain run on a colliding original returns the same clear route.
 *   `routeAround` extends the rule to what `check()` only warns of (PR #395): a CLEARANCE finding on
 *   the step, or the plan coming within the margin, so an explicit Route around keeps the full
 *   margin even when that is slower, and a plain run, which keeps the original, does not.
 */

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const robot: Robot = parseRobot({ ...clone(testRobot), heightIn: { value: 12, provenance: "PLACEHOLDER: test fixture" } });

const fieldWith = (obstacles: unknown[], zones: unknown[] = []): Field => parseField({ ...clone(testField), obstacles, zones });

const keepOut = (minX: number, maxX: number, minY: number, maxY: number): Record<string, unknown> => ({
  id: "lane",
  kind: "rect",
  minXIn: minX,
  maxXIn: maxX,
  minYIn: minY,
  maxYIn: maxY,
  appliesInAuto: true,
  provenance: "PLACEHOLDER: test fixture",
});

const post = (minX: number, maxX: number, minY: number, maxY: number): Record<string, unknown> => ({
  id: "post",
  kind: "box",
  minXIn: minX,
  maxXIn: maxX,
  minYIn: minY,
  maxYIn: maxY,
  minZIn: 0,
  maxZIn: 10,
  solidToRobot: true,
  provenance: "PLACEHOLDER: test fixture",
});

const autoOf = (start: { xIn: number; yIn: number; headingRad: number }, route: Record<string, unknown>): Auto =>
  canonicalAuto(
    parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 4,
      name: "finding-actions",
      alliance: "RED",
      start: { pose: start },
      steps: [{ id: "route", kind: "path", ...route }],
    }),
  ).auto;

const BUDGET = 120;

describe("headingOnly, as Find a faster heading runs it", () => {
  // Driven south-east with the nose held at 0, so the robot strafes; a tangent heading is faster.
  const auto = autoOf(
    { xIn: -40, yIn: 20, headingRad: 0 },
    { segments: [{ kind: "line", from: "current", to: { xIn: 20, yIn: -30 } }], heading: { mode: "constant", headingRad: 0 } },
  );
  const input: ObjectiveInput = { auto, robot, field: fieldWith([]), stepId: "route" };

  it("returns a faster heading and an emitted step whose segments are byte-identical to the original's", () => {
    const result = runOptimize(input, { mode: "headingOnly", budget: BUDGET, scorer: "estimate" });
    expect(result.mode).toBe("headingOnly");
    expect(result.status).toBe("improved");
    const step = result.step as PathStep;
    const original = auto.steps[0] as PathStep;
    expect(JSON.stringify(step.segments)).toBe(JSON.stringify(original.segments));
    expect(JSON.stringify(canonicalPathStep(step).segments)).toBe(JSON.stringify(canonicalPathStep(original).segments));
    expect(step.heading).not.toEqual(original.heading);
  }, 120_000);
});

describe("routeAround", () => {
  // A straight line, the fastest route there is, drives through a post, and every way round is slower.
  const auto = autoOf(
    { xIn: -48, yIn: 0, headingRad: 0 },
    { segments: [{ kind: "line", from: "current", to: { xIn: 48, yIn: 0 } }], heading: { mode: "constant", headingRad: 0 } },
  );
  const input: ObjectiveInput = { auto, robot, field: fieldWith([post(-4, 4, -3, 3)]), stepId: "route" };

  it("is off by default, and on a collision a plain run gives the same clear route as Route around (issue #388)", () => {
    expect(resolveOptimizeOptions(input).routeAround).toBe(false);
    const plain = runOptimize(input, { budget: BUDGET, scorer: "estimate" });
    expect(plain.status).toBe("improved");
    expect(plain.originalBlocked).toMatchObject({ code: "STRUCTURE", label: 'the structure "post"' });
    const around = runOptimize(input, { budget: BUDGET, scorer: "estimate", routeAround: true });
    expect({ ...around, inputKey: plain.inputKey }).toStrictEqual(plain);
  }, 120_000);

  it("accepts a clear route that is slower than the colliding original", () => {
    const result = runOptimize(input, { budget: BUDGET, scorer: "estimate", routeAround: true });
    expect(result.status).toBe("improved");
    const pick = result.pick;
    if (pick === null) throw new Error("expected a route around the post");
    expect(pick.step.id).toBe("route");
    // The route goes round, so it is slower, and the card's change sentences must still be true.
    expect(pick.t0.after.ownS).toBeGreaterThan(pick.t0.before.ownS);
    expect(result.findingsRemoved.map((finding) => finding.code)).toContain("STRUCTURE");
    expect(result.changes.join(" ")).not.toMatch(/ faster/);
    expect(result.changes.join(" ")).toMatch(/slower|clears/);
  }, 120_000);

  it("changes nothing else about the result for a step that does not collide: it must still be faster", () => {
    const clear: ObjectiveInput = { ...input, field: fieldWith([]) };
    const plain = runOptimize(clear, { budget: BUDGET, scorer: "estimate" });
    const around = runOptimize(clear, { budget: BUDGET, scorer: "estimate", routeAround: true });
    expect(plain.status).toBe("noBetter");
    expect(around.status).toBe("noBetter");
  }, 120_000);

  it("is part of the input key, so a run for Route around is never mistaken for a plain one", () => {
    const plain = runOptimize(input, { budget: 4, scorer: "estimate" });
    const around = runOptimize(input, { budget: 4, scorer: "estimate", routeAround: true });
    expect(around.inputKey).not.toBe(plain.inputKey);
  }, 120_000);

  /**
   * Route around is offered on PERIMETER, CLEARANCE and KEEPOUT findings too (check.ts), so each
   * must reach a clear route the same way. For the keep-out and the clearance, the straight line
   * through or beside the obstacle is the fastest there is, so only the Route around rule accepts the
   * way round. A plain run applies it to a collision `check()` reports (the keep-out, issue #388),
   * and not to a CLEARANCE warning, which it leaves as no better (PR #395).
   */
  const aroundCases: { code: string; input: ObjectiveInput; slower: boolean; plainAlso: boolean }[] = [
    { code: "KEEPOUT", input: { auto, robot, field: fieldWith([], [keepOut(-4, 4, -3, 3)]), stepId: "route" }, slower: true, plainAlso: true },
    // The robot's side passes 0.5 in from the post, inside its 1 in clearance, without touching it.
    { code: "CLEARANCE", input: { auto, robot, field: fieldWith([post(-4, 4, 7.5, 13)]), stepId: "route" }, slower: true, plainAlso: false },
    {
      code: "PERIMETER",
      // A curve that bows out over the field's wall at y = 72 and back.
      input: {
        auto: autoOf(
          { xIn: -40, yIn: 50, headingRad: 0 },
          { segments: [{ kind: "bezier", from: "current", control: [{ xIn: 0, yIn: 100 }], to: { xIn: 40, yIn: 50 } }], heading: { mode: "constant", headingRad: 0 } },
        ),
        robot,
        field: fieldWith([]),
        stepId: "route",
      },
      slower: false,
      plainAlso: true,
    },
  ];

  for (const { code, input: collide, slower, plainAlso } of aroundCases) {
    it(`reaches a clear route from a ${code} original`, () => {
      const result = runOptimize(collide, { budget: BUDGET, scorer: "estimate", routeAround: true });
      expect(result.status).toBe("improved");
      const pick = result.pick;
      if (pick === null) throw new Error(`expected a route clear of the ${code} finding`);
      expect(result.findingsRemoved.map((finding) => finding.code)).toContain(code);
      expect(result.findingsAdded.map((finding) => finding.code)).not.toContain(code);
      if (slower) {
        expect(pick.t0.after.ownS).toBeGreaterThan(pick.t0.before.ownS);
        const plain = runOptimize(collide, { budget: BUDGET, scorer: "estimate" });
        // A plain run applies the rule to a collision, so it returns the same slower, clear route;
        // otherwise nothing slower than the original is accepted.
        if (plainAlso) expect({ ...plain, inputKey: result.inputKey }).toStrictEqual(result);
        else expect(plain.status).toBe("noBetter");
      }
    }, 120_000);
  }

  describe("on an original that check() only warns of (PR #395)", () => {
    // The robot's side passes 0.5 in from the post, inside its 1 in clearance, without touching it.
    const near: ObjectiveInput = { auto, robot, field: fieldWith([post(-4, 4, 7.5, 13)]), stepId: "route" };

    it("returns a route that keeps the margin, even when it is slower, and says so", () => {
      const around = runOptimize(near, { budget: BUDGET, scorer: "estimate", routeAround: true });
      expect(around.status).toBe("improved");
      expect(around.originalBlocked).toMatchObject({ code: "CLEARANCE", label: 'the structure "post"', phrase: 'comes within the margin of the structure "post"' });
      const pick = around.pick;
      if (pick === null) throw new Error("expected a route that keeps the margin");
      expect(pick.t0.after.ownS).toBeGreaterThan(pick.t0.before.ownS);
      expect(pick.closest?.clearanceIn ?? 0).toBeGreaterThanOrEqual(around.marginIn - 0.01);
      expect(around.findingsRemoved.map((finding) => finding.code)).toContain("CLEARANCE");
      // The detour that gains the last inch costs a few hundredths of a second at most.
      expect(around.changes[0]).toMatch(
        /^The original comes within the margin of the structure "post", so this is the fastest route found that keeps the margin: it (is \d+\.\d\d s slower|takes the same time) in the estimate/,
      );
    }, 120_000);

    it("is left as no better by a plain run, which keeps the original unless a route is faster and comes no closer", () => {
      const plain = runOptimize(near, { budget: BUDGET, scorer: "estimate" });
      expect(plain.status).toBe("noBetter");
      expect(plain.originalBlocked).toBeNull();
      expect(plain.pick).toBeNull();
      expect(plain.changes).toEqual(["No faster route was found that keeps at least the original's clearance, so the original stays as it is."]);
    }, 120_000);

    it("counts the plan coming within a margin larger than the robot's own, which check() does not report", () => {
      // The post is 2 in from the robot's side: outside its 1 in clearance, so no CLEARANCE finding, and inside a 3 in margin.
      const wide: ObjectiveInput = { auto, robot, field: fieldWith([post(-4, 4, 9, 14)]), stepId: "route" };
      const around = runOptimize(wide, { budget: BUDGET, scorer: "estimate", marginIn: 3, routeAround: true });
      expect(around.originalBlocked).toMatchObject({ step: 5, code: "CLEARANCE", label: 'the structure "post"' });
      expect(around.status).toBe("improved");
      expect(around.pick?.closest?.clearanceIn ?? 0).toBeGreaterThanOrEqual(3 - 0.01);
      const plain = runOptimize(wide, { budget: BUDGET, scorer: "estimate", marginIn: 3 });
      expect(plain.status).toBe("noBetter");
      expect(plain.originalBlocked).toBeNull();
    }, 120_000);

    it("says the step's own end is within the margin, which no route moves, rather than that the pick keeps it (0.1.2 UX sweep W2-4)", () => {
      // The route bows past a post beside its middle, and its end stops 0.5 in short of a second post.
      const ending = autoOf(
        { xIn: -48, yIn: 0, headingRad: 0 },
        { segments: [{ kind: "line", from: "current", to: { xIn: 40, yIn: 0 } }], heading: { mode: "constant", headingRad: 0 } },
      );
      const atEnd: ObjectiveInput = {
        auto: ending,
        robot,
        field: fieldWith([post(-4, 4, 7.5, 13), { ...post(49.5, 53, -3, 3), id: "endPost" }]),
        stepId: "route",
      };
      const around = runOptimize(atEnd, { budget: BUDGET, scorer: "estimate", routeAround: true });
      expect(around.originalBlocked?.code).toBe("CLEARANCE");
      if (around.pick === null) throw new Error(`expected a route; got ${around.status}: ${around.changes.join(" ")}`);
      expect(around.pick.closest?.clearanceIn ?? Infinity).toBeLessThan(around.marginIn);
      expect(around.changes[0]).toMatch(/its own end is within the margin, which Route around cannot move, so this is the fastest route found that keeps the margin everywhere else/);
      expect(around.changes[0]).not.toMatch(/so this is the fastest route found that keeps the margin:/);
    }, 120_000);

    it("changes nothing for an original that keeps the margin: a route must still be faster", () => {
      const clear: ObjectiveInput = { ...near, field: fieldWith([post(-4, 4, 20, 26)]) };
      const around = runOptimize(clear, { budget: BUDGET, scorer: "estimate", routeAround: true });
      expect(around.originalBlocked).toBeNull();
      expect(around.status).toBe("noBetter");
    }, 120_000);
  });

  it("cannot be asked for with headingOnly, which never moves the geometry", () => {
    expect(() => resolveOptimizeOptions(input, { mode: "headingOnly", routeAround: true })).toThrow(/heading/i);
  });
});

describe("the sentence on a route's time", () => {
  it("says faster or slower by the rounded amount", () => {
    expect(timeComparisonSentence(0.12, "the instant sim")).toBe("It is 0.12 s faster in the instant sim.");
    expect(timeComparisonSentence(-0.3, "the estimate")).toBe("It is 0.30 s slower in the estimate.");
    expect(timeComparisonSentence(0.006, "the estimate")).toBe("It is 0.01 s faster in the estimate.");
  });

  it("says the same time, not 0.00 s faster or slower, for a Route around gain that rounds to nothing", () => {
    for (const gainS of [0, 0.004, -0.004, -0]) {
      const sentence = timeComparisonSentence(gainS, "the estimate");
      expect(sentence, String(gainS)).toBe("It takes the same time in the estimate, to the hundredth of a second.");
      expect(sentence).not.toMatch(/0\.00 s/);
    }
  });
});
