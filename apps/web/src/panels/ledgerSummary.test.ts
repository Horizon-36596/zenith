/** The folded ledger's one line names what was collected and launched (issue #316). */
import { describe, expect, it } from "vitest";
import type { LedgerEntry, LedgerRun, SeasonState } from "@horizon36596/zenith-core";
import { ledgerSummary } from "./ledgerSummary";

type Holds = Record<string, number>;

/** A season state that is just the robot's holds, which is all the summary reads through `holds`. */
const season = { holds: (state: SeasonState) => ({ ...(state as unknown as { holds: Holds }).holds }) };
const at = (holds: Holds) => ({ holds }) as unknown as SeasonState;

function entry(stepId: string, before: Holds, after: Holds, extra: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    stepId,
    before: at(before),
    after: at(after),
    holds: after,
    target: null,
    launched: 0,
    collected: null,
    tipped: null,
    transfer: null,
    branch: null,
    row: { stepId, label: stepId, holds: after },
    ...extra,
  };
}

function runOf(entries: LedgerEntry[]): LedgerRun {
  return {
    entries,
    byStepId: Object.fromEntries(entries.map((e) => [e.stepId, e])),
    rows: [...entries.flatMap((e) => (e.row === null ? [] : [e.row])), { stepId: "end", label: "robot", holds: {} }],
    initialState: at({}),
    finalState: at({}),
  };
}

describe("ledgerSummary", () => {
  it("says how much pollen was collected and how many pieces were launched, not a change count", () => {
    const run = runOf([
      entry("grabA", {}, { pollen: 3 }, { collected: { containerId: "flowerA", count: 3 } }),
      entry("shoot1", { pollen: 3 }, { pollen: 1 }, { launched: 2 }),
      entry("grabB", { pollen: 1 }, { pollen: 2 }, { collected: { containerId: "flowerB", count: 1 } }),
      entry("shoot2", { pollen: 2 }, {}, { launched: 2 }),
    ]);
    expect(ledgerSummary(run, season)).toBe("4 pollen in, 4 launched");
  });

  it("counts what the robot actually gained when a flower held less than the step asked for", () => {
    const run = runOf([entry("grab", {}, { pollen: 1 }, { collected: { containerId: "flowerA", count: 3 } })]);
    expect(ledgerSummary(run, season)).toBe("1 pollen in, 0 launched");
  });

  it("counts nothing in when the robot is already full", () => {
    const run = runOf([entry("grab", { pollen: 4 }, { pollen: 4 }, { collected: { containerId: "flowerA", count: 3 } })]);
    expect(ledgerSummary(run, season)).toBe("0 in, 0 launched");
  });

  it("adds back what a step launched before it collected, without mixing in pieces", () => {
    // Held 4, launched 2, collected 3: the holds end at 5, a net gain of 1.
    const both = entry("shootAndGrab", { pollen: 4 }, { pollen: 5 }, {
      launched: 2,
      collected: { containerId: "flowerA", count: 3 },
    });
    expect(ledgerSummary(runOf([both]), season)).toBe("3 pollen in, 2 launched");
    // Launched 4 and collected 2 from a full flower that held 1: the holds fall from 4 to 1.
    const fell = entry("volleyAndGrab", { pollen: 4 }, { pollen: 1 }, {
      launched: 4,
      collected: { containerId: "flowerB", count: 2 },
    });
    expect(ledgerSummary(runOf([fell]), season)).toBe("1 pollen in, 4 launched");
  });

  it("counts the asked-for number as pieces for a season without holds", () => {
    const run = runOf([
      entry("grab", {}, {}, { collected: { containerId: "x", count: 2 } }),
      entry("shootAndGrab", {}, {}, { launched: 1, collected: { containerId: "y", count: 3 } }),
    ]);
    expect(ledgerSummary(run, {})).toBe("5 pieces in, 1 launched");
  });

  it("says 0 in, 0 launched when nothing moved, and is absent with no ledger", () => {
    expect(ledgerSummary(runOf([entry("move", {}, {})]), season)).toBe("0 in, 0 launched");
    expect(ledgerSummary(runOf([entry("shoot", { pollen: 1 }, {}, { launched: 1 })]), season)).toBe(
      "0 in, 1 launched",
    );
    expect(ledgerSummary(null, season)).toBeUndefined();
  });
});
