import { describe, expect, it } from "vitest";
import {
  BUDGET_CEILING_S,
  BUDGET_STEP,
  BUDGET_TARGET_S,
  chooseBudget,
  chooseScorerMode,
  FINALIST_COUNT,
  FINALIST_THRESHOLD_MS,
  medianOf,
  OPTIMIZE_BENCH,
  OPTIMIZE_DEFAULT_BUDGET,
  OPTIMIZE_PROVENANCE,
  OPTIMIZE_SCORER_MODE,
} from "./budget.js";

/** The words `CLAUDE.md` rule 4 allows a provenance string to start with. */
const VOCABULARY =
  /^(MEASURED|SET BY HAND|SPEC|NEEDS MEASUREMENT|CARRIED OVER|PLACEHOLDER|APPROX|SET FROM SIM|SET FROM EDITOR|CALIBRATED FROM SIM|CALIBRATED FROM ROBOT)\b/;

describe("medianOf", () => {
  it("takes the middle value of an odd count and the mean of the middle two of an even count", () => {
    expect(medianOf([3, 1, 2])).toBe(2);
    expect(medianOf([4, 1, 3, 2])).toBe(2.5);
    expect(medianOf([7])).toBe(7);
  });

  it("does not reorder or change its input", () => {
    const values = [3, 1, 2];
    medianOf(values);
    expect(values).toEqual([3, 1, 2]);
  });

  it("refuses an empty list, since there is no median to report", () => {
    expect(() => medianOf([])).toThrow();
  });
});

describe("chooseScorerMode", () => {
  it("scores every candidate with the instant sim while one window costs no more than the threshold", () => {
    expect(chooseScorerMode(FINALIST_THRESHOLD_MS)).toBe("sim");
    expect(chooseScorerMode(2.4)).toBe("sim");
  });

  it("switches to finalist mode when one window costs more than the threshold", () => {
    expect(chooseScorerMode(FINALIST_THRESHOLD_MS + 0.01)).toBe("finalist");
    expect(chooseScorerMode(40)).toBe("finalist");
  });
});

describe("chooseBudget", () => {
  it("fits the target seconds into whole evaluations, rounded down to the budget step", () => {
    expect(chooseBudget(1, 2)).toBe(2000);
    expect(chooseBudget(3, 2)).toBe(650);
    expect(chooseBudget(7.3, 2)).toBe(250);
  });

  it("never returns less than one budget step, however slow an evaluation is", () => {
    expect(chooseBudget(10_000, 2)).toBe(BUDGET_STEP);
  });

  it("refuses a time that is not a positive number", () => {
    expect(() => chooseBudget(0, 2)).toThrow();
    expect(() => chooseBudget(Number.NaN, 2)).toThrow();
  });
});

describe("the recorded bench numbers", () => {
  it("carry a provenance word from the project's vocabulary", () => {
    for (const [name, text] of Object.entries(OPTIMIZE_PROVENANCE)) {
      expect(text, name).toMatch(VOCABULARY);
    }
  });

  it("agree with the rules that were used to choose from them", () => {
    expect(chooseScorerMode(OPTIMIZE_BENCH.t1WindowMedianMs)).toBe(OPTIMIZE_SCORER_MODE);
    // The budget is chosen from everything a run does, not only the candidates it scores (issue
    // #434): from the candidates alone it was 750, and a typical step took 7 to 9 s. It may sit
    // above the target's own figure, where the Contract needs it, but a typical run stays under
    // the ceiling, well inside the editor's 5 s safety stop.
    expect(OPTIMIZE_DEFAULT_BUDGET).toBeGreaterThanOrEqual(chooseBudget(OPTIMIZE_BENCH.wholeRunPerEvaluationMedianMs, BUDGET_TARGET_S));
    expect((OPTIMIZE_DEFAULT_BUDGET * OPTIMIZE_BENCH.wholeRunPerEvaluationMedianMs) / 1000).toBeLessThan(BUDGET_CEILING_S);
    expect(OPTIMIZE_DEFAULT_BUDGET % BUDGET_STEP).toBe(0);
    // The default itself is pinned: 250 is the smallest budget at which the OPT-10 Contract holds,
    // and the Contract test in search.test.ts runs at it, so a change here is a change to what that
    // Contract is checked at.
    expect(OPTIMIZE_DEFAULT_BUDGET).toBe(250);
  });

  it("put a whole run at several times the cost of the candidates it scores, so the candidates alone cannot choose the budget", () => {
    const candidateMs = OPTIMIZE_BENCH.t0CandidateMedianMs + OPTIMIZE_BENCH.t1WindowMedianMs;
    expect(OPTIMIZE_BENCH.wholeRunPerEvaluationMedianMs).toBeGreaterThan(2 * candidateMs);
    expect(chooseBudget(candidateMs, BUDGET_TARGET_S)).toBeGreaterThan(OPTIMIZE_DEFAULT_BUDGET);
  });

  it("were measured in Node 22, the runtime spec 16 section 5.3 and CLAUDE.md rule 9 name", () => {
    expect(OPTIMIZE_BENCH.node).toMatch(/^v22\./);
    expect(OPTIMIZE_PROVENANCE.bench).toContain(OPTIMIZE_BENCH.node);
  });

  it("keep the finalist count a small whole number", () => {
    expect(Number.isInteger(FINALIST_COUNT)).toBe(true);
    expect(FINALIST_COUNT).toBeGreaterThan(0);
  });
});
