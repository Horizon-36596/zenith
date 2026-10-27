import type { ConditionLedgerTest, Robot } from "@horizon36596/zenith-schema";
import type { SeasonRules, SeasonState } from "./season.js";

/**
 * How the planner answers a named condition from the ledger (site/docs/file-format.md,
 * `conditions[].ledger`). The robot answers the same name with the team's own `BooleanSupplier`;
 * this is only the preview's reading of it, so a routine's `else` side can be drawn when the
 * ledger says the condition is false.
 */
export type LedgerConditionTest = "full" | "empty" | ConditionLedgerTest;

/** The names that stand for full and empty when `robot.json` marks no condition either way. */
export const DEFAULT_FULL_CONDITION = "hopperFull";
export const DEFAULT_EMPTY_CONDITION = "hopperEmpty";

/** The declared conditions whose `ledger` marker is `kind`. */
export function markedConditions(robot: Robot, kind: "full" | "empty"): string[] {
  return (robot.conditions ?? []).filter((entry) => entry.ledger === kind).map((entry) => entry.name);
}

/**
 * The ledger test for a condition name, or null when the ledger cannot answer it. A condition
 * marked in `robot.json` uses its marker; otherwise `hopperFull` and `hopperEmpty` stand for full
 * and empty unless the file marks some other condition that way, as the instant sim always did.
 */
export function conditionTestOf(robot: Robot, name: string): LedgerConditionTest | null {
  const declared = (robot.conditions ?? []).find((entry) => entry.name === name);
  if (declared?.ledger !== undefined) return declared.ledger;
  if (name === DEFAULT_FULL_CONDITION && markedConditions(robot, "full").length === 0) return "full";
  if (name === DEFAULT_EMPTY_CONDITION && markedConditions(robot, "empty").length === 0) return "empty";
  return null;
}

const sumHolds = (holds: Readonly<Record<string, number>>): number => {
  let total = 0;
  for (const key of Object.keys(holds).sort()) total += holds[key] as number;
  return total;
};

/** Whether a count lies within a test's bounds, both inclusive. */
export const withinBounds = (count: number, test: ConditionLedgerTest): boolean =>
  (test.min === undefined || count >= test.min) && (test.max === undefined || count <= test.max);

/**
 * How a test reads against one ledger state, or null when this state cannot say: no season plugin
 * that tracks what the robot holds, no capacity for "full", or a quantity the plugin does not keep.
 */
export function evaluateLedgerTest(
  test: LedgerConditionTest,
  state: SeasonState,
  season: SeasonRules,
  robot: Robot,
  alliance: "RED" | "BLUE",
): boolean | null {
  if (test === "full" || test === "empty") {
    if (season.holds === undefined) return null;
    const count = sumHolds(season.holds(state));
    if (test === "empty") return count === 0;
    const max = robot.capacity?.max;
    return max === undefined ? null : count >= max;
  }
  const count = season.measure?.(state, test.quantity, alliance) ?? null;
  return count === null ? null : withinBounds(count, test);
}

/** A test in words, for the reason a preview gives when it cannot answer one. */
export function describeLedgerTest(test: LedgerConditionTest): string {
  if (test === "full") return "the robot holds its capacity";
  if (test === "empty") return "the robot holds nothing";
  const bounds: string[] = [];
  if (test.min !== undefined) bounds.push(`at least ${String(test.min)}`);
  if (test.max !== undefined) bounds.push(`at most ${String(test.max)}`);
  return `${test.quantity} is ${bounds.join(" and ")}`;
}
