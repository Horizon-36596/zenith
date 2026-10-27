import { describe, expect, it } from "vitest";
import { clampLedgerHeight, MIN_LEDGER_H, MIN_STEPS_H, parseLedgerHeight } from "./ledgerSplit";

describe("the divider between the step list and the Ledger", () => {
  it("keeps a height that leaves both sides their minimum", () => {
    expect(clampLedgerHeight(250, 600)).toBe(250);
  });

  it("keeps the step list at its minimum when the Ledger is dragged too tall", () => {
    expect(clampLedgerHeight(900, 600)).toBe(600 - MIN_STEPS_H);
  });

  it("keeps the Ledger at its minimum when it is dragged too short", () => {
    expect(clampLedgerHeight(10, 600)).toBe(MIN_LEDGER_H);
  });

  it("gives the step list its minimum first when there is not room for both", () => {
    expect(clampLedgerHeight(200, MIN_STEPS_H + 30)).toBe(30);
    expect(clampLedgerHeight(200, 50)).toBe(0);
  });

  it("reads back only a positive number from storage", () => {
    expect(parseLedgerHeight(212.4)).toBe(212);
    expect(parseLedgerHeight(undefined)).toBeNull();
    expect(parseLedgerHeight("200")).toBeNull();
    expect(parseLedgerHeight(-5)).toBeNull();
    expect(parseLedgerHeight(Number.NaN)).toBeNull();
  });
});
