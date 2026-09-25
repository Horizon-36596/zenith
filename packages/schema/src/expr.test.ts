import { describe, expect, it } from "vitest";
import {
  estimateExpressionNames,
  evaluateEstimate,
  isEstimateExpression,
  parseEstimateExpression,
  UNKNOWN_ESTIMATE,
} from "./expr.js";

describe("estimateS grammar", () => {
  it("evaluates the registry example", () => {
    expect(evaluateEstimate("0.6 + count * cadence", { count: 3, cadence: 0.5 })).toBeCloseTo(2.1, 9);
  });

  it("respects precedence and parentheses", () => {
    expect(evaluateEstimate("(1 + 2) * 3")).toBe(9);
    expect(evaluateEstimate("1 + 2 * 3")).toBe(7);
    expect(evaluateEstimate("-2 + 1")).toBe(-1);
    expect(evaluateEstimate("8 / 2 / 2")).toBe(2);
  });

  it("has max and min and nothing else", () => {
    expect(evaluateEstimate("max(1, min(4, 2))")).toBe(2);
    expect(() => parseEstimateExpression("sqrt(4)")).toThrow(/only max and min/);
  });

  it("treats the literal unknown as no number", () => {
    expect(parseEstimateExpression(UNKNOWN_ESTIMATE)).toEqual({ kind: "unknown" });
    expect(evaluateEstimate("unknown")).toBeNull();
  });

  it("returns null rather than a wrong number for a missing parameter", () => {
    expect(evaluateEstimate("0.6 + count")).toBeNull();
    expect(evaluateEstimate("1 / 0")).toBeNull();
  });

  it("rejects anything outside the grammar", () => {
    for (const bad of ["1 +", "2 ** 3", "count;", "", "max(1)", "1 2", "$x"]) {
      expect(isEstimateExpression(bad), bad).toBe(false);
    }
    for (const good of ["0", "0.25", "count", "max(1, 2)", "1 + 2 * (3 - x) / 4"]) {
      expect(isEstimateExpression(good), good).toBe(true);
    }
  });

  it("lists the parameter names it reads", () => {
    expect(estimateExpressionNames(parseEstimateExpression("max(a, b) + a * 2"))).toEqual(["a", "b"]);
  });
});
